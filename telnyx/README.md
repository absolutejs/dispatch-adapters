# @absolutejs/dispatch-telnyx

Production Telnyx SMS, MMS, and direct rich RCS for
`@absolutejs/dispatch`. The package includes multi-account routing, atomic
idempotency, Ed25519-signed webhook processing, durable inbox recovery,
consent ingestion, scheduling cancellation, RCS capability checks, carrier
registration helpers, and readiness diagnostics.

## Install

```sh
bun add @absolutejs/dispatch@^0.5 @absolutejs/dispatch-telnyx telnyx
bun add @absolutejs/compliance@^0.5 # when enforcing program consent
```

All dependencies above are normal npm releases. No file overrides or package
prepare/prepack hooks are required.

## Send SMS, MMS, and RCS

```ts
import { createDispatcher } from "@absolutejs/dispatch";
import {
  createPostgresIdempotentOperationStore,
  createPostgresTransactionRunner,
  createTelnyxAdapter,
} from "@absolutejs/dispatch-telnyx";
import { Telnyx } from "telnyx";

const client = new Telnyx({ apiKey: process.env.TELNYX_API_KEY! });
const runner = createPostgresTransactionRunner(postgresPool);

const dispatcher = createDispatcher({
  messaging: createTelnyxAdapter({
    accountId: process.env.TELNYX_ORGANIZATION_ID!,
    client,
    idempotencyStore: createPostgresIdempotentOperationStore(runner),
    messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID!,
    rcsAgentId: process.env.TELNYX_RCS_AGENT_ID,
    webhookFailoverUrl: "https://failover.example.com/webhooks/telnyx",
    webhookUrl: "https://app.example.com/webhooks/telnyx",
  }),
});

await dispatcher.messaging({
  content: { kind: "text", text: "Production database latency is elevated." },
  consent: { programId: "pro-alerts", purpose: "incident-alerts" },
  idempotencyKey: "incident-42:recipient-7",
  tenant: "tenant-a",
  to: { address: "+12025550100", transport: "sms" },
});
```

RCS can use portable rich cards and an explicit fallback route. The compliance
policy derives both `rcs` and `sms` consent checks from these routes:

```ts
await dispatcher.messaging({
  content: {
    actions: [
      {
        kind: "url",
        label: "Open incident",
        url: "https://app.example.com/incidents/42",
      },
    ],
    kind: "rich",
    mediaUrl: "https://cdn.example.com/incident.png",
    text: "Production database latency is elevated.",
    title: "Incident 42",
  },
  consent: { programId: "pro-alerts", purpose: "incident-alerts" },
  fallbacks: [
    {
      content: {
        kind: "text",
        text: "Incident 42: https://app.example.com/incidents/42",
      },
      from: { address: "+12025550199", transport: "sms" },
      transport: "sms",
    },
  ],
  to: { address: "+12025550100", transport: "rcs" },
});
```

Use `checkTelnyxRcsCapabilities()` when product behavior should differ before
sending. Telnyx still performs delivery fallback when one is declared.

## Reliability and webhooks

Apply `IDEMPOTENT_OPERATION_POSTGRES_SCHEMA` and
`WEBHOOK_INBOX_POSTGRES_SCHEMA`, then use a checked-out transaction runner.
Idempotency is scoped by provider, organization, tenant, namespace, and key;
payload reuse conflicts, fencing prevents stale completion, and ambiguous
provider calls become indeterminate instead of being retried automatically.

```ts
import {
  createPostgresWebhookInboxStore,
  createTelnyxWebhookHandler,
} from "@absolutejs/dispatch-telnyx";

const handler = createTelnyxWebhookHandler({
  consentLedger,
  handler: processNormalizedEvent,
  inbox: createPostgresWebhookInboxStore(runner),
  resolveAccount: (organizationId) => accountConfiguration(organizationId),
  resolveConsentScopes: (event) => programsForNumber(event.from),
});
```

`resolveAccount()` returns one or two active Ed25519 public keys for safe key
rotation and an optional Messaging Profile allowlist. Verification covers the
raw body and timestamp before parsing or processing. Events are normalized with
provider event id, occurrence time, requested/actual transport, interactive
payload, media, and delivery errors. Completed inbox rows default to a 24-hour
purge window when the processor runs; applications should also run a scheduled
purge and their legal-hold policy.

## Scheduling, registration, and readiness

Native scheduling is opt-in, limited to SMS/MMS from five minutes to five days,
and prohibited for consent-scoped messages. Prefer an Absolute queue that
re-evaluates consent immediately before delivery. Use
`createTelnyxScheduledMessageManager()` to inspect or cancel native schedules.

`createTelnyxComplianceManager()` validates privacy/terms, opt-in evidence,
current business-registration fields, and exposes explicit `a2p` and
`toll-free` inspections with rejection diagnostics. It does not certify legal
compliance. `inspectTelnyxMessagingReadiness()` checks the live Messaging
Profile/webhook binding plus operator assertions for consent, durable storage,
opt-out testing, carrier registration, and RCS approval.

## License

Apache-2.0.
