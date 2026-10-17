# Repeated expiry and obsolete snapshot HTTP

Functional follow-up on Ubuntu host `quant-server`, isolated Docker project
`mw-issue74-20261017`, actual authenticated app and Playwriter session 3,
Chromium 153. Chart image `market-watch-chart-origin:issue74-recovery-v4`,
source `d56ffff`, image digest
`sha256:2166ba7d8c42b4ea7f47ffeb850a122f0edfe5cac08fe79660f817bd0f8fe062`.
API/worker remain `market-watch-api:issue74-execution-v4` (`0216995`).
No timing budget is evaluated by these functional checks.

The task's synthetic composite is
`MWC:2bcbc81d8e0e33b2318774f24638e2327448c8d3ecae8d190915cb94b50f637b`.
The harness holds a real BBANDS HTTP request, then expires exactly its captured
snapshot in this task's PostgreSQL, guarded by snapshot id, revision and M1.
Each UPDATE returned exactly one row. Requests are released without replacing
their response. No source observations, prices or production data are changed.

| Period / deviation | Real expired HTTP | Parent price reread | Native coverage + matching authority | Already-ready same token expired again |
| --- | --- | --- | --- | --- |
| 141 / 2.731 | 422 `DISPLAY_SNAPSHOT_EXPIRED` | Yes | Pass | No; refresh issued a different token |
| 142 / 2.731 | Same | Yes | Pass | No; current binding had changed since previous recovery |
| 143 / 2.731 | Same | Yes | Pass | **Yes**, same token before/after |

All three observe a new recovery entry, ready state, finite current-parameter
native rows after two animation frames, and exact backend execution, snapshot,
revision, source-time and visible-coverage matching. These are three functional
reproductions, not 30-sample latency groups. They do not retroactively repair
the original matrix's three composite errors.

The separate obsolete-token HTTP check uses three distinct real tokens: error A,
last recovery B, active binding C. An actual bridge `query` with A receives the
server's real HTTP 422. B's recovery entry, C's binding, subscription generation,
native rows/values and scope all stay unchanged; no parent-price reload occurs.
This intentionally submits an obsolete token after accepting C; it does not
simulate a physically delayed in-flight response. The actual-function lifecycle
regression separately reproduces the cross-generation guard failure before the
fix (seven reload attempts instead of six) and passes after it.

Two harness failures remain archived: the first database guard assumed the
revision was a 64-character hash, but revisions are UUIDs, so it stopped before
any UPDATE. After correcting that guard, period 131 recovered but the observer
asserted before its two-frame commit record existed. Its later captured native
commit/HTTP is retained as diagnostic evidence; it is not counted among the
three passes. The follow-up waits for that record under the original deadline.
Final scripts are retained for reproduction; the logs describe the earlier
harness versions and their failures.

`manifest.json` pins the source and stored SHA256 of 17 files. JSON is gzip
compressed without changing its bytes. No cookies, CSRF/session secrets or
complete browser state are included. Observers/routes were removed afterwards;
normal GC, worker and original resource quotas remain enabled.

Issue #74 remains incomplete: durable/layout input timing, completed composite
input cardinality, layout waits, performance overruns and the remaining recovery,
correction and pressure matrix still require evidence.
