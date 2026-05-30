# @absolutejs/dispatch-postmark

Postmark-backed `EmailAdapter` for
[@absolutejs/dispatch](https://github.com/absolutejs/dispatch).

## Install

```sh
bun add @absolutejs/dispatch @absolutejs/dispatch-postmark postmark
```

## Usage

```ts
import { ServerClient } from 'postmark';
import { createDispatcher } from '@absolutejs/dispatch';
import { createPostmarkAdapter } from '@absolutejs/dispatch-postmark';

const postmark = new ServerClient(process.env.POSTMARK_SERVER_TOKEN!);

const dispatcher = createDispatcher({
  email: createPostmarkAdapter({
    client: postmark,
    defaultFrom: 'no-reply@acme.io',
    // Optional — defaults to Postmark's transactional stream.
    // messageStream: 'broadcast',
  }),
});

await dispatcher.email({
  to: 'alice@example.com',
  subject: 'Welcome to Acme',
  text: 'Click here to verify: ...',
  // metadata.tag → Postmark Tag (single-string analytics segment);
  // other string entries → Postmark Metadata (string→string map):
  metadata: { tag: 'onboarding', campaign: 'welcome-v2' },
});
```

## API

```ts
createPostmarkAdapter({
  client,             // Required — your `new ServerClient(serverToken)`
  defaultFrom?,       // Required if your messages don't set `from`
  messageStream?,     // Default: Postmark's transactional stream
  mapMetadata?,       // Customize EmailMessage.metadata → Postmark Tag/Metadata
})
```

### `mapMetadata`

By default the adapter:

- Extracts `metadata.tag` (string) into Postmark's `Tag` field
  (a single-string analytics segment per message)
- Maps every OTHER **string-valued** entry into Postmark's `Metadata`
  (a string→string map)
- Filters out non-string values (Postmark Metadata values must be
  strings)

Override to customize:

```ts
createPostmarkAdapter({
  client: postmark,
  mapMetadata: (metadata) => ({
    Tag: typeof metadata.flow === 'string' ? metadata.flow : 'transactional',
    Metadata: { tenant: String(metadata.tenant ?? 'unknown') },
  }),
});
```

## Error mapping

Postmark's response shape:

```ts
{ MessageID, SubmittedAt, To, ErrorCode, Message }
```

- `ErrorCode !== 0` (and not undefined) → adapter throws with
  `Postmark ErrorCode <n>: <Message>`. `@absolutejs/dispatch`'s error
  path records the exception on the `dispatch.email.send` span, bumps
  the failed counter, and emits `dispatch.email.failed`.
- `ErrorCode === 0` (or undefined) → treated as success.
  `DispatchResult.id` = `response.MessageID`.

## License

[Apache 2.0](../LICENSE). Tier B substrate-adjacent — rides
`@absolutejs/dispatch` (BSL Tier A) and `postmark` (MIT).
