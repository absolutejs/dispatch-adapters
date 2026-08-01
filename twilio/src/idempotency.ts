import { createHash } from "node:crypto";
import type { MessagingDispatchResult } from "@absolutejs/dispatch";
import type { TwilioPostgresPool } from "./postgresLifecycle";

export type TwilioIdempotencyScope = {
  accountSid: string;
  key: string;
  tenant?: string;
};

export type TwilioIdempotencyOutcome =
  | { kind: "provider-error"; code: number; message?: string }
  | { kind: "success"; result: MessagingDispatchResult };

export type TwilioIdempotencyClaim =
  | { disposition: "claimed"; token: string }
  | { disposition: "completed"; outcome: TwilioIdempotencyOutcome }
  | { disposition: "in-flight" }
  | { disposition: "indeterminate" };

export type TwilioIdempotencyStore = {
  readonly durability: "durable" | "memory";
  begin: (
    scope: TwilioIdempotencyScope,
    payloadFingerprint: string,
  ) => Promise<TwilioIdempotencyClaim>;
  complete: (
    scope: TwilioIdempotencyScope,
    token: string,
    outcome: TwilioIdempotencyOutcome,
  ) => Promise<void>;
  markExecuting: (
    scope: TwilioIdempotencyScope,
    token: string,
  ) => Promise<void>;
  markIndeterminate: (
    scope: TwilioIdempotencyScope,
    token: string,
  ) => Promise<void>;
  /** Releases only a prepared claim whose provider side effect has not started. */
  releasePrepared: (
    scope: TwilioIdempotencyScope,
    token: string,
  ) => Promise<void>;
};

export class TwilioIdempotencyConflictError extends Error {
  override name = "TwilioIdempotencyConflictError";
}

