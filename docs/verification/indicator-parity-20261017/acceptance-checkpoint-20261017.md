# Candidate acceptance checkpoint

Status at 2026-10-17 08:50 UTC: **incomplete; Issue #74 is not accepted**.

## Candidate and environment

- Code candidate `21c386e`, baseline `99124bb`, branch `feat/issue74-indicator-parity-20261017`.
- Ubuntu local Docker project `mw-issue74-20261017`; no production services or other projects changed.
- API/indicator worker: `market-watch-api:issue74-execution-v4`, product code `0216995`. Later commits contain acceptance/test changes only.
- Chart origin: `market-watch-chart-origin:issue74-execution-v2`, code `340d634`; no subsequent chart product-code change.
- App: `https://127.0.0.1:18474/advanced-charts`; chart origin `https://127.0.0.1:17475`.
- Same task quotas: API 1 CPU/768 MiB, worker 1 CPU/512 MiB, PostgreSQL 0.5 CPU/384 MiB. Normal GC and worker retained; no diagnostic probes mounted.
- Start: `docker compose -p mw-issue74-20261017 -f /tmp/mw-issue74-20261017/compose.json up -d`.
- Stop without deleting retained data: same command with `stop` instead of `up -d`.
- Compose/credentials stay task-local and are not committed. No push, PR, merge or production publication at this checkpoint.

## Tests and review

The host full-suite attempt was not clean: 1,893 passed, 551 skipped, 70 failed and 67 errors. Missing host dependencies and PostgreSQL configuration prevented it from establishing broad acceptance. Unresolved failures are not automatically classified as baseline issues.

The dependency-complete container attempt uses a separate task-owned logical database, `issue74_fullchecks_20261017`, with per-test schemas, never the app acceptance database. Additional read-only repository test scripts had to be copied into the API container because the production image does not package all test tooling. The broad run was interrupted for failure triage after **945 passed, 10 skipped, 4 failed** (636.59 seconds). Two failures lacked script files; two older-schema tests needed to account for the new demand foreign keys. Both script files were supplied, both migration fixtures corrected, and all four tests were included in the subsequent **64 passed** focused run (130.42 seconds). That run also covers real PostgreSQL demand cancellation/capacity and migration checks. This is not a claim that the entire suite passed.

Independent Standards/Spec review through `21c386e` found no confirmed new product runtime regression or hard repository-rule violation. The earlier reusable-hit input-cardinality finding is fixed. A defensive gap treating durable HTTP work of zero as proof of a short worker suffix now has a reproducing negative check and a fail-closed fix (`212c0ce`). The final incremental reviewers reported no additional findings; static review does not replace acceptance.

## Latest real Playwriter exploration

Playwriter session 3, actual Chromium 153, after real app reload against the current isolated candidate. No tests/build/seed process ran during these operations. All use `execution-evidence-v2`, exact series identity, actual submitted calculation evidence and native rendering after two animation frames.

| Predeclared scenario | n | Operation failures | First / coverage / canonical ms | Interpretation |
| --- | --- | --- | --- | --- |
| History BBANDS new specification | 1 | 0 | 574.9 / 574.9 / 574.9 | Exact authority and 5,760-row miss verified; first exceeds 500 ms |
| History four-study warm layout | 1 | 0 | 1,030 / 1,031 / 1,031 | Real saved layout, all four native studies and authority verified; first exceeds 500 ms |
| History four-study cold-local layout | 1 | 0 | 3,774 / 3,777 / 3,777 | Actual app reload and persisted recovery, same series/four studies; first exceeds 2,000 ms |

These are **exploratory observations, not passing p95 groups**. The BBANDS input-accepted-to-first interval is 309.3 ms and cannot replace the user's total 574.9 ms wait. Provider fixture reads remain local-cache inputs, so a browser reload is cold-local rather than evidence for cold-provider upstream acquisition.

Task-local raw files use phases `execution-v2b-explore-history-bbands-1`, `execution-v2b-explore-warm-history-1`, and `execution-v2b-explore-cold-history-1`. Historical matrices and failures are unchanged.

