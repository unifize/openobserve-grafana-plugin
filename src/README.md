<!-- This README file is going to be the one displayed on the Grafana.com website for your plugin -->

# OpenObserve Logs

Standalone logs datasource with native Grafana Explore context (V1).
Plugin ID: `openobserve-logs-datasource`. Install alongside `openobserve` and use
it through a new datasource; existing logs/metrics datasources are not replaced.
Context uses `deployment_environment` and `service_name` from the selected log,
not the SQL. Original SQL filters are ignored, so surrounding logs can differ in
message, severity, and pod. Up to 100 records before and 100 after are shown
inside the original Explore time range and source stream.

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
