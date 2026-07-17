# @absolutejs/dispatch-fcm

Firebase Cloud Messaging HTTP v1 `PushAdapter` for `@absolutejs/dispatch`.
It uses `google-auth-library` Application Default Credentials by default, so
access tokens remain short-lived and service-account keys do not enter message
payloads or dispatch core.

```ts
import { createDispatcher } from "@absolutejs/dispatch";
import { createFcmAdapter } from "@absolutejs/dispatch-fcm";

const dispatcher = createDispatcher({
  push: createFcmAdapter({ projectId: process.env.FCM_PROJECT_ID! }),
});
```

Use `/topics/name` or `metadata.targetType: 'topic'` for a topic. FCM data
values are normalized to strings as required by HTTP v1. Advanced `android`,
`apns`, and `webpush` objects can be supplied in message metadata.
