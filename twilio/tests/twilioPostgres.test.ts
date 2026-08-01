import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import {
  createPostgresTwilioEventStreamStore,
  createPostgresTwilioIdempotencyStore,
  createPostgresTwilioLifecycleStore,
  fingerprintTwilioPayload,
  TWILIO_EVENT_STREAM_POSTGRES_SCHEMA,
  TWILIO_IDEMPOTENCY_POSTGRES_SCHEMA,
  TWILIO_LIFECYCLE_POSTGRES_SCHEMA,
  type TwilioCloudEvent,
  type TwilioPostgresPool,
} from "../src";

const connectionString = process.env.TWILIO_TEST_POSTGRES_URL;
const run = connectionString === undefined ? describe.skip : describe;

run("real PostgreSQL concurrency", () => {
  const pool = new Pool({ connectionString, max: 8 });
  const postgres = pool as unknown as TwilioPostgresPool;

  beforeAll(async () => {
    await pool.query(TWILIO_IDEMPOTENCY_POSTGRES_SCHEMA);
    await pool.query(TWILIO_LIFECYCLE_POSTGRES_SCHEMA);
    await pool.query(TWILIO_EVENT_STREAM_POSTGRES_SCHEMA);
    await pool.query(
      "TRUNCATE absolute_twilio_send_idempotency_v2, absolute_twilio_webhook_events_v2, absolute_twilio_message_status_v2, absolute_twilio_event_stream_inbox",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  test("grants exactly one account-scoped outbound claim", async () => {
    const store = createPostgresTwilioIdempotencyStore(postgres);
    const scope = {
      accountSid: `AC${"1".repeat(32)}`,
      key: "incident-42:opened",
      tenant: "tenant-a",
    };
    const fingerprint = fingerprintTwilioPayload({
      body: "alert",
      to: "+12025550100",
    });
    const claims = await Promise.all(
      Array.from({ length: 32 }, () => store.begin(scope, fingerprint)),
    );
    expect(
      claims.filter(({ disposition }) => disposition === "claimed"),
    ).toHaveLength(1);
    expect(
      claims.filter(({ disposition }) => disposition === "in-flight"),
    ).toHaveLength(31);
  });

  test("deduplicates lifecycle work across checked-out transactions", async () => {
    const store = createPostgresTwilioLifecycleStore(postgres);
    const event = {
      actualTransport: "sms" as const,
      errors: [],
      eventId: `delivery:SM${"2".repeat(32)}:delivered:`,
      kind: "delivery" as const,
      messageId: `SM${"2".repeat(32)}`,
      occurredAt: Date.now(),
      provider: "twilio" as const,
      providerAccountId: `AC${"1".repeat(32)}`,
      providerData: {},
      providerStatus: "delivered" as const,
      status: "delivered" as const,
    };
    const claims = await Promise.all(
      Array.from({ length: 32 }, () => store.begin(event)),
    );
    expect(
      claims.filter(({ claimToken }) => claimToken !== undefined),
    ).toHaveLength(1);
    expect(
      claims.filter(({ disposition }) => disposition === "accepted"),
    ).toHaveLength(1);
  });

  test("atomically accepts one Event Streams delivery", async () => {
    const store = createPostgresTwilioEventStreamStore(postgres);
    const event: TwilioCloudEvent = {
      data: {},
      id: `EZ${"3".repeat(32)}`,
      source: "twilio.messaging",
      specversion: "1.0",
      time: new Date().toISOString(),
      type: "com.twilio.messaging.message.delivered",
    };
    const claims = await Promise.all(
      Array.from({ length: 32 }, () => store.begin(event)),
    );
    expect(
      claims.filter(({ claimToken }) => claimToken !== undefined),
    ).toHaveLength(1);
    expect(
      claims.filter(({ disposition }) => disposition === "accepted"),
    ).toHaveLength(1);
  });
});
