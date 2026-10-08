# OANDA timeout follow-up

The user requested observation, analysis, debugging and repair of the remaining
timeouts, followed by a complete ten-minute observation for other problems.
Work continues in `fix/oanda-stream-reconnect` without touching other worktrees.
The previous 181-test deadlock repair remains intact. Production release needs
explicit authorization under AGENTS.md before the new image is activated.

## Current evidence

At 2026-10-08 00:34 UTC the unchanged production v1.14.1 worker was running but
the account was latched `unauthorized`, epoch 133, expires=0. Both symbols had
stopped confirmed M1 at 00:00 UTC. Its last stream warning was unauthorized at
00:00:31 UTC. No recent reconnect therefore meant stalled acquisition, not a
healthy stream. A new read-only observation loop treats disconnection or stale
confirmation as a failing result as well as repeated epochs.

Read-only account catalog checks from the existing production container returned
200 with 127 instruments through its configured proxy (4457 ms). The same request
without proxy failed at TCP connect (ConnectError, 5090 ms). No credentials,
proxy URLs or response payloads were printed. This does not establish which party
returned the earlier stream authentication response, and is not justification
for replacing the configured route.

Rechecking all nine original timeout epochs against the continuous samples found
each failed 15.589-15.718 seconds after connection creation, with no new heartbeat
or quote persisted before that exit. This supports an initial-data stall rather
than a later healthy stream becoming idle, but does not distinguish response
headers from response body, routing failure from upstream failure, or rule out
unobserved local processing. New transport phase diagnostics are necessary.

A normal HTTPS password login and existing `/api/market-data/live/retry` call
cleared exactly one expired configuration fault. Logout succeeded; credentials
and cookies remained in memory. No second supplier stream or owner was created.
The original worker resumed, and its unchanged code again produced database
failures and repeated epochs. The permanent authentication fence is preserved;
there is no blind retry of authentication failures.

The 180-second retry observation (00:37:45 to 00:40:45 UTC) recorded 37 samples,
epoch 134 -> 139, twelve per-symbol unavailable audits, and no advance of either
confirmed M1 watermark. Both quotes changed, so this was repeated partial
recovery rather than complete absence of supplier traffic. It is a failing
baseline, not the requested post-repair ten-minute check.

## Hypotheses and diagnostic change

The remaining distinguishable possibilities are transport stalls waiting for
response headers, gaps in response body/heartbeats, or local ownership/generation
timeouts. The existing repair distinguishes stream iteration from local publish
and maintenance failures. New adapter diagnostics use HTTPcore's real trace hooks
to further classify connect/TLS/send/receive phases; HTTP status failures retain
only the numeric status and a fixed JSON/HTML/other content classification.

Warnings include elapsed milliseconds, time since the last decoded record,
record count and epoch. They exclude request/response metadata, exception text,
account identifiers, tokens, raw prices and payloads. Exceptions are re-raised
unchanged, and timeout, backoff, readiness and authentication fencing behavior
are unchanged. These are lasting bounded diagnostic fields, not temporary debug
logging. No production product files have been patched in place.

Tests first failed for missing phase diagnostics, then passed against a real
Ubuntu-local HTTP server stalling separately before headers and after a heartbeat.
They use HTTPX/httpcore's real streaming/trace path. A separate authentication
response test verifies safe status logging without response-body disclosure.
The targeted stream/worker suites passed 24 tests.

## Acceptance and observation

New isolated Ubuntu task/project `mw-oanda-timeout-20261008`, PostgreSQL 14 on
`127.0.0.1:19750`, independent database/network/volume and synthetic credentials.
Private Compose/env/logs are under
`/home/quant/repos/.production/mw-oanda-timeout-20261008`. Builds use `mw-docker`.
The prior completed acceptance project is not reused. The user subsequently
directed continued debugging and observation in isolation. Production activation
is deferred; no production image or file is changed. The ten-minute isolated
observation is running as described below.

The installed acceptance image passed **65 PostgreSQL** and **119 SQLite/worker**
tests (184 total, no skips); standards and spec reviews found no new issues.
The formal image `market-watch-api:oanda-repair-3f311bc` uses clean immutable
source `3f311bca31fffd916a06cd9641cc0d4323344169` and release lifecycle labels;
its image ID is
`sha256:3553da9b90a41739c404ebc8e61914fdb2e05db6a5fa81d6cb6e9213f6c68d93`.
It separately passed 24 stream/diagnostics/lifecycle tests, and all five changed
runtime modules were verified loaded from installed site-packages. A concrete
image-only backend Compose change and explicit rollback scripts are prepared
privately. Activating production remains pending explicit authorization under
AGENTS.md; no fixed release tag has been overwritten.