export class TwilioIdempotencyIndeterminateError extends Error {
  override name = "TwilioIdempotencyIndeterminateError";
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

export const fingerprintTwilioPayload = (payload: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");

const scopeKey = (scope: TwilioIdempotencyScope) =>
  JSON.stringify([scope.accountSid, scope.tenant ?? null, scope.key]);

type MemoryEntry = {
  fingerprint: string;
  outcome?: TwilioIdempotencyOutcome;
  state: "prepared" | "executing" | "indeterminate" | "completed";
  token?: string;
};

export const createMemoryTwilioIdempotencyStore =
  (): TwilioIdempotencyStore => {
    const entries = new Map<string, MemoryEntry>();
    return {
      durability: "memory",
      begin: async (scope, fingerprint) => {
        const key = scopeKey(scope);
        const entry = entries.get(key);
        if (entry !== undefined && entry.fingerprint !== fingerprint) {
          throw new TwilioIdempotencyConflictError(
            "idempotency key was already used with a different Twilio payload",
          );
        }
        if (entry?.state === "completed" && entry.outcome !== undefined) {
          return {
            disposition: "completed",
            outcome: structuredClone(entry.outcome),
          };
        }
        if (entry?.state === "executing" || entry?.state === "prepared") {
          return { disposition: "in-flight" };
        }
        if (entry?.state === "indeterminate")
          return { disposition: "indeterminate" };
        const token = crypto.randomUUID();
        entries.set(key, { fingerprint, state: "prepared", token });
        return { disposition: "claimed", token };
      },
      complete: async (scope, token, outcome) => {
        const entry = entries.get(scopeKey(scope));
        if (entry?.token !== token || entry.state !== "executing") {
          throw new Error("invalid Twilio idempotency claim completion");
        }
        entries.set(scopeKey(scope), {
          fingerprint: entry.fingerprint,
          outcome: structuredClone(outcome),
          state: "completed",
        });
      },
      markExecuting: async (scope, token) => {
        const entry = entries.get(scopeKey(scope));
        if (entry?.token !== token || entry.state !== "prepared") {
          throw new Error("invalid Twilio idempotency execution claim");
        }
        entry.state = "executing";
      },
      markIndeterminate: async (scope, token) => {
        const entry = entries.get(scopeKey(scope));
        if (entry?.token !== token || entry.state !== "executing") {
          throw new Error("invalid Twilio idempotency indeterminate claim");
        }
        entry.state = "indeterminate";
        delete entry.token;
      },
      releasePrepared: async (scope, token) => {
        const key = scopeKey(scope);
        const entry = entries.get(key);
        if (entry?.token === token && entry.state === "prepared")
          entries.delete(key);
      },
    };
  };

export const TWILIO_IDEMPOTENCY_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS absolute_twilio_send_idempotency_v2 (
  account_sid text NOT NULL,
  tenant text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  payload_fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared', 'executing', 'completed', 'indeterminate')),
  fencing_token bigint NOT NULL DEFAULT 0,
  claim_token text,
  claimed_until_ms bigint,
  outcome jsonb,
  completed_at_ms bigint,
  PRIMARY KEY (account_sid, tenant, idempotency_key)
);
`;

export const createPostgresTwilioIdempotencyStore = (
  pool: TwilioPostgresPool,
  options: { claimTtlMs?: number; now?: () => number } = {},
): TwilioIdempotencyStore => {
  const claimTtlMs = options.claimTtlMs ?? 60_000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(claimTtlMs) || claimTtlMs < 1_000) {
    throw new TypeError("claimTtlMs must be an integer of at least 1000");
  }
  const values = (scope: TwilioIdempotencyScope) => [
    scope.accountSid,
    scope.tenant ?? "",
    scope.key,
  ];
  return {
    durability: "durable",
    begin: async (scope, fingerprint) => {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 3))",
          [scopeKey(scope)],
        );
        const found = await connection.query(
          `SELECT payload_fingerprint, state, claim_token, claimed_until_ms, outcome
           FROM absolute_twilio_send_idempotency_v2
           WHERE account_sid = $1 AND tenant = $2 AND idempotency_key = $3
           FOR UPDATE`,
          values(scope),
        );
        const row = found.rows[0];
        if (row !== undefined && row.payload_fingerprint !== fingerprint) {
          throw new TwilioIdempotencyConflictError(
            "idempotency key was already used with a different Twilio payload",
          );
        }
        if (row?.state === "completed") {
          await connection.query("COMMIT");
          return {
            disposition: "completed" as const,
            outcome: row.outcome as TwilioIdempotencyOutcome,
          };
        }
        if (row?.state === "indeterminate") {
          await connection.query("COMMIT");
          return { disposition: "indeterminate" as const };
        }
        const timestamp = now();
        if (row?.state === "executing") {
          if (Number(row.claimed_until_ms) <= timestamp) {
            await connection.query(
              `UPDATE absolute_twilio_send_idempotency_v2
               SET state = 'indeterminate', claim_token = NULL, claimed_until_ms = NULL
               WHERE account_sid = $1 AND tenant = $2 AND idempotency_key = $3`,
              values(scope),
            );
            await connection.query("COMMIT");
            return { disposition: "indeterminate" as const };
          }
          await connection.query("COMMIT");
          return { disposition: "in-flight" as const };
        }
        if (
          row?.state === "prepared" &&
          Number(row.claimed_until_ms) > timestamp
        ) {
          await connection.query("COMMIT");
          return { disposition: "in-flight" as const };
        }
        const token = crypto.randomUUID();
        await connection.query(
          `INSERT INTO absolute_twilio_send_idempotency_v2
             (account_sid, tenant, idempotency_key, payload_fingerprint, state,
              fencing_token, claim_token, claimed_until_ms)
           VALUES ($1, $2, $3, $4, 'prepared', 1, $5, $6)
           ON CONFLICT (account_sid, tenant, idempotency_key) DO UPDATE SET
             state = 'prepared', fencing_token = absolute_twilio_send_idempotency_v2.fencing_token + 1,
             claim_token = EXCLUDED.claim_token, claimed_until_ms = EXCLUDED.claimed_until_ms`,
          [...values(scope), fingerprint, token, timestamp + claimTtlMs],
        );
        await connection.query("COMMIT");
        return { disposition: "claimed" as const, token };
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    complete: async (scope, token, outcome) => {
      const updated = await pool.query(
        `UPDATE absolute_twilio_send_idempotency_v2
         SET state = 'completed', outcome = $5::jsonb, completed_at_ms = $6,
             claim_token = NULL, claimed_until_ms = NULL
         WHERE account_sid = $1 AND tenant = $2 AND idempotency_key = $3
           AND claim_token = $4 AND state = 'executing'
         RETURNING idempotency_key`,
        [...values(scope), token, JSON.stringify(outcome), now()],
      );
      if (updated.rows.length !== 1)
        throw new Error("invalid Twilio idempotency claim completion");
    },
    markExecuting: async (scope, token) => {
      const updated = await pool.query(
        `UPDATE absolute_twilio_send_idempotency_v2 SET state = 'executing'
         WHERE account_sid = $1 AND tenant = $2 AND idempotency_key = $3
           AND claim_token = $4 AND state = 'prepared'
         RETURNING idempotency_key`,
        [...values(scope), token],
      );
      if (updated.rows.length !== 1)
        throw new Error("invalid Twilio idempotency execution claim");
    },
    markIndeterminate: async (scope, token) => {
      const updated = await pool.query(
        `UPDATE absolute_twilio_send_idempotency_v2
         SET state = 'indeterminate', claim_token = NULL, claimed_until_ms = NULL
         WHERE account_sid = $1 AND tenant = $2 AND idempotency_key = $3
           AND claim_token = $4 AND state = 'executing'
         RETURNING idempotency_key`,
        [...values(scope), token],
      );
      if (updated.rows.length !== 1)
        throw new Error("invalid Twilio idempotency indeterminate claim");
    },
    releasePrepared: async (scope, token) => {
      await pool.query(
        `DELETE FROM absolute_twilio_send_idempotency_v2
         WHERE account_sid = $1 AND tenant = $2 AND idempotency_key = $3
           AND claim_token = $4 AND state = 'prepared'`,
        [...values(scope), token],
      );
    },
  };
};
