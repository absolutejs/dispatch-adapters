# @absolutejs/dispatch-sinch

Production Sinch Conversation API messaging for `@absolutejs/dispatch`.

## Install

```sh
bun add @absolutejs/dispatch-sinch @sinch/sdk-core
```

This package uses real npm releases and has no install-time lifecycle hooks,
local file dependencies, or overrides.

## What it covers

- SMS, MMS, RCS, WhatsApp, Viber Business, Messenger, Instagram, Telegram,
  KakaoTalk, LINE, and WeChat through the recommended Conversation API
- Ordered `channel_priority_order` fallback with one generic message safely
  transcoded by Sinch
- Text, one-media, omnichannel template, portable card/action, and guarded
  `extensions.sinch` content
- Atomic provider/project/tenant-scoped idempotency and indeterminate-outcome
  handling through `@absolutejs/reliability`
- HmacSHA256 verification over the exact raw callback body, nonce, and
  timestamp, with replay bounds and one-secret rotation
- Durable webhook inbox, recovery drain, delivery/inbound/choice event
  normalization, provider opt events, WhatsApp marketing preferences, and
  explicit SMS STOP/START/HELP parsing
- Live app/channel/webhook readiness, asynchronous channel capability lookup,
  multi-project tenant routing, channel-specific recipient identity resolution,
  10DLC brand/campaign/number workflows, and toll-free verification

The standalone Sinch SMS API is intentionally not used because Sinch marks it
end-of-sale for new integrations.

## Minimal sending

```ts
import { createDispatcher } from "@absolutejs/dispatch";
import { createSinchAdapter } from "@absolutejs/dispatch-sinch";
import { SinchClient } from "@sinch/sdk-core";

const client = new SinchClient({
  conversationRegion: "us",
  keyId: process.env.SINCH_KEY_ID!,
  keySecret: process.env.SINCH_KEY_SECRET!,
  projectId: process.env.SINCH_PROJECT_ID!,
});

const messaging = createSinchAdapter({
  appId: process.env.SINCH_APP_ID!,
  client,
  projectId: process.env.SINCH_PROJECT_ID!,
  webhookUrl: "https://example.com/webhooks/sinch/account-a",
});

const dispatch = createDispatcher({ messaging });
await dispatch.messaging({
  content: { kind: "text", text: "Production latency is elevated." },
  fallbacks: [{ transport: "sms" }],
  idempotencyKey: "incident-42:recipient-7",
  to: { address: "+12025550100", transport: "rcs" },
});
```

Use a durable idempotency store for every retryable production send and a
durable webhook inbox for callbacks. `createSinchWebhookHandler` requires a
trusted route-to-account resolver so the correct secret is selected before
the raw body is parsed.

## Compliance boundary

`createSinchRegistrationManager()` submits and inspects 10DLC brands and
campaigns, qualifies use cases, links approved numbers, and submits toll-free
verification evidence. These are
operational workflows, not legal certification. Your application remains
responsible for consent evidence, privacy/terms, quiet hours, opt-out testing,
and carrier-specific program rules.

## License

Apache-2.0
