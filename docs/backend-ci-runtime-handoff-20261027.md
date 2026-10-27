# Backend CI Runtime Handoff

Date: 2026-10-27

## Goal

Reduce the wall-clock time of backend CI in a separate change from the active runtime PR. Keep the full backend test suite as required pre-merge coverage. The preferred route is to identify the slow tests, then parallelize or shard only after PostgreSQL test isolation is understood.

## Repository Baseline

- Base branch: `main` at `78697159067e1c1bc6c38be8ca8218cd12c29179`.
- Current runtime work is in `/home/quant/repos/market-watch-runtime-switch-20261027`, branch `refactor/managed-realtime-switch-20261027`; do not edit that worktree.
- CI changes belong on branch `ci/backend-runtime-speed-20261027`, worktree `/home/quant/repos/market-watch-ci-backend-20261027`.
- Workflow: `.github/workflows/ci.yml`.
- Backend suite root: `backend/tests`; `pyproject.toml` sets it as pytest's default test path.
- There are 265 backend test files.

## Evidence

- Workflow step `Python tests` runs `python -m pytest -q` whenever backend code, migrations, or relevant dependency inputs change.
- On successful run `40453799935`, backend job ran 23m overall. The full pytest step took 21m44s. Dependency installation took 23s; tooling checks took 8s. Two PostgreSQL tests were then repeated after the full suite and took 4s and 13s, respectively. Removing those duplicate executions saves about 17s only.
- Current PR #103 run `40488025175` failed in `Python tests` after 20m52s: 65 failed, 3,078 passed, 3 skipped, and 7 errors in 1,238.53s. The two subsequent dedicated PostgreSQL steps were skipped. Treat these failures as a separate current test baseline issue; do not mask or fix product behavior as part of a performance change without first proving its relation.
- PR #103 head was `5e6b2af244a711499492e16f17c57948c3f08b88`; CI ran against the PR merge ref. Reproduce against the exact run commit when investigating the failing test baseline.

## Current Implementation Status

- This work is isolated to `ci/backend-runtime-speed-20261027`; the runtime PR worktree was not changed.
- The proposed workflow now runs the complete backend suite with `python -m pytest -q -n 2 --dist=loadfile`. `pytest-xdist==3.8.0` and `execnet==2.1.1` are pinned in `requirements.lock`; the development extra declares `pytest-xdist>=3.8,<4`. The two redundant post-suite invocations were removed.
- The PostgreSQL isolation audit found that the shared `provider_pg`, chart-alert, managed-revision, and publication-migration fixtures create UUID-named schemas and drop them in teardown. The backup test creates UUID-named databases. The direct default-database publication-wakeup test only exercises `LISTEN`/`NOTIFY`; the database-JIT tests only inspect connection settings. This supports a two-worker experiment, but xdist safety is not established until the full parallel suite passes.
- A serial profile was started on `main` with PostgreSQL 14.24 using `python -m pytest -q --durations=50`. It ended with `KeyboardInterrupt` after 2,778 passed and 3 skipped in 2,549.16s (42m29s), at about 89% progress. This is an incomplete run, not a passing full-suite baseline. The slowest observed tests were `test_shared_composite_quote_cost[8-M1-True]` (45.10s), `[1-M1-True]` (33.61s), `test_small_native_demand_materializes_bounded_rows_in_large_pg_cache` (29.87s), `test_two_large_task_blocks_stay_warm_without_exceeding_memory_budget` (25.43s), and `test_pause_resume_cancel_restart_and_locked_queue_backpressure` (19.10s). The profile indicates cost is distributed across multiple real database/scheduling tests rather than the two redundant checks.
- Local validation and xdist timing are pending. The task-owned PostgreSQL service at `127.0.0.1:19645` was handed to the parent agent for PR #103 contract testing; wait until that use is complete before running the parallel suite.
- Workflow YAML parsing, Ruff on the change-classification script/tests, all 14 change-classification unit tests, and `git diff --check` passed before the Draft PR was opened.

## Requested Work

1. Capture a test duration profile for the backend suite (for example, `pytest --durations=50`) and identify whether wall time is concentrated in a few tests, PostgreSQL fixture setup, process startup, or broad serial database work.
2. Audit PostgreSQL test fixture isolation and shared resources before enabling `pytest-xdist` or splitting PostgreSQL tests across workers. Verify each worker/schema can run concurrently without collisions and that tests relying on cross-test ordering are absent.
3. Implement the smallest change that materially reduces CI wall time while retaining complete pre-merge test coverage. Consider job sharding or a small, measured xdist worker count only after the audit. Do not switch to changed-files-only testing as a replacement for the full required suite.
4. Remove the two redundant post-suite test invocations if their assertions are already exercised in the full suite, but treat this only as cleanup, not the main performance result.
5. Compare before/after CI wall time and confirm the exact full test inventory still runs. Report test and runner cost tradeoffs.

## Validation and Stop Conditions

- Run focused timing/profile experiments before changing workflow behavior.
- Validate the workflow syntax and change-classification tests.
- Complete a non-interrupted baseline profile if feasible, then run the exact full backend suite under the proposed execution mode; no skipped or dropped required tests may be counted as a pass.
- Run any required backend/PostgreSQL CI checks on the new head and record duration.
- Stop before merge, formal tagging, or production deployment.
- If the current PR #103 failures cannot be separated from CI/runtime changes, report that evidence and keep the optimization isolated; do not alter PR #103.

## Initial Decision

The existing actionable low-risk cleanup is worth including, but the substantive work is duration profiling and a verified parallel/sharded full-suite run. Preserve the full suite as a required gate.
