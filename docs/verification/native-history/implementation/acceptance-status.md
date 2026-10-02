# Native history acceptance status

Isolated branch: `feature/native-history-buffer`, baseline v1.3.2
`9596b25eda507ef708a327feb5271f238cdfdc0b`. Implementation and corrections are
committed through `893bf576675aa412b7ecd7a4d10ece3106a072fd`; acceptance
harness/evidence delivery is committed at 698f81f, with a subsequent correctness supplement. Nothing is merged, pushed or
production deployed. Default buffer remains **false**; isolated acceptance runtime was also restored to off after sampling. Overall acceptance is
**not passed**.

## Primary clock and exact quantities

User direction supersedes the original cold UI clock: **native getBars entry →
chart dataReady followed by double requestAnimationFrame**. This includes bridge
queueing, postMessage, backend/native provider work and native acceptance/render.
Screenshots accompany successful samples. Double RAF is a visible-render proxy,
not proof of every individual painted pixel. Page construction is appendix-only;
HTTP duration alone and native-held-history zero-request gestures are separate.

PG means PostgreSQL demand cache, not a market-data provider. All sampled bars
are real native-period OANDA/Binance bars. PG preparation occurs before timing,
using a finite separate read; no frontend/product preload scheduler is added.

Common measured M5 first-screen native countBack is 165–166. Exact responses:

| Configuration | Cold response | Full demand-cache first response |
| --- | --- | --- |
| E off | 165–166| 165–166|
| R2 E 600/3000 | 765–766| 3165–3166|
| Candidate E 400/2000 | 565–566| 2165–2166|

These are total delivered bars, not viewport bars. Required range D can exceed
countBack; Python prefix H, mandatory demand and capacity remain unchanged.
Downward backend configuration limits only optional E; source defaults remain
R2. Candidate retains two thirds of optional history and avoids the smallest
exploration's coverage reduction, but is **not approved for default enablement**.

## Fixed formal cohorts

Original 80-sample A/B: two providers × off/on × cold/PG × 10, alternating switch
order, fixed fc8af766 runtime. User-clock recomputation:

| Provider | E | Cold <3s | Cold median | PG <1s | PG median |
| --- | --- | --- | --- | --- | --- |
| OANDA | on |10/10|1381.3ms|9/10|767.3ms|
| Binance | on |7/10|1328.7ms|9/10|959.6ms|

Original UI-open medians/scores remain in [performance summary](performance-summary.json)
and [raw records](browser-performance.json), outside the primary gate.

Exploration 36 samples: E 200/1000,400/2000,600/3000, three per provider/scene,
rotated configuration order. This is parameter exploration, not a pass gate.
[Exploration summary](buffer-candidate-summary.json).

Selected 400/2000 formal cohort: 40 fixed samples, 10 per provider/scene. Required
pass rate remains 8/10. Failures, timeouts, page errors, non-200 responses and PG
misses stay in the denominator; no samples were added or discarded.

| Provider | Cold <3s | Cold numeric median | PG scene <1s | PG numeric median | Actual PG hits |
| --- | --- | --- | --- | --- | --- |
| OANDA |10/10|900.8ms|9/10|734.2ms|10/10|
| Binance |4/10|3277.0ms|7/10|798.6ms|8/10|

[Selected raw records](buffer-selected-acceptance.json),
[summary](buffer-selected-summary.json),
[red-capable gate checker](../../../../scripts/check_native_history_gate.py).
Binance PG repeats 0 and 7 missed required freshness/coverage; repeat 7 displayed
within 1s but is still a PG-scene failure. Cold repeat 0 returned 503. Numeric
medians omit absent latency on failure; gate denominators never do.

Slow Binance records show 2.1–6.0s TLS/connection work, including ConnectError
retries, versus about 0.16–0.31s commit for 565–566 bars. Reducing optional bars
can reduce transfer/commit/render cost but does not remove connection long tails.
This later cohort's worse Binance proportion is not a controlled causal proof
that E 400 is slower: network conditions vary over time. Do not retest to obtain
passing percentages or reopen prolonged proxy investigation.

## Behavior and remaining acceptance

Original behavior evidence is preserved; its 2-chart CPU 4x 503 remains failed in
[behavior audit](behavior-audit.json). Selected candidate behavior now completes
10 cases with no HTTP failures or page errors: both providers, MA200, M1/M15/H4/D1/
W1/MN, 20 settled switches and 20 overlapping switches 80ms apart; 1/2/4/8 matching
charts at CPU 1x/4x. Real initial-history bidirectional gestures produced zero
new getBars. Shared sequence budgets, response bytes, long tasks, RAF intervals
and heap are in [candidate behavior](buffer-selected-behavior.json). This does
not promise 60fps or bound total native accumulation. Explicit unfocused budgets
are covered by backend tests, not falsely represented as independent browser
series coverage.

[Real revision run](browser-revision.json) proved pure older backfill does not
reset, real historical revision reloads through SSE/public APIs, revised bar is
delivered to native and historical range/spacing are preserved. The fixture
restored injected isolated data.

