import twilio from "twilio";
import type { TwilioPostgresPool } from "./postgresLifecycle";
import { TwilioWebhookError } from "./webhooks";

export type TwilioCloudEvent = {
  data: unknown;
  datacontenttype?: string;
  dataschema?: string;
  id: string;
  source: string;
  specversion: "1.0";
  time: string;
  type: string;
};

export type TwilioEventStreamClaim = {
  claimToken?: string;
  disposition: "accepted" | "duplicate";
};

export type TwilioEventStreamWorkItem = {
  claimToken: string;
  event: TwilioCloudEvent;
};

export type TwilioEventStreamStore = {
  readonly durability: "durable" | "memory";
  begin: (event: TwilioCloudEvent) => Promise<TwilioEventStreamClaim>;
  claimPending: (limit?: number) => Promise<TwilioEventStreamWorkItem[]>;
  complete: (eventId: string, claimToken: string) => Promise<void>;
  release: (eventId: string, claimToken: string) => Promise<void>;
  purgeExpired: (at?: number) => Promise<number>;
};

export type TwilioEventStreamStoreOptions = {
  claimTtlMs?: number;
  now?: () => number;
  /** Defaults to seven days, matching a bounded operational recovery window. */
  retentionMs?: number;
  /** Redact product-specific PII before durable persistence. */
  redact?: (event: TwilioCloudEvent) => TwilioCloudEvent;
};

const validateStoreOptions = (options: TwilioEventStreamStoreOptions) => {
  const claimTtlMs = options.claimTtlMs ?? 60_000;
  const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60_000;
  if (!Number.isInteger(claimTtlMs) || claimTtlMs < 1_000) {
    throw new TypeError("claimTtlMs must be an integer of at least 1000");
  }
  if (!Number.isInteger(retentionMs) || retentionMs < 1_000) {
    throw new TypeError("retentionMs must be an integer of at least 1000");
  }
  return { claimTtlMs, retentionMs };
};

export const createMemoryTwilioEventStreamStore = (
  options: TwilioEventStreamStoreOptions = {},
): TwilioEventStreamStore => {
  const { claimTtlMs, retentionMs } = validateStoreOptions(options);
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    {
      claimToken?: string;
      claimedUntil?: number;
      complete: boolean;
      event: TwilioCloudEvent;
      expiresAt: number;
    }
  >();
  const claim = (
    entry: typeof entries extends Map<string, infer T> ? T : never,
  ) => {
    const claimToken = crypto.randomUUID();
    entry.claimToken = claimToken;
    entry.claimedUntil = now() + claimTtlMs;
    return claimToken;
  };
  return {
    durability: "memory",
    begin: async (event) => {
      const existing = entries.get(event.id);
      if (
        existing?.complete === true ||
        (existing?.claimToken !== undefined &&
          (existing.claimedUntil ?? 0) > now())
      )
        return { disposition: "duplicate" };
      if (existing !== undefined) {
        return { claimToken: claim(existing), disposition: "duplicate" };
      }
      const entry = {
        complete: false,
        event: structuredClone(options.redact?.(event) ?? event),
        expiresAt: Date.parse(event.time) + retentionMs,
      };
      entries.set(event.id, entry);
      return { claimToken: claim(entry), disposition: "accepted" };
    },
    claimPending: async (limit = 100) => {
      const work: TwilioEventStreamWorkItem[] = [];
      for (const entry of [...entries.values()].sort(
        (left, right) =>
          Date.parse(left.event.time) - Date.parse(right.event.time),
      )) {
        if (work.length >= limit) break;
        if (
          entry.complete ||
          (entry.claimToken !== undefined && (entry.claimedUntil ?? 0) > now())
        )
          continue;
        work.push({
          claimToken: claim(entry),
          event: structuredClone(entry.event),
        });
      }
      return work;
    },
    complete: async (eventId, claimToken) => {
      const entry = entries.get(eventId);
      if (entry?.claimToken !== claimToken)
        throw new Error("invalid Event Stream claim completion");
      entry.complete = true;
      delete entry.claimToken;
      delete entry.claimedUntil;
    },
    release: async (eventId, claimToken) => {
      const entry = entries.get(eventId);
      if (entry?.claimToken === claimToken) {
        delete entry.claimToken;
        delete entry.claimedUntil;
      }
    },
    purgeExpired: async (at = now()) => {
      let count = 0;
      for (const [id, entry] of entries) {
        if (entry.expiresAt <= at) {
          entries.delete(id);
          count += 1;
        }
      }
      return count;
    },
  };
};

