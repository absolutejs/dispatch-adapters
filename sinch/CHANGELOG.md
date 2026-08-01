# Changelog

## 0.2.0 — 2026-08-01

- Use registered Conversation webhooks instead of per-message callback
  overrides so readiness and HMAC secret validation cover the same path.
- Separate authenticated durable callback intake from retryable consent and
  application effects, and deduplicate provider retries independently of the
  signature nonce.
- Accept WhatsApp business-scoped user IDs and reject undocumented Viber
  Business sender overrides.
- Add selectable US/EU/BR Conversation wiring and a concrete OAuth-backed
  Sinch Registration/Numbers API client for 10DLC and toll-free workflows.

## 0.1.0 — 2026-08-01

- Add the official Sinch Conversation API adapter for SMS, MMS, RCS,
  WhatsApp, Viber Business, Messenger, Instagram, Telegram, KakaoTalk, LINE,
  and WeChat with ordered channel-priority fallback.
- Add shared atomic idempotency, raw-body HMAC webhook verification, durable
  recovery, normalized delivery/inbound/interaction events, and consent
  ingestion including explicit SMS STOP/START handling.
- Add multi-project tenant routing, channel-specific recipient identity
  resolution, live application/webhook readiness, asynchronous channel
  capability lookup, rich generic messages, templates, privacy-aware dispatch
  mode, complete 10DLC workflows, and toll-free verification.
