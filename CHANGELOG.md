# Changelog

## 1.0.3

- Scope log context to the selected Kubernetes pod, falling back to environment/service when unavailable.
- Load the full inclusive ±60-second window, including outside Explore's range, with no total-row cap.
- Preserve microsecond ordering and repeated occurrences; keep native selected-log centering and Explore's display order.
- Continue dropping original search filters. Add focused regression tests and bundle rollback instructions.

## 1.0.0 (Unreleased)

Initial release.