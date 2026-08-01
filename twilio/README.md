# @absolutejs/dispatch-twilio

Production Twilio SMS, MMS, RCS, and WhatsApp for
[`@absolutejs/dispatch`](https://github.com/absolutejs/dispatch): Messaging
Service sending, signed lifecycle webhooks, normalized delivery and consent
events, enforceable consent, registration automation, retry-safe persistence
boundaries, and operational readiness checks.

This package supplies application infrastructure. Twilio still owns carrier
registration and enforcement, and the application owner remains responsible
for lawful consent and correct campaign configuration.

## Install

```sh
bun add @absolutejs/dispatch @absolutejs/dispatch-twilio twilio
```

Add `@absolutejs/compliance` when using the shared consent ledger:

```sh
bun add @absolutejs/compliance
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

### RCS with fallback

Add an approved RCS sender to the Messaging Service sender pool. An E.164
recipient tries RCS first and lets Twilio fall back to SMS/MMS:

```ts
await dispatcher.sms({
  body: "CPU usage has exceeded 90%.",
  channel: "rcs",
  rcs: { fallbackFrom: "+12025550199" },
  to: "+12025550100",
});
```

Set `rcs.fallback` to `"disabled"` (or use a `rcs:+E164` recipient) when the
message must not fall back. Templates and HTTPS media use the same
`template` and `mediaUrls` fields as the other messaging channels.

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

To make opt-outs enforceable before a provider call, connect signed START and
STOP events to `@absolutejs/compliance`. The application resolves the exact
tenant, sender, and topic because those are product concepts:

```ts
import {
  createMessagingConsentDispatchPolicy,
  createMessagingConsentLedger,
  createPostgresMessagingConsentStore,
} from "@absolutejs/compliance";

const consent = createMessagingConsentLedger({
  audit,
  store: createPostgresMessagingConsentStore(postgres),
});

const dispatcher = createDispatcher({
  policies: [createMessagingConsentDispatchPolicy({ ledger: consent })],
  sms: createTwilioAdapter({ client, messagingServiceSid, statusCallbackUrl }),
});

const handleTwilioWebhook = createTwilioWebhookHandler({
  authToken,
  expectedAccountSid,
  publicUrl: statusCallbackUrl,
  store: lifecycleStore,
  consent: {
    ledger: consent,
    resolveScope: (event) => ({
      recipient: event.from!,
      senderId: "acme",
      tenant: "tenant-a",
      topic: "incident-alerts",
      transport: "sms",
    }),
  },
  onEvent: async (event) => alerts.recordTwilioEvent(event),
});

await consent.grant(
  {
    recipient: "+12025550100",
    senderId: "acme",
    tenant: "tenant-a",
    topic: "incident-alerts",
    transport: "sms",
  },
  { at: Date.now(), reference: "settings-form-v3", source: "product-settings" },
);

await dispatcher.sms({
  body: "CPU usage has exceeded 90%.",
  consent: { senderId: "acme", topic: "incident-alerts" },
  tenant: "tenant-a",
  to: "+12025550100",
});
```

Apply `MESSAGING_CONSENT_POSTGRES_SCHEMA` before constructing the Postgres
store. Missing consent and revoked scopes are denied before Twilio is called.
Webhook retry deduplication uses the signed Twilio event identity.

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

### Registration submission and status

The compliance manager validates common evidence constraints before submitting
Twilio A2P brand/campaign or toll-free verification requests. It can then
inspect the live provider states:

```ts
import { createTwilioComplianceManager } from "@absolutejs/dispatch-twilio";

const registration = createTwilioComplianceManager(client);

const brand = await registration.registerA2PBrand({
  customerProfileBundleSid,
  a2PProfileBundleSid,
  brandType: "STANDARD",
});

const campaign = await registration.registerA2PCampaign(messagingServiceSid, {
  brandRegistrationSid: brand.sid,
  description: "Operational alerts selected by Pro-tier account owners.",
  messageFlow: "Customers enable alerts in settings and can text STOP.",
  messageSamples: [sampleOne, sampleTwo],
  usAppToPersonUsecase: "ACCOUNT_NOTIFICATION",
  hasEmbeddedLinks: false,
  hasEmbeddedPhone: false,
  subscriberOptIn: true,
  privacyPolicyUrl,
  termsAndConditionsUrl,
});

const registrationStatus = await registration.inspect({
  customerProfileSid,
  brandRegistrationSid: brand.sid,
  messagingServiceSid,
  campaignSid: campaign.sid,
  tollfreeVerificationSid,
});
```

`submitTollFreeVerification()` covers the corresponding Twilio submission.
Status checks are `pass`, `pending`, or `fail`; `ready` becomes true only when
every requested resource is approved.

```ts
import { inspectTwilioMessagingReadiness } from "@absolutejs/dispatch-twilio";

const report = await inspectTwilioMessagingReadiness({
  client,
  expectedAccountSid: process.env.TWILIO_ACCOUNT_SID!,
  inboundWebhookUrl: "https://app.example.com/webhooks/twilio/inbound",
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
  requiresUsA2PRegistration: true,
  requiresRcsSender: true,
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
