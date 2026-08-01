# @absolutejs/dispatch-infobip

Infobip Messages API adapter for AbsoluteJS Dispatch. It covers SMS, MMS, RCS, WhatsApp, Viber Business Messages and Bots, Apple Messages for Business, Instagram Direct, LINE, and Messenger through one transport.

The adapter can validate every request with Infobip before sending, maps portable content and actions, supports provider-native request extensions, provides authenticated durable webhook intake, and exposes 10DLC brand/campaign plus number resource-request operations.

```ts
import { createInfobipAdapter } from "@absolutejs/dispatch-infobip";

const messaging = createInfobipAdapter({
  apiKey: process.env.INFOBIP_API_KEY!,
  baseUrl: process.env.INFOBIP_BASE_URL!,
  defaultSenders: { sms: process.env.INFOBIP_SMS_SENDER! },
  deliveryWebhookUrl: "https://example.com/webhooks/infobip/delivery",
  validateBeforeSend: true,
});
```

Infobip channel onboarding and consent remain mandatory. Complete 10DLC brand/campaign registration for US long codes and use an authenticated webhook profile or gateway verifier for event ingestion.
