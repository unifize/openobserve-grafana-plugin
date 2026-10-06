<!-- This README file is going to be the one displayed on the Grafana.com website for your plugin -->

# OpenObserve Logs

Standalone logs datasource with native Grafana Explore context (V1).
Plugin ID: `openobserve-logs-datasource`. Install alongside `openobserve` and use
it through a new datasource; existing logs/metrics datasources are not replaced.
Context uses `deployment_environment`, `service_name`, and (when present)
`kubernetes_pod_name` from the selected log, never from the SQL. Without a valid
pod, it falls back to environment/service with a visible cross-pod notice.
Original SQL filters are ignored, so surrounding logs can differ in message and
severity. All matching records from **60 seconds before through 60 seconds after**
the selected log are loaded, including outside the original Explore range. Both
endpoints are inclusive. There is no row cap or additional volume guardrail in V1.

Context searches use explicit result sizes, starting at 1,000 and doubling only
when a response is full. Only the final complete response is used; no offset or
timestamp cursor can skip identical occurrences. `size: -1` is not used because
OpenObserve applies its default limit. Results use the exact timestamp ascending.
The native viewer keeps the selected log centered
and retains Explore's display order: select **Oldest first** in Explore for earlier
logs above and later logs below. Timestamps retain microsecond precision. Large
windows may take longer and consume significant backend/browser memory.

Context queries select `body` plus exact timestamp and scope metadata. Only
neighboring lines display body; the highlighted original line and main Explore
view are unchanged. Full single-stream `SELECT *` source rows are still required.
Projection-identical occurrences are retained, with a display-only suffix for
peers of the selected tuple; physical identity/order is unknown without a record ID.

Oversized matched rows scroll normally rather than obscuring their neighbors;
above/below jump buttons skip the large original record, regardless of sort order. This guarded layout
adapter targets Grafana 12.2/12.3 native markup, is confined to this datasource’s
modal, and restores styles on close. The native pin indicator may remain on.
If the adapter cannot recognize the markup, use the native **Unpin line** control.

## License

OpenObserve commercial license. Please contact hello@openobserve.ai for more information.
