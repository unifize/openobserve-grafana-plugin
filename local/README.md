# OpenObserve Logs / Show context — local review and rollback

## Run locally

```bash
npm ci
npm run build
docker compose up -d
# Existing demo: refresh fixtures without deleting data.
docker compose run --rm seed
node -e "const d=require('./artifacts/demo.json'); console.log('http://localhost:3000'+d.explore_path)"
```

Grafana: <http://localhost:3000>, local-only login **admin / LocalDemo123!**.
Datasource: `OpenObserve Logs local`. OpenObserve: <http://localhost:5080>,
local-only login **demo@example.com / LocalDemo123!**. Never deploy this demo's
credentials or provisioning to shared Grafana.

- Grafana **12.3.1**; SDK remains 12.2.0. Native layout adapter targets 12.2/12.3.
- OpenObserve **v1.0.4**; ports bind to loopback; images/ports can be overridden.
- Hard-refresh Grafana after rebuilding assets.
- `docker compose down` preserves data. Do not use `down -v` unless intentionally
  deleting the local demo's data.

## Version 1.0.3 behavior

- Scope comes from the clicked log: required `deployment_environment` +
  `service_name`, plus `kubernetes_pod_name` when it is a nonblank string.
- Missing/blank/non-string pod falls back to environment/service, with a visible
  cross-pod notice. It does not infer pod from SQL, namespace, or another field.
  A pod-less stream is supported: fallback SQL does not reference the pod column.
- Original SQL filters, order, limit, and offset are dropped. Only the source
  stream and originating request provenance are reused. Full single-stream
  `SELECT *` source records remain required; joins/projections/aggregations fail clearly.
- Retrieve all matching records in **[selected −60 seconds, selected +60 seconds]**,
  regardless of the original Explore time range. The exclusive API end is +60s+1µs.
- Queries sort ascending on the configured timestamp (normally `_timestamp`),
  preserving microseconds. Select **Oldest first** in Explore for earlier-above /
  selected-center / later-below. Native display order still follows Explore;
  this update does not introduce a custom viewer or change Explore preferences.
- No total-row cap or new volume guardrails. Requests start at `size: 1000` and
  double while full. Only the final complete response is used: no prefix merging,
  OFFSET pagination, or timestamp cursor can skip ties. This is necessary because
  OpenObserve's `size: -1` applies a default 1,000-row limit and marks results partial.
- Identical occurrences and arbitrarily large timestamp ties are retained. Remove
  exactly one selected tuple for the native highlighted line. Equal-time physical
  order is unknown without a stable record ID. Selected-tuple peers get a display-only suffix.
- Body-only neighbors, unchanged original highlighted record, and existing
  oversized-row scrolling/jump controls are retained. If markup is unrecognized,
  use native **Unpin line**. The adapter is scoped to this plugin's own modal.
- Native auto-paging cannot move the fixed window. Errors/partial responses are
  explicit, not silently shown as complete. Closing/reopening after failure retries.
- Large windows can consume substantial backend/browser memory and query time;
  repeated searches also repeat work. Platform timeouts/resource limits still apply.

## Try the fixture

Fixture v5 writes the exact anchor and expected pod-scoped count to
`artifacts/demo.json`. It uses `kubernetes_pod_name`, not the old synthetic `pod` field.

Use this restrictive source query with the generated time range:

```sql
SELECT * FROM "default"
WHERE deployment_environment = 'context-demo'
  AND service_name = 'checkout'
  AND kubernetes_pod_name = 'checkout-a'
  AND body = 'CONTEXT_ANCHOR: checkout accepted'
ORDER BY _timestamp DESC LIMIT 1
```

Select **Oldest first**, then **Log menu → Show context**. Expected:

- 1,394 records including the selected row, all from `checkout-a`.
- 600 dense microsecond neighbors on each side, 150 identical timestamp peers,
  and a second occurrence of the selected tuple.
- `AT_CONTEXT_START` and `AT_CONTEXT_END` included; `OUTSIDE_CONTEXT_*` excluded.
- Other pods/environments/services excluded; original body/severity filters ignored.
- Repeat with a narrow Explore range around the anchor: context still covers ±60s.
- Query `body = 'POD_FALLBACK_ANCHOR'`: cross-pod notice and service-level context.
- Service `dense-window` contains 12,050 records for API checks beyond backend defaults.

## Validation

```bash
npm run test:ci -- src/features/log/contextQuery.test.ts src/features/log/logContext.test.ts
npm run typecheck
npm run lint
npm run build
```

Focused tests cover scope, SQL escaping, fallback, uncapped growth, exact-size
responses, identical occurrences, microseconds, inclusive bounds outside Explore,
partial-response retry, and fixed-window exhaustion. Legacy editor/datasource tests
have separate existing Monaco/Jest compatibility and outdated query expectations;
record full-suite failures rather than calling the entire suite green.

Verified locally (Grafana 12.3.1 / OpenObserve v1.0.4): 33 focused tests, typecheck,
lint (six existing deprecation warnings), and production build. Browser: 1,394
same-pod rows, inclusive endpoints, 150 identical peers, exact ordering of 600
microsecond neighbors on each side, unchanged original highlighted row, and
cross-pod fallback notice. The oversized original needs **Below matched line**
to reveal the native lower loading sentinel. No browser errors. A separate API
check retrieves 12,050 dense-service rows with sizes 1k/2k/4k/8k/16k. Evidence is
local/ignored: `artifacts/context-window-{verified,fallback,dense-api}.json`.

## Package and deploy

The plugin ID stays **`openobserve-logs-datasource`**; existing `openobserve` is untouched.
Bundle-only upgrades keep datasource UID `openobserve-logs`, URLs, credentials,
dashboards, alert rules, and provisioning unchanged.

A GitOps PR in `unifize-infra` updates only:

1. `grafana-config/plugins/openobserve-logs-datasource-1.0.3-v4.tar.gz`.
2. Immutable bundle ConfigMap name and archive path in `grafana-config/kustomization.yaml`.
3. Bundle SHA-256 and mounted ConfigMap name in `grafana/values.yaml`.

The content-addressed ConfigMap name covers the archive plus the unchanged
`existing-openobserve.sha256` guard. Keep the previous archive in Git for rollback.
The old-plugin checksum guard and installer must not be relaxed.

## Rollback

**Bundle rollback is not datasource removal.** Revert the 1.0.3 rollout commit in
`unifize-infra` via a PR to `main`, then sync `grafana-config` before `grafana`.
This restores the known-good 1.0.2-v3 archive, checksum, and immutable ConfigMap
reference. After the normal Grafana rollout, hard-refresh browsers and verify
plugin version 1.0.2. The prior behavior is 100 earlier / 100 later records,
inside Explore's range, scoped to environment/service across pods.

Do **not** delete/recreate the datasource, remove its provisioning, remove the
unsigned-plugin allowlist entry, alter the old `openobserve` plugin, or delete volumes.
The infra PR's rollback document records the exact old/new hashes and paths.

For local-only rollback, extract the preserved 1.0.2-v3 archive into a temporary
directory and replace only the mounted `dist/` contents with that plugin directory;
hard-refresh Grafana. Rebuilding this branch restores 1.0.3. No local database reset
or datasource recreation is needed.
