# @absolutejs/dispatch-twilio

Production Twilio SMS, MMS, RCS, and WhatsApp for `@absolutejs/dispatch`, with
consent enforcement, signed webhooks and Event Streams, carrier-registration
helpers, bounded durable inboxes, and operational readiness checks.

## Install

```sh
bun add @absolutejs/dispatch @absolutejs/dispatch-twilio twilio
bun add @absolutejs/compliance # when using the shared consent ledger
```

## Send alerts

Every send uses a Twilio Messaging Service and a public status callback.

```ts
import { createDispatcher } from "@absolutejs/dispatch";
import { createTwilioAdapter } from "@absolutejs/dispatch-twilio";
import { Twilio } from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const client = new Twilio(accountSid, process.env.TWILIO_AUTH_TOKEN!);

const dispatcher = createDispatcher({
  messaging: createTwilioAdapter({
    accountSid,
    client,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
    statusCallbackUrl: "https://app.example.com/webhooks/twilio/messaging",
    smartEncoded: true,
    validityPeriod: 300,
  }),
});

await dispatcher.messaging({
  content: { kind: "text", text: "CPU usage has exceeded 90%." },
  consent: {
    programId: "pro-alerts",
    purpose: "incident-alerts",
  },
  privacy: {
    addressRetention: "obfuscate",
    contentRetention: "discard",
  },
  tenant: "tenant-a",
  to: { address: "+12025550100", transport: "sms" },
});
```

RCS fallback is declared as a route, so the compliance policy automatically
checks consent for both transports:

```ts
await dispatcher.messaging({
  content: { kind: "template", id: "HX0123456789abcdef0123456789abcdef" },
  consent: {
    programId: "pro-alerts",
    purpose: "incident-alerts",
  },
  fallbacks: [
    {
      from: { address: "+12025550199", transport: "sms" },
      transport: "sms",
    },
  ],
  to: { address: "+12025550100", transport: "rcs" },
});
```

Omit `fallbacks` to require RCS. Twilio rich content uses a published `HX`
Content SID through `content.kind: "template"`; portable text and media content
use their own exclusive content variants.

### Idempotency and tenant isolation

```ts
import {
  createPostgresTwilioIdempotencyStore,
  TWILIO_IDEMPOTENCY_POSTGRES_SCHEMA,
} from "@absolutejs/dispatch-twilio";

const adapter = createTwilioAdapter({
  accountSid,
  client,
  idempotencyStore: createPostgresTwilioIdempotencyStore(postgresPool),
  messagingServiceSid,
  statusCallbackUrl,
  resolveTenant: (tenant) => tenantTwilioConfiguration(tenant),
});
```

Apply `TWILIO_IDEMPOTENCY_POSTGRES_SCHEMA` first. The pool must expose
`connect()` so transactions use one checked-out connection. Keys are scoped by
Twilio account and tenant, bound to a canonical payload fingerprint, and fenced.
Completed results are replayed. Conflicting payloads fail. An ambiguous network
result becomes `TwilioIdempotencyIndeterminateError` instead of being sent
again.

Provider-native scheduling is disabled by default. Prefer an application queue
that re-evaluates consent immediately before sending. Explicit native schedules
must be 15 minutes to 35 days away and cannot carry a consent scope. Use
`createTwilioScheduledMessageManager()` to inspect or cancel them.

## Consent and signed messaging webhooks

```ts
import {
  createMessagingConsentDispatchPolicy,
  createMessagingConsentLedger,
  createPostgresMessagingConsentStore,
} from "@absolutejs/compliance";
import {
  createPostgresTwilioLifecycleStore,
  createTwilioWebhookHandler,
} from "@absolutejs/dispatch-twilio";

const consent = createMessagingConsentLedger({
  audit,
  store: createPostgresMessagingConsentStore(postgresPool),
});
const lifecycleStore = createPostgresTwilioLifecycleStore(postgresPool);

const handleTwilioWebhook = createTwilioWebhookHandler({
  publicUrl: "https://app.example.com/webhooks/twilio/messaging",
  resolveAccount: (untrustedAccountSid) =>
    accountDirectory.get(untrustedAccountSid),
  store: lifecycleStore,
  consent: {
    ledger: consent,
    resolveScopes: (event) =>
      ["sms", "rcs"].map((transport) => ({
        programId: "pro-alerts",
        purpose: "incident-alerts",
        recipient: event.from!,
        tenant: "tenant-a",
        transport,
      })),
  },
  onEvent: async (event) => alerts.recordTwilioEvent(event),
});
```

