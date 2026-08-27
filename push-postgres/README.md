# @absolutejs/dispatch-push-postgres

Production persistence for the provider-neutral push lifecycle in `@absolutejs/dispatch`.

The store supports APNs, FCM, and structured Web Push subscriptions. Its schema
is additive: applying the current schema upgrades existing native-only tables,
backfills their credential identity, and keeps native token rows intact.

It stores tenant-isolated device registrations, user/device/topic targeting state, invalid-token retirement, and fenced idempotent fanout claims. Apply both exported schemas, then compose the stores with `createPushLifecycle`.

```ts
import { createPushLifecycle } from "@absolutejs/dispatch";
import {
  createPostgresPushSubscriptionStore,
  createPostgresPushFanoutClaimStore,
} from "@absolutejs/dispatch-push-postgres";
import {
  createPostgresIdempotentOperationStore,
  createPostgresTransactionRunner,
} from "@absolutejs/reliability";

const runner = createPostgresTransactionRunner(pool);
const lifecycle = createPushLifecycle({
  adapterFor: ({ platform, tenant }) => resolveTenantAdapter(tenant, platform),
  claimStore: createPostgresPushFanoutClaimStore(
    createPostgresIdempotentOperationStore(runner),
  ),
  store: createPostgresPushSubscriptionStore(runner),
});
```

Registration is atomic across a stable `(tenant, platform, deviceId)` identity
and provider credential (native token or Web Push endpoint). Credential rotation
retains the subscription identity and removes superseded records inside the same
fenced transaction.
