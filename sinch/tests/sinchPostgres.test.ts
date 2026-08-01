import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import {
  createPostgresIdempotentOperationStore,
  createPostgresTransactionRunner,
  createPostgresWebhookInboxStore,
  IDEMPOTENT_OPERATION_POSTGRES_SCHEMA,
  WEBHOOK_INBOX_POSTGRES_SCHEMA,
} from "../src";

const url = process.env.SINCH_TEST_POSTGRES_URL;
const suite = url === undefined ? describe.skip : describe;

suite("real PostgreSQL Sinch reliability contention", () => {
  const pool = new Pool({ connectionString: url, max: 32 });
  const runner = createPostgresTransactionRunner(pool);

  beforeAll(async () => {
    await pool.query(IDEMPOTENT_OPERATION_POSTGRES_SCHEMA);
    await pool.query(WEBHOOK_INBOX_POSTGRES_SCHEMA);
    await pool.query(
      "TRUNCATE absolute_idempotent_operations, absolute_webhook_inbox",
    );
  });

  afterAll(async () => pool.end());

  test("grants exactly one provider/project/tenant send claim", async () => {
    const store = createPostgresIdempotentOperationStore(runner);
    const claims = await Promise.all(
      Array.from({ length: 32 }, () =>
        store.begin({
          fingerprint: "payload-1",
          leaseMs: 60_000,
          now: Date.now(),
          scope: {
            account: "project-1",
            key: "incident-1",
            namespace: "dispatch.send",
            provider: "sinch",
            tenant: "tenant-1",
          },
        }),
      ),
    );
    expect(
      claims.filter(({ disposition }) => disposition === "claimed"),
    ).toHaveLength(1);
    expect(
      claims.filter(({ disposition }) => disposition === "in-flight"),
    ).toHaveLength(31);
  });

  test("atomically accepts one signed callback", async () => {
    const store = createPostgresWebhookInboxStore(runner);
    const event = {
      eventId: "sinch:nonce-1",
      occurredAt: Date.now(),
      payload: { status: "DELIVERED" },
      provider: "sinch",
      streamId: "project-1:app-1",
    };
    const claims = await Promise.all(
      Array.from({ length: 32 }, () =>
        store.accept(event, { leaseMs: 60_000, now: Date.now() }),
      ),
    );
    expect(
      claims.filter(({ disposition }) => disposition === "accepted"),
    ).toHaveLength(1);
    expect(claims.filter(({ token }) => token !== undefined)).toHaveLength(1);
  });
});
