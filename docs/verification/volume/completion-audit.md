# Volume R2 completion audit

2026-10-02 UTC. Baseline: `v1.3.2` / `9596b25eda507ef708a327feb5271f238cdfdc0b`.
Isolated worktree: `/home/quant/repos/market-watch-volume`, branch
`fix/volume-v1.3.3`. Runtime source: `edc799a97999b8cf387a03c380669bf6a8d28083`.
This audit maps [R2](../../volume-repair-plan.md) to implementation and actual
acceptance evidence. Performance is excluded by the user's explicit instruction;
its retained failures are not converted into passes.

| R2 requirement | Completion evidence |
| --- | --- |
| §1 source meaning, exact Decimal, zero/null, forming completeness | `backend/tests/test_volume.py`, `test_volume_postgres.py`; final `backend-pg17.txt`; `upstream-alignment.json`, `native-zero-missing.json`. Zero/null browser samples are controlled fixtures. |
| §2 provider parsing, versioned persistent cache, SSE/CSV and revisions | `backend/alerts/provider_chart.py`, provider cache regressions; `local-api-repro.json`, `http-csv.json`, `provider-sse.json`. Cache identity is `volume-v1`; old cache remains for rollback. |
| §3 M1, nine aggregate periods, published snapshots, independent revisions | Storage/aggregation/managed-dataset regressions; `native-managed.json`, `upstream-alignment.json`, `publication-liveness.json`; final M5 and monthly image checks. Missing members and forming buckets never claim complete totals. |
| §3.1 merge rules and §3.2 price/watch/replay isolation | PG NULL-safe merge/Decimal roundtrip; legacy replay, price correction, duplicate-no-op and live-tick regressions; `real-backfill.json` records unchanged historical price, coverage, watch and replay snapshots. |
| §4 approved fixed ranges, bounded reverse pages, durable partial/retry, cancellation/lease fencing, resource priority | `backend/alerts/volume_jobs.py` and job regressions; `real-backfill.json`, `local-upgrade.json`, `rollback.json`, `rollback-resume.json`. Overlap owners are revoked; retries are bounded to 600 minutes. Main automatic start list contains only four approved enabled plans. |
| §4.1 task page and §4.2 paged unresolved ranges | `web/src/advanced/HistoryPlansDialog.tsx`; real `history-ui-audit.json` reads existing jobs and two segment pages, exposes start/cancel/retry controls and closes without mutation. Start/cancel/resume/retry transitions are covered by backend tests and actual backfill/rollback-resume; this UI probe does not claim clicking mutating controls. |
| §5 native historical/live mapping, metadata, manual Volume/style/save-reopen, Python internal 0/1, CSV | `advanced-host/bridge.js`, `web/tests/advanced-volume.cjs`, 39 scripts in `frontend-vm.json`; `native-provider.json`, `native-managed.json`, `native-zero-missing.json`, `native-local.json`, `http-csv.json`. Native SSE uses the historical mapping. |
| §6 publication/recovery, historical reset and viewport preservation | Final publisher/managed revision regressions, `web/tests/advanced-managed-revisions.cjs`; inherited real provider reset evidence in `../provider-cache/historical-revision-deferred-reset-callback.json` and real layout checks. Volume uses the same published revision/reset path. These are component proofs, not a claim of a newly injected Volume-only revision browser run. |
| §6 real matrix, aligned positive quantities, readonly/regressions, review | 36 native source/series/period cases; 6 upstream-aligned samples; final `native-release-candidate.json`, `native-release-monthly.json`, `native-local.json`; `mobile-readonly.txt`, final full suite 340 passed/1 skipped, frontend build, `code-review.md` (no blockers). |
| §7 migration, same-source images, backup, local update, rollback/resume | `migration.json` (n15→o16→p17 and restored o16→p17), `local-upgrade.json`, `rollback.json`, `rollback-resume.json`; `runtime-audit.json` freshly confirms seven running service image IDs, six application source labels, schema, health/ready and backup mode/size/hash. |

The 36-case matrix predates the final publisher/watch fixes. Parser, native
mapping and aggregate files did not change; `source-verification.json` records
the relationship. Final-source regressions and candidate/local browser checks
cover the delivered image. All 36 cases were not rerun after the final fix.

Main EURUSD/XAUUSD volume jobs completed. BTCUSDT and OANDA:CAD_CHF remain
partial where existing prices cannot establish confirmed volume publication
or require explicit price repair. Unknown stays null. R2 explicitly permits
unavailable/conflicting historical ranges; automatic price repair is outside
this scope. The complete-page performance gate failed and remains excluded.
The backup-tool conditional skip and mobile viewport warning are retained.
Supplementary UI probe failures (iframe, selector, first-page assumption)
are preserved and explained in the index.

No required product implementation remains within the user-approved scope.
Delivery is local Ubuntu only; no main merge, tag movement or remote push.
Evidence-only commits after runtime source do not change images.
