import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreateAwsEndUserMessagingAdapterOptions } from "./index";

export const manifest =
  defineManifest<CreateAwsEndUserMessagingAdapterOptions>()({
    contract: 2,
    identity: {
      accent: "#FF9900",
      category: "messaging",
      description:
        "AWS End User Messaging adapter for SMS, MMS, RCS with SMS fallback, Notify templates, fraud controls, registration, event destinations, and WhatsApp.",
      docsUrl:
        "https://github.com/absolutejs/dispatch-adapters/tree/main/aws-end-user-messaging",
      name: "@absolutejs/dispatch-aws-end-user-messaging",
      tagline: "Deliver compliant carrier and social messages through AWS.",
    },
    implements: [
      defineImplementation<CreateAwsEndUserMessagingAdapterOptions>()({
        contract: "dispatch/messaging-adapter",
        factory: "createAwsEndUserMessagingAdapter",
        from: "@absolutejs/dispatch-aws-end-user-messaging",
        requires: {
          env: [
            {
              description: "AWS region for End User Messaging",
              key: "AWS_REGION",
              secret: false,
            },
            {
              description: "AWS phone pool ARN or id",
              key: "AWS_EUM_POOL_ARN",
              secret: false,
            },
          ],
          peers: [],
        },
        settings: Type.Object({
          configurationSetName: Type.String({ minLength: 1 }),
          originationIdentity: Type.String({ minLength: 1 }),
          protectConfigurationId: Type.String({ minLength: 1 }),
        }),
        title: "AWS End User Messaging",
        wiring: {
          code: "createAwsEndUserMessagingAdapter({ client: new PinpointSMSVoiceV2Client({ region: process.env.AWS_REGION }), ...${settings} })",
          imports: [
            {
              from: "@absolutejs/dispatch-aws-end-user-messaging",
              names: ["createAwsEndUserMessagingAdapter"],
            },
            {
              from: "@aws-sdk/client-pinpoint-sms-voice-v2",
              names: ["PinpointSMSVoiceV2Client"],
            },
          ],
        },
      }),
    ],
    settings: Type.Object({}),
    wiring: [],
  });
