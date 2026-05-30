# @absolutejs/dispatch-twilio

Twilio-backed `SmsAdapter` for
[@absolutejs/dispatch](https://github.com/absolutejs/dispatch).

## Install

```sh
bun add @absolutejs/dispatch @absolutejs/dispatch-twilio twilio
```

## Usage

```ts
import twilio from 'twilio';
import { createDispatcher } from '@absolutejs/dispatch';
import { createTwilioAdapter } from '@absolutejs/dispatch-twilio';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

const dispatcher = createDispatcher({
  sms: createTwilioAdapter({
    client: twilioClient,
    defaultFrom: '+15551234567',
    // OR — instead of a single from number, use a Messaging Service:
    // messagingServiceSid: 'MG...',
    // Optional webhook for status updates (queued → sent → delivered/failed):
    // statusCallback: 'https://hooks.acme.io/twilio',
  }),
});

const result = await dispatcher.sms({
  to: '+12025550100',
  body: 'Your verification code: 482910',
});

console.log(result.id); // Twilio Message SID (SM...)
```

## API

```ts
createTwilioAdapter({
  client,                  // Required — your twilio(sid, token)
  defaultFrom?,            // E.164 origination — required if no service
  messagingServiceSid?,    // Use service-based routing instead of `from`
  statusCallback?,         // Webhook URL for delivery status updates
});
```

### Sender precedence

1. `message.from` (per-call) — always wins
2. `defaultFrom` (adapter option)
3. `messagingServiceSid` (adapter option)

If none are set, the adapter throws.

## Error mapping

Twilio's SDK rejects on most errors (rate limit, invalid number,
account suspended). The adapter lets the rejection propagate so
`@absolutejs/dispatch`'s error path runs (failed counter, ERROR span,
`dispatch.sms.failed` audit).

A returned response with `errorCode != null` is the
bulk-send/queue-rejection case — Twilio doesn't throw but signals
the error in the response. The adapter throws on this too:

```ts
{ errorCode: 21610, errorMessage: 'Recipient unsubscribed' }
// → throws "Twilio errorCode 21610: Recipient unsubscribed"
```

## License

[Apache 2.0](../LICENSE). Tier B substrate-adjacent — rides
`@absolutejs/dispatch` (BSL Tier A) and `twilio` (MIT).
