"""Seed the local Compose demo; standard library only, not a test suite."""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = os.environ.get("OPENOBSERVE_URL", "http://openobserve:5080")
if urllib.parse.urlparse(URL).scheme not in ("http", "https"):
    raise ValueError("OPENOBSERVE_URL must use http or https")
AUTH = base64.b64encode(b"demo@example.com:LocalDemo123!").decode()
STATE = Path("/state/demo.json")
FIXTURE_VERSION = 5


def request(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    # URL is restricted to HTTP/HTTPS above; endpoints are fixed by this seed CLI.
    req = urllib.request.Request(URL + path, data=data, headers={  # noqa: S310
        "Authorization": "Basic " + AUTH,
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=20) as response:  # noqa: S310
        try:
            return json.load(response)
        except json.JSONDecodeError as error:
            raise RuntimeError("Local OpenObserve returned invalid JSON") from error


def iso(micros):
    return datetime.fromtimestamp(micros / 1_000_000, timezone.utc).isoformat()


def seed():
    # Anchor has non-zero microseconds, intentionally lost by millisecond-only UI.
    anchor = (time.time_ns() // 1_000_000_000 - 180) * 1_000_000 + 123456
    start = (anchor // 1_000_000 - 120) * 1_000_000
    end = (anchor // 1_000_000 + 120) * 1_000_000
    logs = []

    def add(timestamp, message, pod: str | None = "checkout-a", environment="context-demo",
            service="checkout", **extra):
        logs.append({
            "_timestamp": timestamp,
            "deployment_environment": environment,
            "service_name": service,
            "kubernetes_pod_name": pod,
            "severity": "ERROR" if message.startswith("CONTEXT_ANCHOR:") else "INFO",
            "body": message,
            **extra,
        })

    for offset in range(-110, 111):
        message = ("CONTEXT_ANCHOR: checkout accepted" if offset == 0
                   else f"{'EARLIER' if offset < 0 else 'LATER'} {offset:+04d}")
        extra = {}
        if offset == 0:
            # Reproduce the production wrapped/pinned-row obstruction. This
            # metadata must remain in Explore, but never in projected neighbors.
            extra["debug_metadata"] = "SYNTHETIC_EXTRA_FIELD_NOT_IN_CONTEXT " * 240
        if abs(offset) == 50:
            message += "\n" + "\n".join(
                f"stack frame {i}: " + "wrapped body text " * 8 for i in range(12)
            )
        add(anchor + offset * 1_000_000, message,
            pod=["checkout-a", "checkout-b", "checkout-c"][offset % 3], **extra)
    # Same projected tuple, different original metadata: retain its occurrence.
    add(anchor, "CONTEXT_ANCHOR: checkout accepted", pod="checkout-a")
    # Uncapped context: exceed both the old 201 rows and common 1000-row defaults.
    for offset in range(1, 601):
        add(anchor - offset, f"DENSE_BEFORE {offset:04d}")
        add(anchor + offset, f"DENSE_AFTER {offset:04d}")
    for _ in range(150):
        add(anchor, "IDENTICAL_TIE: retain every occurrence")
    for offset, message in [
        (-60_000_001, "OUTSIDE_CONTEXT_START"),
        (-60_000_000, "AT_CONTEXT_START"),
        (60_000_000, "AT_CONTEXT_END"),
        (60_000_001, "OUTSIDE_CONTEXT_END"),
    ]:
        add(anchor + offset, message)
    add(anchor + 2, "POD_FALLBACK_ANCHOR", pod=None)
    # Separate service for API verification beyond a typical backend 10k default.
    for offset in range(12_050):
        add(anchor + offset, f"UNLIMITED_API {offset:05d}", service="dense-window")
    add(anchor + 52_000_000, "", pod="checkout-c")
    add(anchor, "EQUAL_TIMESTAMP: different pod", pod="checkout-b")
    add(anchor, "EQUAL_TIMESTAMP: different pod", pod="checkout-c")
    # Two physically separate but fully identical records must not be collapsed.
    add(anchor, "IDENTICAL_TWIN: keep both", pod="checkout-b")
    add(anchor, "IDENTICAL_TWIN: keep both", pod="checkout-b")
    add(anchor - 1, "ONE_MICROSECOND_BEFORE", pod="checkout-c")
    add(anchor + 1, "ONE_MICROSECOND_AFTER", pod="checkout-b")
    for offset in range(-30, 31):
        add(anchor + offset * 1_000_000, "EXCLUDED_ENVIRONMENT",
            environment="another-environment")
        add(anchor + offset * 1_000_000, "EXCLUDED_SERVICE",
            service="another-service")
    for timestamp, message in [
        (start - 1, "OUTSIDE_START"), (start, "AT_START"),
        (start + 1, "JUST_INSIDE_START"), (end - 1, "JUST_INSIDE_END"),
        (end, "AT_END"), (end + 1, "OUTSIDE_END"),
    ]:
        add(timestamp, message, pod="checkout-c")

    result = request("/api/default/default/_json", logs)
    statuses = result.get("status", [])
    if not statuses or any(s.get("failed", 0) for s in statuses):
        raise RuntimeError(f"Ingestion failed: {result}")
    sql = ('SELECT * FROM "default" WHERE '
           "deployment_environment = 'context-demo' "
           "AND service_name = 'checkout'")
    context_records = [record for record in logs
                       if record["deployment_environment"] == "context-demo"
                       and record["service_name"] == "checkout"
                       and record["kubernetes_pod_name"] == "checkout-a"
                       and abs(record["_timestamp"] - anchor) <= 60_000_000]
    return {
        "fixture_version": FIXTURE_VERSION,
        "expected_pod_context_records": len(context_records),
        "sql": sql, "from": iso(start), "to": iso(end),
        "anchor_microseconds": anchor,
        "event": "CONTEXT_ANCHOR: checkout accepted",
        "records_seeded": len(logs),
    }


def explore_path(demo):
    pane = {
        "datasource": "openobserve-logs-local",
        "queries": [{
            "refId": "A",
            "datasource": {
                "type": "openobserve-logs-datasource",
                "uid": "openobserve-logs-local",
            },
            "query": demo["sql"], "sqlMode": True, "organization": "default",
            "stream": "default", "displayMode": "logs",
        }],
        "range": {
            "from": str(round(datetime.fromisoformat(demo["from"]).timestamp() * 1000)),
            "to": str(round(datetime.fromisoformat(demo["to"]).timestamp() * 1000)),
        },
    }
    return "/explore?" + urllib.parse.urlencode({
        "schemaVersion": 1, "panes": json.dumps({"demo": pane}), "orgId": 1,
    })


for _attempt in range(90):
    try:
        request("/healthz")
        break
    except (urllib.error.URLError, TimeoutError):
        time.sleep(2)
else:
    raise RuntimeError("Local OpenObserve did not become ready within 3 minutes")

try:
    demo = json.loads(STATE.read_text()) if STATE.exists() else {}
except (OSError, json.JSONDecodeError) as error:
    raise RuntimeError("Cannot read demo state; refusing to reseed automatically") from error
if demo.get("fixture_version") != FIXTURE_VERSION:
    # Refresh the demo window when fixtures change; retain existing local logs.
    demo = seed()
# Refresh routing independently of the fixtures; changing plugin identity must not reseed.
demo["explore_path"] = explore_path(demo)
STATE.write_text(json.dumps(demo, indent=2) + "\n")
Path("/artifacts/demo.json").write_text(json.dumps(demo, indent=2) + "\n")
print(json.dumps(demo, indent=2))
