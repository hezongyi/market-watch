# Issue #74 implementation and acceptance

Status: in progress. No implementation or SLO completion is claimed.

## Authority and boundaries

- User: implement all of #74 on the latest baseline; ignore unrelated baseline blockers; use Playwriter for browser acceptance.
- Baseline: `99124bb31069a813798e3bde097b3f2e2997aaba` (`origin/main`, v1.25.9 plus CI change filtering), fetched 2026-10-17. Fast-forwarded from `b79744b`; application code unchanged.
- Worktree: `/home/quant/repos/market-watch-issue74-20261017`; branch `feat/issue74-indicator-parity-20261017`.
- Specification: [approved revised plan](../../chart-indicator-parity-plan-20261016.md), restored verbatim from `1fd8246e19d61083ce5b5d8efbe16b9e54cb4c8e`; [historical review](../../issues/issue-74-plan-review-20261016.md).
- Risk: F1 because shared persistent indicator jobs and composite recovery are in scope. Minimum validation includes targeted numerical, coordinator, native adapter and queue tests; isolated PostgreSQL compatibility/rollback checks; Ubuntu R2 with Playwriter; CI, self-review and independent Standards/Spec review before a merge candidate.
- No production deployment, official tags, acquisition policy changes, changes to licensed library source, or deletion of other tasks' resources.
- Existing closed-session OANDA quote blocker is recorded but does not block implementation or substitute for any #74 requirement.

## Stages

- [ ] I0: reproducible baseline, per-catalog paths, cold/hot/new-spec measurements and queue/resource budgets.
- [ ] I1: input/seed/identity/coverage/invalidation protocol, consumer cancellation and actual native transition rendering.
- [ ] I3: measured provider snapshot and existing cache reuse.
- [ ] I4: managed/history result/checkpoint/new-spec paths, genuine partial results and demand scheduling.
- [ ] I5: fixed/display demand association, bounded warming, valid recovering history and live continuity.
- [ ] G1: measured per-catalog decision about remaining latency and exact display adapters.
- [ ] I2: only adapters justified by G1; Python oracle parity for every published catalog item.
- [ ] I6: full correctness, resource, compatibility and performance acceptance; reviewable Draft PR.

## Required evidence audit

All A1–A16 from the approved plan remain pending. Evidence must distinguish first current-spec visible value, visible coverage, canonical convergence and complete history. At least 30 independent samples per declared p95 group; failures and cold/new-spec misses remain in the report. No approximate recursive initialization or old parameter value counts as a successful new result.

## Initial resource inventory

Ubuntu local Docker, 2026-10-17: approximately 6.8 GiB available RAM and 14 GiB available disk. Other projects are retained. Plan a task-local synthetic dataset instead of copying a production database. Actual project, ports, service budgets, source data, Playwriter session, startup/shutdown commands and validation results must be recorded before acceptance is claimed.

## I0 measured feedback loop

Command: Playwriter session 1, `-f web/tests/indicator-parity-latency.playwriter.js` against the real isolated app. Thirty separate add/remove operations using LWMA periods 31–60 on managed PARITY M1, all previously unused in that page. First accepted current-parameter native batch followed by two render frames; verified nonempty native study data. Nearest-rank including failures: n=30, failures=0, p50=451.5 ms, p95=609.2 ms; assertion `<300 ms` fails. Raw task-local evidence: `/tmp/mw-issue74-20261017/latency-baseline.json` and `.log`. This synthetic short-history group is not evidence for other series/actions or real supplier latency.

An exploratory prior LWMA5 add measured 565.6 ms vs API responseEnd 175.8 ms (2000 returned bars, 145 native rows). Hypotheses, in priority order: native study changes wait for the 500 ms fallback; managed repeats full-prefix SQL and calculation even for reusable input. Falsify separately with native event subscription timing and SQL/compute counters. No blanking failure was observed in the simple delayed LWMA transition; labelling, multi-output, correction and failures still require evidence.

## Implementation checkpoint (not full acceptance)

