import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreateResendAdapterOptions } from "./index";

export const manifest = defineManifest<CreateResendAdapterOptions>()({
  contract: 2,
  discovery: {
    audiences: ["agent-hosts", "application-developers"],
    intents: ["send transactional email", "execute installed email effects"],
    keywords: ["email", "resend", "idempotency", "effect-adapter"],
    protocols: ["HTTPS"],
  },
  identity: {
    accent: "#111827",
    category: "messaging",
    description:
      "Resend-backed EmailAdapter and credential-safe installed effect driver with stable provider idempotency.",
    docsUrl: "https://github.com/absolutejs/dispatch-adapters/tree/main/resend",
    name: "@absolutejs/dispatch-resend",
    tagline: "Deliver your site’s email with Resend.",
  },
  implements: [
    defineImplementation<CreateResendAdapterOptions>()({
      contract: "dispatch/email-adapter",
      factory: "createResendAdapter",
      from: "@absolutejs/dispatch-resend",
      requires: {
        env: [
          {
            description: "Resend API key",
            docsUrl: "https://resend.com/api-keys",
            example: "re_xxxxxxxxx",
            key: "RESEND_KEY",
            secret: true,
          },
        ],
        peers: [
          {
            name: "resend",
            range: "^4.0.0",
            reason: "Resend SDK client",
          },
        ],
      },
      settings: Type.Object({
        defaultFrom: Type.Optional(
          Type.String({
            description:
              "Used when a message doesn’t name a sender. Resend requires a verified sender.",
            examples: ["hello@yoursite.com"],
            format: "email",
            title: "Default sender",
          }),
        ),
      }),
      title: "Resend",
      wiring: {
        code: "createResendAdapter({ client: new Resend(${env.RESEND_KEY}), ...${settings} })",
        imports: [
          {
            from: "@absolutejs/dispatch-resend",
            names: ["createResendAdapter"],
          },
          { from: "resend", names: ["Resend"] },
        ],
      },
    }),
    defineImplementation<Record<string, never>>()({
      contract: "execution/effect-adapter-driver",
      factory: "createResendEffectAdapterDriver",
      from: "@absolutejs/dispatch-resend",
      requires: {
        peers: [
          {
            name: "@absolutejs/execution",
            range: "^0.6.1",
            reason: "Credential-safe installed effect execution",
          },
          {
            name: "resend",
            range: ">=4.0.0",
            reason: "Resend SDK client",
          },
        ],
      },
      settings: Type.Object({}),
      title: "Resend installed effect driver",
      wiring: {
        code: "createResendEffectAdapterDriver((apiKey) => new Resend(apiKey))",
        imports: [
          {
            from: "@absolutejs/dispatch-resend",
            names: ["createResendEffectAdapterDriver"],
          },
          { from: "resend", names: ["Resend"] },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
