# Changelog

## [0.0.1] — 2026-05-30

Initial preview. Postmark-backed `EmailAdapter` for `@absolutejs/dispatch`.

### Surface

- **`createPostmarkAdapter({ client, defaultFrom?, messageStream?, mapMetadata? })`** —
  returns an `EmailAdapter`.
- **`PostmarkClientLike`** — minimal subset of Postmark's
  `ServerClient` (just `sendEmail`); keeps `postmark` a true peer dep.
- **`mapMetadata` default** — extracts `metadata.tag` into Postmark's
  `Tag` field; other string-valued entries → Postmark `Metadata`
  (string→string map); non-strings filtered.
- **Address arrays** csv-join (Postmark accepts comma-separated for
  `To`/`Cc`/`Bcc`).
- **Custom headers** map to Postmark's `[{ Name, Value }]` array shape.
- **Custom `messageStream`** — defaults to Postmark's transactional
  stream; override for broadcast.
- **`ErrorCode !== 0` throws** so `@absolutejs/dispatch`'s error path
  runs.

### Tested

12 tests against a mock Postmark client: field mapping, MessageID
roundtrip, defaultFrom fallback, no-From throw, array To csv-join,
cc/bcc/replyTo/htmlBody/headers passthrough, metadata.tag → Tag,
non-string metadata filtered, custom messageStream, ErrorCode != 0
throws, ErrorCode === 0 is success, custom mapMetadata override.

### License

Apache 2.0 (Tier B substrate-adjacent).
