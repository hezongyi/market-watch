# Isolated OANDA stream observation

`run.py` runs inside the installed application image on Ubuntu. It redirects only
the adapter's REST and stream destinations to a local synthetic HTTP server;
HTTPX/httpcore streaming, the real worker, leases, minute confirmation, shared
request budget, PostgreSQL writes, aggregation/publication and authenticated API
reads retain their production implementations.

The first connection withholds response headers for 16 seconds, exceeding the
unchanged 15-second read timeout. The second sends two prices and a heartbeat,
then withholds response bytes for 16 seconds. After both faults, the supplier
sends one quote per symbol and a heartbeat every second. The worker must identify
both timeout phases and recover before the separate 600-second steady window
starts. Warnings from injection/recovery are counted separately.

Each five-second observation checks actual API snapshots, account epoch/lease,
confirmed minutes, M1 publication watermarks, publication error counters, outbox
rows and transactions currently idle whose transaction age exceeds five seconds.
A publisher observer also
records every cycle's abnormal publication result, including internally caught
exceptions which can recover between samples. Publication progress is checked
separately for EURUSD and XAUUSD, and PostgreSQL's cumulative deadlock count must
remain zero. The report fails for an incomplete window, further
epoch changes, unhealthy readiness, stalled minute/publication progress, warnings,
publication errors or notifications. All prices and account identities are
synthetic; actual supplier or proxy reliability is outside this harness's claim.

The API uses its real auth and routes with lifespan disabled, preventing unrelated
native-provider startup traffic. The script creates only the isolated database
schema and synthetic auth credential. It asserts that production OANDA credentials
are absent and notifications are disabled. No auth secrets appear in reports.

## This run

Ubuntu Compose project/task: `mw-oanda-timeout-20261008`.
Database: `127.0.0.1:19750`, independent PostgreSQL14 database and named volume.
Initial API: `http://127.0.0.1:19751/readyz`; supplier: `127.0.0.1:19752`.
Final strengthened run: fresh database `oanda_observe_final` in the same isolated
PostgreSQL, API `http://127.0.0.1:19753/readyz`, supplier `127.0.0.1:19754`.

The private env and Compose files are in
`/home/quant/repos/.production/mw-oanda-timeout-20261008`. The harness is mounted
read-only, while application modules load from installed site-packages.
`runtime-evidence` contains injection samples, steady samples, warnings and the
final report. Synthetic login passwords are kept only in the private env.
The final run uses `compose-runtime-final.yaml`, service `isolated-runtime-final`
and `runtime-final-evidence`; the initial run's raw results are retained.

```sh
sg docker -c 'docker compose --env-file /home/quant/repos/.production/mw-oanda-timeout-20261008/acceptance.env -p mw-oanda-timeout-20261008 -f /home/quant/repos/.production/mw-oanda-timeout-20261008/compose.yaml -f /home/quant/repos/.production/mw-oanda-timeout-20261008/compose-runtime.yaml up -d --no-build isolated-runtime'
sg docker -c 'docker logs -f mw-oanda-timeout-20261008-isolated-runtime-1'
sg docker -c 'docker compose --env-file /home/quant/repos/.production/mw-oanda-timeout-20261008/acceptance.env -p mw-oanda-timeout-20261008 -f /home/quant/repos/.production/mw-oanda-timeout-20261008/compose.yaml -f /home/quant/repos/.production/mw-oanda-timeout-20261008/compose-runtime.yaml stop isolated-runtime'
```

Do not restart the harness against the same populated database: it deliberately
requires no previous pricing owner. Repeat with a fresh isolated task/project and
volume, built through `mw-docker`. Retire the finished acceptance project through
the exact `mw-docker retire` preview and `--apply`; actual dump/restore validation
must precede removal. A retired task must not be reused.

The final evidence and retirement state are recorded in the investigation report
after observation completes. No production deployment is performed by this run.
