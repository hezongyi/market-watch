# Stage 4: Runtime Preflight Acceptance

Date: 2026-10-28. Ubuntu local Docker (`/var/run/docker.sock`); no host-accessible address because the task network is internal and no ports are published.

The host-side preflight inspects only explicitly named Compose projects. It blocks a live legacy API or scheduler, ignores non-scheduler services, and fails closed if Docker cannot be queried. It does not read heartbeat freshness as ownership and does not mutate containers.

## Verification

- Pure and CLI-contract tests: `PYTHONPATH=backend python -m pytest -q tests/ops/test_runtime_preflight.py`: **5 passed**.
- Ubuntu Docker contract uses task/project `mw-runtime-preflight-stage4-20261028`, Compose file `deploy/ubuntu/runtime-preflight.acceptance.yaml`, an internal network, two 64 MiB/0.1 CPU containers, no ports, and no volumes.
- Start: `docker compose -p mw-runtime-preflight-stage4-20261028 -f deploy/ubuntu/runtime-preflight.acceptance.yaml up -d --no-build`.
- Conflict check: `python deploy/ubuntu/runtime_preflight.py --project mw-runtime-stage4-candidate --legacy-project mw-runtime-preflight-stage4-20261028` returned 1 and named `notify-worker`.
- Non-scheduler check: after stopping only `notify-worker`, the same command returned 0 while the fixture `postgres` remained running.
- Stop/cleanup: `docker compose -p mw-runtime-preflight-stage4-20261028 -f deploy/ubuntu/runtime-preflight.acceptance.yaml down`.

This verifies local Docker label handling and the conflict policy, not a production project inventory or an actual deployment switch. The operator must supply the verified legacy project list at switch time.

## Switch and rollback runbook

Use this sequence only in the isolated Ubuntu acceptance project until the joint acceptance matrix is signed. Production execution remains separately authorized. Keep the legacy and candidate configuration files, image IDs, Compose project names, and database identity in a private operator record; do not copy secrets into this report.

1. Confirm the candidate Compose file renders to exactly `web`, `api`, `market-runtime`, `data-worker`, `notification-worker`, plus explicitly declared one-shot dependencies. Confirm all three runtime profiles depend on successful migration and not API health. Record candidate image IDs and verify the task-owned PostgreSQL database/volume is the intended one.
2. Record the exact legacy Compose project names from the deployment inventory. Stop the old API and old scheduled workers using that deployment's normal Compose command. Do not remove containers or volumes. Wait for in-flight work to finish and inspect runtime ownership/fencing state.
3. Run `runtime_preflight.py` with the candidate project and every verified legacy project. Continue only on exit 0. Exit 1 means a legacy API/scheduler is still running; exit 2 means the check was inconclusive. Resolve the named conflict or Docker access issue and rerun. This check only observes running containers, so keep the old startup path stopped through the cutover.
4. Start the candidate's database dependency and one-shot migration, then the three runtime groups and API. Start web after API readiness. Do not run old and new schedulers together. Verify each group reports the current boot and healthy loops; feed the isolated acceptance fixture and verify expected input, decision, and notification records have unique IDs and no duplicates. Keep real provider delivery disabled in acceptance.
5. Mark the candidate accepted only after the required API-offline, restart/recovery, notification, and contention checks pass. A running container or healthy API alone is not a successful cutover.

Rollback is an operator action in the acceptance rehearsal, not an automatic preflight behavior. Stop the candidate web/API and all three candidate runtime groups first. Verify they are stopped and that no candidate owner remains active. Confirm the legacy release can read the database schema and persisted formats as they now stand; if compatibility is not established, do not restart old writers against that database. The `v1.29.1-rc.2` legacy image used in this rehearsal cannot parse Alembic revision `az53_notification_outbox_types` (its head is `ay52_history_modes`), so its old migration command must not run against a migrated candidate DB. Restore the recorded legacy configuration without starting that migration, then verify owner identity and business processing. Preserve both projects, logs, database, and evidence if rollback verification fails. Never delete a project, image, or volume as part of this runbook.

## Current rehearsal limits

Before the user-authorized run below, the Ubuntu Docker host had 18 GiB free on the filesystem containing Docker data, below the repository's 23 GiB minimum startup threshold; swap was fully allocated. Several unrelated task-owned acceptance projects were running. No unrelated project was stopped and no unrelated volume was changed. The full Compose expansion is covered by `tests/ops/test_database_compose.py`; destructive old-to-new switching and rollback remain pending.

