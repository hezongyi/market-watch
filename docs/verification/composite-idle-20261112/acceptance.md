# Development acceptance

Candidate implementation: 0e2b2f33 (base v2.0.7 ba58ea1d).
Draft PR: https://github.com/hezongyi/market-watch/pull/134.
Host: Ubuntu quant-server, 4 CPU / 16 GiB. Existing authorized development project: mw-dev.
Address: https://192.168.7.232:18443. Start/status/stop: `mw-dev up`, `mw-dev status`, `mw-dev stop` (stop affects only this development project).
Backend image: market-watch-api:dev-composite-idle-r3-20261112. Source mounts: /home/quant/repos/market-watch-composite-idle-20261112/backend. Image ID: sha256:30c0b1da115ef174609398f86baded6c48c9cf90ab28d0eb62152bb34e73dbbf. Frontend retains existing development mode and private native assets. No schema migration introduced; existing schema bd57_notice_source_poll_index retained.

## Functional evidence

- Browser acceptance on r2 (same frontend and chart logic; r3 changes only listener stop-check blocking slice): login, five numeric OHLC combination charts, data center 50 rows, no console page errors or failed resources.
- OANDA/Binance/Dukascopy/Yahoo/AKShare/FXCM platform reads each returned 40 bars.
- readyz ready; 38 market/data/notification role records healthy; SSE event and notice endpoints work; ntfy healthy; proprietary asset returns HTTP 200; MCP exposes 42 tools.
- EURUSD/GBPUSD/XAUUSD acquisition remains stream. All three independently show owned connection, fresh quote sample and source-confirmed tail ready, with no browser demand or active alerts. REST minute confirmation/recovery retained.
- Explicit off preferences retire legacy EURUSD/XAUUSD/BTCUSDT collection, retaining identifiers and histories. First five-minute proof: each composite advanced five confirmed minutes / five immutable input events; all legacy last_received, stored-bar counts and max observed_at remained exactly stable.
- Final read-only health check: PostgreSQL connections 55/80, 21 listener connections (earlier check 54/80). Isolated test PG stopped after checks; its volume retained. Other task projects unchanged.

## Final idle performance acceptance

Final sample: 2026-11-12 03:23:14–03:28:19 UTC, 304.94 seconds, 30 ten-second intervals after discarding the initial CPU point. Isolated test PostgreSQL was stopped; no tests, builds, browsers or profiling ran during sampling. All browser clients/subscriptions/tasks, provider interests and active alerts were zero throughout. Exactly three live composite connections remained active throughout. Source/config/table snapshots bracket the sample and include a small additional interval.

CPU below is the sum of this development project's nine container CPU deltas divided by four host cores; it excludes host OS and other projects. These are five-minute means, not instantaneous readings.

| Measure | Original baseline | Core repair r1 | Final r3 |
| --- | ---: | ---: | ---: |
| Development CPU / four-core capacity | 9.798% | 9.686% | 8.146% |
| Equivalent CPU cores | 0.392 | 0.387 | 0.326 |
| Data worker / one core | 15.406% | 9.977% | 6.742% |
| Market runtime / one core | 8.298% | 13.732% | 11.949% |
| PostgreSQL / one core | 8.079% | 7.672% | 7.366% |
| Database commits/second | 132.004 | 107.241 | 88.228 |
| Actual composite live connections | 0 | 3 | 3 |

Final CPU is 16.9% below the original and 15.9% below r1 with the same three-composite workload. Commits are 33.2% below the original. The original baseline had legacy collectors running and **no actual composite stream demand**; this is not a controlled identical-workload comparison. Ten-second final CPU intervals range 4.945–17.715% of four-core capacity; minute-boundary work still produces bursts. The intermediate r2 sample regressed due to overly frequent empty listener polls; it is retained as diagnosis evidence, not a successful result.

Snapshot assertions passed: EURUSD/GBPUSD/XAUUSD each advanced six confirmed minutes and six immutable composite input events between bracketing snapshots, with sample and confirmed tail ready. All three retired legacy records retained identical enabled=false, last_received, stored-bar count and observed_at. The indicator fairness table had zero inserts/updates/deletes. Aggregation queue and publication backlog were zero at the final sampled point.

Remaining cost is material: 8.15% of four cores is about 32.6% of one core, despite no users. Final table deltas still include preferences (2,412 updates), live state (2,108), pricing ownership (1,596), live minutes (1,215) and instrument health (1,158). These deltas include real stream/confirmation/health work and do not prove each write is necessary. Earlier r1 profiling identifies pricing and composite source-row/period aggregation work as further candidates; final r3 was not re-profiled during its CPU sample. Future optimization should measure coalescing unchanged health/lease writes and incremental large-period aggregates, preserving fencing, recovery and alert correctness. This change does not claim near-zero idle CPU.

Final functional check on r3 passed: readyz ready, 38 role records healthy, nine containers running, zero restarts and zero OOM kills. Six provider reads, MCP, SSE, ntfy and native assets were checked on the final code candidate before CPU sampling. Browser acceptance was on the identical frontend/functional implementation in r2 as noted above.

## Validation and review

Core local: 240 passed. Additional alert contracts: 109 passed / 1 skipped. Provider/idle follow-up: 95 passed. Final listener supplement: 58 passed. Counts overlap and are not a sum of distinct tests.
Core isolated PostgreSQL: 115 passed. Provider/idle follow-up: 37 passed. Final listener supplement: 17 passed. Independent Standards and Spec reviews passed after fixing authentication recovery/health and future-due prefetch cadence findings. No CI tracking.

Initial broad-suite attempts were interrupted after exposing obsolete default-on fixtures and overly broad aggregate invalidation expectations, plus missing local declared mcp dependency. Dependency and affected compatibility fixtures/contracts were corrected and covered by the final focused suites. Full repository test success is not claimed.

## Private evidence and rollback

Private evidence directory: /home/quant/.local/share/market-watch-dev/updates/composite-idle-20261112. Includes build/deployment logs, browser screenshots, service results, raw CPU samples, table deltas, both legacy switch snapshots and source/config/image inventory. Credentials remain outside Git and public reports.

Original launcher mw-dev.before, compose.env.before, image market-watch-api:dev-idle-final-20261111, and old bind checkout market-watch-cpu-fix-20261111 retained. Rollback stops the four backend writers, restores that saved launcher/config, and uses mw-dev up; schema is unchanged. Keep the retired switches off unless explicitly restoring old collector behavior. No volume/history deletion or production action occurred.
