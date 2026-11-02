# Changelog

## [0.2.1] — 2026-11-02

- Accept Dispatch 0.8 and 0.9. The peer range stopped below 0.8, so an app on
  Dispatch 0.9 got a second copy for this adapter; the Dispatch types it uses
  are unchanged since 0.7.1, and it is developed against 0.9.1.

## 0.2.0 — 2026-08-01

- Require Dispatch and Compliance 0.7 as the single current ecosystem contract.

## 0.1.0 — 2026-08-01

- Add Vonage Messages API support for SMS, MMS, RCS, WhatsApp, Viber, and
  Facebook Messenger with ordered cross-channel failover.
- Add shared atomic idempotency, signed JWT/raw-payload webhook verification,
  durable recovery, normalized lifecycle economics, and consent ingestion.
- Add multi-account routing, application readiness checks, complete 10DLC
  brand/campaign/number workflows, rich RCS cards/actions, templates, and
  provider extensions.
- Add RCS device capability checks and message revocation plus WhatsApp read
  receipts through the official SDK contract.