## Continued isolated observation

The real installed worker/HTTPX/PostgreSQL/publication/API chain is running on
Ubuntu against a local synthetic supplier. The first response deliberately stalls
before headers for 16 seconds; the second sends two quotes and a heartbeat, then
stalls its response body. Both exceed the unmodified 15-second read timeout.
The logged faults were `ReadTimeout phase=receive_headers records=0` at epoch 1
and `ReadTimeout phase=receive_body records=3` at epoch 2. The worker automatically
reconnected and restored both symbols to healthy at epoch 3.

The separate 600-second steady observation started 2026-10-08 01:11:52 UTC
(09:11:52 Singapore), after injection and recovery. It samples real authenticated
API results and independent database queries every five seconds, without supplier
connections or production data. The harness and reproduction instructions are
in `docs/verification/oanda-stream-isolated/`. API address:
`http://127.0.0.1:19751/readyz`; synthetic supplier: `127.0.0.1:19752`.
These isolated results establish application recovery/lock behavior, not the cause
or disappearance of the historical real-supplier timeout events.

Independent harness review found that the initial publication check compared
only the greatest watermark and could miss a stalled symbol; five-second
`attempts` samples could miss recovered publication failures. Both were corrected:
each symbol now has its own publication watermark check, and every publisher
cycle records abnormal results cumulatively. PostgreSQL deadlocks are checked
independently. A momentary `idle in transaction` sample between normal SQL
statements is retained but distinguished from a transaction older than five
seconds which is currently idle. The original run's raw result is preserved.

The strengthened observation restarted against fresh database
`oanda_observe_final` in the same isolated project, API `127.0.0.1:19753`, synthetic
supplier `127.0.0.1:19754`. The two deliberate 16-second faults were repeated;
both recovered at epoch 3 before the new 600-second window started at
2026-10-08 01:18:16 UTC. Re-review confirmed the previously found observation
defects were addressed. This final window, rather than the earlier run, determines
the application-chain acceptance result.

The final isolated window ran **01:18:16.270 to 01:28:16.280 UTC** (09:18 to
09:28 Singapore), **600.024 seconds / 121 samples**, and the harness exited 0.
All eleven checks passed: constant epoch 3, fresh healthy/readiness results for
both symbols, positive leases, each symbol's confirmed M1 and M1 publication
advancing ten minutes, no cumulative publication failures, zero PostgreSQL
deadlocks, no old currently-idle transactions, no notifications and no new
warnings during the steady window. The four expected warnings correspond to
two deliberate timeouts and are outside that window. The supplier was contacted
three times in total, exactly the injected first and second attempts plus the
healthy third connection. Safe synthetic evidence is committed at
`docs/verification/oanda-stream-isolated/result.json`.

The final run's separate SSE client received 30 heartbeat events and 31 snapshots
over 30.25 seconds, epoch 3 throughout, with no unhealthy row. Its login/logout
completed normally. The initial run's 600-second report remains private with its
original failed instantaneous-idle check; it was not relabeled as passed.

The application-chain repair and controlled timeout recovery are verified in
isolation. The actual historical nine transport failures remain unproven: no
real supplier/production proxy stream was opened during this isolated run.
Testing that path can also be done on Ubuntu with a separate practice account;
it does not require first deploying to production. No production image/file was
changed, and the prior production-switch request is deferred by user direction.

After successful observation, `mw-docker retire` preview and `--apply` archived
and actually restored every non-template database, including both populated
synthetic observation databases. Table counts and source stability matched.
The private archive is
`/home/quant/.local/share/market-watch-docker/archives/mw-oanda-timeout-20261008-20261008T012902-4f5c9290`.
Exactly three project-owned containers, its network and PostgreSQL volume were
removed; label-filtered inventory is empty. The acceptance image was retired;
the separately owned formal release candidate remains retained and undeployed.
Local addresses `19750` through `19754` no longer serve this task. A repeat
requires a fresh task/project and database rather than reusing the completed one.