`resolveAccount` returns only known `{ accountSid, authTokens,
messagingServiceSids? }` records. Put the current token first and a still-valid
previous token second during rotation. The fixed `publicUrl` is used for
signature validation; forwarded host/protocol headers are not trusted.

START and STOP may resolve to multiple program transports so fallback consent
stays synchronized. Twilio's RCS Advanced Opt-Out behavior has provider
limitations, so production readiness requires an explicit tested mitigation.

### Durable lifecycle inbox

Apply `TWILIO_LIFECYCLE_POSTGRES_SCHEMA` before constructing the Postgres
store. It atomically deduplicates events, rejects status regressions, and leases
consumer work. It accepts both `SM` and `MM` SIDs, records the actual fallback
transport, and includes interactive `ButtonPayload`/`ButtonText` fields.

Raw form payloads are discarded by default. Normalized recovery data has a
seven-day default retention window and configurable address/content redaction.
Use `exportMessage()` and `purgeExpired()` for privacy workflows. Run
`drainTwilioWebhookInbox()` from a worker so accepted work survives beyond
Twilio's retry window.

## Event Streams

`createTwilioEventStreamHandler()` validates the raw JSON body signature and
handles CloudEvent batches. Use `createPostgresTwilioEventStreamStore()` after
applying `TWILIO_EVENT_STREAM_POSTGRES_SCHEMA`; it provides atomic deduplication,
bounded retention, optional product-specific redaction, and recovery through
`drainTwilioEventStreamInbox()`.

## Carrier compliance and ISV onboarding

```ts
const registration = createTwilioComplianceManager(client);

const campaign = await registration.registerA2PCampaign(messagingServiceSid, {
  brandRegistrationSid,
  description,
  messageFlow,
  messageSamples: [sampleOne, sampleTwo],
  usAppToPersonUsecase: "ACCOUNT_NOTIFICATION",
  hasEmbeddedLinks: false,
  hasEmbeddedPhone: false,
  privacyPolicyUrl,
  termsAndConditionsUrl,
});

const status = await registration.inspect({
  kind: "a2p",
  customerProfileSid,
  brandRegistrationSid,
  messagingServiceSid,
  campaignSid: campaign.sid,
});
```

Inspection targets are complete discriminated workflows, so a partial set of
green resources cannot report ready. Toll-free submission requires its Trust
Hub profile and current business registration fields; failed checks expose
rejection reasons, error codes, and edit/resubmission windows.

ISVs can call `initializeTollFreeEmbeddableInquiry()` to obtain the inquiry ID
and ephemeral session token for Twilio's Compliance Embeddable. Keep Twilio
credentials server-side and expose that token only to the authenticated end
customer.

## Operational readiness

```ts
const report = await inspectTwilioMessagingReadiness({
  client,
  expectedAccountSid: accountSid,
  inboundWebhookUrl,
  messagingServiceSid,
  requiresUsA2PRegistration: true,
  requiresRcsSender: true,
  rcsAssertions: {
    senderApproved: true,
    advancedOptOutMitigationTested: true,
  },
  statusCallbackUrl,
  store: lifecycleStore,
  assertions: {
    consentEvidenceStored: true,
    optOutConfigured: true,
    privacyPolicyPublished: true,
    termsPublished: true,
  },
});
```

The report checks account/service binding, webhook configuration, sender pools,
A2P attachment, durable storage, consent, policy disclosures, RCS approval, and
opt-out testing. Its scope is always `operational-not-legal-certification`.

## License

[Apache 2.0](../LICENSE).
