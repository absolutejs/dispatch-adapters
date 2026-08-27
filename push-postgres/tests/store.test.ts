import { describe, expect, test } from "bun:test";
import { createMemoryIdempotentOperationStore } from "@absolutejs/reliability";
import {
  PUSH_SUBSCRIPTION_POSTGRES_SCHEMA,
  createPostgresPushFanoutClaimStore,
  createPostgresPushSubscriptionStore,
} from "../src";

describe("push PostgreSQL stores", () => {
  test("uses fenced durable fanout claims", async () => {
    const store = createPostgresPushFanoutClaimStore(
      createMemoryIdempotentOperationStore<{ delivered: true }>(),
    );
    const first = await store.claim("tenant:key:subscription");
    expect(first.disposition).toBe("claimed");
    expect((await store.claim("tenant:key:subscription")).disposition).toBe(
      "in-flight",
    );
    if (first.disposition !== "claimed") throw new Error("claim missing");
    await store.complete("tenant:key:subscription", first.token);
    expect((await store.claim("tenant:key:subscription")).disposition).toBe(
      "completed",
    );
  });

  test("marks ambiguous sends indeterminate", async () => {
    const store = createPostgresPushFanoutClaimStore(
      createMemoryIdempotentOperationStore<{ delivered: true }>(),
    );
    const claim = await store.claim("tenant:key:subscription");
    if (claim.disposition !== "claimed") throw new Error("claim missing");
    await store.fail("tenant:key:subscription", claim.token, "timeout");
    expect((await store.claim("tenant:key:subscription")).disposition).toBe(
      "indeterminate",
    );
  });

  test("parameterizes tenant and topic queries", async () => {
    const calls: Array<{ text: string; values?: ReadonlyArray<unknown> }> = [];
    const store = createPostgresPushSubscriptionStore({
      transaction: async (run) =>
        run({
          query: async (text, values) => {
            calls.push({ text, values });
            return { rows: [] };
          },
        }),
    });
    await store.list({
      tenant: "tenant-a",
      topic: "incidents",
      userId: "alex",
    });
    expect(calls[0]?.text).toContain("user_id = $2");
    expect(calls[0]?.text).toContain("$3 = ANY(topics)");
    expect(calls[0]?.values).toEqual(["tenant-a", "alex", "incidents"]);
  });

  test("documents atomic token rotation by stable device identity", () => {
    expect(PUSH_SUBSCRIPTION_POSTGRES_SCHEMA).toContain(
      "(tenant, platform, device_id)",
    );
    expect(PUSH_SUBSCRIPTION_POSTGRES_SCHEMA).toContain(
      "absolute_push_subscriptions_credential_identity_idx",
    );
    expect(PUSH_SUBSCRIPTION_POSTGRES_SCHEMA).toContain("platform = 'webpush'");
    expect(PUSH_SUBSCRIPTION_POSTGRES_SCHEMA).toContain(
      "SET credential_key = token",
    );
  });

  test("persists structured Web Push credentials without token flattening", async () => {
    const calls: Array<{ text: string; values?: ReadonlyArray<unknown> }> = [];
    const subscription = {
      createdAt: 1,
      deviceId: "web-installation",
      enabled: true,
      id: "subscription-1",
      lastSeenAt: 3,
      platform: "webpush" as const,
      subscription: {
        endpoint: "https://push.example/subscription-1",
        keys: { auth: "auth-key", p256dh: "p256dh-key" },
      },
      tenant: "tenant-a",
      topics: ["incidents"],
      updatedAt: 2,
      userId: "user-1",
    };
    const store = createPostgresPushSubscriptionStore({
      transaction: async (run) =>
        run({
          query: async (text, values) => {
            calls.push({ text, values });
            if (text.includes("RETURNING"))
              return {
                rows: [
                  {
                    created_at_ms: 1,
                    device_id: subscription.deviceId,
                    enabled: true,
                    id: subscription.id,
                    last_seen_at_ms: 3,
                    platform: "webpush",
                    tenant: subscription.tenant,
                    topics: subscription.topics,
                    updated_at_ms: 2,
                    user_id: subscription.userId,
                    web_push_subscription: subscription.subscription,
                  },
                ],
              };
            return { rows: [] };
          },
        }),
    });

    expect(await store.upsert(subscription)).toEqual(subscription);
    const insert = calls.find((call) => call.text.includes("INSERT INTO"));
    expect(insert?.text).toContain("web_push_subscription");
    expect(insert?.text).toContain("credential_key");
    expect(insert?.values).toContain(null);
    expect(insert?.values).toContain(subscription.subscription.endpoint);
    expect(insert?.values).toContain(JSON.stringify(subscription.subscription));
  });
});
