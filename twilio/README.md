# @absolutejs/dispatch-twilio

Production Twilio SMS for
[`@absolutejs/dispatch`](https://github.com/absolutejs/dispatch): Messaging
Service sending, signed lifecycle webhooks, normalized delivery and consent
events, retry-safe persistence boundaries, and operational readiness checks.

This package supplies application infrastructure. Twilio still owns carrier
registration and enforcement, and the application owner remains responsible
for lawful consent and correct campaign configuration.

## Install

```sh
bun add @absolutejs/dispatch @absolutejs/dispatch-twilio twilio
```

## Send alerts

The adapter deliberately requires a Messaging Service and a public status callback.
Every message therefore stays inside the service's sender pool, campaign, and
opt-out policy.

```ts
import { createDispatcher } from "@absolutejs/dispatch";
import { createTwilioAdapter } from "@absolutejs/dispatch-twilio";
import { Twilio } from "twilio";

const client = new Twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

const dispatcher = createDispatcher({
  sms: createTwilioAdapter({
    client,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
    statusCallbackUrl: "https://app.example.com/webhooks/twilio/messaging",
    validityPeriod: 300,
    smartEncoded: true,
  }),
});

const result = await dispatcher.sms({
  body: "CPU usage has exceeded 90%.",
  tenant: "tenant-a",
  to: "+12025550100",
});

console.log(result.id); // SM...
```

The dispatch contract also supports MMS media, WhatsApp destinations, Twilio
Content templates, scheduled sends, and durable idempotency keys:

```ts
import {
  createPostgresTwilioIdempotencyStore,
  TWILIO_IDEMPOTENCY_POSTGRES_SCHEMA,
} from "@absolutejs/dispatch-twilio";

const idempotencyStore = createPostgresTwilioIdempotencyStore(postgres);
const adapter = createTwilioAdapter({
  client,
  idempotencyStore,
  messagingServiceSid,
  statusCallbackUrl,
  resolveTenant: (tenant) => tenantTwilioConfiguration(tenant),
});

await adapter.send({
  channel: "whatsapp",
  idempotencyKey: "incident-42:opened",
  template: { id: "HX...", variables: { incident: "42" } },
  tenant: "tenant-a",
  to: "whatsapp:+12025550100",
});
```

Apply `TWILIO_IDEMPOTENCY_POSTGRES_SCHEMA` once before using the supplied
Postgres store. A key is claimed atomically before Twilio is called; completed
results are replayed and active claims fail with
`TwilioIdempotencyInFlightError`. Use a stable business-operation key, not a
random value generated on every retry.

A per-message `from` may pin a sender, but the Messaging Service SID is still
sent. Twilio will require that number to belong to the service's sender pool.
Destinations and explicit senders must use E.164 format. `validityPeriod` must
be 1–36,000 seconds.

## Handle delivery and consent webhooks

Twilio signs messaging webhooks with the account auth token. The handler below
accepts form-encoded callbacks only after validating `X-Twilio-Signature`
against the exact public URL and all received parameters.

```ts
import {
  createTwilioWebhookHandler,
  type TwilioLifecycleStore,
} from "@absolutejs/dispatch-twilio";

const lifecycleStore: TwilioLifecycleStore = durableLifecycleStore;

const handleTwilioWebhook = createTwilioWebhookHandler({
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  expectedAccountSid: process.env.TWILIO_ACCOUNT_SID!,
  expectedMessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
  publicUrl: "https://app.example.com/webhooks/twilio/messaging",
  store: lifecycleStore,
  onEvent: async (event) => {
    if (event.kind === "status") {
      // accepted | scheduled | queued | sending | sent | delivered |
      // undelivered | failed | canceled | read
      await alerts.recordDelivery(event);
      return;
    }

    if (event.kind === "consent") {
      // Twilio Advanced Opt-Out emits STOP, START, or HELP as OptOutType.
      await consent.record(event);
      return;
    }

    // Ordinary inbound SMS/MMS/WhatsApp replies include normalized media.
    await inbox.record(event);
  },
});

// Mount with any Request/Response-compatible server.
app.post("/webhooks/twilio/messaging", ({ request }) =>
  handleTwilioWebhook(request),
);
```

`publicUrl` is fixed configuration and is the exact HTTPS URL Twilio signs.
The handler does not trust forwarded host/protocol headers. It also binds each
request to the expected account and, when supplied, Messaging Service.

### Durable lifecycle store

The store is an atomic inbox boundary:

```ts
type TwilioLifecycleStore = {
  durability: "durable" | "memory";
  begin(event): Promise<{
    disposition: "accepted" | "duplicate" | "stale";
    claimToken?: string;
    previousStatus?: TwilioMessageStatus;
  }>;
  complete(eventId, claimToken): Promise<void>;
  release(eventId, claimToken): Promise<void>;
};
```

`begin` must atomically deduplicate `event.eventId`, reject status regressions,
and lease pending consumer work to one worker. It must recheck status ordering
when reclaiming pending work so an old callback cannot run after a newer
terminal state. Durable implementations must expire abandoned leases.
`complete` closes the inbox item; `release` makes it available after a consumer
failure. Consumers should also use `eventId` as an idempotency key because no
webhook system can make an external side effect and an inbox commit atomic
without shared storage.

`createMemoryTwilioLifecycleStore()` is supplied for tests and local
development. For production, apply `TWILIO_LIFECYCLE_POSTGRES_SCHEMA` and use
`createPostgresTwilioLifecycleStore(postgres)`. The readiness checker always
rejects memory storage.

Use `createTwilioWebhookProcessor()` instead of the Response-returning handler
when a framework needs control over its own response format.

## Operational readiness

```ts
import { inspectTwilioMessagingReadiness } from "@absolutejs/dispatch-twilio";

const report = await inspectTwilioMessagingReadiness({
  client,
  expectedAccountSid: process.env.TWILIO_ACCOUNT_SID!,
  inboundWebhookUrl: "https://app.example.com/webhooks/twilio/inbound",
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
  requiresUsA2PRegistration: true,
  statusCallbackUrl: "https://app.example.com/webhooks/twilio/messaging",
  store: lifecycleStore,
  assertions: {
    consentEvidenceStored: true,
    optOutConfigured: true,
    privacyPolicyPublished: true,
    termsPublished: true,
  },
});

if (!report.ready) throw new Error("Twilio messaging is not production ready");
```

This API inspects the Messaging Service/account binding, inbound POST URL,
status callback, sender pool, and optional US A2P attachment using Twilio's API.
Consent, Advanced Opt-Out testing, privacy, and terms remain operator
assertions. The report scope is always `operational-not-legal-certification`.

Before production, configure and test a Twilio Messaging Service, its sender
pool, applicable carrier registration (such as US A2P 10DLC), Advanced Opt-Out,
the inbound webhook, the status callback, consent evidence, privacy policy, and
messaging terms. Twilio recommends SDK signature validation because webhook
fields may evolve; this package uses the official SDK validator.

## Breaking changes from 0.0.x

- `messagingServiceSid` and `statusCallbackUrl` are required.
- `defaultFrom` and service-or-number sender precedence were removed.
- A per-message `from` augments rather than replaces the Messaging Service.
- E.164 numbers, service SIDs, HTTPS callbacks, non-empty bodies, and validity
  periods are validated before calling Twilio.
- Response-level failures throw the typed `TwilioSendError`.

`0.0.x` was a preview and has no compatibility aliases in `0.1.0`.

## License

[Apache 2.0](../LICENSE). Tier B substrate-adjacent — rides
`@absolutejs/dispatch` (BSL Tier A) and `twilio` (MIT).