During the first isolated window, a separate actual API SSE client received
45 heartbeat events and 46 snapshots in 45.33 seconds, all at epoch 3 with no
unhealthy rows. PostgreSQL's cumulative deadlock count was zero. Authentication
used only the isolated synthetic password and each client logged out normally.

## Authorized live-account investigation

The user subsequently authorized pausing the production pricing service and
exclusive use of the same practice account in Ubuntu isolation. This supersedes
the earlier account-use restriction; production product deployment remains
outside the current authorization. The exact existing production pricing
container stopped at **2026-10-08 01:36:21 UTC**. All debugging instances run on
Ubuntu, fresh task/project `mw-oanda-live-debug-20261008`, PostgreSQL on
`127.0.0.1:19755` and isolated API on `127.0.0.1:19756`. Only whitelisted supplier
settings were copied privately; no production database, notifications or account
changes are used. Recovery remains the configured 1500 minutes.

Three initial sequential 30-second real streams succeeded. A subsequent bounded
reconnect probe reproduced **ReadTimeout after 15.837 seconds, zero records,
receive_headers**, without any pricing publication or confirmation work. This
reproduces the historical timing signature independently of the database lock
inversion. A separate attempt failed proxy TLS after 5.005 seconds; every later
attempt on that client's single-slot pool failed PoolTimeout after 15 seconds.
The probe was stopped instead of retrying indefinitely.

Ranked, falsifiable hypotheses were proxy/route stalls, account reconnect timing,
and HTTP client pool state. HTTPcore trace then showed a successful CONNECT
followed by a stalled TLS upgrade. With the repaired pool lifecycle, further
real attempts distinguished **receive_headers / upstream** stalls (15.7-16.0
seconds, zero records): the CONNECT and TLS stages had already succeeded.
These are separate faults; the nine old warnings lack the fields needed to
assign each one retrospectively.

### Deterministic pool failure and repair

Installed dependencies are HTTPX 0.28.1 and HTTPcore 1.0.9. HTTPcore's
TunnelHTTPConnection starts an HTTP CONNECT request, leaving its underlying
HTTP11Connection ACTIVE after upgrade. If the subsequent start_tls raises, the
tunnel never becomes connected, but delegates availability/idle/closed checks
to that ACTIVE connection. It occupies the sole stream pool slot indefinitely;
next requests wait for a slot and raise PoolTimeout without contacting OANDA.

`test_proxy_tls_failure_does_not_poison_next_stream_pool` uses a real local CONNECT
proxy and actual HTTPX/HTTPcore/socket/pool path. Only the TLS handshake is
injected, first failing and then succeeding. With `a4a006f` the second attempt
fails PoolTimeout; after the fix it receives a heartbeat. ConnectTimeout and
ConnectError both exercise this seam. Early consumer termination also closes the
owned pool. Caller-supplied test clients retain caller ownership.

Each owned stream attempt now gets its own client/pool, closed in finally on
normal EOF, transport error, invalid payload or generator close. REST remains
separate; the connection/read timeouts stay 5/15 seconds. Worker backoff,
authentication fencing, dataset identity and recovery/readiness gates are intact.
Safe diagnostics distinguish proxy CONNECT, proxy TLS, upstream and pool routes,
without printing metadata, request URLs or credentials.

### Route comparison in progress

Direct authenticated catalog access from Ubuntu fails ConnectError after about
five seconds, matching the previous production direct check. The configured
Mihomo proxy applies an existing dedicated OANDA selector; its fallback had
selected US node 01. Only this OANDA selector is temporarily changed for a
sequential route comparison, with the original selector saved privately. No
shared/general selector, proxy rule or other provider group is changed.
This separates route behavior from the now-proven client pool defect; final
route and full real ten-minute results follow below.

The alternate US node also reproduced upstream receive-header stalls, so the
comparison does **not** justify attributing the stalls to node 01 or changing the
shared proxy policy. The original dedicated OANDA selector has been restored.
An A/B/A handoff mistakenly started the next probe before the prior one had
fully exited; the overlap was stopped and its interval is excluded from causal
comparison. All later probe/worker harnesses hold a nonblocking account-wide file
lock in the private Ubuntu project. No production stream ran during the probes.

The application pool repair alone eliminates the reproducible permanent local
PoolTimeout state; it does not make the network infallible. In a separate
post-repair sequential probe, actual upstream read-header timeouts were followed
by successful connections instead of permanently occupied pool slots. A
60-second continuous stream on the original route received 183 prices and 11
heartbeats without reconnecting.

