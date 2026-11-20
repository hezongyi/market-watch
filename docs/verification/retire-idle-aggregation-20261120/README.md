# Retire unused standalone aggregation replicas

## Scope and baseline

User explicitly authorized retirement after verifying no running charts or alerts
use the old replicas. Baseline: PR #146 at `a612d106`, including upfront full-period
history materialization and immutable block sharing. Risk: **F1**, because this
changes durable background scheduling and removes reviewed task metadata.

Target set: the seven mapped OANDA targets AUDUSD, AUDJPY, EURUSD, GBPJPY,
USDCAD, USDJPY and XAUUSD whose own standalone realtime setting is explicitly off.
Their canonical inputs continue supporting the current fixed/composite path.
Do not disable their Instrument rows or remove their realtime mappings.

The generic aggregation implementation remains available for other genuine
standalone users. Retirement is explicit per instrument; it does not infer that
an idle or temporarily disabled unrelated instrument should be removed.

## Change

- A durable `Preference` tombstone (`retired_compatibility:<instrument>`) closes
  the old standalone identity permanently. No schema migration or expiry timer.
- Explicit CLI defaults to preview; it locks all datasets by dataset ID, then all
  instruments by ID, checks the entire batch, and applies in one transaction.
- Reject active independent demands, standalone maintenance and saved chart
  references before changing anything. Three saved-layout models are scanned
  using parsed identities; encoded published identities are included.
- Remove only `chart_aggregation_jobs`, `chart_aggregation_state`,
  `chart_publication_jobs` and `chart_publication_state` for the explicit IDs.
- Old readers return HTTP 410 `SERIES_RETIRED`, without waking derivation or
  silently returning stale bars. Layout saves, independent demand, live enable,
  history restart/retry, volume backfill and ended managed-alert restart reject
  the retired entry under their existing dataset/instrument fences.
- Source M1 writes and composite input revisions continue. Skip retired replica
  aggregation, observation publication, discovery and automatic adoption.

Do not delete prices, coverage, published snapshots, history versions/chunks/
artifacts, shared payloads, composite inputs/aggregates, mappings, rules, events,
notifications or user preferences. No production action, merge or release tag.

## Verification

SQLite regressions:

```sh
PYTHONPATH=backend pytest -q \
  backend/tests/test_compatibility_retirement.py \
  backend/tests/test_history_retention.py backend/tests/test_volume.py \
  backend/tests/test_chart_alert_service.py
PYTHONPATH=backend pytest -q \
  backend/tests/test_postgres_idle_optimization.py backend/tests/test_chart_aggregation.py \
  backend/tests/test_composite_chart.py backend/tests/test_realtime_switch.py \
  backend/tests/test_live_pricing.py backend/tests/test_confirmed_minutes.py \
  backend/tests/test_publication_scheduler.py backend/tests/test_publication_observation.py
```

Results: 45 passed and 122 passed. After the final adoption guard, the focused
retirement/publication suite passed 20 tests. SQLite test imports must use this
worktree's `backend`, not another checkout's editable installation.

Isolated Ubuntu PostgreSQL (existing task database; each test owns a unique
schema, dropped afterward):

```sh
pytest -q backend/tests/test_compatibility_retirement_postgres.py \
  backend/tests/test_composite_aggregates_postgres.py \
  backend/tests/test_history_retention_postgres.py
```

The retirement contracts cover actual task removal, retained bars, inline and
deferred M1 ingest, composite reads, idempotence, refusal with a consumer, saved
layouts, old mutations and completed-alert restart. Real PostgreSQL races cover
both orders of saved-layout writes versus retirement: the loser rejects after
waiting for the same dataset fence. Composite aggregation and history retention
contracts are also included. An initial PostgreSQL fixture failure (missing
Instrument label/precision in the unrelated test target) was corrected.

PostgreSQL result: 11 retirement tests passed on the final code; the other 19
composite/retention contracts passed in the preceding run.

Independent Standards and Spec reviews completed without remaining blockers.
Private logs and task-row snapshots live under
`~/.local/share/market-watch-dev/evidence/retire-idle-aggregation-20261120/`.

## Persistent development deployment

Only Ubuntu Docker project `mw-dev`, https://quant.kookvv.com:8443 (HTTPS18443).
Actual launcher:
`~/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json`.
Build with `mw-docker build --task retire-idle-aggregation-20261120 --project mw-dev
--purpose development`, then pin candidate API image in API, market-runtime,
data-worker and the launcher's migrate service. Preserve web, notification worker,
PostgreSQL, TLS, ntfy and all mounts/configuration.

Read-only preflight found seven exact targets; 280 paused aggregation tasks,
5 aggregation service-state rows, no publication jobs and 63 publication-state
rows; no active independent consumers or saved chart/watch/replay/alert references.
All 828 history artifacts were published. Snapshot task rows before apply.

Stop only API/market/data writers for replacement, start candidate API, run
preview and explicit-ID apply, then resume candidate market/data workers. Do
not clean an arbitrary search result or delete unrelated task rows. Stop if any
new consumer appears or candidate validation fails.

Verify task rows remain zero after normal live confirmations, all fixed-period
chart reads and the current composite chart still work, and immutable artifact,
mapping and alert counts do not decrease. Record source/input advancement only
where the sampled session has actual confirmed minutes. Keep unchanged service
container IDs as evidence that notification/web/configuration were preserved.

Operations: `mw-dev status`, `mw-dev logs api market-runtime data-worker`;
start the selected services with `docker compose -p mw-dev -f <actual launcher>
up -d --no-build --no-deps api market-runtime data-worker`; stop them with
`mw-dev stop api market-runtime data-worker`.

## Recovery

No schema rollback. The prior shared-history-capable image remains readable:
`sha256:65c468a3ecca5bbccaecb4d242089a19ad8666c4b76e5eccb206e399751d327e`.
For a code defect, prefer a forward fix retaining tombstones. Emergency rollback
requires writers stopped and restoration of only this task's tombstones/task-row
snapshot before restarting the prior image; old code does not honor retirement.
Do not restore a whole old launcher or roll back to a reader predating history
block sharing. No rollback is needed for ordinary upstream downtime.
