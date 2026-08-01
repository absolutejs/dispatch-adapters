import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

type SinchManifestSettings = {
  conversationRegion: "br" | "eu" | "us";
};

export const manifest = defineManifest<SinchManifestSettings>()({
  contract: 2,
  identity: {
    accent: "#ff5a10",
    category: "messaging",
    description:
      "Production Sinch Conversation API adapter with multichannel priority fallback, signed durable webhooks, consent, readiness, capabilities, and 10DLC workflows.",
    docsUrl: "https://github.com/absolutejs/dispatch-adapters/tree/main/sinch",
    name: "@absolutejs/dispatch-sinch",
    tagline: "Run resilient omnichannel messaging with Sinch.",
  },
  implements: [
    defineImplementation<SinchManifestSettings>()({
      contract: "dispatch/messaging-adapter",
      factory: "createSinchAdapter",
      from: "@absolutejs/dispatch-sinch",
      requires: {
        env: [
          { description: "Sinch project id", key: "SINCH_PROJECT_ID" },
          {
            description: "Sinch access key id",
            key: "SINCH_KEY_ID",
            secret: true,
          },
          {
            description: "Sinch access key secret",
            key: "SINCH_KEY_SECRET",
            secret: true,
          },
          { description: "Sinch Conversation app id", key: "SINCH_APP_ID" },
        ],
        peers: [
          {
            name: "@sinch/sdk-core",
            range: ">=1.5.0 <2",
            reason: "Official Sinch Node SDK",
          },
        ],
      },
      settings: Type.Object({
        conversationRegion: Type.Union(
          [Type.Literal("us"), Type.Literal("eu"), Type.Literal("br")],
          {
            description:
              "Conversation API region where the Sinch app was created.",
            title: "Conversation region",
          },
        ),
      }),
      title: "Sinch",
      wiring: {
        code: "createSinchAdapter({ appId: ${env.SINCH_APP_ID}, projectId: ${env.SINCH_PROJECT_ID}, client: new SinchClient({ projectId: ${env.SINCH_PROJECT_ID}, keyId: ${env.SINCH_KEY_ID}, keySecret: ${env.SINCH_KEY_SECRET}, conversationRegion: ${settings.conversationRegion} }) })",
        imports: [
          { from: "@absolutejs/dispatch-sinch", names: ["createSinchAdapter"] },
          { from: "@sinch/sdk-core", names: ["SinchClient"] },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
