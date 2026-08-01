import {
  classifyTwilioStatusTransition,
  type TwilioLifecycleClaim,
  type TwilioLifecycleStore,
  type TwilioMessageStatus,
  type TwilioWebhookEvent,
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

export const TWILIO_LIFECYCLE_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS absolute_twilio_message_status (
  message_sid text PRIMARY KEY,
  status text NOT NULL,
  updated_at_ms bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS absolute_twilio_webhook_events (
  event_id text PRIMARY KEY,
  message_sid text NOT NULL,
  payload jsonb NOT NULL,
  disposition text NOT NULL,
  claim_token text,
  claimed_until_ms bigint,
  completed_at_ms bigint,
  received_at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS absolute_twilio_webhook_claim_idx
  ON absolute_twilio_webhook_events (claimed_until_ms)
  WHERE completed_at_ms IS NULL;
`;

export const createPostgresTwilioLifecycleStore = (
  client: TwilioPostgresClient,
  options: { claimTtlMs?: number } = {},
): TwilioLifecycleStore => {
  const claimTtlMs = options.claimTtlMs ?? 60_000;
  if (!Number.isInteger(claimTtlMs) || claimTtlMs < 1_000) {
    throw new TypeError("claimTtlMs must be an integer of at least 1000");
  }

  const transaction = async <T>(run: () => Promise<T>) => {
    await client.query("BEGIN");
    try {
      const result = await run();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  };

  return {
    durability: "durable",
    begin: (event): Promise<TwilioLifecycleClaim> =>
      transaction(async () => {
        const now = Date.now();
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [event.eventId],
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
          [event.messageSid],
        );
        const existingResult = await client.query(
          "SELECT claim_token, claimed_until_ms, completed_at_ms FROM absolute_twilio_webhook_events WHERE event_id = $1 FOR UPDATE",
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
          Number(existing.claimed_until_ms) > now
        ) {
          return { disposition: "duplicate" };
        }

        let previousStatus: TwilioMessageStatus | undefined;
        let disposition: "accepted" | "duplicate" | "stale" = existing
          ? "duplicate"
          : "accepted";
        if (event.kind === "status") {
          const statusResult = await client.query(
            "SELECT status FROM absolute_twilio_message_status WHERE message_sid = $1 FOR UPDATE",
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
            `INSERT INTO absolute_twilio_webhook_events
              (event_id, message_sid, payload, disposition, completed_at_ms, received_at_ms)
             VALUES ($1, $2, $3::jsonb, 'stale', $4, $5)
             ON CONFLICT (event_id) DO UPDATE SET
               claim_token = NULL, claimed_until_ms = NULL,
               completed_at_ms = EXCLUDED.completed_at_ms,
               disposition = 'stale'`,
            [
              event.eventId,
              event.messageSid,
              JSON.stringify(event),
              now,
              event.receivedAt,
            ],
          );
          return {
            disposition,
            ...(previousStatus === undefined ? {} : { previousStatus }),
          };
        }

        const claimToken = crypto.randomUUID();
        await client.query(
          `INSERT INTO absolute_twilio_webhook_events
            (event_id, message_sid, payload, disposition, claim_token, claimed_until_ms, received_at_ms)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
           ON CONFLICT (event_id) DO UPDATE SET
             claim_token = EXCLUDED.claim_token,
             claimed_until_ms = EXCLUDED.claimed_until_ms,
             disposition = EXCLUDED.disposition`,
          [
            event.eventId,
            event.messageSid,
            JSON.stringify(event),
            disposition,
            claimToken,
            now + claimTtlMs,
            event.receivedAt,
          ],
        );
        if (event.kind === "status" && disposition === "accepted") {
          await client.query(
            `INSERT INTO absolute_twilio_message_status (message_sid, status, updated_at_ms)
             VALUES ($1, $2, $3)
             ON CONFLICT (message_sid) DO UPDATE SET
               status = EXCLUDED.status, updated_at_ms = EXCLUDED.updated_at_ms`,
            [event.messageSid, event.status, now],
          );
        }
        return {
          claimToken,
          disposition,
          ...(previousStatus === undefined ? {} : { previousStatus }),
        };
      }),
    complete: async (eventId, claimToken) => {
      const result = await client.query(
        `UPDATE absolute_twilio_webhook_events
         SET completed_at_ms = $3, claim_token = NULL, claimed_until_ms = NULL
         WHERE event_id = $1 AND claim_token = $2 AND completed_at_ms IS NULL
         RETURNING event_id`,
        [eventId, claimToken, Date.now()],
      );
      if (result.rows.length !== 1) {
        throw new Error("invalid Twilio lifecycle claim completion");
      }
    },
    release: async (eventId, claimToken) => {
      await client.query(
        `UPDATE absolute_twilio_webhook_events
         SET claim_token = NULL, claimed_until_ms = NULL
         WHERE event_id = $1 AND claim_token = $2 AND completed_at_ms IS NULL`,
        [eventId, claimToken],
      );
    },
  };
};
