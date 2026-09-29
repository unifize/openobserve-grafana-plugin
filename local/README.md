# OpenObserve Logs / Show context V1 — local review

```bash
npm ci
npm run build
docker compose up -d
node -e "const d=require('./artifacts/demo.json'); console.log('http://localhost:3000'+d.explore_path)"
```

Open the printed Explore URL. Grafana: <http://localhost:3000>, login
**admin / LocalDemo123!**. Datasource `OpenObserve Logs local`, organization/stream
`default`, SQL mode on. Local-only credentials; ports bind to loopback.

```sql
SELECT * FROM "default"
WHERE deployment_environment = 'context-demo'
  AND service_name = 'checkout'
```

The seed writes the exact UTC range and direct Explore link to
`artifacts/demo.json`. Select **Oldest first** for ascending time; Grafana 12.2's
native modal may retain the old sort until Explore is reloaded. In 12.3.1, use
**Search logs** to locate `CONTEXT_ANCHOR: checkout accepted`, then open its
**Log menu → Show context** (12.2 also exposes a hover action). Expect 201 rows,
records originating from all three checkout pods, both identical twins, and no
excluded environments/services. Fixture v4 uses the real `body` field. Choose the
`checkout-a` anchor: its large `debug_metadata` reproduces the wrapped-row problem.
The second anchor shares its projected fields but has different original metadata;
its separate occurrence must remain. An empty body and multiline neighbors are
also included.
`AT_START` and `JUST_INSIDE_END` demonstrate bounded context near range edges.
The original API range is start-inclusive/end-exclusive.

You can also run `SELECT * FROM "default"` without environment/service filters.
Explore will show the centralized stream, but **Show context** on the anchor still
returns only its `deployment_environment = 'context-demo'` and
`service_name = 'checkout'`, across pods. These values come from the selected log,
not from defaults or mandatory query text. Even a query restricted to
`severity = 'ERROR' AND pod = 'checkout-a' AND body LIKE 'CONTEXT_ANCHOR:%'`
must show surrounding records from all three matching pods. Pod and severity
metadata are not fetched/displayed by the new body-only context projection.

## Versions / lifecycle

- Grafana **12.3.1**, matching the version reported by
  `https://watch.unifize.com/api/health`; override `GRAFANA_VERSION` and optionally
  `GRAFANA_IMAGE`. SDK packages remain at 12.2.0; no dependency upgrade.
- OpenObserve **v1.0.4**; override `OPENOBSERVE_IMAGE` with a full tagged image.
- Seed helper **python:3.12.11-alpine3.22**; override `SEED_PYTHON_VERSION`.
- Override `GRAFANA_PORT` / `OPENOBSERVE_PORT` if needed.
- Compose/metadata originally targeted 9.3.8. Metadata now requires 12.2–12.x;
  the deployed 12.3.1 version was confirmed read-only. Legacy 9.3.8 E2E
  dependencies remain untouched and unused for this phase.
- Rebuild with `npm run build`, then hard-refresh Grafana (plugin assets cache).
- For an existing demo, run `docker compose run --rm seed` to load the larger
  100-per-side fixture set. Open the updated link in `artifacts/demo.json`.
  Old local records are retained; the refreshed demo uses a new time window.
- `docker compose down` stops the demo and preserves data. To generate a fresh
  time range, `docker compose down -v` **deletes this demo's data**, then start again.
- OpenObserve UI: <http://localhost:5080>, `demo@example.com / LocalDemo123!`.

## V1 boundaries

The original Explore query must return complete log rows from single-stream
`SELECT *`. Context searches themselves select only the configured timestamp,
`body`, `deployment_environment`, and `service_name`. Neighbors display body;
normal Explore and the native highlighted middle row remain unchanged.
Original `WHERE`, `ORDER BY`, `LIMIT`, and `OFFSET` clauses do not constrain context.
Unsupported projections/joins/aggregations return an explanation without a search.
Resolved SQL, organization, stream selection, and original range are attached to
each result frame; requests reuse the authenticated proxy. Only the source stream
is taken from the SQL. Scope values come exclusively from the selected log's exact
`deployment_environment` and `service_name`; all original SQL filters are ignored.
Neither field is inferred from pod, namespace, or another field. Missing, blank,
or non-string scope fields produce an explanation without issuing context requests.

The native viewer auto-loads; V1 stops at 100 per side and displays an explicit cap
notice. Equal-timestamp peers count toward the earlier side. With no stable
record ID, tie order/cutoff selection is unspecified; more than 100 anchor peers
produces an explicit error rather than silently losing them. The selected tuple
is matched using the same four projected fields; exactly one occurrence is removed
for the native middle row. Remaining occurrences are never collapsed. Other original
metadata and physical identity cannot be recovered from this projection. Peers
identical to the selected tuple receive a display-only occurrence suffix. A missing
selected tuple fails clearly. Timestamps and backend records are not fabricated.

## Wrapped-row scrolling

A matched row taller than 60% of the viewport scrolls normally instead of staying
sticky over context. **Above matched line** and **Below matched line** jump past
its original full record, regardless of time sort order. Short rows retain native
pinning. The adapter observes wrapping/resizing and restores styles on close.

This is a guarded DOM workaround for Grafana 12.2/12.3 markup, verified on 12.3.1,
not a public layout API. It only touches the notice's own modal, does not mutate
Grafana's shared row or native pin state, and may leave the native pin indicator
on for oversized rows. Unknown markup falls back to native behavior; use
**Unpin line** manually. Other datasources receive no styling changes.