- Event-triggered sync: 30 samples, p50 207.4 ms, p95 338.1 ms. Event plus managed input/result reuse: 30 samples, p50 188.4 ms, p95 277.0 ms, failures 0. Only this managed M1 LWMA-add group meets the target so far. Raw comparable samples are included beside this report. Subsequent window-size optimization and the other scenario groups still need measurement.
- Managed uses the existing provider exact calculation/checkpoint engine, with separate publication input evidence. Same publication: no payload SQL and zero computation steps on result hit; new EMA parameters: no payload SQL but full origin replay; append: mutable tail query and same-spec checkpoint; correction: full withdrawal/replay. Twelve tests cover all ten catalog indicators plus these paths.
- Native Playwriter probe: [32 checkpoints](native-transitions.json), [actual Chromium screencast](native-transitions.mp4). LWMA, BBANDS, MACD and Supertrend cover delayed A→B→A, stale response, failure/retry, atomic multi-output replacement and metadata correction withdrawal. Inputs/results are synthetic Python oracle data, rendered by the actual pinned native runtime. App-level labels, deletion/switching, display controls, cold layout and real changed-price correction remain pending.
- Fixed responses now declare source-time coverage and visible readiness separately from whole-run status. A partial prefix outside the requested window is not accepted. Existing display-complete response compatibility is retained only when every series actually supplies every requested bar.
- Demand migration is additive (`av49_indicator_demands`). Existing results/state formats stay readable. New priority tables are disposable on downgrade; old code can run with the additional tables retained. PostgreSQL migration/old-code compatibility and actual downgrade remain pending.

## Defined scheduling budget

- Foreground TTL 30 s; active browser leases renewed every 10 s; cancellation tombstones 60 s to fence late HTTP.
- 64 active consumers per page/client, 256 active demands globally (the application has one authenticated workspace), 256 pending fixed runs. Replacement parameters reuse the consumer slot. Cancellation fences have a separate 256-record budget; if it fills, eviction establishes a persistent 60-second admission fence for unknown consumers. Existing active consumers continue to renew/edit/release. A late request cannot resurrect an evicted cancellation; new admission gets the retryable capacity error until the fence expires.
- Default warming: exactly SMA20 and EMA20 per visited series/period; eight warm demands globally, one concurrent warm claim per fixed/display role. Prices do not fail if the warm budget is full.
- Every four claims: two foreground-preferred, one warming-preferred, one maintenance-preferred. Unused shares fall through; no demand expiration deletes immutable outputs.
- Existing display limits remain 256 tasks, 10,000 output rows per task, 64 MiB total compressed output, 8 MiB state, 2,000 rows per worker page. Fixed pages remain 2,000 rows; exact input caches are bounded at 250,000 rows and result caches at 1.5 million weighted values. Capacity, expiry, concurrent claims, fairness and PostgreSQL pressure still require comprehensive acceptance.

## Independent checkpoint review and migration validation

- Standards: no confirmed documented-standard violations; two P2 correctness findings (lost cancellation at capacity, shared-run waiter incorrectly rejected at final capacity slot).
- Spec: two P2 findings (cancellation records charged as active consumers, lost cancellation at capacity). Full specification acceptance remains pending independently of these defects.
- Fixes: reclaim expired cancellation records before release, separate active/fence budgets, retain an overflow admission fence, check active capacity when reactivating a canceled consumer, and recheck the shared run after acquiring its capacity lock.
- Regression: 25 demand/fixed tests passed on SQLite; four real PostgreSQL tests passed, including two simultaneous requests sharing the final pending slot and the three cancellation-capacity cases. The tests use disposable unique schemas inside this task's PostgreSQL. The first-response origin-discovery coordinator regression also passed.
- [Actual restored-database migration/rollback](demand-migration-rollback.json): upgrade, downgrade to au48, re-upgrade. All 12,412 published bars, one fixed run, three result/checkpoint blocks and one history version preserved, including the stored state/block digest. Old candidate API/worker remained healthy on the migrated live acceptance DB before replacement. This is partial F1 evidence; old-binary numerical reads and the broader pressure matrix remain pending.
