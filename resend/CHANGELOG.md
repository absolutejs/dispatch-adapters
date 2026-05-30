# Changelog

## [0.0.1] — 2026-05-30

Initial preview. Resend-backed `EmailAdapter` for `@absolutejs/dispatch`.

### Surface

- **`createResendAdapter({ client, defaultFrom?, tagsFromMetadata? })`** —
  returns an `EmailAdapter` shaped per `@absolutejs/dispatch`'s
  contract.
- **`ResendClientLike`** — minimal subset of Resend's client that we
  use, so `resend` stays a true peer dep (types aren't required at
  compile time, only the tag-template-style API at runtime).
- **`defaultFrom`** — Resend requires `from`; the adapter falls back
  to this default when the message omits it, and throws if neither is
  set.
- **String metadata → Resend tags** by default — every
  `string`-valued entry in `message.metadata` becomes a Resend tag.
  Non-string entries are filtered out (Resend requires string tags).
- **`tagsFromMetadata`** option to fully override the default mapping.
- **Resend `{ error }` response → thrown** so `@absolutejs/dispatch`'s
  error path runs (`dispatch.email.failed` audit, span ERROR, failed
  counter).

### Tested

11 tests with a mock Resend client (no real API key needed): field
mapping, message-id round-trip, defaultFrom fallback, missing-from
throw, array `to`, replyTo/cc/bcc/headers passthrough, string
metadata → tags, non-string filtered, custom tagsFromMetadata,
Resend error → throw, missing `data.id` graceful.

### License

Apache 2.0 (Tier B substrate-adjacent — rides `@absolutejs/dispatch`
Tier A and `resend` MIT).
