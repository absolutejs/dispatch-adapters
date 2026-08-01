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
- Fast durable webhook intake followed by an out-of-band recovery drain,
  stable provider-retry deduplication, delivery/inbound/choice event
  normalization, provider opt events, WhatsApp marketing preferences, and
  explicit SMS STOP/START/HELP parsing
- Live app/channel/webhook readiness, asynchronous channel capability lookup,
  multi-project tenant routing, E.164 and WhatsApp business-scoped recipient
  identities, a concrete OAuth registration client, 10DLC
  brand/campaign/number workflows, and toll-free verification

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
the raw body is parsed. Configure that URL as a registered Conversation API
webhook in Sinch; the adapter intentionally does not emit a per-message
`callback_url`, because override callbacks use a separate signing-secret
contract.

The HTTP handler authenticates and durably stores each callback, then returns
`202` without waiting for application code. Run `drainSinchWebhookInbox()` in a
worker with the same durable inbox, consent ledger, scope resolver, and event
handler. Consent writes and application effects share the same retry path, so
a temporary ledger failure cannot complete a STOP event prematurely.

## Compliance boundary

`createSinchRegistrationClient()` uses short-lived OAuth credentials against
Sinch's US Registration API and Numbers API. Pass it to
`createSinchRegistrationManager()` to submit and inspect 10DLC brands and
campaigns, qualify use cases, preserve the number's SMS service plan while
linking an approved campaign, and submit toll-free verification evidence.

```ts
import {
  createSinchRegistrationClient,
  createSinchRegistrationManager,
} from "@absolutejs/dispatch-sinch";

const registrations = createSinchRegistrationManager(
  createSinchRegistrationClient({
    keyId: process.env.SINCH_KEY_ID!,
    keySecret: process.env.SINCH_KEY_SECRET!,
  }),
  process.env.SINCH_PROJECT_ID!,
);
```

These are operational workflows, not legal certification. Your application
remains responsible for consent evidence, privacy/terms, quiet hours, opt-out
testing, and carrier-specific program rules.

## License

Apache-2.0
