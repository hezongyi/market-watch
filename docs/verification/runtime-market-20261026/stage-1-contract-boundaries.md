# Stage 1 Contract Boundaries

Branch: `refactor/runtime-alert-boundaries-20261027`, based on stage 1A commit `c39455d6`.

This Draft PR is a stage 1 boundary slice, not completion of stage 1 or the runtime migration. It is F1 because it changes a persistent alert lifecycle and an important background acquisition path. Minimum checks are HTTP/MCP/application contracts, real PostgreSQL locking and evidence preservation, provider-browser compatibility, pending-export persistence, CI, and independent Standards/Spec reviews. No schema migration is required.

## Changes

- Shared ChartAlert application writes accept only `composite`; HTTP and MCP reject legacy `managed`/`provider` create or edit requests before resolving provider metadata or creating a provider cache demand.
- Legacy capability queries remain readable but mark those sources unavailable with a retirement reason, so the alert editor does not offer writes that the server rejects.
- Existing legacy records remain readable. Their application lifecycle is restricted to pause/archive. The runtime scheduler pauses any still-active legacy rule, records a retired-source health reason, and does not enter its old evaluation path.
- The scheduler locks each rule with `FOR UPDATE SKIP LOCKED`. A locked or no-longer-active rule emits no completed-evaluation observation. Concurrent monitors retire a legacy rule only once and preserve its versions, run, count, state, runtime, signal evidence, and delivery records.
- Provider realtime acquisition no longer scans legacy alerts for main-frame or independent ATR demand, including before a monitor first pauses the rule. Browser interests still acquire bars; historical alert references still protect evidence caches during cleanup.
- Fixed-history export limits now raise transport-neutral `QueryError(413, ...)`. Pending exports still return normally so the owning transaction commits indicator requests.

## Verification

- Ubuntu local Docker, fixed read-only test image `sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743`. Tests mount this worktree read-only; the image supplies the locked dependencies, including the MCP SDK.
- Targeted contract suite: **169 passed** across `test_alert_monitor_cadence.py`, `test_provider_service.py`, `test_chart_alert_capabilities.py`, `test_live_api.py`, `test_chart_alert_offsets.py`, `test_chart_alert_api.py`, `test_chart_alert_worker.py`, `test_chart_alert_geometry.py`, `test_series_access.py`, and `test_composite_alerts.py`.
- After the review fixes, capabilities, worker, and cadence suites: **29 passed**. This includes a valid composite geometry/association request, invalid association/geometry rejection, composite HTTP/MCP writes and lifecycle/idempotency, and legacy read/pause/archive behavior.
- Two additional HTTP/MCP managed/provider cases passed with dataset resolution replaced by a failing sentinel: both create and edit reject the source before metadata resolution or possible supplier I/O and leave no rule, operation, or outbox row.
- PostgreSQL contract suites: initially **68 passed, 10 failed**; all failures were the ATR wrapper's stale renamed-function reference. After fixing that reference, the 10 failed cases plus concurrent retirement and a new held-lock observation regression: **12 passed**. This covers **79 distinct PostgreSQL cases** overall, without counting repeated cases twice. Other PostgreSQL suites were `test_composite_alerts_postgres.py` and `test_series_access_postgres.py`.
- PostgreSQL is task-owned `mw-runtime-1b-postgres`, `postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`, on internal network `mw-runtime-1b-20261027`. Data is synthetic, in tmpfs, with no persistent volume or host port. Fixtures create/drop unique schemas. No shared writable test database is used.
- Test clients use one CPU and 1024 MiB; PostgreSQL uses one CPU and 768 MiB. Existing unrelated containers remain running. Before creating the database, local disk had approximately 24 GiB free and available memory approximately 6 GiB; swap was full, so no full-stack instance or candidate rebuild was started.
- Ruff and `git diff --check` passed for the changed files. Independent Standards/Spec reviews found the stale test reference, inconsistent geometry fixture, and false completed-evaluation observation; all three were corrected and statically rechecked with no remaining findings.
- Full GitHub CI is tracked on Draft PR #102 for the final pushed commit. Local contract verification does not stand in for pending CI or the plan's combined R2 acceptance.
- No schema or persisted format changed. No production database, deployment, or runtime was touched.

Reproduction uses the image above, `PYTHONPATH=/candidate/backend`, `PYTHONDONTWRITEBYTECODE=1`, and `python -m pytest -q -p no:cacheprovider` with the named suites. Ordinary clients run with `--network none`; PostgreSQL clients use only the internal task network and `TEST_POSTGRES_URL` / `CHART_ALERT_TEST_DATABASE_URL` pointing to the synthetic `runtime_contracts` database. The held-lock test has a bounded timeout and checks that evaluation resumes exactly once after unlocking.

## Compatibility Boundary

The `AlertConfig` contract continues to parse `managed` and `provider` so historical configurations can be inspected and paused/archived. New writes use the shared application guard, and the long-running worker enforces retirement in `step()`. Direct calls to the lower-level `evaluate()` helper remain available to preserve focused legacy algorithm fixtures; production scheduling calls `step()`.

The existing provider capability/dispatch modules remain the common registry; this slice adds no parallel registry or plugin framework. Provider browser interests, pagination, and cache-reference protection remain covered by provider and ATR contracts.

The next stage 1 slice must finish the per-managed-instrument realtime switch and its composite query/alert eligibility semantics. The existing `ChartHistoryPlan.realtime_enabled` flag alone does not prove this contract: current pricing-target discovery and composite snapshots do not consistently consult it. Stage 2 owner/profile migration remains gated on that work. Five/six-service combined R2 and API-offline latency acceptance, track C shadow/activation/restore gates, and A17b phone acceptance have not been performed by this PR.