The historical jump matrix completed 8 cases: OANDA cold navigation and both PG
navigation/direct reopen succeeded (three real gestures each, zero new getBars);
OANDA cold direct reopen and both Binance cold paths returned 503 on approximately
9600–9700 mandatory bars. Both Binance PG preparations contained 12000 bars but their
latest tail expired while the long preparation ran, and measured startup returned
503. Those remain recorded as failed PG scenes, not cache-hit performance.
[Jump raw record](browser-jump.json). A corrected finite preparation completes a
required tail refresh within its original 30s budget; separate PG-only behavior
verification identifies the fixture change and preserves original failures.
The corrected PG-only run delivered Binance's historical corridor in both
navigation/direct cases. The first older drag crossed the exact earliest native
callback time and legitimately issued one getBars; return/newer movements issued
none. Large native demand 8001/9588 exceeds R4000, so E=0 by policy. This is a
finite-history boundary, not a failed within-buffer gesture.
[Boundary audit](jump-behavior-audit.json) preserves the overstrict original
assertion and separately assesses actual loaded bounds. Its initial direct
Binance read was a miss, so the complete direct scene is not claimed all-PG.
OANDA layout preparation in this later run timed out and stays unverified;
original OANDA PG/direct success remains distinct evidence. Backend PG barriers
and VM tests cover late old snapshots, bounded correction and worker fencing.

Primary performance gate still fails on the fixed Binance common-first-screen
cohort. Approximately 10000-bar historical navigation is a separate stress/behavior
case: the native request itself demanded 8000–9700 bars, E=0. User clarification
confirms that common cold loading is mandatory demand plus fixed optional bars,
then existing finite prewarming; the large-jump timeouts are **not a 10000-bar cold
prefetch policy and not the 3s common-cold gate**. They remain documented deadline
limits, not a reason to raise ordinary first-screen fetch quantity.

Controlled real browser late-response interleaves now pass in a fresh workspace:
[revision barrier](browser-late-revision-barrier.json) holds an unchanged actual
native response until a real PG revision arrives over the real React/SSE chain.
Release is 2817ms after native navigation action, leaving the original 8s budget;
exactly one automatic review returns changed=true. The public native callback
receives the exact injected revised close, correction reload completes and the
bounded pending work clears. [Pure-backfill barrier](browser-late-backfill-barrier.json)
uses an actual provider older-history read, releases in 3464ms, returns one
changed=false review and causes no reset or additional native reload.

These are correctness barriers, not additional performance samples. The unchanged
API image runs [acceptance-only entrypoint](../../../../scripts/native_history_barrier_server.py)
with autonomous provider warm/live loops held, so upstream can neither replace
an injected revision nor consume its setup budget. Product foreground, snapshot,
endpoint, bridge, native and SSE paths remain real. The uncontrolled attempt
[browser late revision](browser-late-revision.json) reached the intended interleave
but failed exact-value assertion after an ordinary provider refresh legitimately
restored the supplier's original historical price. That failed record remains.
Prior reset/navigation setup failures also remain in their original JSON files.

[Independent multichart focus](browser-focus.json) passes at CPU 1x/4x with four
actual distinct periods: M5 focused receives up to 1000 optional bars, M1/M15/M30
unfocused receive E=0; mandatory demand is retained. Two matching M5 charts
share one response and use focus priority. No HTTP/page/native/time errors.
[New frontend/old API](browser-new-front-old-api.json) and
[old frontend/new API](browser-old-front-new-api.json) both pass with actual
v1.3.2/new image combinations for both platforms. Native demand remains N,
optional context is ignored/absent as expected and no extra bars are returned.
Per-combination source/image hashes and old-web origin build argument are in
[runtime manifest](runtime-manifest.json).
The default enablement step is withheld until applicable gates are satisfied.

## Verification and runtime

[Supplement affected tests](supplement-affected-tests.txt): **115 passed** with
real PostgreSQL snapshot/worker/lease barriers. Includes six high-period HTTP
stop cases for D1/W1/MN on both adapters, exercising actual count padding and
trading label filtering without an extra optional HTTP. Original 109-test evidence
and separate six-case output remain preserved. Request lifetime, subscriptions
and history-observation VM checks pass. Web build passed earlier with the existing
bundle-size warning. Licensed library 2928 files show 0 changes and are not committed.
[Independent review](review-results.md), [runtime identities](runtime-manifest.json).
Tuning API uses the 893bf57 source build; web/chart/workers use fc8af766. Runtime
behavior changes after fc8af766 are backend-only optional caps; no schema change.
The precise cohort/source/image relation is listed in the manifest.

## Switch and rollback

`ALERTS_PROVIDER_NATIVE_HISTORY_BUFFER=false` disables E, preserving mandatory
native D/H correction and native-held bars. Candidate settings are cold 400,
first 2000, history 2000; defaults 600/3000/2000 remain unchanged. Complete source
rollback to v1.3.2 also restores its older N/H contract. Older backend ignores
optional unknown fields; no revalidation result is not a negative proof. Older
frontend without context retains old demand behavior on the new backend.
No schema migration was added; schema remains o16.

PG statements use remaining request budget and SKIP LOCKED access bookkeeping.
HTTP waiter is bounded; an expired thread in existing pool checkout waits for
pool timeout then releases without provider SQL. No per-request pool mutation.

Requirement-by-requirement status and limits: [completion audit](completion-audit.md).

Final audit supplement: [Python native-demand tests](python-native-demand-tests.txt)
proves E on/off produces identical bars and EMA output with both D=N and D>N.
No product code or original performance sample changed. Existing v1.3.2 already
prewarms/maintains two chart connections and rotates failed pools; current
recorded TLS reconnects are not evidence of missing buffer-layer prewarming.
