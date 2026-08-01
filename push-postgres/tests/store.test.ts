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
  });
});
