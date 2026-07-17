# Changelog

## 0.0.2

- Preserve the detailed FCM registration error code so hosts can safely retire
  `UNREGISTERED` device tokens without conflating them with payload errors.

## 0.0.1

- Add the FCM HTTP v1 push adapter with ADC/OAuth authentication.
- Support device tokens, topics, conditions, validation-only requests, and
  platform-specific payload sections.
