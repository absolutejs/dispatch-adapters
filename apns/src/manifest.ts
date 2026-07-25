import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreateApnsAdapterOptions } from "./index";

export const manifest = defineManifest<CreateApnsAdapterOptions>()({
  contract: 2,
  identity: {
    accent: "#111827",
    category: "messaging",
    description:
      "Apple Push Notification service HTTP/2 PushAdapter with ES256 provider-token rotation.",
    docsUrl: "https://github.com/absolutejs/dispatch-adapters/tree/main/apns",
    name: "@absolutejs/dispatch-apns",
    tagline: "Deliver native Apple push through APNs.",
  },
  implements: [
    defineImplementation<CreateApnsAdapterOptions>()({
      contract: "dispatch/push-adapter",
      factory: "createApnsAdapter",
      from: "@absolutejs/dispatch-apns",
      requires: {
        env: [
          {
            description: "Apple developer team id",
            key: "APNS_TEAM_ID",
            secret: false,
          },
          {
            description: "APNs signing key id",
            key: "APNS_KEY_ID",
            secret: false,
          },
          {
            description: "APNs ES256 .p8 private signing key",
            key: "APNS_PRIVATE_KEY",
            secret: true,
          },
          {
            description: "Application bundle identifier / APNs topic",
            key: "APNS_BUNDLE_ID",
            secret: false,
          },
        ],
        peers: [],
      },
      settings: Type.Object({
        environment: Type.Optional(
          Type.Union([Type.Literal("production"), Type.Literal("sandbox")]),
        ),
      }),
      title: "Apple Push Notification service",
      wiring: {
        code: "createApnsAdapter({ bundleId: ${env.APNS_BUNDLE_ID}, keyId: ${env.APNS_KEY_ID}, privateKey: ${env.APNS_PRIVATE_KEY}, teamId: ${env.APNS_TEAM_ID}, ...${settings} })",
        imports: [
          { from: "@absolutejs/dispatch-apns", names: ["createApnsAdapter"] },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