## Completed strict loaded/long matrix

The fixed 39-group matrix completed once: **1,170 operations; 30 passing groups, nine nonpassing groups**. Both 20,160-row long-origin groups have 30 independent misses, zero operation errors and matching rendered/authority evidence: EMA p95 3,268.4 ms (5/10/10 s budget), Supertrend p95 2,442 ms (10/15/15 s budget). These three latency verdicts do not fill the separate missing durable input/history timing evidence.

| Nonpassing group | Observed p95 ms | Retained reason |
| --- | --- | --- |
| History MACD new | 528.6 | Above 500 ms first budget; no operation error |
| Managed Swing new | first undefined; coverage 202.7 | Legal complete-null shape; no finite first is invented and no worker hang is established |
| Provider EMA new | 591.4 | Above 500 ms first budget; no operation error |
| Composite EMA new | null | Three HTTP 422 responses followed by 5-second waits; 27 other operations retained; requires diagnosis |
| Composite BBANDS new | 518.9 | Above 500 ms first budget; no operation error |
| Composite MACD new | 562.1 | Above 500 ms first budget; no operation error |
| Composite EMA reusable add | null | 30 preparation-evidence rejections: completed durable result lacks observed input-cardinality execution data; not proof of a bad numerical/native result |
| Composite EMA reusable edit | null | Same 30 evidence rejections; not retroactively accepted |
| History SMA new | 447.2 | First declared new spec (201) was observed as a cache hit and correctly rejected; remaining 29 cannot establish an independently valid 30-sample new-spec group |

The harness records 64 failed samples: 60 input-cardinality evidence rejections, one invalid new-spec preparation and three actual HTTP/timeouts. They remain separate from the complete-null output and pure latency overruns. Full raw results, fixed plans and hashes are [archived here](scenario-budgets/matrix-v2-execution/README.md); no sample was deleted or reclassified by its elapsed time.

## Remaining acceptance

- The completed fixed plan is `/tmp/mw-issue74-20261017/execution-matrix-plan-v2b.json`, with `execution-matrix-summary-v2b.json` and one immutable raw JSON per phase. The earlier unexecuted plan is retained; preflight caught its out-of-range EMA period before any sampling and the replacement plan uses valid periods.
- All eight four-kind warm/cold-local layout groups have 30 samples in the archived matrix; none passes the full budget. Six cold failures exposed an iframe-navigation race in the harness. The fix (`4b78911`) waits for actual navigation within the original deadline. A separate history cold-local group then completed 30 actual reloads with zero errors: first/coverage/canonical p95 3,280/3,281/3,281 ms, still over the 2-second first budget. Original failures were retained.
- A read-only audit of 636 referenced runs establishes completion-marker/publication bounds separately from visible latency. Long durable input acceptance and layout input timing remain absent; failed samples without an operation-start timestamp retain null history timing. These missing timings are not zero or a pass.
- Recovering composite history, source recovery, changed-price correction/concurrent edits, multi-chart capacity/fairness and maintenance progress still need their remaining app/resource evidence. Existing unit/native probes are partial evidence, not a substitute for the full A1–A16 matrix.
- Remaining first-value budget overruns will be reported with their costs and limits. The authorized bounded optimization round is not an authorization for endless retries or retroactively relabeling failures.

## Snapshot recovery follow-up

The exact retained composite request currently returns HTTP 422 `DISPLAY_SNAPSHOT_EXPIRED`. A separate lifecycle regression then reproduced a concrete recovery defect: unchanged prices may renew the same content-addressed token; after its next expiry, the previous completed recovery Promise suppressed another price refresh. The real bridge-function regression failed with four reload attempts where five were required. The candidate fix allows a new recovery when that token is still bound, while continuing to ignore delayed errors for a token replaced by newer prices. The regression and the adjacent coordinator/batch checks pass. A candidate chart build and real Playwriter expired-token recovery still need verification; this is not yet claimed as the explanation or fix for every original timeout.