export const TWILIO_EVENT_STREAM_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS absolute_twilio_event_stream_inbox (
  event_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  claim_token text,
  claimed_until_ms bigint,
  completed_at_ms bigint,
  received_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS absolute_twilio_event_stream_pending_idx
  ON absolute_twilio_event_stream_inbox (claimed_until_ms, received_at_ms)
  WHERE completed_at_ms IS NULL;
CREATE INDEX IF NOT EXISTS absolute_twilio_event_stream_expiry_idx
  ON absolute_twilio_event_stream_inbox (expires_at_ms);
`;

export const createPostgresTwilioEventStreamStore = (
  pool: TwilioPostgresPool,
  options: TwilioEventStreamStoreOptions = {},
): TwilioEventStreamStore => {
  const { claimTtlMs, retentionMs } = validateStoreOptions(options);
  const now = options.now ?? Date.now;
  return {
    durability: "durable",
    begin: async (event) => {
      const token = crypto.randomUUID();
      const timestamp = now();
      const result = await pool.query(
        `INSERT INTO absolute_twilio_event_stream_inbox
           (event_id, payload, claim_token, claimed_until_ms, received_at_ms, expires_at_ms)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO UPDATE SET
           claim_token = CASE
             WHEN absolute_twilio_event_stream_inbox.completed_at_ms IS NULL
              AND (absolute_twilio_event_stream_inbox.claim_token IS NULL
                OR absolute_twilio_event_stream_inbox.claimed_until_ms <= $5)
             THEN EXCLUDED.claim_token ELSE absolute_twilio_event_stream_inbox.claim_token END,
           claimed_until_ms = CASE
             WHEN absolute_twilio_event_stream_inbox.completed_at_ms IS NULL
              AND (absolute_twilio_event_stream_inbox.claim_token IS NULL
                OR absolute_twilio_event_stream_inbox.claimed_until_ms <= $5)
             THEN EXCLUDED.claimed_until_ms ELSE absolute_twilio_event_stream_inbox.claimed_until_ms END
         RETURNING (xmax = 0) AS inserted, claim_token`,
        [
          event.id,
          JSON.stringify(options.redact?.(event) ?? event),
          token,
          timestamp + claimTtlMs,
          timestamp,
          Date.parse(event.time) + retentionMs,
        ],
      );
      const row = result.rows[0];
      return {
        ...(row?.claim_token === token ? { claimToken: token } : {}),
        disposition: row?.inserted === true ? "accepted" : "duplicate",
      };
    },
    claimPending: async (limit = 100) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new TypeError("claimPending limit must be between 1 and 1000");
      }
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        const timestamp = now();
        const found = await connection.query(
          `SELECT event_id, payload FROM absolute_twilio_event_stream_inbox
           WHERE completed_at_ms IS NULL
             AND (claim_token IS NULL OR claimed_until_ms <= $1)
           ORDER BY received_at_ms ASC FOR UPDATE SKIP LOCKED LIMIT $2`,
          [timestamp, limit],
        );
        const work: TwilioEventStreamWorkItem[] = [];
        for (const row of found.rows) {
          const claimToken = crypto.randomUUID();
          await connection.query(
            `UPDATE absolute_twilio_event_stream_inbox
             SET claim_token = $2, claimed_until_ms = $3 WHERE event_id = $1`,
            [row.event_id, claimToken, timestamp + claimTtlMs],
          );
          work.push({ claimToken, event: row.payload as TwilioCloudEvent });
        }
        await connection.query("COMMIT");
        return work;
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    complete: async (eventId, claimToken) => {
      const result = await pool.query(
        `UPDATE absolute_twilio_event_stream_inbox
         SET completed_at_ms = $3, claim_token = NULL, claimed_until_ms = NULL
         WHERE event_id = $1 AND claim_token = $2 AND completed_at_ms IS NULL
         RETURNING event_id`,
        [eventId, claimToken, now()],
      );
      if (result.rows.length !== 1)
        throw new Error("invalid Event Stream claim completion");
    },
    release: async (eventId, claimToken) => {
      await pool.query(
        `UPDATE absolute_twilio_event_stream_inbox
         SET claim_token = NULL, claimed_until_ms = NULL
         WHERE event_id = $1 AND claim_token = $2 AND completed_at_ms IS NULL`,
        [eventId, claimToken],
      );
    },
    purgeExpired: async (at = now()) => {
      const result = await pool.query(
        "DELETE FROM absolute_twilio_event_stream_inbox WHERE expires_at_ms <= $1 RETURNING event_id",
        [at],
      );
      return result.rows.length;
    },
  };
};

const EVENT_ID = /^[A-Z]{2}[0-9a-fA-F]{32}$/;
const parseEvents = (rawBody: string): TwilioCloudEvent[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new TwilioWebhookError("invalid Event Streams JSON", 400);
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
    throw new TwilioWebhookError(
      "Event Streams body must contain 1 to 100 events",
      400,
    );
  }
  return parsed.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TwilioWebhookError("invalid CloudEvent", 400);
    }
    const event = value as Partial<TwilioCloudEvent>;
    if (
      event.specversion !== "1.0" ||
      typeof event.id !== "string" ||
      !EVENT_ID.test(event.id) ||
      typeof event.type !== "string" ||
      event.type.length === 0 ||
      typeof event.source !== "string" ||
      event.source.length === 0 ||
      typeof event.time !== "string" ||
      !Number.isFinite(Date.parse(event.time)) ||
      !("data" in event)
    )
      throw new TwilioWebhookError("invalid CloudEvent", 400);
    return structuredClone(event as TwilioCloudEvent);
  });
};

export type CreateTwilioEventStreamHandlerOptions = {
  /** Resolve current/previous tokens from untrusted parsed event metadata. */
  resolveAuthTokens: (
    events: ReadonlyArray<TwilioCloudEvent>,
  ) => Promise<readonly [string, ...string[]]> | readonly [string, ...string[]];
  onEvent: (event: TwilioCloudEvent) => Promise<void> | void;
  publicUrl: string;
  store: TwilioEventStreamStore;
  maxBodyBytes?: number;
};

export const createTwilioEventStreamProcessor =
  (options: CreateTwilioEventStreamHandlerOptions) =>
  async (request: Request) => {
    if (request.method !== "POST")
      throw new TwilioWebhookError("Event Streams requires POST", 405);
    if (
      request.headers.get("content-type")?.split(";", 1)[0] !==
      "application/json"
    ) {
      throw new TwilioWebhookError("Event Streams requires JSON", 415);
    }
    const rawBody = await request.text();
    if (
      new TextEncoder().encode(rawBody).byteLength >
      (options.maxBodyBytes ?? 1024 * 1024)
    ) {
      throw new TwilioWebhookError("Event Streams body is too large", 413);
    }
    const events = parseEvents(rawBody);
    const tokens = await options.resolveAuthTokens(events);
    const signature = request.headers.get("x-twilio-signature");
    if (
      signature === null ||
      tokens.length === 0 ||
      tokens.some((token) => token.length === 0)
    ) {
      throw new TwilioWebhookError("invalid Event Streams credentials", 403);
    }
    const configured = new URL(options.publicUrl);
    if (configured.protocol !== "https:")
      throw new TwilioWebhookError("publicUrl must use HTTPS", 500);
    configured.search = new URL(request.url).search;
    if (
      !tokens.some((token) =>
        twilio.validateRequestWithBody(
          token,
          signature,
          configured.href,
          rawBody,
        ),
      )
    ) {
      throw new TwilioWebhookError("invalid Event Streams signature", 403);
    }
    const results: TwilioEventStreamClaim[] = [];
    for (const event of events) {
      const claim = await options.store.begin(event);
      results.push(claim);
      if (claim.claimToken === undefined) continue;
      try {
        await options.onEvent(event);
        await options.store.complete(event.id, claim.claimToken);
      } catch (error) {
        await options.store.release(event.id, claim.claimToken);
        throw error;
      }
    }
    return results;
  };

export const createTwilioEventStreamHandler = (
  options: CreateTwilioEventStreamHandlerOptions,
) => {
  const process = createTwilioEventStreamProcessor(options);
  return async (request: Request) => {
    try {
      const results = await process(request);
      return Response.json({
        dispositions: results.map(({ disposition }) => disposition),
      });
    } catch (error) {
      if (error instanceof TwilioWebhookError) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      }
      return Response.json(
        { error: "Event Streams processing failed" },
        { status: 500 },
      );
    }
  };
};

export const drainTwilioEventStreamInbox = async (
  options: Pick<CreateTwilioEventStreamHandlerOptions, "onEvent" | "store"> & {
    limit?: number;
  },
) => {
  const work = await options.store.claimPending(options.limit);
  let completed = 0;
  const errors: Array<{ error: unknown; eventId: string }> = [];
  for (const item of work) {
    try {
      await options.onEvent(item.event);
      await options.store.complete(item.event.id, item.claimToken);
      completed += 1;
    } catch (error) {
      await options.store.release(item.event.id, item.claimToken);
      errors.push({ error, eventId: item.event.id });
    }
  }
  return { claimed: work.length, completed, errors };
};
