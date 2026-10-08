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
