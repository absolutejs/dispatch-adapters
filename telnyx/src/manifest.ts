import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreateTelnyxAdapterOptions } from "./adapter";

export const manifest = defineManifest<CreateTelnyxAdapterOptions>()({
  contract: 2,
  identity: {
    accent: "#00e3aa",
    category: "messaging",
    description:
      "Production Telnyx SMS, MMS, and direct rich RCS for `@absolutejs/dispatch`, with signed webhooks, durable recovery, registration automation, and readiness checks.",
    docsUrl: "https://github.com/absolutejs/dispatch-adapters/tree/main/telnyx",
    name: "@absolutejs/dispatch-telnyx",
    tagline: "Run reliable carrier and rich messaging with Telnyx.",
  },
  implements: [
    defineImplementation<CreateTelnyxAdapterOptions>()({
      contract: "dispatch/messaging-adapter",
      factory: "createTelnyxAdapter",
      from: "@absolutejs/dispatch-telnyx",
      requires: {
        env: [
          {
            description: "Telnyx API key",
            docsUrl: "https://portal.telnyx.com/#/app/api-keys",
            key: "TELNYX_API_KEY",
            secret: true,
          },
          {
            description:
              "Telnyx organization id used for tenant and webhook isolation",
            docsUrl: "https://portal.telnyx.com",
            key: "TELNYX_ORGANIZATION_ID",
          },
        ],
        peers: [
          {
            name: "telnyx",
            range: ">=7.0.0 <8",
            reason: "Official Telnyx SDK client",
          },
        ],
      },
      settings: Type.Object({
        messagingProfileId: Type.String({
          description:
            "Telnyx Messaging Profile used for routing and webhooks.",
          format: "uuid",
          title: "Messaging Profile ID",
        }),
        rcsAgentId: Type.Optional(
          Type.String({
            description: "Approved Telnyx RCS Agent id.",
            title: "RCS Agent ID",
          }),
        ),
        webhookFailoverUrl: Type.Optional(
          Type.String({ format: "uri", title: "Webhook failover URL" }),
        ),
        webhookUrl: Type.String({
          description:
            "Public HTTPS endpoint handled by createTelnyxWebhookHandler.",
          format: "uri",
          title: "Messaging webhook URL",
        }),
      }),
      title: "Telnyx",
      wiring: {
        code: "createTelnyxAdapter({ accountId: ${env.TELNYX_ORGANIZATION_ID}, client: new Telnyx({ apiKey: ${env.TELNYX_API_KEY} }), ...${settings} })",
        imports: [
          {
            from: "@absolutejs/dispatch-telnyx",
            names: ["createTelnyxAdapter"],
          },
          { from: "telnyx", names: ["Telnyx"] },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
