# @absolutejs/dispatch-resend

Resend-backed `EmailAdapter` for
[@absolutejs/dispatch](https://github.com/absolutejs/dispatch).

**Docs:** [absolutejs.com/documentation/dispatch-overview#adapters](https://absolutejs.com/documentation/dispatch-overview#adapters)

## Install

```sh
bun add @absolutejs/dispatch @absolutejs/dispatch-resend resend
```

## Usage

```ts
import { Resend } from "resend";
import { createDispatcher } from "@absolutejs/dispatch";
import { createResendAdapter } from "@absolutejs/dispatch-resend";

const resend = new Resend(process.env.RESEND_KEY!);

const dispatcher = createDispatcher({
  email: createResendAdapter({
    client: resend,
    defaultFrom: "no-reply@acme.io",
  }),
});

const result = await dispatcher.email({
  to: "alice@example.com",
  subject: "Welcome to Acme",
  text: "Click here to verify: ...",
  // String metadata becomes Resend tags by default:
  metadata: { campaign: "welcome-v2", priority: "high" },
});

console.log(result.id); // Resend's message id
```

## API

```ts
createResendAdapter({
  client,         // Required — your `new Resend(apiKey)`
  defaultFrom?,   // Required if your messages don't set `from`
  tagsFromMetadata?,  // Customize metadata → Resend tags mapping
})
```

### `tagsFromMetadata`

By default the adapter maps every **string-valued** entry in
`message.metadata` to a Resend tag. Non-string values (numbers,
booleans, objects) are filtered out — Resend requires `string` for
both `name` and `value`.

Override to customize:

```ts
createResendAdapter({
  client: resend,
  tagsFromMetadata: (metadata) => [
    // Always include the tenant
    ...(typeof metadata.tenant === "string"
      ? [{ name: "tenant", value: metadata.tenant }]
      : []),
    // Drop debug-only entries
  ],
});
```

## Error mapping

Resend's `{ data, error }` response shape becomes:

- `error` set → adapter throws (`@absolutejs/dispatch` records the
  exception on the `dispatch.email.send` span, bumps `failed`
  counter, emits `dispatch.email.failed` audit event).
- `data.id` present → `DispatchResult.id` = the Resend message id.
- `data.id` missing → `DispatchResult.id` is `undefined`,
  `result.provider` still `'resend'`.

## License

[Apache 2.0](../LICENSE). Tier B substrate-adjacent under the
AbsoluteJS licensing policy — rides `@absolutejs/dispatch` (BSL Tier
A) and `resend` (MIT).
The package also exports `resendEffectAdapterDescriptor` and
`createResendEffectAdapterDriver()` for `@absolutejs/execution`. The driver
accepts resolved credentials only in its execution context, requires the exact
Resend API destination and `email.send` effect, and forwards the durable effect
idempotency key to Resend. Hosts retain ownership of secret storage and provide
the narrow `clientForKey` factory at the final provider boundary.

## Durable effect webhook evidence

The effect driver adds an `abs_effect` Resend tag containing the durable effect
ID and declares webhook reconciliation. Hosts can pass the exact raw request
body, Standard Webhooks headers, project tenant ID, and that project's exact
`RESEND_WEBHOOK_SECRET` to `verifyResendEffectWebhook()`. It uses Resend's SDK
verifier before returning a normalized `EffectEvidenceRecord`; recipients,
sender, subject, headers, and the raw payload are never returned for storage.

All supported outbound `email.*` webhook events confirm that the `email.send`
effect was accepted by Resend, so the normalized effect outcome is
`confirmed_succeeded`. Delivery state remains explicit in `eventType` (for
example `email.delivered`, `email.bounced`, or `email.failed`) and must not be
confused with successful inbox delivery. Inbound `email.received`, contact,
domain, uncorrelated, and invalidly signed events are rejected.

Webhook signing secrets are host ingress credentials, not provider-send
credentials. Store one under the exact project secret alias
`RESEND_WEBHOOK_SECRET`; do not place it in an adapter installation or resolve
it during email sends.
