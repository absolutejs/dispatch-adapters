import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreateInfobipAdapterOptions } from "./index";

export const manifest = defineManifest<CreateInfobipAdapterOptions>()({
  contract: 2,
  identity: {
    accent: "#FF5A1F",
    category: "messaging",
    description:
      "Infobip Messages API adapter for global carrier and conversational channels with request validation, durable webhook intake, and registration operations.",
    docsUrl:
      "https://github.com/absolutejs/dispatch-adapters/tree/main/infobip",
    name: "@absolutejs/dispatch-infobip",
    tagline: "Reach global customers across carrier and chat channels.",
  },
  implements: [
    defineImplementation<CreateInfobipAdapterOptions>()({
      contract: "dispatch/messaging-adapter",
      factory: "createInfobipAdapter",
      from: "@absolutejs/dispatch-infobip",
      requires: {
        env: [
          {
            description: "Infobip account-specific API hostname",
            key: "INFOBIP_BASE_URL",
            secret: false,
          },
          {
            description: "Least-privilege Infobip API key",
            key: "INFOBIP_API_KEY",
            secret: true,
          },
        ],
        peers: [],
      },
      settings: Type.Object({
        baseUrl: Type.String({ minLength: 1 }),
        validateBeforeSend: Type.Optional(Type.Boolean({ default: true })),
      }),
      title: "Infobip Messages API",
      wiring: {
        code: "createInfobipAdapter({ apiKey: process.env.INFOBIP_API_KEY, ...${settings} })",
        imports: [
          {
            from: "@absolutejs/dispatch-infobip",
            names: ["createInfobipAdapter"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
