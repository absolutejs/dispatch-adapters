# AbsoluteJS Dispatch Adapters

Provider implementations for `@absolutejs/dispatch`, covering email, push notifications, SMS, MMS, RCS, WhatsApp, consent workflows, registration, webhooks, and durable push fanout.

## Email

- `@absolutejs/dispatch-postmark`
- `@absolutejs/dispatch-resend`

## Mobile push

- `@absolutejs/dispatch-apns`
- `@absolutejs/dispatch-fcm`
- `@absolutejs/dispatch-push-postgres` for durable device registration and fenced fanout claims

## Omnichannel messaging

- `@absolutejs/dispatch-aws-end-user-messaging`
- `@absolutejs/dispatch-infobip`
- `@absolutejs/dispatch-sinch`
- `@absolutejs/dispatch-telnyx`
- `@absolutejs/dispatch-twilio`
- `@absolutejs/dispatch-vonage`

## Installation

Install the core package and only the providers you use:

```sh
bun add @absolutejs/dispatch @absolutejs/dispatch-resend @absolutejs/dispatch-twilio
```

Each adapter README documents credentials, supported channels, webhook verification, consent requirements, readiness checks, and provider-specific limitations.
