# @absolutejs/dispatch-vonage

Production Vonage Messages API adapter for `@absolutejs/dispatch`. It supports
SMS, MMS, RCS, WhatsApp, Viber, and Facebook Messenger; ordered provider-native
failover; signed durable webhooks; consent ingestion; tenant routing; readiness;
and 10DLC inspection.

## Install

```sh
bun add @absolutejs/dispatch@^0.6 @absolutejs/dispatch-vonage @vonage/server-sdk
bun add @absolutejs/compliance@^0.6 # when enforcing program consent
```

These are normal npm releases. No overrides, file dependencies, prepare, or
prepack hooks are required.

## Send with failover

```ts
import { createDispatcher } from "@absolutejs/dispatch";
import {
  createPostgresIdempotentOperationStore,
  createPostgresTransactionRunner,
  createVonageAdapter,
} from "@absolutejs/dispatch-vonage";
import { Vonage } from "@vonage/server-sdk";

const client = new Vonage({
  applicationId: process.env.VONAGE_APPLICATION_ID!,
  privateKey: process.env.VONAGE_PRIVATE_KEY!,
});
const runner = createPostgresTransactionRunner(postgresPool);
const messaging = createVonageAdapter({
  apiKey: process.env.VONAGE_API_KEY!,
  applicationId: process.env.VONAGE_APPLICATION_ID!,
  client,
  defaultFrom: {
    rcs: process.env.VONAGE_RCS_SENDER!,
    sms: process.env.VONAGE_SMS_SENDER!,
  },
  idempotencyStore: createPostgresIdempotentOperationStore(runner),
  webhookUrl: "https://app.example.com/webhooks/vonage/messages",
});

const dispatch = createDispatcher({ messaging });
await dispatch.messaging({
  content: {
    actions: [{ kind: "reply", label: "Acknowledge", payload: "ack:42" }],
    kind: "rich",
    mediaUrl: "https://cdn.example.com/incidents/42.png",
    text: "Database latency is elevated.",
    title: "Production incident",
  },
  consent: { programId: "pro-alerts", purpose: "incident-alerts" },
  fallbacks: [
    {
      content: { kind: "text", text: "Database latency is elevated." },
      transport: "sms",
    },
  ],
  idempotencyKey: "incident-42:recipient-7",
  tenant: "tenant-a",
  to: { address: "+12025550100", transport: "rcs" },
});
```

`extensions.vonage` accepts channel-specific message content such as an RCS
carousel while protecting routing, sender, recipient, and failover fields from
override.

## Signed durable webhooks

```ts
import {
  createPostgresWebhookInboxStore,
  createVonageWebhookHandler,
} from "@absolutejs/dispatch-vonage";

const webhook = createVonageWebhookHandler({
  consentLedger,
  handler: (event) => lifecycle.record(event),
  inbox: createPostgresWebhookInboxStore(runner),
  resolveAccount: (apiKey) => webhookAccount(apiKey),
  resolveConsentScopes: (event) => programsForNumber(event.from!.address),
});

app.post("/webhooks/vonage/messages", ({ request }) => webhook(request));
```

The handler requires an HS256 Bearer JWT, validates issuer, API key,
application binding, issuance time, signature rotation, and the SHA-256 hash of
the exact raw request body before parsing. Normalized events include typed
content/endpoints, fallback attempt position, price/currency, SMS segments,
network code, provider errors, and delivery/read state. Completed inbox rows
default to 24-hour retention; pending work remains recoverable.

## Operational boundaries

- Native scheduling is intentionally rejected; enqueue the Dispatch call so
  consent is re-evaluated immediately before delivery.
- `inspectVonageMessagingReadiness()` checks the live application webhooks plus
  durable inbox, signature, consent, opt-out, and carrier assertions.
- `createVonageRegistrationManager()` registers and inspects 10DLC brands and
  campaigns, then links approved sending numbers
- `createVonageRcsCapabilityManager()` checks device reachability and supported
  RCS features before choosing rich content or a fallback
- `createVonageMessageController()` revokes supported outbound RCS messages and
  marks inbound WhatsApp messages read
  and number linkage through a narrow API client.
- OTP/Verify, number intelligence, support conversations, and campaigns remain
  separate product boundaries rather than being hidden inside Dispatch.

## License

[Apache-2.0](./LICENSE)
