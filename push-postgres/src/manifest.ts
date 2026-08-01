import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

export const manifest = defineManifest<Record<string, never>>()({
  contract: 2,
  identity: {
    accent: "#336791",
    category: "messaging",
    description:
      "PostgreSQL-backed push device registry and fenced fanout idempotency for @absolutejs/dispatch.",
    docsUrl:
      "https://github.com/absolutejs/dispatch-adapters/tree/main/push-postgres",
    name: "@absolutejs/dispatch-push-postgres",
    tagline: "Persist push devices and retry-safe fanout.",
  },
  implements: [
    defineImplementation<Record<string, never>>()({
      contract: "dispatch/push-subscription-store",
      factory: "createPostgresPushSubscriptionStore",
      from: "@absolutejs/dispatch-push-postgres",
      requires: {
        env: [
          {
            description: "PostgreSQL connection string",
            key: "DATABASE_URL",
            secret: true,
          },
        ],
        peers: [],
      },
      settings: Type.Object({}),
      title: "PostgreSQL push subscriptions",
      wiring: {
        code: "createPostgresPushSubscriptionStore(transactionRunner)",
        imports: [
          {
            from: "@absolutejs/dispatch-push-postgres",
            names: ["createPostgresPushSubscriptionStore"],
          },
        ],
      },
    }),
    defineImplementation<Record<string, never>>()({
      contract: "dispatch/push-fanout-claim-store",
      factory: "createPostgresPushFanoutClaimStore",
      from: "@absolutejs/dispatch-push-postgres",
      requires: { env: [], peers: [] },
      settings: Type.Object({}),
      title: "PostgreSQL push fanout claims",
      wiring: {
        code: "createPostgresPushFanoutClaimStore(idempotencyStore)",
        imports: [
          {
            from: "@absolutejs/dispatch-push-postgres",
            names: ["createPostgresPushFanoutClaimStore"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