The clean repaired acceptance image is
`market-watch-api:oanda-live-repaired-20261008`, runtime source
`7dfc223f7e12771289758eb395c1c639e746365e`, image ID
`sha256:8594e2221ebb2f33e9c62ef8bea6cffe89bbd9cae9525c8849aa1394f0fff906`.
Its 50 targeted adapter/worker/history-source/live-pricing regression tests
passed in 5.33 seconds; the earlier broader 184-test deadlock/transport suite
remains the preceding validation, not an additional disjoint test count.
All five affected/runtime-adjacent module SHA256 values match installed
site-packages against the isolated worktree; no source import override is used
in final runtime observation. Standards and Spec review of `a4a006f...7dfc223`
each found zero new findings, and both retained the unproven-stall limitation.

The actual supplier/worker/PostgreSQL/confirmation/publication/API chain restored
both symbols healthy at epoch 1 with the original proxy selection and configured
1500-minute recovery. Its final real 600-second observation began
**2026-10-08 01:51:36 UTC** (09:51:36 Singapore). Results are recorded after the
complete window; intermediate healthy snapshots do not constitute acceptance.

## First complete real window and remaining findings

The original real observation ran **01:51:36.815 to 02:01:36.827 UTC**
(09:51:36 to 10:01:36 Singapore), **600.037 seconds / 121 samples**.
Stream epoch stayed 1 throughout; no transport warning, reconnect, database
deadlock, long idle transaction, cumulative publication failure or notification
occurred. Both confirmed M1 watermarks advanced exactly ten minutes. Each M1
publication advanced at least ten minutes (EURUSD was still completing initial
publication catch-up in the first snapshot, so its difference was 70 minutes).
The isolated SSE check lasted 30.401 seconds, with 29 snapshots and 30 API
heartbeats at epoch 1 and no unhealthy snapshot during that shorter check.

The strict every-sample-healthy assertion **failed**, and the original report and
nonzero harness result are preserved, not overwritten. Across 242 symbol samples,
236 were healthy, four were degraded (two simultaneous confirmation-fault
samples at 01:55:13 and 01:58:14), and two were EURUSD quote-stale at the end
(source quote age 19.1/20.5 seconds, fresh stream heartbeats and confirmed M1).
The three transport/confirmation/readiness outcomes are reported separately.
Short M1 request failures recovered automatically; minute failure counters retain
those failures even after last_result becomes data. No new database latency
regression was observed: confirmation processing was at most 189 ms, with
observed completed-minute evaluation latency up to 16.51 seconds. The sparse
samples cannot retrospectively identify the first two REST exception classes.
No gate or quote freshness threshold is relaxed to turn this failed assertion
into a passing result.

Further sequential protocol comparison negotiated actual HTTP/2 but still had
three upstream header ReadTimeouts and one connection error among twelve
attempts, followed by recovery on fresh pools. Therefore HTTP/2 is not enabled
in the product. Twelve separate REST-only confirmation requests succeeded;
that shorter check does not negate the intermittent faults in the real window.
The official OANDA development guide states 20 active streams per requesting IP,
120 REST requests/sec and at most two new connections/sec. The sole-account
sequential probe cadence is well below the last limit; a shared outbound IP's
other usage remains outside the captured evidence.
Reference: https://developer.oanda.com/rest-live-v20/development-guide/

## Handoff-stage additional isolation

Read-only inspection of the existing production Mihomo logs correlates the two
01:55:13 and 01:58:14 degraded samples with preceding OANDA REST dial warnings
at 01:55:10.996/10.998 and 01:58:10.298/10.301 UTC (`connect error: context
canceled`). Cancellation may be an effect of an application deadline; these
warnings do not by themselves identify the originating network cause. Proxy
health tests continued to report the selected nodes alive, and test a generic
Cloudflare endpoint rather than actual OANDA.

An additional proxy ran only on Ubuntu, within the exact same isolated acceptance
project/network. It executes the copied existing Mihomo v1.19.31 binary, mounted
read-only, with a private minimal fixed-node configuration, no provider refresh,
no fallback, no sniffing and no production volume. HTTP mixed/controller ports
are loopback 19757/19758. The binary and node credentials are private and are
not repository artifacts. Production pricing was temporarily resumed at
02:08:48 UTC then paused again at 02:14:26 UTC for this sole-account comparison.
No production product image was changed.

