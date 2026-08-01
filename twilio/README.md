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

`0.1.0` deliberately requires a Messaging Service and a public status callback.
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
  store: lifecycleStore,
  onEvent: async (event) => {
    if (event.kind === "status") {
      // accepted | scheduled | queued | sending | sent | delivered |
      // undelivered | failed | canceled | read
      await alerts.recordDelivery(event);
      return;
    }

    // Twilio Advanced Opt-Out emits STOP, START, or HELP as OptOutType.
    await consent.record(event);
  },
});

// Mount with any Request/Response-compatible server.
app.post("/webhooks/twilio/messaging", ({ request }) =>
  handleTwilioWebhook(request),
);
```

If a trusted reverse proxy changes the request URL, supply
`resolvePublicUrl(request)` to reconstruct the exact URL Twilio signed. Never
derive that URL from untrusted forwarded headers.

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
development. The readiness checker always rejects it for production.

Use `createTwilioWebhookProcessor()` instead of the Response-returning handler
when a framework needs control over its own response format.

## Operational readiness

```ts
import { checkTwilioMessagingReadiness } from "@absolutejs/dispatch-twilio";

const report = checkTwilioMessagingReadiness({
  store: lifecycleStore,
  assertions: {
    carrierRegistrationApproved: true,
    consentEvidenceStored: true,
    optOutConfigured: true,
    privacyPolicyPublished: true,
    termsPublished: true,
  },
});

if (!report.ready) throw new Error("Twilio messaging is not production ready");
```

These are operator assertions, not remotely verified facts. The report scope is
always `operational-not-legal-certification`.

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
