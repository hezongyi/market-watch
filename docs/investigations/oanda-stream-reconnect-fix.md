# OANDA stream reconnect repair

The repair is isolated in `fix/oanda-stream-reconnect`, worktree
`/home/quant/repos/market-watch-oanda-stream-fix`, based on immutable v1.14.1
(`6fd9273a5f78d8761f76a20e3ad66b17e441f9f5`). It has not been deployed to production.
The pre-existing investigation branch is preserved.

## Requirements

The user requested an isolated worktree and branch to repair the repeated OANDA
stream reconnects diagnosed in production. Remove the demonstrated database
deadlock while retaining dataset identity, source isolation, lease fencing,
history reclamation protection and the actual recovery/readiness rules.
Distinguish the remaining timeout events using safe diagnostics; do not lengthen
timeouts, disable gates, silently retry every database failure or claim a supplier
or proxy root cause without evidence.

Develop and verify only on Ubuntu, with a separate Compose project, network,
volume, database and port. Do not reuse production credentials, data or account
streams. Build through `mw-docker` and the `market-watch-ubuntu` builder. Retire
only the exact acceptance project after dump and actual restore validation.
Production deployment, password changes and notifications are outside this task.

## Evidence and reproduction

The read-only observation from 2026-10-07 23:27:17 to 23:37:17 UTC
(2026-10-08 07:27:17 to 07:37:17 Singapore) recorded 121 samples over 600 seconds.
Demand stayed EUR_USD and XAU_USD; epoch increased from 44 to 78, with no process
restart. Both symbols' confirmed M1 advanced nine minutes. PostgreSQL recorded
75 deadlocks, and all 26 `unavailable` stream-exit warnings matched a deadlock
within 150 milliseconds. Nine timeout exits remained unclassified.

Pricing waits on Instrument while holding MarketDataset. Publication owns
Instrument, updates ChartHistoryPlan.realtime_end, then the ORM before_flush
reference guard requests MarketDataset. This reversed pair of locks forms the
wait cycle. The production worker's catch includes both upstream iteration and
local quote publishing, so the generic `unavailable` classification obscures a
database failure as a stream exit.

The new PostgreSQL test runs the real confirmation and publisher transactions,
coordinates their existing lock boundaries and asserts both complete, publication
advances and the owner epoch stays unchanged. The release image failed with
`psycopg.errors.DeadlockDetected` before applying the repair. Source tests need
`PYTHONPATH=/app/backend`: mounting the worktree alone leaves Python importing the
installed release package, which was caught and corrected during validation.

## Implementation

An existing ChartHistoryPlan which already blocks reclamation keeps the same
reference when its cursor or publication watermark changes. Its committed
reference already excludes reclamation, so the guard skips the redundant dataset
lock for this progress update. New plans, changes to instrument/status/realtime
enablement and inactive terminal plans still take the dataset lock. Reclamation
and this guard share the same eligibility predicate; other reference writers
retain their existing locks.

Regression cases cover pending, complete and cancelled plans with realtime still
enabled, the actual production state. Separate tests verify that creation,
reactivation, rebinding and inactive-plan updates exclude a competing reclamation
lock, and that actual reclamation remains rejected while an existing blocking
plan advances.

Worker warnings now include the constant stage, exception class, validated
five-character SQLSTATE and epoch. `stream` means upstream iteration, `publish`
means local event persistence, and maintenance stages identify renewal,
subscription or confirmation. Lease renewal failure, intentional subscription or
recovery-range changes and normal EOF are observable. Exception messages, SQL
statements/parameters, URLs, account IDs, credentials and payloads are not logged.
Classification, fencing, disconnect backoff and transport timeouts are unchanged.

## Ubuntu acceptance environment

Task/project: `mw-oanda-fix-20261008`, purpose `acceptance`; PostgreSQL 14 at
`127.0.0.1:19749`, with an independent named volume and Compose network. Synthetic
test identities and minutes are used; no OANDA upstream connection is opened.
Each PostgreSQL fixture creates and removes its own schema in this isolated DB.
The image build uses the dedicated `market-watch-ubuntu` builder.

Private env, Compose files and detailed test logs live under
`/home/quant/repos/.production/mw-oanda-fix-20261008`, excluded from the repository.
Existing Docker group membership is activated with `sg docker`.

Start and stop this exact acceptance environment:

```sh
sg docker -c 'docker compose --env-file /home/quant/repos/.production/mw-oanda-fix-20261008/acceptance.env -p mw-oanda-fix-20261008 -f /home/quant/repos/.production/mw-oanda-fix-20261008/compose.yaml up -d --no-build --wait postgres'
sg docker -c 'docker compose --env-file /home/quant/repos/.production/mw-oanda-fix-20261008/acceptance.env -p mw-oanda-fix-20261008 -f /home/quant/repos/.production/mw-oanda-fix-20261008/compose.yaml stop'
```

Source validation additionally uses the private `compose-source.yaml` override.
Final image validation omits that override, exercising the installed candidate
package. Test commands use `python -m pytest -q -p no:cacheprovider`; the permanent
tests are in `test_pricing_publication_deadlock_postgres.py` and
`test_oanda_worker_diagnostics.py`.

Final image results, independent review and retirement status will be recorded
after these checks complete. The task remains active during validation. No claim
of production recovery is made until a separately authorized release is deployed
and the original observation loop is rerun; transport timeout responsibility is
still unproven.
