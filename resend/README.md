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
