import {
  classifyTwilioStatusTransition,
  type TwilioLifecycleClaim,
  type TwilioLifecycleRetentionOptions,
  type TwilioLifecycleStore,
  type TwilioLifecycleWorkItem,
  type TwilioMessageStatus,
  type TwilioWebhookEvent,
  redactTwilioWebhookEvent,
} from "./lifecycle";

export type TwilioPostgresClient = {
  query: (
    text: string,
    values?: ReadonlyArray<unknown>,
  ) => Promise<{
    rowCount?: number | null;
    rows: Array<Record<string, unknown>>;
  }>;
};

export type TwilioPostgresConnection = TwilioPostgresClient & {
  release: () => void;
};

/** PostgreSQL pool contract; transactions always use one checked-out connection. */
export type TwilioPostgresPool = TwilioPostgresClient & {
  connect: () => Promise<TwilioPostgresConnection>;
};

export const TWILIO_LIFECYCLE_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS absolute_twilio_message_status_v2 (
  message_sid text PRIMARY KEY,
  status text NOT NULL,
  updated_at_ms bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS absolute_twilio_webhook_events_v2 (
  event_id text PRIMARY KEY,
  message_sid text NOT NULL,
  payload jsonb NOT NULL,
  disposition text NOT NULL,
  claim_token text,
  claimed_until_ms bigint,
  completed_at_ms bigint,
  received_at_ms bigint NOT NULL
  ,expires_at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS absolute_twilio_webhook_claim_idx
  ON absolute_twilio_webhook_events_v2 (claimed_until_ms, received_at_ms)
  WHERE completed_at_ms IS NULL;
CREATE INDEX IF NOT EXISTS absolute_twilio_webhook_message_idx
  ON absolute_twilio_webhook_events_v2 (message_sid, received_at_ms);
CREATE INDEX IF NOT EXISTS absolute_twilio_webhook_expiry_idx
  ON absolute_twilio_webhook_events_v2 (expires_at_ms);
`;

export const createPostgresTwilioLifecycleStore = (
  pool: TwilioPostgresPool,
  options: TwilioLifecycleRetentionOptions = {},
): TwilioLifecycleStore => {
  const claimTtlMs = options.claimTtlMs ?? 60_000;
  const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60_000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(claimTtlMs) || claimTtlMs < 1_000) {
    throw new TypeError("claimTtlMs must be an integer of at least 1000");
  }
  if (!Number.isInteger(retentionMs) || retentionMs < 1_000) {
    throw new TypeError("retentionMs must be an integer of at least 1000");
  }

  const transaction = async <T>(
    run: (client: TwilioPostgresConnection) => Promise<T>,
  ) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    durability: "durable",
    begin: (event): Promise<TwilioLifecycleClaim> =>
      transaction(async (client) => {
        const timestamp = now();
        const storedEvent = redactTwilioWebhookEvent(event, options);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [event.eventId],
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
          [event.messageSid],
        );
        const existingResult = await client.query(
          "SELECT claim_token, claimed_until_ms, completed_at_ms FROM absolute_twilio_webhook_events_v2 WHERE event_id = $1 FOR UPDATE",
          [event.eventId],
        );
        const existing = existingResult.rows[0];
        if (
          existing?.completed_at_ms !== null &&
          existing?.completed_at_ms !== undefined
        ) {
          return { disposition: "duplicate" };
        }
        if (
          existing?.claim_token !== null &&
          existing?.claim_token !== undefined &&
          Number(existing.claimed_until_ms) > timestamp
        ) {
          return { disposition: "duplicate" };
        }

        let previousStatus: TwilioMessageStatus | undefined;
        let disposition: "accepted" | "duplicate" | "stale" = existing
          ? "duplicate"
          : "accepted";
        if (event.kind === "status") {
          const statusResult = await client.query(
            "SELECT status FROM absolute_twilio_message_status_v2 WHERE message_sid = $1 FOR UPDATE",
            [event.messageSid],
          );
          previousStatus = statusResult.rows[0]?.status as
            | TwilioMessageStatus
            | undefined;
          if (!existing) {
            disposition = classifyTwilioStatusTransition(
              previousStatus,
              event.status,
            );
          } else if (
            previousStatus !== event.status &&
            classifyTwilioStatusTransition(previousStatus, event.status) ===
              "stale"
          ) {
            disposition = "stale";
          }
        }

        if (disposition === "stale") {
          await client.query(
            `INSERT INTO absolute_twilio_webhook_events_v2
              (event_id, message_sid, payload, disposition, completed_at_ms, received_at_ms, expires_at_ms)
             VALUES ($1, $2, $3::jsonb, 'stale', $4, $5, $6)
             ON CONFLICT (event_id) DO UPDATE SET
               claim_token = NULL, claimed_until_ms = NULL,
               completed_at_ms = EXCLUDED.completed_at_ms,
               disposition = 'stale'`,
            [
              event.eventId,
              event.messageSid,
              JSON.stringify(storedEvent),
              timestamp,
              event.receivedAt,
              event.receivedAt + retentionMs,
            ],
          );
          return {
            disposition,
            ...(previousStatus === undefined ? {} : { previousStatus }),
          };
        }

        const claimToken = crypto.randomUUID();
        await client.query(
          `INSERT INTO absolute_twilio_webhook_events_v2
            (event_id, message_sid, payload, disposition, claim_token, claimed_until_ms, received_at_ms, expires_at_ms)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
           ON CONFLICT (event_id) DO UPDATE SET
             claim_token = EXCLUDED.claim_token,
             claimed_until_ms = EXCLUDED.claimed_until_ms,
             disposition = EXCLUDED.disposition`,
          [
            event.eventId,
            event.messageSid,
            JSON.stringify(storedEvent),
            disposition,
            claimToken,
            timestamp + claimTtlMs,
            event.receivedAt,
            event.receivedAt + retentionMs,
          ],
        );
        if (event.kind === "status" && disposition === "accepted") {
          await client.query(
            `INSERT INTO absolute_twilio_message_status_v2 (message_sid, status, updated_at_ms)
             VALUES ($1, $2, $3)
             ON CONFLICT (message_sid) DO UPDATE SET
               status = EXCLUDED.status, updated_at_ms = EXCLUDED.updated_at_ms`,
            [event.messageSid, event.status, timestamp],
          );
        }
        return {
          claimToken,
          disposition,
          ...(previousStatus === undefined ? {} : { previousStatus }),
        };
      }),
    claimPending: (limit = 100): Promise<TwilioLifecycleWorkItem[]> => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new TypeError("claimPending limit must be between 1 and 1000");
      }
      return transaction(async (client) => {
        const timestamp = now();
        const found = await client.query(
          `SELECT event_id, payload, disposition
           FROM absolute_twilio_webhook_events_v2
           WHERE completed_at_ms IS NULL
             AND (claim_token IS NULL OR claimed_until_ms <= $1)
           ORDER BY received_at_ms ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2`,
          [timestamp, limit],
        );
        const work: TwilioLifecycleWorkItem[] = [];
        for (const row of found.rows) {
          const event = row.payload as TwilioWebhookEvent;
          if (event.kind === "status") {
            const status = await client.query(
              "SELECT status FROM absolute_twilio_message_status_v2 WHERE message_sid = $1",
              [event.messageSid],
            );
            const current = status.rows[0]?.status as
              | TwilioMessageStatus
              | undefined;
            if (
              current !== event.status &&
              classifyTwilioStatusTransition(current, event.status) === "stale"
            ) {
              await client.query(
                `UPDATE absolute_twilio_webhook_events_v2
                 SET disposition = 'stale', completed_at_ms = $2,
                     claim_token = NULL, claimed_until_ms = NULL
                 WHERE event_id = $1`,
                [event.eventId, timestamp],
              );
              continue;
            }
          }
          const claimToken = crypto.randomUUID();
          await client.query(
            `UPDATE absolute_twilio_webhook_events_v2
             SET claim_token = $2, claimed_until_ms = $3
             WHERE event_id = $1`,
            [event.eventId, claimToken, timestamp + claimTtlMs],
          );
          work.push({
            claimToken,
            disposition:
              row.disposition as TwilioLifecycleWorkItem["disposition"],
            event,
          });
        }
        return work;
      });
    },
    complete: async (eventId, claimToken) => {
      const result = await pool.query(
        `UPDATE absolute_twilio_webhook_events_v2
         SET completed_at_ms = $3, claim_token = NULL, claimed_until_ms = NULL
         WHERE event_id = $1 AND claim_token = $2 AND completed_at_ms IS NULL
         RETURNING event_id`,
        [eventId, claimToken, now()],
      );
      if (result.rows.length !== 1) {
        throw new Error("invalid Twilio lifecycle claim completion");
      }
    },
    release: async (eventId, claimToken) => {
      await pool.query(
        `UPDATE absolute_twilio_webhook_events_v2
         SET claim_token = NULL, claimed_until_ms = NULL
         WHERE event_id = $1 AND claim_token = $2 AND completed_at_ms IS NULL`,
        [eventId, claimToken],
      );
    },
    exportMessage: async (messageSid) => {
      const result = await pool.query(
        `SELECT payload FROM absolute_twilio_webhook_events_v2
         WHERE message_sid = $1 ORDER BY received_at_ms ASC`,
        [messageSid],
      );
      return result.rows.map((row) => row.payload as TwilioWebhookEvent);
    },
    purgeExpired: async (at = now()) => {
      const result = await pool.query(
        `DELETE FROM absolute_twilio_webhook_events_v2
         WHERE expires_at_ms <= $1 RETURNING event_id`,
        [at],
      );
      return result.rows.length;
    },
  };
};
