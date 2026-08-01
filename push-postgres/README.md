# @absolutejs/dispatch-push-postgres

Production persistence for the provider-neutral push lifecycle in `@absolutejs/dispatch`.

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
and the provider token. Token rotation retains the subscription identity and
removes any superseded token record inside the same fenced transaction.
