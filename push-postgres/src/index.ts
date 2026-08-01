import type {
  PushFanoutClaimStore,
  PushSubscription,
  PushSubscriptionQuery,
  PushSubscriptionStore,
} from "@absolutejs/dispatch";
import {
  IDEMPOTENT_OPERATION_POSTGRES_SCHEMA,
  operationId,
  type IdempotentOperationStore,
  type TransactionRunner,
} from "@absolutejs/reliability";

export { IDEMPOTENT_OPERATION_POSTGRES_SCHEMA } from "@absolutejs/reliability";

export const PUSH_SUBSCRIPTION_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS absolute_push_subscriptions (
  tenant text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  device_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('apns', 'fcm')),
  token text NOT NULL,
  topics text[] NOT NULL DEFAULT '{}',
  locale text,
  enabled boolean NOT NULL,
  invalid_reason text,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  last_seen_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant, id),
  UNIQUE (tenant, platform, token)
);
CREATE UNIQUE INDEX IF NOT EXISTS absolute_push_subscriptions_device_identity_idx
  ON absolute_push_subscriptions (tenant, platform, device_id);
CREATE INDEX IF NOT EXISTS absolute_push_subscriptions_user_idx
  ON absolute_push_subscriptions (tenant, user_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS absolute_push_subscriptions_device_idx
  ON absolute_push_subscriptions (tenant, device_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS absolute_push_subscriptions_topics_idx
  ON absolute_push_subscriptions USING gin (topics) WHERE enabled;
`;

const fromRow = (row: Record<string, unknown>): PushSubscription => ({
  createdAt: Number(row.created_at_ms),
  deviceId: String(row.device_id),
  enabled: Boolean(row.enabled),
  id: String(row.id),
  lastSeenAt: Number(row.last_seen_at_ms),
  ...(row.locale ? { locale: String(row.locale) } : {}),
  platform: String(row.platform) as PushSubscription["platform"],
  tenant: String(row.tenant),
  token: String(row.token),
  topics: Array.isArray(row.topics) ? row.topics.map(String) : [],
  updatedAt: Number(row.updated_at_ms),
  userId: String(row.user_id),
});

export const createPostgresPushSubscriptionStore = (
  runner: TransactionRunner,
): PushSubscriptionStore => ({
  disable: async ({ id, reason, tenant }) => {
    await runner.transaction(async (client) => {
      await client.query(
        "UPDATE absolute_push_subscriptions SET enabled = false, invalid_reason = $3, updated_at_ms = $4 WHERE tenant = $1 AND id = $2",
        [tenant, id, reason, Date.now()],
      );
    });
  },
  list: (query: PushSubscriptionQuery) =>
    runner.transaction(async (client) => {
      const values: unknown[] = [query.tenant];
      const where = ["tenant = $1"];
      const add = (sql: string, value: unknown) => {
        values.push(value);
        where.push(sql.replace("?", `$${values.length}`));
      };
      if (query.ids) add("id = ANY(?::text[])", [...query.ids]);
      if (query.userId) add("user_id = ?", query.userId);
      if (query.deviceId) add("device_id = ?", query.deviceId);
      if (query.platform) add("platform = ?", query.platform);
      if (query.topic) add("? = ANY(topics)", query.topic);
      const found = await client.query(
        `SELECT tenant, id, user_id, device_id, platform, token, topics, locale, enabled, created_at_ms, updated_at_ms, last_seen_at_ms
       FROM absolute_push_subscriptions WHERE ${where.join(" AND ")} ORDER BY id`,
        values,
      );
      return found.rows.map(fromRow);
    }),
  remove: async ({ id, tenant }) => {
    await runner.transaction(async (client) => {
      await client.query(
        "DELETE FROM absolute_push_subscriptions WHERE tenant = $1 AND id = $2",
        [tenant, id],
      );
    });
  },
  upsert: (subscription) =>
    runner.transaction(async (client) => {
      const lockKeys = [
        `${subscription.tenant}:device:${subscription.platform}:${subscription.deviceId}`,
        `${subscription.tenant}:token:${subscription.platform}:${subscription.token}`,
      ].sort();
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0)), pg_advisory_xact_lock(hashtextextended($2, 0))",
        lockKeys,
      );
      const existing = await client.query(
        `SELECT tenant, id, user_id, device_id, platform, token, topics, locale,
           enabled, created_at_ms, updated_at_ms, last_seen_at_ms
         FROM absolute_push_subscriptions
         WHERE tenant = $1 AND platform = $2 AND (device_id = $3 OR token = $4)
         ORDER BY (device_id = $3) DESC, created_at_ms ASC FOR UPDATE`,
        [
          subscription.tenant,
          subscription.platform,
          subscription.deviceId,
          subscription.token,
        ],
      );
      const retained = existing.rows[0];
      if (retained) {
        const duplicateIds = existing.rows
          .slice(1)
          .map((row) => String(row.id));
        if (duplicateIds.length)
          await client.query(
            "DELETE FROM absolute_push_subscriptions WHERE tenant = $1 AND id = ANY($2::text[])",
            [subscription.tenant, duplicateIds],
          );
        const updated = await client.query(
          `UPDATE absolute_push_subscriptions SET
             user_id = $3, device_id = $4, platform = $5, token = $6,
             topics = $7::text[], locale = $8, enabled = true,
             invalid_reason = NULL, updated_at_ms = $9, last_seen_at_ms = $10
           WHERE tenant = $1 AND id = $2
           RETURNING tenant, id, user_id, device_id, platform, token, topics,
             locale, enabled, created_at_ms, updated_at_ms, last_seen_at_ms`,
          [
            subscription.tenant,
            retained.id,
            subscription.userId,
            subscription.deviceId,
            subscription.platform,
            subscription.token,
            [...subscription.topics],
            subscription.locale ?? null,
            subscription.updatedAt,
            subscription.lastSeenAt,
          ],
        );
        const row = updated.rows[0];
        if (!row)
          throw new Error("[dispatch-push-postgres] update returned no row");
        return fromRow(row);
      }
      const result = await client.query(
        `INSERT INTO absolute_push_subscriptions
        (tenant, id, user_id, device_id, platform, token, topics, locale, enabled, created_at_ms, updated_at_ms, last_seen_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, true, $9, $10, $11)
       RETURNING tenant, id, user_id, device_id, platform, token, topics, locale,
         enabled, created_at_ms, updated_at_ms, last_seen_at_ms`,
        [
          subscription.tenant,
          subscription.id,
          subscription.userId,
          subscription.deviceId,
          subscription.platform,
          subscription.token,
          [...subscription.topics],
          subscription.locale ?? null,
          subscription.createdAt,
          subscription.updatedAt,
          subscription.lastSeenAt,
        ],
      );
      const row = result.rows[0];
      if (!row)
        throw new Error("[dispatch-push-postgres] upsert returned no row");
      return fromRow(row);
    }),
});

export const createPostgresPushFanoutClaimStore = (
  store: IdempotentOperationStore<{ delivered: true }>,
  options: { leaseMs?: number } = {},
): PushFanoutClaimStore => {
  const leaseMs = options.leaseMs ?? 60_000;
  const scope = (key: string) => ({ key, namespace: "dispatch-push-fanout" });
  return {
    claim: async (key) => {
      const claim = await store.begin({
        fingerprint: key,
        leaseMs,
        scope: scope(key),
      });
      if (claim.disposition === "claimed") {
        await store.markExecuting(claim.operationId, claim.token);
        return { disposition: "claimed", token: claim.token };
      }
      if (claim.disposition === "completed")
        return { disposition: "completed" };
      if (
        claim.disposition === "indeterminate" ||
        claim.disposition === "conflict"
      )
        return { disposition: "indeterminate" };
      return { disposition: "in-flight" };
    },
    complete: (key, token) =>
      store.complete(operationId(scope(key)), token, { delivered: true }),
    fail: (key, token, reason) =>
      store.markIndeterminate(operationId(scope(key)), token, reason),
  };
};
