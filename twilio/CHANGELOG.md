# Changelog

## [0.0.1] — 2026-05-30

Initial preview. Twilio-backed `SmsAdapter` for `@absolutejs/dispatch`.

### Surface

- **`createTwilioAdapter({ client, defaultFrom?, messagingServiceSid?, statusCallback? })`** —
  returns an `SmsAdapter`.
- **`TwilioClientLike`** — minimal subset of Twilio's client
  (`messages.create`); keeps `twilio` a true peer dep.
- **Sender precedence**: `message.from` > `defaultFrom` >
  `messagingServiceSid`. At least one must be set; otherwise the
  adapter throws.
- **`statusCallback`** option threads Twilio's delivery-status webhook
  URL through every send.
- **Error mapping**: SDK throws propagate. Response-level errors
  (`errorCode != null`, the bulk-send case) ALSO throw.

### Tested

11 tests against a mock Twilio client: field mapping, SID roundtrip,
per-call from override, messagingServiceSid fallback, from beats
service, no-sender throw, statusCallback passthrough, SDK throw
propagates, errorCode in response throws, errorCode null treated as
success, missing sid graceful.

### License

Apache 2.0 (Tier B substrate-adjacent).