Twelve attempts through this Ubuntu proxy using the same US01 outbound produced
six successes, four TLS ConnectTimeout/ConnectError failures and two upstream
response-header ReadTimeout failures. Changing only the isolated proxy's fixed
outbound to a different supplier's Japan VMess/WebSocket node gave eight
successes and four response-header ReadTimeouts (16.0–16.3 seconds, zero records).
This disproves an exclusive VLESS/xhttp explanation and does not justify a
permanent production route change. A preceding same-endpoint SOCKS probe also
failed TLS in seven of twelve attempts; no SOCKS dependency or policy is added
to the product.

The user requested `$handoff` to let another agent investigate this remaining
blocker. Independent read-only deep analysis has been delegated; live probes
are closed before restoring original production pricing. The task remains
unfinished. Its isolated database/project and images are retained, not retired
or marked complete; resumption requires pausing production pricing again before
opening any Ubuntu account stream. The sanitized temporary handoff references
the existing documents and private evidence instead of duplicating them.

## Execution of returned diagnosis plan

The user explicitly requested execution of the returned plan in
`/tmp/market-watch-oanda-timeout-handoff-gn0gxojl/analysis-resumed.md`.
Production pricing stopped again at **02:31:41 UTC**, with no concurrent Ubuntu
account stream. Existing task/project remains active. A private host-side probe
holds the same account flock used inside the bind-mounted debug container.

Fixed Japan VMess/WebSocket outbound, HTTP/1.1, account, symbols, snapshot=true,
User-Agent/Accept/Accept-Encoding/date/auth headers, fresh client/process per
attempt, five seconds of records and two seconds after full close. ABBA order
compared HTTPX 0.28.1/HTTPcore 1.0.9 with curl 7.81.0. No extra catalog or REST
requests ran inside that comparison. Raw curl verbose lines are parsed only in
memory and immediately discarded; account/token are supplied through stdin
config, never argv or persisted traces. The valid batch is
`compare-abba-final.jsonl`; the earlier harness parser failure is preserved and
excluded rather than combined. Host Python used OpenSSL 3.6.3, curl OpenSSL 3.0.2;
these version differences remain explicit.

Curl's 60-second total timeout is only an insurance deadline. The observer starts
its 15-second header inactivity deadline after GET is sent, resets only for
received upstream header/body data, and labels observer termination separately
from curl exit 28. HTTPX keeps real connect5/read15 timing. At every exit the
subprocess/client/socket closes before the next attempt. Authentication or rate
limit responses stop the batch.

The 24-attempt batch completed with **HTTPX 7/12 success, five header stalls** and
**curl 9/12 success, three header stalls**. All failed requests had completed TLS,
then no status/record until the header deadline. Both stacks reproduce the
remaining symptom; this does not justify replacing HTTPX. Header serialization
and TLS fingerprints are not identical, so the counts are diagnostic batches,
not equivalent randomized SLA estimates.

A separate fixed-client snapshot false/true/true/false comparison completed with
12/12 snapshot=false successful attempts and 11/12 snapshot=true successful
attempts. One failure is insufficient to establish snapshot causality; the
product snapshot parameter is unchanged. Two authenticated DoH resolvers through
the existing isolated outlet agree on OANDA addresses that differ from Ubuntu's
ordinary DNS. A separate isolated-proxy hosts mapping retains original Host/SNI
and certificate checks; it still reproduced one header stall among twelve curl
attempts. Therefore a static address mapping is not deployed as a fix.

REST boundaries now use the same bounded trace mapping as the stream. Safe
`oanda_rest_failed` warnings retain catalog/candles, network or local-slot phase,
route, exception class, numeric status, body category and elapsed time; they do
not log URLs, SQL, identities, tokens, content or exception strings. Catalog
errors still raise unchanged; page errors still become the same failed
CandleBatch and cooldown behavior. Four real local header/body timeout cases
were red before instrumentation, then green; two 401 cases verify preserved
classification and secret exclusion. The 56 relevant source tests passed.
Final observation will also keep every failed REST batch cumulatively and
supplier/receiver quote timestamps; no readiness or freshness thresholds change.


### Further controlled path and timing evidence

