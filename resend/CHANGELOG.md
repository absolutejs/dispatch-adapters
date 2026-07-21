# Changelog

## [0.2.1] — 2026-07-21

- Keep local verifier and signing fixtures visibly synthetic so repository
  secret scanners do not mistake test-only material for live credentials.

## [0.2.0] — 2026-07-21

- Upgrade to `@absolutejs/execution` 0.8 and Resend 6.18.
- Correlate durable sends with a protected `abs_effect` provider tag.
- Verify exact raw webhook bodies through the Resend SDK and normalize them to
  privacy-minimal, tenant-bound effect evidence.
- Declare webhook reconciliation while retaining provider idempotency.

## [0.0.3] — 2026-07-14

- Make `ResendClientLike` structurally compatible with the current Resend SDK
  by expressing its required text-or-HTML content union.
- Reject empty-content messages before invoking the provider. This prevents an
  invalid request shape that current Resend clients correctly refuse to type.

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
