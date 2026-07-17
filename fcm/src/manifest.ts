import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreateFcmAdapterOptions } from "./index";

export const manifest = defineManifest<CreateFcmAdapterOptions>()({
  contract: 1,
  identity: {
    accent: "#F59E0B",
    category: "messaging",
    description:
      "Firebase Cloud Messaging HTTP v1 PushAdapter with Application Default Credentials and short-lived OAuth tokens.",
    docsUrl: "https://github.com/absolutejs/dispatch-adapters/tree/main/fcm",
    name: "@absolutejs/dispatch-fcm",
    tagline: "Deliver Android and web push through FCM.",
  },
  implements: [
    defineImplementation<CreateFcmAdapterOptions>()({
      contract: "dispatch/push-adapter",
      factory: "createFcmAdapter",
      from: "@absolutejs/dispatch-fcm",
      requires: {
        env: [
          {
            description: "Firebase target project id",
            example: "my-app-production",
            key: "FCM_PROJECT_ID",
            secret: false,
          },
          {
            description:
              "Path to a service-account JSON file when workload identity is unavailable",
            key: "GOOGLE_APPLICATION_CREDENTIALS",
            secret: true,
          },
        ],
        peers: [
          {
            name: "google-auth-library",
            range: "^10.0.0",
            reason: "Application Default Credentials and OAuth token rotation",
          },
        ],
      },
      settings: Type.Object({
        projectId: Type.String({
          description: "Firebase project that owns the target registrations.",
          minLength: 1,
          title: "Firebase project id",
        }),
      }),
      title: "Firebase Cloud Messaging",
      wiring: {
        code: "createFcmAdapter({ projectId: ${settings.projectId} })",
        imports: [
          { from: "@absolutejs/dispatch-fcm", names: ["createFcmAdapter"] },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
