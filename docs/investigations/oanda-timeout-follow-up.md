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
The prior completed acceptance project is not reused. Final image tests,
production activation approval and the requested post-repair ten-minute window
remain pending until their evidence is recorded here.

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
