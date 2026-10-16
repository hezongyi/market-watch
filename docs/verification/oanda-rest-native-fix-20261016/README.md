# OANDA REST chart and indicator acceptance

Status: **Ubuntu candidate acceptance passed** on 2026-10-16. Final implementation
`b2f57f0`; API image `market-watch-api:oanda-native-history-fix-20261015-r11`, built
from a clean worktree. Baseline `b1e6e27`. [Candidate manifest](candidate.json).
Production was not accessed or changed in this acceptance task.

## Result and evidence

| Gate | Final evidence |
| --- | --- |
| Current-code CI | [Run 38856331950](https://github.com/hezongyi/market-watch/actions/runs/38856331950): backend **2,495 passed / 11 skipped** in 933.99 s; web and compose successful. [Summary](ci-code.json) |
| Focused clock/history regressions | **134 passed** in 37.83 s; Ruff and diff checks passed. Initial clock cases: 12 failed / 12 passed. Minute-handoff cases: 4 failed / 2 passed before the final correction. |
| Real PG14 boundary checks | **16 passed** in 23.57 s, covering D/W/M first prices and cold ordinary/native queued and minute-handoff reads in isolated schemas. Restored public data was not reset. |
| Review | Standards: 0 hard violations; Spec: 0 remaining blockers. Independent 756-calendar enumeration plus cold/queued/multi-page probes. [Separate axes](review.md) |
| Process-cold fixed four-way HTTP | **4/4 HTTP 200**, 3.505–4.284 s. 2,000 bars and nonempty Supertrend per request; no upstream history HTTP. |
| Mixed cold startup | After API restart, two browsers + high-period probe + fixed four-way HTTP: **4/4 HTTP 200**, 6.508–7.516 s. [All attempts, including earlier failures](http-evidence.json) |
| Real supplier current reads | M1/M5/H1/D1/W1/MN, three each: **18/18 successful**. [Results](native-clock-r11.json) |
| D/W/M coordinates | Five candles per frame: independently derived labels, completed OHLC equal to OANDA, EMA bound to the same price bars/revision. [API](native-coordinates-r11.json), [actual drawn browser coordinates](browser-coordinates-r11.json) |
| Platform M1 + Supertrend | **970.639 s**, 4,472 logical / 4,495 visual samples; 407 price-snapshot requests and 115 indicator-value variants. Zero application/page/HTTP errors, resets, empty price/indicator, not-ready or blank/colourless canvas samples. [Result](browser-m1-r11.json) |
| Composite M1 + Supertrend | **975.152 s**, 4,443 logical / 4,463 visual samples; 104 indicator-value variants. The same zero-error/empty/reset conditions. [Result](browser-composite-r11.json) |
| Runtime resources | 41 samples through the final observation: API sampled peak 741.4 MiB / 1 GiB, PG 803.7 MiB / 2 GiB. All 11 services running; zero OOM or restart. These are sampled peaks. [Details](resources-r11.json) |

Platform observation: 05:37:28.663–05:53:39.302 UTC. Composite observation:
05:36:51.246–05:53:06.398 UTC. Startup error events were inspected in addition to
formal observation; the r11 event records contain none. Canvas checks sample about
every 200 ms; this evidence does not claim a longer soak or unbounded concurrency.

## Problem and implementation

Ordinary M1 indicator requests repeatedly decoded and computed about 102,806 rows
for a 2,000-row view. With 0.8 CPU and an 8-second API budget, concurrency caused
503. Calculation also held the price read transaction, and continuous prices could
cancel indicators before application.

The candidate freezes pure inputs and version credentials in a repeatable-read
observation, releases the connection before calculation, and shares bounded inputs
and indicator checkpoints. Formation previews remain separate from confirmed state.
Corrections, backfills and deletions rotate the history epoch; restored legacy data
shares only its exact revision. Historical windows strictly before a retained mutable
tail can reuse proven unchanged prefixes. Fixed calculation origins remain.

Price snapshots use a distinct 64-hex credential in the existing preference table:
120-second TTL, maximum 2,048 entries, frozen mutable tail, dataset revision, calendar
and epoch. Expiry or history changes require price recovery. Display batches allow
indicators to progress while prices keep arriving. There is no schema migration or
full-history copy into preferences.

Swing retains the evaluation snapshot's causal end and right-side confirmation delay.
Ordinary paging clips display while preserving statistics origin and evaluation end;
replay uses its explicit cursor. Source start and chart date are separate: a legitimate
NY17 current D/W/M label after UTC now is admitted, future source rows remain excluded.
Worker, first-price ordinary/native paths and price credentials share that rule.
See the [boundary decision](../../provider-swing-evaluation-boundary-20261016.md).

Current requests across all OANDA native frames use the supplier clock. A queued
explicit cursor can still be future to OANDA: only its exact future-to HTTP400 permits
one no-to recovery, inside the original deadline and original source/display filters.
At a count=1 candle handoff, latest may return the candle equal to exclusive before;
that candle stays excluded, and one explicit request at the unchanged cursor retrieves
the prior candle. Repeated no-progress still fails. Successful requests determine
count_latest/count_to evidence, and coverage never exceeds the real observation or
retained legitimate date label. Normal historical pages keep explicit source cursors.

## Scope and runtime

Risk F1: shared acquisition, read transactions, worker calculation and display
coordination. No schema/dependency change or migration of prices, accounts, user
settings or alert rules. Added metadata and namespaced preferences are bounded,
rebuildable accelerators that old images can ignore. Yahoo's date-label risk is
[tracked separately](../../issues/yahoo-native-chart-date-boundary-20261016.md).

Only Ubuntu project `mw-v1257-restore` is used, with its existing restored PG14.24
volume and database port 20407. API remains 0.8 CPU / 1 GiB, pool 2 / overflow 0 and
8-second request budget; PG remains 1 CPU / 2 GiB. All seven backends use the r11
image. Web/chart images retain their clean `b4e712a` builds; those trees are unchanged
in the final implementation.

The web and chart origins are `https://trade.kookvv.com:8443` and
`https://charts.kookvv.com:8443`, bound to Ubuntu loopback. The browser harness maps
both domains to 127.0.0.1 and checks actual remote IPs; final observations saw only
127.0.0.1. Saves and unrelated writes are blocked. These are Ubuntu services, with
no Unraid test instance. Production was last verified as v1.25.7 / stream; this task
does not reassert an unverified current production state or evidence a switch.

## Earlier evidence and failures

- r6 cold HTTP 4/4 and warm 8/8 succeeded. Platform/composite observations lasted
  977.704 / 968.880 s. Composite had one logical history rebuild after a confirmed
  115-minute backfill; it was not a zero-reload run.
- r7 mixed cold startup failed **4/4 HTTP 503** at 8.85–8.87 s; warm requests later
  succeeded. This motivated strict historical-prefix reuse. Platform startup also
  had two application errors, before an otherwise clean continuous observation.
- r9 fixed/mixed cold HTTP passed. Platform/composite continuous portions lasted
  972.671 / 975.230 s with zero empty/reset/blank samples. However platform startup
  had two `HISTORY_PROVIDER_FAILED` application errors at 04:54:31.389 UTC, caused
  by native M1 HTTP400. A real M1/M5/H1 probe reproduced future-to **8/9** times.
  The startup failure remains recorded; it prompted the all-period clock recovery.
- Spec probes then found the 200-ms queued-clock and exact-minute count=1 edges.
  Both were corrected before r11. r10 was built but not used for final acceptance.
- Earlier browser-coordinate harnesses missed native-history result envelopes;
  those attempts were not passing evidence. A raw OANDA probe also had a transport
  failure; successful retries are recorded separately.
- An early local full-suite run omitted TEST_POSTGRES_URL (1,855 passed / 551 skipped /
  38 setup errors). Two short-deadline assertions failed under load; a later related
  172-test run passed. A new cached-page test initially lacked its database fixture
  (129 passed / 1 setup-related failure), corrected before the final 134-test pass.
- PG-enabled focused suite at `27c9dde`: 173 passed; additional first-price PG cases:
  12 passed. These precede the final 16-case PG clock run and are not relabelled as
  tests of later code. Earlier CI runs are also distinct from current-code CI above.

## Local operation and evidence handling

```sh
docker compose -p mw-v1257-restore -f /tmp/market-watch-rest-analysis-20261016/runtime-r11.private.yaml up -d
docker compose -p mw-v1257-restore -f /tmp/market-watch-rest-analysis-20261016/runtime-r11.private.yaml stop
```

These address only this task project. Do not use `down -v` or global prune. Existing
restored data and the accepted backup remain retained. Private Compose/env, raw
logs/browser state, videos/screenshots and licensed assets remain outside git. Only
sanitized summaries are committed. Production tags and deployment are separate work.
