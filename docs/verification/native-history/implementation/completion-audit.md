# Completion audit against R2 and user corrections

Audit date: 2026-10-02. **Implementation and isolated-environment delivery are
complete under explicit user acceptance of the Binance network blocker.**
The user's latest instruction supersedes the prior performance-blocked verdict:
“ 不解决binance 阻塞，由于网络问题引起的 不进行解决。 视为可以达标 ”.
[Decision](user-acceptance-decision.json) binds the original 40-sample cohort;
numeric failures remain visible and immutable. Default buffer is enabled with
400/2000/2000 caps. No production merge, push or deployment is claimed.

| Requirement | Current authoritative evidence | Assessment |
| --- | --- | --- |
| Handoff, fixed v1.3.2 baseline, isolated branch/worktree, preserve research | Branch `feature/native-history-buffer`, git base 9596b25; plan-review/import records and original 12 research hashes; current worktree `/home/quant/repos/market-watch-native-history` | Implemented; no main merge/push/deploy |
| R2 §1–2 native owns demand/history; thin frontend; policy only backend; real native periods; no licensed edits | `provider_history_policy.py`, `provider_cache.py`, `provider_chart.py`, `bridge.js`, `AdvancedWorkspace.tsx`; runtime manifest 2928 licensed files/0 changes | Implemented; no second frontend bar cache or product scheduler |
| §3 mandatory D/H, exclusive to, countBack unchanged, optional caps/backend switch, multichart R/focus, Python E=0, strict context | Cache/chart affected tests; selected response metadata; `browser-focus.json` and old/new compatibility reports | Proven within recorded test scopes; defaults enabled at 400/2000/2000; downwards caps preserve D/H |
| §4.1–2 invalid types/ranges, actual range counts, future-empty range, capacity 20000/20001 and real boundary | `test_native_history_rejects_number_and_time_coercion`, `test_native_capacity_exact_limit_and_one_over`, `test_native_future_empty_range_and_confirmed_young_boundary`, structured capacity/API tests | Proven backend behavior; no guessed calendar counts or forged noData |
| §4.3 mandatory PG hit does not become miss for E, no gap crossing, fresh tail/classification | `test_native_missing_optional_or_disconnected_history_never_fetches`, stale-tail tests, fixed formal response cache_hit/attempts | Implemented/tested; two selected PG-scene misses retained as failed samples |
| §4.4–5 attach E only to required provider request, stop at D/H; exact HTTP attempts | `test_cold_optional_does_not_add_candles_http` Binance 200/700/1000/1200 and OANDA 3999; `high-period-http-tests.txt` D1/W1/MN both adapters; formal candles attempts separately classified | Proven affected test scopes; real retries not disguised as pages |
| §4.6–9 generation/coverage, one statement snapshot metadata/bars, optional budget and SKIP LOCKED, bounded active read lifecycle | `test_provider_postgres.py` snapshot revision barrier, lease fencing, locked bookkeeping and expired pool waiter; 116 enabled-default affected tests | Proven real-PG barriers; existing checkout residency limit documented |
| §4 late old response, real revision and pure backfill, inclusive last, once-only check, failed/legacy check, inactive correction, 64 original observation bounds | Provider-history-observation VM scripts; backend observation test; `browser-late-revision-barrier.json` and `browser-late-backfill-barrier.json` | Real browser positive/negative interleave proven with autonomous loops held; inactive/failure/overflow remain VM proofs, not claimed separate full browser matrix |
| §5 same-anchor target growth, done reopening, generation/task_id CAS, finite two rounds and existing ordering | `test_same_anchor_historical_demand_growth_only_expands_focus_left_targets`, real-PG worker/activate race and recreated-task tests; finite targets/service tests | Proven affected test scopes |
| §5 historical direct/navigation cold/cache and real gestures; crossing finite boundary allowed | `browser-jump.json`, corrected preparation report, `jump-behavior-audit.json` | Native corridor/to/gesture mechanism recorded. Cold stress has 503; OANDA later setup timeout; entire matrix not passed. User clarified this is separate from ordinary cold demand+fixed E and 3s gate |
| §6 rapid cycles, legal old callbacks, workspace epoch, subscription lifetime | `buffer-selected-behavior.json`: 20 settled + 20 overlapping 80ms actions each provider; request-lifetime/subscription VM checks; late actual callbacks | Proven recorded actions/VM lifecycle scope; no universal scheduling guarantee |
| §7 native MA200, native M1/M15/H4/D1/W1/MN, no duplicate time | Candidate single-provider behavior trace/screenshots and affected adapter tests | Proven recorded behavior |
| §7 Python equal same D/H with E on/off, both D=N and D>N | `python-native-demand-tests.txt`, cache EMA same-D/H test; Python E=0 policy | Proven both D=N and D>N; broad numerical equality to old N/H explicitly not promised |
| §7 1/2/4/8charts, CPU 1x/4x, focused/unfocused/shared sequence, response bytes/long tasks/RAF/heap | Candidate behavior 10 cases; additional independent focus CPU 1x/4x | Proven recorded configurations; no 60fps/native-total-memory guarantee |
| §7 real historical revision/SSE public reload, preserve range/spacing, real callback revised close; pure backfill no reset | `browser-revision.json`, exact injected-close barrier and negative backfill barrier; provider service tests | Proven controlled correctness. Uncontrolled overwrite failure preserved; screenshot/dataReady are visible-render proxies, not per-pixel paint proof |
| §7 primary latency clock revised by user to getBars entry→dataReady/doubleRAF, UI build appendix | `check_native_history_gate.py`, raw native start/callback/display times/screenshots, summaries | Correct clock and denominators. Original 80 samples: OANDA10/10 cold, 9/10 PG; Binance7/10 cold, 9/10 PG. Selected 40: OANDA10/10 cold, 9/10 PG; Binance4/10 cold, 7/10 PG. **Numeric failure retained; accepted by user for delivery** |
| §8 default enablement only after gates; compatible rollback combinations, no migrations, source/image IDs, final reviewable artifacts | `runtime-manifest.json` per-combination IDs, real old/new compatibility reports, review-results, ordinary runtime true/400/2000/2000 verified; 116 tests; final both-platform display smoke; commits and evidence manifest | Default enablement and isolated delivery complete under explicit user acceptance; no production deployment |

The prior numeric performance blocker has been accepted by the user, so it no
longer prevents this delivery. The checker still reports the original FAIL scores;
only its explicit `--acceptance-decision` mode accepts the bound Binance groups.
No required demand was shrunk, no sample was added/discarded and no PG miss was
reclassified. Recorded stress deadlines and controlled-barrier scope remain
limitations. Final display smoke proves both platforms render with enabled
balanced defaults; it is not another formal performance cohort.