## Stage-4 five-service acceptance run

The user authorized ignoring the host swap/disk thresholds for this isolated run. Candidate project `mw-runtime-stage4-20261028` was started on Ubuntu local Docker with `deploy/ubuntu/runtime-stage4.acceptance.yaml`, private internal networking, a task-owned PostgreSQL volume, and only `127.0.0.1:18089` published for web. The cached immutable API and web image IDs and the pinned PostgreSQL 14.24 image were present locally. The initial attempt failed before migration because the fixture mounted only `backend/`; after changing it to mount the read-only worktree root, migration completed with exit 0.

- Compose render: `postgres`, one-shot `migrate`, `api`, `market-runtime`, `data-worker`, `notification-worker`, `web`; each runtime group depends only on successful `migrate`, and web depends on API health.
- Startup: PostgreSQL healthy, migration exit 0, API healthy, web returned HTML, all three runtime groups remained running. PostgreSQL reported `server_version_num=140024` and `pg_jit_available()=true` through the health query.
- Role state: market/data/notifications each wrote independent boot IDs and role records. Provider/OANDA, Yahoo, and delivery were explicitly disabled for this acceptance. Therefore `pricing=disabled` and `realtime=degraded` are expected no-source states, not provider-SLA evidence.
- API-offline check: API was stopped for 12 seconds. The market heartbeat audit advanced from id 110 to 114; market-runtime, data-worker, and notification-worker stayed running with exit code 0. API restart reran the successful migration dependency, returned healthy, and web remained reachable; the three ownership roles returned to `idle`.
- Real preflight conflict: `python deploy/ubuntu/runtime_preflight.py --project mw-runtime-stage4-20261028 --legacy-project mw-single-frontend-20261026` returned exit 1 and listed `api` and `notification-projector` from that explicitly named live legacy project. No unlisted project was inspected.

This run proves the candidate five-service startup, API-independent runtime operation, recovery, and live legacy conflict policy in an isolated task. It does not prove real provider delivery, phone receipt, production configuration, or a destructive old-to-new switch. The unrelated legacy project was not stopped; the rollback rehearsal instead used a dedicated old-release simulation attached to the candidate's task-owned database.

## Isolated old/new switch and rollback rehearsal

The legacy fixture `deploy/ubuntu/runtime-stage4-legacy.acceptance.yaml` used the pinned cached `v1.29.1-rc.2` API image and old `market-stream`, `notification-projector`, `chart-history`, and `native-history` commands. It attached only to the stage-4 task network and database; provider, Yahoo, and delivery were disabled. The legacy Compose project used a separate name so the actual preflight could inspect it.

- Old/new exclusivity: candidate API and runtime groups were stopped before legacy startup; legacy was stopped before candidate startup; the same order was used for rollback. The shared task database remained at Alembic revision `az53_notification_outbox_types`; no downgrade was attempted.
- Forward switch: old API returned `/readyz` ready and the old notification projector reported `ok` on the migrated DB. Preflight returned 1 while old API/projector were live. After stopping the legacy group, preflight returned 0 and the candidate started, migrated successfully, returned API healthy/web HTTP 200, and wrote fresh market/data/notification boot IDs.
- Rollback compatibility: the old API returned `/readyz` ready against the `az53` schema and the old notification projector again reported `ok`. The old `alembic current` command failed because the image only knows revision `ay52`; rollback must bypass the old migration command. The old chart-history role was `degraded` because its provider catalog request was intentionally blocked in this offline fixture.
- Rollback stop: API and market-stream stopped with exit 0. Notification-projector, chart-history, and native-history were force-killed with exit 137 after both the default 10-second stop and an explicit 30-second `stop_grace_period`; Docker reported `OOMKilled=false`. This is a real failed stop-path result. Do not call the old runtime rollback procedure clean or signed off until the legacy worker shutdown path is resolved and the full sequence passes with all old containers exiting 0.
- Final recovery: all legacy containers are stopped; candidate five-service project is running again, API is healthy, web returns HTTP 200, all runtime ownership roles are idle on fresh boot IDs, revision remains `az53`, and preflight returns 0 for the stopped legacy project.

This rehearsal verifies one-way schema readability for the old API and notification projector, the preflight gate, and forward candidate recovery. It does **not** sign off a safe complete rollback because of the old Alembic revision mismatch and forced worker termination. No production or unrelated acceptance resources were changed.