The pinned-address HTTPX batch also retained two header stalls among twelve
attempts (10/12 success); the proxy controller verified the actual destination
as 104.18.39.182. Fixed address does not establish a cure. After restoring domain
routing, fresh HTTPX attempts with **15 seconds after complete close** still
failed twice among eight (6/8 success), including the first two attempts. This
is not a demonstrated benefit of extending product backoff.

Ordinary Ubuntu DNS returns unrelated addresses; two authenticated DoH resolvers
through the existing exit agree on the OANDA addresses. A new controlled ABBA
path comparison pins **104.18.39.182 for both direct and isolated Japan proxy**,
retains original Host/SNI and certificate validation, fixes HTTPX and request
headers, and closes completely before the same two-second gap. Direct completed
**5/6**, proxy **5/6**, with one upstream-header ReadTimeout each. The direct
failure completed TLS in 174 ms then waited about 15 seconds without status or
records. Thus this proxy is not a necessary condition for the symptom. These
small batches do not establish equal reliability; Cloudflare anycast does not
guarantee the same physical edge from different exits. Direct trace initially
labels TCP as proxy_connect_tcp due to a harness label, not actual proxy use.

The new installed image `market-watch-api:oanda-rest-diagnostics-20261008`
(source 6f2af8f) passed **83 relevant installed-package tests**; five runtime
module SHA256 hashes match the worktree and import from site-packages. Both
Standards and Spec reviews report no findings. The source test result of 56
covered a narrower selected set; it is not combined with installed counts.

A new fresh database `oanda_rest_final` in the existing isolated Ubuntu project
runs the real worker, confirmation, publisher and authenticated API. This window
explicitly uses the **original configured production proxy path**, not the
isolated Japan comparison exit. Configured recovery remains 1500 minutes,
delivery is disabled, and no freshness/readiness or timeout gate changes.
After both symbols were healthy and both publications caught up, observation
started **03:34:44 UTC** for 600 seconds. Earlier failed records remain intact.
The observer records every failed confirmation batch cumulatively plus source,
receiver and local sample timestamps. Final results will follow below.


### Latest completed real window: strict acceptance failed

**03:34:44.151–03:44:44.158 UTC**, **600.026 seconds / 121 samples**,
observer exit **1**. This was the immutable 6f2af8f diagnostic image on Ubuntu,
original configured production proxy, real practice account, fresh isolated PG
database. It is not a successful final acceptance and is not superseded by a
selected later green window.

- Connection: epoch **1 -> 2**. After **713 decoded records**, the established
  stream stalled in `receive_body`, `ReadTimeout`, **15,030 ms** since its last
  record, status 200. It automatically reconnected, then both symbols became
  healthy by **03:41:46.694 UTC**; neither pool exhaustion nor DB deadlock
  prevented recovery. This adds a mature-stream failure to the initial-header
  stalls; the remaining problem cannot be described as initial-only.
- Confirmation: **six cumulative REST failures**, three paired episodes at
  03:37:10, 03:39:10 and 03:41:30 UTC. All show `phase=tls route=proxy_tls`,
  **5,011–5,019 ms**, three ConnectTimeout and three ConnectError. Therefore
  these confirmation failures are TLS establishment faults, distinct from
  initial upstream response-header stalls. The five-second connect limit is
  unchanged. Each symbol's confirmed M1 still advanced **600,000 ms**.
- Publication: each symbol's M1 publication advanced **600,000 ms**; **zero
  cumulative publication failures**, zero pending publication error counts.
- DB/ownership: **zero PostgreSQL deadlocks**, positive leases throughout, zero
  long idle transactions. Delivery remained off and outbox empty.
- Quote quality: of 242 symbol samples, **230 healthy, three stale, three
  unavailable and six recovering**. EURUSD stale samples had source ages
  **17.4, 15.261 and 19.043 seconds**, corresponding source-to-receive delays
  **366, 176 and 809 ms**, with fresh heartbeats and XAUUSD quotes. These show
  the latest accepted EURUSD quote did not advance sufficiently, not a
  persistently delayed delivery of that quote or a whole-stream outage in
  those samples. Existing minute metrics corroborate accepted quote gaps:
  **19,164 ms** at 03:38, **15,922 ms** at 03:39, **18,736 ms** at 03:44.
  They only count accepted records, so they cannot prove the supplier sent
  nothing or that no old/duplicate record was filtered. No filtering defect
  was found: newer source time is accepted even when prices do not change.
  The 15-second stale gate remains correct and unchanged.