## Side-by-side installation / rollback

This build is a separate, logs-only plugin: **OpenObserve Logs**, ID
`openobserve-logs-datasource`. It does not replace `openobserve` or change existing
logs/metrics datasource UIDs. Logs volume remains supported by the new plugin.
Prepared local archive: `artifacts/openobserve-logs-datasource-1.0.2-v3.tar.gz`
with a sibling `.sha256` checksum file. Its only top-level directory is the new
plugin ID; it contains no datasource provisioning or demo credentials.

For a shared Grafana trial, add the new plugin directory alongside the existing
one, append `openobserve-logs-datasource` to the unsigned-plugin allowlist, and
create a **new, non-default datasource** pointing to the existing OpenObserve.
Use approved/read-only credentials; do not deploy the local demo provisioning or
credentials to watch.unifize.com. Leave old datasources, dashboards, alert rules,
plugin files, and provisioning unchanged.

For a bundle-only upgrade or rollback, change only the bundle and checksum/ConfigMap
references. Keep the existing `openobserve-logs` datasource; do not recreate it.

Removing the entire trial means removing the test datasource and plugin installation/config,
then restarting Grafana replicas and refreshing browsers. Keep the previous Helm/
deployment configuration. Do not delete shared plugin volumes or modify the old
plugin directory. V1 was deployed through `unifize-infra` PR #221; updated bundles
require a separate GitOps rollout. Removing provisioning alone does not delete the
new datasource's database record: rollback must explicitly delete only that UID.

Separate identity reduces replacement risk, but Grafana rollout/restart and shared
OpenObserve query load remain. Each context view issues three searches (limits
100, 100, 102), displaying at most 201 rows. No OpenObserve writes or Grafana database
migrations are introduced by this feature.

Optional local coexistence setup (this workspace's previous local artifact and
both datasource definitions were preserved under ignored `artifacts/`):

```bash
docker compose -f docker-compose.yaml -f local/compose.side-by-side.yaml up -d
```

The override requires `artifacts/openobserve-existing-plugin/` and
`artifacts/side-by-side-provisioning/datasources/`; it is for local comparison,
not a production installation manifest. The standard Compose command above starts
only the new plugin on a fresh checkout.

## Checks performed

Production build, typecheck, lint: pass (six pre-existing lint warnings).
Grafana 12.3.1 local coexistence: both plugin IDs registered, both datasource
queries/histograms worked concurrently, and the preserved old plugin checksums
and full datasource configuration were unchanged. New datasource is non-default.
Earlier 1.0.0/1.0.1 builds, Chrome: native viewer with 201 chronological rows
(100 before / selected / 100 after), exact microseconds and original time range,
three matching pods, exclusions, both identical twins, and no extra requests when
scrolling past the cap. Ordinary queries/histogram work (230 scoped matches).
The unfiltered query matches 352 records (ordinary results are capped at 300),
but its anchor context still contains only 201 matching environment/service rows.
Those counts describe the earlier fixture, not v4.

Version 1.0.2, Grafana 12.3.1: 200 body-only neighbors plus the unchanged original
selected row, from a restrictive source query. Main Explore display is unchanged. Verified wrapped
mouse-wheel scrolling, above/below jumps, resize, sticky restoration when unwrapped,
and style cleanup on close. All three searches request exactly the four projected
columns, retain the exact original range/scope, and omit source SQL filters. Both
identical twins, the projected-identical peer, and an empty body remain visible.
No browser errors. Evidence: `artifacts/context-v3-body-wrap.json`, its screenshot,
and `artifacts/context-v3-layout-lifecycle.json`. Missing either scope field still
issues zero context requests. Missing selected tuples and wrong-scope responses
fail clearly (`artifacts/context-v3-guards.json`). Range-edge checks show 101 rows
at start and just inside the end, with normal short-row pinning retained
(`artifacts/context-v3-range-edges.json`).

Version 1.0.1 browser checks use the live schema's `deployment_environment` field.
Unfiltered `SELECT *` shows 201 scoped rows. A query filtered to one ERROR on one
pod/message, with `ORDER BY ... LIMIT 1`, still shows 201 chronological context
rows: the selected ERROR and 200 INFO records, across all three matching pods.
All three context requests omit the original SQL filters and retain the original
API time bounds. Removing either required scope field from a browser-injected
response blocks all context requests, even when both values appear in the SQL.
Evidence: `artifacts/context-v2-unfiltered.json`,
`artifacts/context-v2-filters-ignored.json`, `artifacts/context-v2-missing-scope.json`,
and the sibling unfiltered/filters-ignored screenshots.

Earlier V1 browser checks also covered range edges, two-query isolation,
aggregation refusal, simulated empty responses, API failure/retry, different
selected environments/services, missing scope fields without context requests,
and safely escaped quoted values (browser-injected sample rows).
No automated tests added or run.

Local evidence (ignored by Git): `artifacts/show-context.png`,
`artifacts/explore-histogram.png`, `artifacts/context-requests.json`,
`artifacts/context-rendered.json`, `artifacts/context-from-unfiltered-query.png`,
`artifacts/context-from-unfiltered-requests.json`, `artifacts/openobserve-side-by-side.png`,
`artifacts/openobserve-datasources.png`, `artifacts/openobserve-logs-context.png`.
All records are synthetic. The legacy snapshot is the prior local build, not a
copy of the plugin installed on watch.unifize.com.
