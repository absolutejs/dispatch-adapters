# @absolutejs/dispatch-aws-end-user-messaging

AWS End User Messaging adapter for AbsoluteJS Dispatch. It uses AWS SDK v3 and IAM credentials to send SMS, MMS, plain or rich RCS, managed Notify templates, and WhatsApp messages.

Use an AWS phone pool as `originationIdentity` to get provider-managed RCS-to-SMS fallback. Put identities for only one consented use case in each pool. Configure an event destination and a Protect configuration for delivery telemetry and AIT fraud controls.

```ts
import { PinpointSMSVoiceV2Client } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { createAwsEndUserMessagingAdapter } from "@absolutejs/dispatch-aws-end-user-messaging";

const messaging = createAwsEndUserMessagingAdapter({
  client: new PinpointSMSVoiceV2Client({ region: "us-east-1" }),
  configurationSetName: "alerts-events",
  originationIdentity: process.env.AWS_EUM_POOL_ARN!,
  protectConfigurationId: process.env.AWS_EUM_PROTECT_ID,
  socialClient: new SocialMessagingClient({ region: "us-east-1" }),
  whatsappPhoneNumberId: process.env.AWS_WHATSAPP_PHONE_NUMBER_ID,
});
```

Template content uses AWS Notify when `notifyConfigurationId` is configured. Rich RCS accepts the provider request body under `message.extensions.aws.rcs`. WhatsApp template or rich payloads can be supplied under `message.extensions.aws.whatsapp`; ordinary text messages are generated automatically.
