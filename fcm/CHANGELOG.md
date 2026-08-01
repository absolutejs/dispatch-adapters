# Changelog

## 0.1.0 — 2026-08-01

- Align the adapter and manifest with the current Dispatch 0.6 contract.
- Publish the first stable push-adapter release with an explicit Apache-2.0
  license artifact.

## 0.0.2

- Preserve the detailed FCM registration error code so hosts can safely retire
  `UNREGISTERED` device tokens without conflating them with payload errors.

## 0.0.1

- Add the FCM HTTP v1 push adapter with ADC/OAuth authentication.
- Support device tokens, topics, conditions, validation-only requests, and
  platform-specific payload sections.
