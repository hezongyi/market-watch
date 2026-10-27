# Stage 1 Contract Boundaries

Branch: `refactor/runtime-alert-boundaries-20261027`, based on stage 1A commit `c39455d6`.

## Changes

- Shared ChartAlert application writes accept only `composite`; HTTP and MCP reject legacy `managed`/`provider` create or edit requests before resolving provider metadata or creating a provider cache demand.
- Legacy capability queries remain readable but mark those sources unavailable with a retirement reason, so the alert editor does not offer writes that the server rejects.
- Existing legacy records remain readable. Their application lifecycle is restricted to pause/archive. The runtime scheduler pauses any still-active legacy rule, records a retired-source health reason, and does not enter its old evaluation path.
- Fixed-history export limits now raise transport-neutral `QueryError(413, ...)`. Pending exports still return normally so the owning transaction commits indicator requests.

## Verification

- Targeted local tests: `test_chart_alert_api.py`, `test_chart_alert_worker.py`, `test_chart_alert_geometry.py`, `test_series_access.py`, and `test_composite_alerts.py`: 55 passed.
- Ruff passed for all changed Python modules and tests.
- `compileall` and `git diff --check` passed.
- MCP adapter tests are updated but not run locally because the available shared Python environment lacks the `mcp` SDK. The PR Backend CI must provide the authoritative adapter/full-suite result.
- No schema or persisted format changed. No production database, deployment, or runtime was touched.

## Compatibility Boundary

The `AlertConfig` contract continues to parse `managed` and `provider` so historical configurations can be inspected and paused/archived. New writes use the shared application guard, and the long-running worker enforces retirement in `step()`. Direct calls to the lower-level `evaluate()` helper remain available to preserve focused legacy algorithm fixtures; production scheduling calls `step()`.
