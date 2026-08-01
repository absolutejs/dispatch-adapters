import type { DispatchResult } from "@absolutejs/dispatch";
import type { TwilioPostgresClient } from "./postgresLifecycle";

export type TwilioIdempotencyClaim =
  | { disposition: "claimed"; token: string }
  | { disposition: "completed"; result: DispatchResult }
  | { disposition: "in-flight" };

export type TwilioIdempotencyStore = {
  readonly durability: "durable" | "memory";
  begin: (key: string) => Promise<TwilioIdempotencyClaim>;
  complete: (
    key: string,
    token: string,
    result: DispatchResult,
  ) => Promise<void>;
  release: (key: string, token: string) => Promise<void>;
};

export const createMemoryTwilioIdempotencyStore =
  (): TwilioIdempotencyStore => {
    const entries = new Map<
      string,
      { result?: DispatchResult; token?: string }
    >();

    return {
      durability: "memory",
      begin: async (key) => {
        const entry = entries.get(key);
        if (entry?.result)
          return { disposition: "completed", result: entry.result };
        if (entry?.token) return { disposition: "in-flight" };
        const token = crypto.randomUUID();
        entries.set(key, { token });
        return { disposition: "claimed", token };
      },
      complete: async (key, token, result) => {
        if (entries.get(key)?.token !== token) {
          throw new Error("invalid Twilio idempotency claim completion");
        }
        entries.set(key, { result: { ...result } });
      },
      release: async (key, token) => {
        if (entries.get(key)?.token === token) entries.delete(key);
      },
    };
  };

export const TWILIO_IDEMPOTENCY_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS absolute_twilio_send_idempotency (
  idempotency_key text PRIMARY KEY,
  claim_token text,
  claimed_until_ms bigint,
  result jsonb,
  completed_at_ms bigint
);
`;

export const createPostgresTwilioIdempotencyStore = (
  client: TwilioPostgresClient,
  options: { claimTtlMs?: number } = {},
): TwilioIdempotencyStore => {
  const claimTtlMs = options.claimTtlMs ?? 60_000;
  return {
    durability: "durable",
    begin: async (key) => {
      await client.query("BEGIN");
      try {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 2))",
          [key],
        );
        const found = await client.query(
          "SELECT claim_token, claimed_until_ms, result FROM absolute_twilio_send_idempotency WHERE idempotency_key = $1 FOR UPDATE",
          [key],
        );
        const row = found.rows[0];
        if (row?.result !== null && row?.result !== undefined) {
          await client.query("COMMIT");
          return {
            disposition: "completed" as const,
            result: row.result as DispatchResult,
          };
        }
        const now = Date.now();
        if (
          row?.claim_token !== null &&
          row?.claim_token !== undefined &&
          Number(row.claimed_until_ms) > now
        ) {
          await client.query("COMMIT");
          return { disposition: "in-flight" as const };
        }
        const token = crypto.randomUUID();
        await client.query(
          `INSERT INTO absolute_twilio_send_idempotency
            (idempotency_key, claim_token, claimed_until_ms)
           VALUES ($1, $2, $3)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             claim_token = EXCLUDED.claim_token,
             claimed_until_ms = EXCLUDED.claimed_until_ms`,
          [key, token, now + claimTtlMs],
        );
        await client.query("COMMIT");
        return { disposition: "claimed" as const, token };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    complete: async (key, token, result) => {
      const updated = await client.query(
        `UPDATE absolute_twilio_send_idempotency
         SET result = $3::jsonb, completed_at_ms = $4,
             claim_token = NULL, claimed_until_ms = NULL
         WHERE idempotency_key = $1 AND claim_token = $2
         RETURNING idempotency_key`,
        [key, token, JSON.stringify(result), Date.now()],
      );
      if (updated.rows.length !== 1) {
        throw new Error("invalid Twilio idempotency claim completion");
      }
    },
    release: async (key, token) => {
      await client.query(
        "DELETE FROM absolute_twilio_send_idempotency WHERE idempotency_key = $1 AND claim_token = $2 AND result IS NULL",
        [key, token],
      );
    },
  };
};
