# Idle optimization acceptance evidence (2026-11-12)

Candidate commit: `fe2970e9` (API image `market-watch-api:dev-idle-v2-20261112`, web image `market-watch-web:dev-idle-v2-20261112`). Development project: `mw-dev` on Ubuntu Docker, four host CPUs. No CI status was queried.

Functional checks passed:

- API `/readyz`, 38 runtime roles, six provider source checks, MCP (42 tools), both SSE streams and ntfy health.
- Browser login, five numeric composite OHLC charts and 50-row data center.
- Isolated PostgreSQL active-rule check: 300/300 quotes accepted, one signal, no errors, quote commit P95 29.306 ms, crossing-to-judgment 50.059 ms, monitor interval P95 250.361 ms.
- Unit/core regressions: 163 expanded tests and 42 final focused tests passed. PostgreSQL isolated checks: 111 passed in the first run; subsequent incremental/JIT checks 18 passed and settlement retest 2 passed. The initial three failures were stale test assumptions (warm-up delta count and legacy stream expectation) and were corrected; no application failure remained.
- Independent Standards and Spec reviews: no unresolved findings. A stream-error retry regression (1s becoming 5s) was fixed and covered.

Two five-minute idle samples ran with no browser, active alerts, or stream subscriptions; three live composite states remained connected. Container CPU (single-core percentages; four-core total in parentheses):

| sample | four-core total | market | data | postgres | api | notifications | ntfy |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3.682% | 3.136% | 6.399% | 3.111% | 0.372% | 0.862% | 0.842% |
| 2 | 4.227% | 6.149% | 5.149% | 3.511% | 0.375% | 0.871% | 0.851% |

The service process values are normalized to one CPU by Docker; the four-core total is the sum divided by four. The variance is expected around quote/confirmation and minute-boundary work. PostgreSQL counters show no active stream tasks, alerts, imports or volume jobs during the samples; three live composite datasets remained connected. The residual 3–4% host total is therefore the cost of preserving per-quote state, provisional OHLC, ownership/confirmation, and the composite aggregate path, not the retired standalone symbol collectors. No display-state throttling was introduced.
