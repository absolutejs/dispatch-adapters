# @absolutejs/dispatch-apns

Apple Push Notification service HTTP/2 `PushAdapter` for
`@absolutejs/dispatch`. It signs ES256 provider JWTs, reuses them for fifty
minutes, maintains pooled HTTP/2 sessions, and never exposes the `.p8` key to
dispatch messages or audit metadata.

```ts
import { createDispatcher } from "@absolutejs/dispatch";
import { createApnsAdapter } from "@absolutejs/dispatch-apns";

const apns = createApnsAdapter({
  bundleId: process.env.APNS_BUNDLE_ID!,
  keyId: process.env.APNS_KEY_ID!,
  privateKey: process.env.APNS_PRIVATE_KEY!,
  teamId: process.env.APNS_TEAM_ID!,
});

const dispatcher = createDispatcher({ push: apns });
```

Call `apns.dispose()` during shutdown to drain its HTTP/2 sessions. Use
`environment: 'sandbox'` only for development registrations. Alert, background,
badge, sound, category, collapse, expiration, and mutable-content controls are
available through message metadata.