- Separate API/SSE check: **30.393 seconds**, 22 snapshots, 30 heartbeats,
  epoch 1, no unhealthy snapshot in that short subwindow. This is not the
  whole-window verdict.

Private evidence: `live-rest-final-evidence/report.json`, `observation.jsonl`,
`fault-recovery.jsonl`, `warnings.json`, `live-rest-final.log`,
`quote-gap-evidence.json`, and `live-rest-final-sse.json`. Earlier failures
remain in their original directories.

### Remaining discriminants and conclusion

After the observation worker and account lock exited, a **direct curl/HTTPX
ABBA** batch pinned the same trusted IP with original Host/SNI and certificate
validation, disabled all proxies, and retained identical safe headers and
phase timing. **Curl 5/6, HTTPX 5/6**, one upstream-header deadline each. Both
stacks therefore reproduce on the direct path as well as the proxy path. A
second direct HTTPX batch changes only request headers: **adapter default
headers 3/4, comparison headers 1/4**, header stalls in both. These bounded
samples establish reproduction; they do not estimate relative reliability or
show a header-level fix. Host OpenSSL differs from the installed image and
Cloudflare anycast is not a fixed physical backend.

Two independent agents reviewed the evidence and quote filtering: no additional
proved code defect. The local pool recovery and lock-order changes remain
validated, but initial response headers, REST TLS establishment and stream body
loss still occur. Do not change library, route, backoff, pool size or timeout
without a successful controlled counterfactual. For responsibility assignment,
next useful evidence is a genuinely controlled dedicated outlet or supplier-side
request handling, and per-symbol receive/accept/reject counters plus byte/chunk
arrival and local processing timing for a new targeted stream window. Existing
DB cannot retrospectively supply those counters. No supplier messages were sent.

The task/project stays **active**; no retirement or production release occurs.
Ubuntu account processes all exited and the account flock was free, debug and
proxy containers were confirmed stopped, then the original production pricing
container was started again. Its original v1.14.1 image remains unchanged; the
new repair is not deployed to production. Post-resume status is recorded below.


Production resumed at **03:51:08.393 UTC** with image
`market-watch-api:v1.14.1-6fd9273`. At **03:52:06 UTC** it was running but
pricing epoch 236 was disconnected/unavailable; neither symbol was ready and
confirmed M1 had not caught up. Restart is not described as healthy restoration.
The unchanged production does not contain the verified application repairs.


### Ubuntu instance operation

Observed API/ready address: **http://127.0.0.1:19756/readyz**, authenticated live
API on the same port. This address served the Ubuntu installed-image observation,
not an SSH forwarding to production. The API process has exited and both debug
and isolated-proxy services are now stopped. Only the task's PostgreSQL remains
running; the task is unresolved and its volume/evidence are retained.

Private files are in `/home/quant/repos/.production/mw-oanda-live-debug-20261008`.
Exact idle-service startup and service stop commands (no build, no production
volume, no account stream starts merely by starting the sleep container):

```sh
sg docker -c 'docker compose --env-file /home/quant/repos/.production/mw-oanda-live-debug-20261008/compose.env -p mw-oanda-live-debug-20261008 -f /home/quant/repos/.production/mw-oanda-live-debug-20261008/compose.yaml up -d --no-build postgres debug proxy'
sg docker -c 'docker compose --env-file /home/quant/repos/.production/mw-oanda-live-debug-20261008/compose.env -p mw-oanda-live-debug-20261008 -f /home/quant/repos/.production/mw-oanda-live-debug-20261008/compose.yaml stop -t 30 debug proxy'
```

A new account observation requires: production pricing stopped and confirmed
exited, no pending account process and exclusive `/verify/account-stream.lock`,
a **new independent empty DB** selected privately in runtime.env and debug
recreated, then run the installed harness with a unique new evidence directory:

```sh
sg docker -c 'docker exec mw-oanda-live-debug-20261008-debug-1 python -u /verify/run_live_final.py --seconds 600 --output /verify/NEW-UNIQUE-EVIDENCE-DIRECTORY'
```

Do not reuse `oanda_rest_final` or overwrite the preserved failure directories.
The fresh-owner assertion deliberately rejects them. Confirm the account process
has exited before stopping Ubuntu services and restoring the exact original
production container. This operation is not production deployment authorization.
