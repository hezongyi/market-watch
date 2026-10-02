# Volume evidence

All observations are from 2026-10-02 UTC on this Ubuntu host. Candidate:
`https://localhost:15553`, chart `https://127.0.0.1:15554`, PostgreSQL16 database
`market_watch_volume`; local target: ports15453/15454, database `market_watch_dual`.
Delivery/runtime source is `edc799a97999b8cf387a03c380669bf6a8d28083`.

| Evidence | Meaning |
| --- | --- |
| backend-pg17.txt | Final full suite:340 passed,1 skipped; fresh disposable PG17 precision/locking fixture, SQLite logical tests also run by the suite |
| frontend-vm.json | 39 non-browser Node scripts passed, including market volume and Python internal0/1 bridge |
| web-build.txt | TypeScript/Vite production build passed; existing chunk-size warning |
| native-provider.json / native-managed.json | 18 real native cases per series, two sources and nine periods; canvas pixels prove Volume histograms were painted |
| native-values-*.json | Native data-window/crossHairMoved quantities match API values |
| native-final-candidate.json | Intermediate fe370c2 same-source images:four M5 source/series cases, histogram/value/save-reopen checks |
| native-zero-missing.json | Controlled VOLUME:CHECK fixture in the actual native package:0 displays0, null displays∅; not a claim of an upstream zero sample |
| upstream-alignment.json | Six confirmed provider/managed samples re-fetched from real upstream; managed M5 and monthly sums checked member by member |
| http-csv.json | Authenticated container API and CSV exact Decimal quantities/units, both sources and both series |
| provider-sse.json | Real HTTP SSE bars carry actual quantities for both sources; heartbeats do not count |
| real-backfill.json | Real backfill preserves fixed historical price fields, coverage, watches and replay snapshots; this is an earlier snapshot |
| final-candidate-state.json | Later final publication/job statistics after actual BTC September acquisition and gap repair; supersedes earlier aggregate counts |
| native-load.json | Final six cold native reads, all cache_hit=false; nine reopened-document warm reads, all cache_hit=true; eight-chart real volume-backfill overlap |
| native-first-screen-initial.json/txt | Additional complete-page probe stopped on timeout; JSON SAMPLE records reconstructed from preserved stdout after accidental overwrite, explicitly identified |
| native-first-screen-concurrent.json | Additional complete-page probe failed performance gates while another native-history browser benchmark and part of local native verification overlapped |
| performance-environment.json | Four-core host contention evidence; concurrent task was not terminated |
| native-load-initial.json | Earlier latest-period switches exceeded1s; no cache classification was captured. Failure is retained |
| native-load-reset-timeout.json | resetData did not issue an HTTP demand; harness failed waiting for a response |
| native-load-warm-miss.json / native-load-observer-race.json | Harness response-observer race included prewarm responses in reopening timing; corrected by awaiting response recording before the offset |
| migration.json | Fresh PG16 n15→o16→p17 chain and independent restored o16→p17 path; original backup's before-n15 filename was inaccurate and is explicitly corrected |
| rollback.json / rollback-resume.json | PG16 dump restore, durable fence/archive, actual v1.3.2 startup/price read-write/health, then final new image resumes fenced work |
| local-upgrade.json | Actual local backup, o16→p17, permitted start list and initial matching service IDs |
| local-api-repro.json | Original two-source50-bar provider reproduction now returns50/50 quantities for each source |
| native-local.json / local-final-state.json | After fixed-image restoration:four local M5 quantity/histogram/save-reopen checks and repeated matching source/image runtime verification passed |
| local-concurrent-overwrite.json | Another worktree replaced local chart-origin with a price-only v1.3.2 image after upgrade; original upgrade evidence cannot represent that later mixed runtime |
| native-local-initial.json / native-local-debug.json | Local mismatch detection while that old chart image was present |
| mobile-readonly.txt | Real mobile native read-only probe; no writes or page errors. An existing viewport restoration warning is retained |
| code-review.md | Independent Standards and Spec conclusions and fixed regressions |
| completion-audit.md / runtime-audit.json | Final requirement audit; current images/source, schema, health and backup hash/mode confirmed |
| history-ui-audit.json | Real task page reads jobs and two segment pages; controls visible; reading/closing performs no task writes |
| history-ui-audit-initial.json / history-ui-audit-selector.json / history-ui-audit-page-order.json | Probe failures: wrong iframe, ambiguous text selector, then invalid assumption that the first page contains the conflict; corrected without product changes |

The 36-case matrix predates the final watch-evaluation/publication fixes.
Chart/parser/aggregation runtime files were unchanged; the publisher was
changed to allow existing confirmed historical snapshots to reconcile outside
the current continuous range, including when current coverage is absent.
Final same-image browser checks, final regression suite and source/image labels
establish the relationship. The six real upstream samples include BTC
September managed month469465.12983000 and OANDA CAD_CHF366489. The BTC month
required acquiring its approved September M1 range in the acceptance copy;
that extended candidate fixture was not transplanted into the local target.

Performance timing ends at native public dataReady plus two animation frames,
not GPU completion. Final cold readings were611–1874ms, warm reads258–464ms.
The120-second eight-chart experiment produced10 observations while actual
volume tasks were active and live maintenance advanced. The final observation
had all four watermarks below120s. One intermediate sample reached140850ms
during an upstream error; this is not a guarantee that every observation stays
below120s. Provider latest-tail refreshes that fetch upstream are not asserted
to be complete cache hits.

The additional complete-page cold benchmark failed its original performance
gate (balanced12-sample serial run:3 below3s). Performance work was explicitly
removed from scope by the user's subsequent instruction. Keep this failure;
the delivery's accepted scope is Volume functionality and data correctness,
not a claim that complete-page performance passed.

Re-run source checks with `PYTHONPATH=backend .venv/bin/python -m pytest -q`
and a disposable `TEST_POSTGRES_URL` (never a user database). Run browser probes
with `node web/tests/advanced-volume.browser.cjs` and
`node web/tests/advanced-volume-load.browser.cjs`; set VOLUME_APP,
VOLUME_CHART and VOLUME_OUTPUT to an isolated target. Set
PLAYWRIGHT_CHROMIUM_EXECUTABLE for a local Chromium installation; this host
uses `/tmp/mw-volume-browser-libs/usr/lib/x86_64-linux-gnu` in LD_LIBRARY_PATH.
VOLUME_VALUES=1 enables quantity comparison, VOLUME_CASES selects samples.
Browser probes create dedicated acceptance workspaces. The load probe starts
approved EURUSD/XAUUSD volume tasks, and must run only on the acceptance copy.
Credentials, API envs, dumps and licensed chart binaries are intentionally
kept outside Git.

Final-source evidence added after the historical publication fixes:

- native-release-candidate.json:four M5 source/series quantity/pixel/save-reopen checks.
- native-release-monthly.json:two managed monthly real positive API/pixel/save-reopen checks.
- native-release-monthly-hover.json:an extra monthly value-probe attempt could not
  put its cursor on either of only two sparse candles; the retained crosshair
  event was the previous M5 event. This is a probe failure, not a value match.
  The separate monthly histogram/API checks and upstream member-sum evidence
  establish the actual values; no claim of a new monthly data-window check.
- native-first-screen-balanced-before-fix.json:complete-page serial performance failure.
- native-first-screen-fixture-scope.json/fixture-identity.json:invalid fixture
  invocations retained and corrected; not accepted cold measurements.

The final publisher proof is publication-liveness.json:actual old complete
snapshots reconcile and their dirty queues drain without advancing coverage.
