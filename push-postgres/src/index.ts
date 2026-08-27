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
  platform text NOT NULL,
  token text,
  web_push_subscription jsonb,
  credential_key text NOT NULL,
  topics text[] NOT NULL DEFAULT '{}',
  locale text,
  enabled boolean NOT NULL,
  invalid_reason text,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  last_seen_at_ms bigint NOT NULL,
  PRIMARY KEY (tenant, id)
);
ALTER TABLE absolute_push_subscriptions
  ADD COLUMN IF NOT EXISTS web_push_subscription jsonb;
ALTER TABLE absolute_push_subscriptions
  ADD COLUMN IF NOT EXISTS credential_key text;
UPDATE absolute_push_subscriptions
  SET credential_key = token
  WHERE credential_key IS NULL AND token IS NOT NULL;
ALTER TABLE absolute_push_subscriptions ALTER COLUMN token DROP NOT NULL;
ALTER TABLE absolute_push_subscriptions
  DROP CONSTRAINT IF EXISTS absolute_push_subscriptions_platform_check;
ALTER TABLE absolute_push_subscriptions
  DROP CONSTRAINT IF EXISTS absolute_push_subscriptions_tenant_platform_token_key;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'absolute_push_subscriptions_credential_check'
      AND conrelid = 'absolute_push_subscriptions'::regclass
  ) THEN
    ALTER TABLE absolute_push_subscriptions
      ADD CONSTRAINT absolute_push_subscriptions_credential_check CHECK (
        (
          platform IN ('apns', 'fcm') AND token IS NOT NULL
          AND web_push_subscription IS NULL AND credential_key = token
        ) OR (
          platform = 'webpush' AND token IS NULL
          AND jsonb_typeof(web_push_subscription) = 'object'
          AND jsonb_typeof(web_push_subscription->'keys') = 'object'
          AND credential_key = web_push_subscription->>'endpoint'
          AND length(web_push_subscription->>'endpoint') > 0
          AND length(web_push_subscription->'keys'->>'auth') > 0
          AND length(web_push_subscription->'keys'->>'p256dh') > 0
        )
      );
  END IF;
END $$;
ALTER TABLE absolute_push_subscriptions ALTER COLUMN credential_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS absolute_push_subscriptions_credential_identity_idx
  ON absolute_push_subscriptions (tenant, platform, credential_key);
CREATE UNIQUE INDEX IF NOT EXISTS absolute_push_subscriptions_device_identity_idx
  ON absolute_push_subscriptions (tenant, platform, device_id);
CREATE INDEX IF NOT EXISTS absolute_push_subscriptions_user_idx
  ON absolute_push_subscriptions (tenant, user_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS absolute_push_subscriptions_device_idx
  ON absolute_push_subscriptions (tenant, device_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS absolute_push_subscriptions_topics_idx
  ON absolute_push_subscriptions USING gin (topics) WHERE enabled;
`;

const subscriptionBase = (row: Record<string, unknown>) => ({
  createdAt: Number(row.created_at_ms),
  deviceId: String(row.device_id),
  enabled: Boolean(row.enabled),
  id: String(row.id),
  lastSeenAt: Number(row.last_seen_at_ms),
  ...(row.locale ? { locale: String(row.locale) } : {}),
  tenant: String(row.tenant),
  topics: Array.isArray(row.topics) ? row.topics.map(String) : [],
  updatedAt: Number(row.updated_at_ms),
  userId: String(row.user_id),
});

const fromRow = (row: Record<string, unknown>): PushSubscription => {
  const platform = String(row.platform);
  if (platform === "webpush") {
    const value = row.web_push_subscription;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("[dispatch-push-postgres] invalid Web Push credential");
    const endpoint = Reflect.get(value, "endpoint");
    const keys = Reflect.get(value, "keys");
    const auth =
      typeof keys === "object" && keys !== null
        ? Reflect.get(keys, "auth")
        : null;
    const p256dh =
      typeof keys === "object" && keys !== null
        ? Reflect.get(keys, "p256dh")
        : null;
    if (
      typeof endpoint !== "string" ||
      typeof auth !== "string" ||
      typeof p256dh !== "string"
    )
      throw new Error("[dispatch-push-postgres] invalid Web Push credential");
    return {
      ...subscriptionBase(row),
      platform,
      subscription: { endpoint, keys: { auth, p256dh } },
    };
  }
  if (platform !== "apns" && platform !== "fcm")
    throw new Error("[dispatch-push-postgres] invalid push platform");
  if (typeof row.token !== "string")
    throw new Error("[dispatch-push-postgres] invalid native push token");
  return { ...subscriptionBase(row), platform, token: row.token };
};

const credentialColumns = (subscription: PushSubscription) =>
  subscription.platform === "webpush"
    ? {
        credentialKey: subscription.subscription.endpoint,
        token: null,
        webPushSubscription: JSON.stringify(subscription.subscription),
      }
    : {
        credentialKey: subscription.token,
        token: subscription.token,
        webPushSubscription: null,
      };

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
        `SELECT tenant, id, user_id, device_id, platform, token, web_push_subscription, topics, locale, enabled, created_at_ms, updated_at_ms, last_seen_at_ms
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
      const credential = credentialColumns(subscription);
      const lockKeys = [
        `${subscription.tenant}:device:${subscription.platform}:${subscription.deviceId}`,
        `${subscription.tenant}:credential:${subscription.platform}:${credential.credentialKey}`,
      ].sort();
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0)), pg_advisory_xact_lock(hashtextextended($2, 0))",
        lockKeys,
      );
      const existing = await client.query(
        `SELECT tenant, id, user_id, device_id, platform, token, web_push_subscription, credential_key, topics, locale,
           enabled, created_at_ms, updated_at_ms, last_seen_at_ms
         FROM absolute_push_subscriptions
         WHERE tenant = $1 AND platform = $2 AND (device_id = $3 OR credential_key = $4)
         ORDER BY (device_id = $3) DESC, created_at_ms ASC FOR UPDATE`,
        [
          subscription.tenant,
          subscription.platform,
          subscription.deviceId,
          credential.credentialKey,
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
             web_push_subscription = $7::jsonb, credential_key = $8,
             topics = $9::text[], locale = $10, enabled = true,
             invalid_reason = NULL, updated_at_ms = $11, last_seen_at_ms = $12
           WHERE tenant = $1 AND id = $2
           RETURNING tenant, id, user_id, device_id, platform, token, web_push_subscription, topics,
             locale, enabled, created_at_ms, updated_at_ms, last_seen_at_ms`,
          [
            subscription.tenant,
            retained.id,
            subscription.userId,
            subscription.deviceId,
            subscription.platform,
            credential.token,
            credential.webPushSubscription,
            credential.credentialKey,
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
        (tenant, id, user_id, device_id, platform, token, web_push_subscription, credential_key, topics, locale, enabled, created_at_ms, updated_at_ms, last_seen_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::text[], $10, true, $11, $12, $13)
       RETURNING tenant, id, user_id, device_id, platform, token, web_push_subscription, topics, locale,
         enabled, created_at_ms, updated_at_ms, last_seen_at_ms`,
        [
          subscription.tenant,
          subscription.id,
          subscription.userId,
          subscription.deviceId,
          subscription.platform,
          credential.token,
          credential.webPushSubscription,
          credential.credentialKey,
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
