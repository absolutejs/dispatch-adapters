# Changelog

## 0.7.0 — 2026-08-01

- Require Dispatch and Compliance 0.7 as the single current ecosystem contract.

## 0.6.0 — 2026-08-01

- Adopt Dispatch 0.6 normalized delivery, inbound, consent, scheduling,
  readiness, and registration contracts.
- Normalize webhook endpoints, content, interactions, provider status, errors,
  and account binding while retaining signed provider data explicitly.
- Return structured delivery-attempt results and expose optional operational
  capabilities through the adapter.

## [0.5.0] — 2026-08-01

- Adopt Dispatch's provider-neutral messaging contract with typed endpoints,
  discriminated content, and explicit fallback routes.
- Remove the legacy SMS adapter/message surface.
- Report requested transport in send results and derive RCS fallback behavior
  solely from declared routes.

## [0.4.0] — 2026-08-01

- Replace global idempotency with account/tenant scope, payload fingerprints, fencing, and fail-closed indeterminate outcomes.
- Require checked-out PostgreSQL connections and add real contention gates.
- Add bounded/redacted lifecycle retention, privacy export/purge, recovery workers, and signed Event Streams ingestion.
- Add multi-account webhook credential resolution, token rotation, and Messaging Service allowlists.
- Enforce program/purpose consent across every fallback route and prohibit consent-scoped native schedules.
- Add schedule cancellation/reconciliation, SM/MM support, actual fallback transport, and interactive reply fields.
- Require complete registration workflows and current business, Trust Hub, privacy, and terms fields; surface failure diagnostics.
- Add Toll-Free Compliance Embeddable sessions and explicit RCS approval/opt-out readiness assertions.

## [0.3.0] — 2026-08-01

### Channels

- Add native RCS delivery through Messaging Service sender pools.
- Support automatic SMS/MMS fallback, explicit fallback senders, and
  required-RCS delivery with `rcs:+E164` recipients.
- Add readiness inspection for an RCS sender in the configured service.

### Consent and compliance

- Persist signed Twilio START/STOP events into the provider-neutral
  `@absolutejs/compliance` consent ledger with retry-safe event keys.
- Add typed A2P brand/campaign and toll-free verification submission helpers.
- Add live status inspection for Trust Hub customer profiles, A2P brands and
  campaigns, and toll-free verification.
- Keep every status report explicitly operational, not a legal certification.

## [0.2.1] — 2026-08-01

- Include the repository's Apache 2.0 license text in published artifacts.

## [0.2.0] — 2026-08-01

### Messaging

- Add MMS media, WhatsApp, Twilio Content templates, and scheduled sends.
- Add tenant-specific client, Messaging Service, callback, and sender routing.
- Add atomic memory and Postgres idempotency stores for retry-safe sends.

### Inbound and lifecycle

- Normalize ordinary inbound replies and MMS media alongside delivery and
  Advanced Opt-Out events.
- Bind signed webhooks to a fixed public URL, expected account, and optional
  Messaging Service with bounded request bodies.
- Add a transactional Postgres lifecycle store and installable SQL schemas.

### Readiness

- Inspect the configured Twilio account/service binding, inbound POST URL,
  status callback, sender pool, and optional US A2P attachment via Twilio's API.
- Keep consent, opt-out testing, privacy, and terms as explicit operator
  assertions rather than claiming legal certification.

## [0.1.0] — 2026-07-31

Production messaging lifecycle release. This intentionally replaces the
`0.0.x` preview contract rather than preserving compatibility aliases.

### Sending

- Require a Twilio Messaging Service and an HTTPS status callback for every
  adapter.
- Keep optional per-message sender pinning inside Messaging Service policy.
- Add E.164, Messaging Service SID, callback URL, body, and validity-period
  validation before the provider call.
- Add `smartEncoded` and `validityPeriod` controls.
- Add typed configuration and response-level send errors.

### Signed lifecycle webhooks

- Add framework-neutral Request/Response webhook handling and a lower-level
  processor.
- Validate `X-Twilio-Signature` with the official Twilio SDK using the exact
  public URL and complete form parameter set.
- Normalize outbound delivery states and Advanced Opt-Out `STOP`, `START`, and
  `HELP` events.
- Reject malformed, forged, unsupported, and non-form callbacks before consumer
  code runs.

### Delivery guarantees and readiness

- Add an atomic lifecycle store contract with claim, complete, release,
  deduplication, stale-transition rejection, and abandoned-lease requirements.
- Add a memory store for tests and local development.
- Add an operational readiness report that requires durable lifecycle storage,
  carrier approval, consent evidence, opt-out configuration, privacy policy,
  and messaging terms while explicitly avoiding legal-certification claims.

### Breaking

- Remove `defaultFrom` and the service-or-number fallback model.
- Require `messagingServiceSid` and `statusCallbackUrl`.
- A per-message `from` no longer removes `messagingServiceSid`.

## [0.0.1] — 2026-05-30

Initial preview. Twilio-backed `MessagingAdapter` for `@absolutejs/dispatch`.

### Surface

- **`createTwilioAdapter({ client, defaultFrom?, messagingServiceSid?, statusCallback? })`** —
  returns an `MessagingAdapter`.
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
