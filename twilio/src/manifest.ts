import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreateTwilioAdapterOptions } from "./index";

export const manifest = defineManifest<CreateTwilioAdapterOptions>()({
  contract: 2,
  identity: {
    accent: "#f22f46",
    category: "messaging",
    description:
      "Production Twilio SMS, MMS, RCS, and WhatsApp for `@absolutejs/dispatch`, with signed webhooks, consent integration, registration automation, and readiness checks.",
    docsUrl: "https://github.com/absolutejs/dispatch-adapters/tree/main/twilio",
    name: "@absolutejs/dispatch-twilio",
    tagline: "Run compliant messaging programs with Twilio.",
  },
  implements: [
    defineImplementation<CreateTwilioAdapterOptions>()({
      contract: "dispatch/messaging-adapter",
      factory: "createTwilioAdapter",
      from: "@absolutejs/dispatch-twilio",
      requires: {
        env: [
          {
            description: "Twilio account SID",
            docsUrl: "https://console.twilio.com",
            example: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            key: "TWILIO_ACCOUNT_SID",
            secret: true,
          },
          {
            description: "Twilio auth token",
            docsUrl: "https://console.twilio.com",
            key: "TWILIO_AUTH_TOKEN",
            secret: true,
          },
        ],
        peers: [
          {
            name: "twilio",
            range: ">=5.0.0 <7",
            reason: "Twilio SDK client",
          },
        ],
      },
      settings: Type.Object({
        messagingServiceSid: Type.String({
          description:
            "Twilio Messaging Service used for sender routing and opt-out management.",
          example: "MG0123456789abcdef0123456789abcdef",
          title: "Messaging Service SID",
        }),
        statusCallbackUrl: Type.String({
          description:
            "Public HTTPS endpoint handled by createTwilioWebhookHandler.",
          example: "https://example.com/webhooks/twilio/messaging",
          title: "Status callback URL",
        }),
        smartEncoded: Type.Optional(
          Type.Boolean({
            description: "Replace compatible Unicode characters with GSM-7.",
            title: "Smart encoding",
          }),
        ),
        validityPeriod: Type.Optional(
          Type.Integer({
            description: "Maximum send retry window in seconds (1–36000).",
            maximum: 36000,
            minimum: 1,
            title: "Validity period",
          }),
        ),
      }),
      title: "Twilio",
      wiring: {
        code: "createTwilioAdapter({ accountSid: ${env.TWILIO_ACCOUNT_SID}, client: new Twilio(${env.TWILIO_ACCOUNT_SID}, ${env.TWILIO_AUTH_TOKEN}), ...${settings} })",
        imports: [
          {
            from: "@absolutejs/dispatch-twilio",
            names: ["createTwilioAdapter"],
          },
          { from: "twilio", names: ["Twilio"] },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
