import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreateVonageAdapterOptions } from "./adapter";

export const manifest = defineManifest<CreateVonageAdapterOptions>()({
  contract: 2,
  identity: {
    accent: "#7b3fe4",
    category: "messaging",
    description:
      "Production Vonage Messages API adapter with SMS, MMS, RCS, WhatsApp, Viber, Messenger, ordered failover, signed durable webhooks, consent, and readiness.",
    docsUrl: "https://github.com/absolutejs/dispatch-adapters/tree/main/vonage",
    name: "@absolutejs/dispatch-vonage",
    tagline: "Run resilient multichannel messaging with Vonage.",
  },
  implements: [
    defineImplementation<CreateVonageAdapterOptions>()({
      contract: "dispatch/messaging-adapter",
      factory: "createVonageAdapter",
      from: "@absolutejs/dispatch-vonage",
      requires: {
        env: [
          {
            description: "Vonage API key",
            docsUrl: "https://dashboard.nexmo.com/settings",
            key: "VONAGE_API_KEY",
            secret: true,
          },
          {
            description: "Vonage application id used for JWT authentication",
            docsUrl: "https://dashboard.nexmo.com/applications",
            key: "VONAGE_APPLICATION_ID",
          },
          {
            description: "Vonage application private key",
            docsUrl: "https://dashboard.nexmo.com/applications",
            key: "VONAGE_PRIVATE_KEY",
            secret: true,
          },
        ],
        peers: [
          {
            name: "@vonage/server-sdk",
            range: ">=3.29.0 <4",
            reason: "Official Vonage SDK client",
          },
        ],
      },
      settings: Type.Object({
        webhookUrl: Type.String({
          description:
            "Public HTTPS URL handled by createVonageWebhookHandler.",
          format: "uri",
          title: "Webhook URL",
        }),
      }),
      title: "Vonage",
      wiring: {
        code: "createVonageAdapter({ apiKey: ${env.VONAGE_API_KEY}, applicationId: ${env.VONAGE_APPLICATION_ID}, client: new Vonage({ applicationId: ${env.VONAGE_APPLICATION_ID}, privateKey: ${env.VONAGE_PRIVATE_KEY} }), ...${settings} })",
        imports: [
          {
            from: "@absolutejs/dispatch-vonage",
            names: ["createVonageAdapter"],
          },
          { from: "@vonage/server-sdk", names: ["Vonage"] },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
