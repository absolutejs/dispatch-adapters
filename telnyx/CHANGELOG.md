# Changelog

## [0.3.1] — 2026-11-02

- Accept Dispatch 0.8 and 0.9. The peer range stopped below 0.8, so an app on
  Dispatch 0.9 got a second copy for this adapter; the Dispatch types it uses
  are unchanged since 0.7.1, and it is developed against 0.9.1.

## 0.3.0 — 2026-08-01

- Require Dispatch and Compliance 0.7 as the single current ecosystem contract.

## 0.2.0 — 2026-08-01

- Adopt Dispatch 0.6 normalized lifecycle events, delivery-attempt results,
  scheduling, readiness, and registration capabilities.
- Return typed endpoints/content from signed inbound webhooks and preserve the
  complete provider payload behind `providerData`.
- Consume extensible Dispatch transports and Compliance 0.6 consent scopes.

## 0.1.0 — 2026-08-01

- Initial Telnyx SMS, MMS, and direct RCS adapter.
- Add scoped atomic idempotency, Ed25519 webhook verification, durable inbox
  recovery, normalized inbound/delivery events, and consent ingestion.
- Add scheduling cancellation, RCS capability checks, 10DLC/toll-free
  registration workflows, multi-account routing, and readiness diagnostics.
