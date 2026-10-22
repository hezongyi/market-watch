# Integration fixes and final acceptance

The original P1 and P2 in [the initial review](README.md) are fixed. Product code is fixed at `7418c08892848d53dcef411cf140a7796470533e`; `0883a5a4a8d4eac56ed30f14a97ac3183614695d` adds PostgreSQL test isolation and CI execution. Later evidence-only commits do not change the product. Final remote CI is tracked against the exact head of [PR #93](https://github.com/hezongyi/market-watch/pull/93); earlier green runs do not validate these fixes.

This batch is **F1**: it adds the compatible `ax51_mapping_notes` table and changes persisted mapping/note semantics. It includes the two-step native mapping flow, message-icon alignment, quote changes, and browser titles. No main merge, formal tag or production release is performed by this verification.

## Fixes

- P1: derived previous close requires the complete, source-confirmed final M1 of the same daily bucket, with an equal close. Fixed history pins the same history version; composites pin the same revision/input revision and exclude provisional data. Missing terminal evidence keeps the latest price and omits change fields. Interior gaps alone do not invalidate a proven closing price.
- P2: selection, checking and saving use the same full current OANDA identity. The snapshot carries `target_dataset_id`, invalidating stale bindings after calendar changes while preserving old mapping/composite identities.
- Corrected changed-file Ruff imports; mapping and title regressions run in CI. The new PostgreSQL migration test has an explicit CI step with the required database variable.

## Local and isolated Ubuntu verification

New regression tests first reproduced the defects: **7 failed, 2 passed**. With the fix, eight relevant backend modules passed **87 tests**. Web build, mapping/title/tab, multi-chart initialization and resolve-recovery checks passed. Changed Python Ruff and `git diff --check` passed.

R1 runs on Ubuntu `quant-server`, task/project `mw-integration-20261022`, separate PostgreSQL 14.24 volume/network/database and synthetic account. Main `https://localhost:18491`; chart `https://localhost:18492`. Its fixture refuses other tasks/databases and disables external quote streams and delivery.

- [Real mapping browser report](r1-mapping.json): nine groups pass, including native selection, save-only without live demand, create/open with peer-pane preservation, reconciliation after a committed save loses its response, open retries, delayed suggestions/manual edits, changed catalogue snapshots, gold product confirmation and 390px layout.
- [Message alignment](r1-alignment.json): light/dark, 1440/1024/390px, badge/sidebar variations, keyboard and click pass; visible icon centers differ by at most one CSS pixel.
- [Actual PostgreSQL migration execution](postgresql.txt): **1 passed**. Populated aw50 → ax51 and repeated upgrade retain mappings, composite/revision IDs, fixed history/seam and independent notes. The first run exposed a fixture Session/schema mismatch; the fixture was fixed and rerun successfully.
- [Old application compatibility](old-application-compatibility.json): actual main/v1.26.5 Python modules read two new mappings and reopen the existing composite against the upgraded task database. References and three notes remain; the transaction is rolled back. Application rollback retains the additive table; no destructive database downgrade is needed.

R1 start/stop: from this worktree use `python3 deploy/ubuntu/mw_docker.py preview up|stop --task mw-integration-20261022 --project mw-integration-20261022`. The mapping fixture overlay is private at `~/.local/share/market-watch-docker/previews/mw-integration-20261022/fixture-env.json`; reapply it only to this task's API after a generic preview up. Credentials remain private. The project is retained for the pending merge decision.

## Independent Standards review

Original **P1 closed; no new blocking finding**. The reviewer independently ran 59 tests and Ruff on 13 backend files. Follow-up review of `7418c08..0883a5a` found no blocker: scoped Session fixes internal history transactions, the explicit CI step runs the migration test, and the actual PostgreSQL pass closes the F1 verification gap.

## Independent Spec review

Original **P2 closed; no new blocking finding**. The reviewer independently ran 59 backend tests. Full OANDA identity checking and snapshot invalidation match the specification without mutating old identities. Follow-up review confirmed the explicit PostgreSQL step and fixture correction preserve compatibility assertions. These checks address the found defects; they do not promise immunity to every future fault.

## Shared mwa acceptance

Ubuntu `quant-server`, existing project `mw-issue75-v2-20261018`, [main](https://192.168.7.232:18280), chart `https://192.168.7.232:18281`.

Only API, market-stream-worker and Web were replaced, using fixed clean image identities in [images.json](images.json). API/worker product source is 7418c08; Web was built at 0883a5a for the correct mwa chart origin. Chart remains the existing image; its touched native sources match this candidate ([hash evidence](preserved-chart-source.json)). Other workers do not consume the changed previous-close calculation and retain their images/containers.

- [Runtime audit](mwa-runtime.json): 15 services running, API/PG healthy, exactly three intended containers changed. All environments, mounts, network names and port bindings match the fresh before snapshot. PG/gateway and all other containers are unchanged.
- [Native mapping UI](mwa-mapping.json): real login, current-account EURUSD/gold selection, two steps, server rules, optional notes, explicit gold confirmation, light/dark/mobile and discard pass. Full workspace and mapping lists remain unchanged, revision **43**. No trial mapping/composite was saved to mwa.
- [Five-chart restore](mwa-five-charts.json): two real reloads restore XAUUSD 60/5/1W/1D/240, all dataReady with canvases and no page errors. Complete workspace remains unchanged at revision 43. [Screenshot](mwa-five-charts.png).
- [Quote/title browser check](mwa-title.json): managed/composite percentage display, history title `EURUSD·历史 [我的图表]`, refresh and favicon pass. Workspace unchanged; preferences happened to compare equal in this observation. Test-context preference saves were intercepted; protected browser profiles were untouched.
- [Read-only actual close evidence](mwa-close-evidence.json): composite prior close 1.123110 is proven by its exact final M1 in the same revision/input. Its D1 has internal gaps, validating the intended policy. Fixed-history prior close 1.121160 likewise has matching final-M1 evidence. Missing-tail behavior is covered by the automated regressions.

No mwa seed, migration, reset, volume replacement or credential/config change ran. Existing ax51 schema was verified before update. Notification/provider switches and protected browser profiles remain preserved. This is functional acceptance over a short observation period, not a long-duration stability or disaster-recovery claim.

Durable mwa start/status/stop remains `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`, with the updated fixed candidate overlay. Round-specific private snapshots, previous durable overlay and rollback are in `/home/quant/repos/.mwa-integration-20261022/`. For this round only, combine its `rollback-override.json` with the existing `integrated-compose.json`, select **api market-stream-worker web**, and use `up -d --no-deps --no-build --pull never`; restore the saved durable overlay as well. Do not use the manager's historical rollback or recreate the whole stack.
