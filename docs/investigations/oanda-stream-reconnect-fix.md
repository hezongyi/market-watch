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

Review also exposed the same reversed locks when the planner completes a pending
plan, a user cancels/resumes history or joins maintenance, or the publisher adopts
existing verified history. All four supported plan writers now use one scoped
Dataset -> Instrument locking helper. Legacy instruments still lock only
Instrument; adoption skips either busy row rather than blocking the publisher.
The helper defers autoflush until the locks are held, then flushes deliberate
caller changes. Writers reload preloaded plans under the locks so a concurrent
cancellation or approved-range change is respected without discarding intentional
unflushed edits. New and changed references retain the original reclamation guard.

Real PostgreSQL lifecycle tests reproduced completion, cancellation, resume and
maintenance-join deadlocks before the lock-order repair. The expanded cases cover
reactivation, stale cancellation and approved ranges, preservation of unflushed
approved ranges, and adoption skipping either busy row before a later successful
pass. These tests call the production plan functions and real confirmation writes.

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

Commands used to start and stop this exact acceptance environment before its
retirement (the completed task must not be reused for a later run):

```sh
sg docker -c 'docker compose --env-file /home/quant/repos/.production/mw-oanda-fix-20261008/acceptance.env -p mw-oanda-fix-20261008 -f /home/quant/repos/.production/mw-oanda-fix-20261008/compose.yaml up -d --no-build --wait postgres'
sg docker -c 'docker compose --env-file /home/quant/repos/.production/mw-oanda-fix-20261008/acceptance.env -p mw-oanda-fix-20261008 -f /home/quant/repos/.production/mw-oanda-fix-20261008/compose.yaml stop'
```

Source validation additionally uses the private `compose-source.yaml` override.
Final image validation omits that override, exercising the installed candidate
package. A separate read-only `/oldsource` mount of immutable v1.14.0 enabled the
old-ingestion rollback/re-upgrade regression; it did not replace the candidate
package. Test commands use `python -m pytest -q -p no:cacheprovider`; the permanent
tests are in `test_pricing_publication_deadlock_postgres.py` and
`test_oanda_worker_diagnostics.py`.

## Final validation

The final candidate `market-watch-api:oanda-fix-final-20261008` was built through
`mw-docker` from clean source `25a1af28027de02a475de6122459a41443660f2a`. Its image ID
was `sha256:8504181de7fc6521ace637c0f4df8e4467b86783f36ff923038fad3003ac6c2f`.
All four modified runtime modules loaded from the installed site-packages path,
with SHA-256 matching the worktree, and no source override or PYTHONPATH.

- PostgreSQL final image suite: **65 passed**, no skips, in 85.13 seconds. Includes
  publication/confirmation and plan-lifecycle races, reclamation, history writes,
  live fencing, dataset/migration checks and real v1.14.0 ingestion rollback.
- SQLite and worker/plan lifecycle final image suite: **116 passed**, no skips,
  in 20.17 seconds. Includes transport, safe diagnostics, recovery/readiness,
  history retention, managed publication, approved boundaries and scheduling.
- Ruff checks on all changed Python files and `git diff --check` passed.
- Three existing Alembic `path_separator` deprecation warnings were emitted by
  the PostgreSQL migration checks; no test failures.

Acceptance finished and the exact project was retired at 2026-10-08 00:23:48 UTC
(08:23:48 Singapore), through `mw-docker retire` preview followed by `--apply`.
Both non-template databases were dumped and actually restored into temporary
databases; table counts and source stability matched. A synthetic public probe
table with two rows ensured the restore verified nonempty data. The one PostgreSQL
container, its dedicated volume/network and all three task-owned acceptance
images were removed. Follow-up label-filtered inventory found no project
containers, volumes or networks. `127.0.0.1:19749` is therefore no longer serving.

The private backup archive is
`/home/quant/.local/share/market-watch-docker/archives/mw-oanda-fix-20261008-20261008T002340-9bfa260c`.
It contains sensitive env/global-role material and is not in the repository.
The isolated worktree and branch remain available for code review. A future
acceptance run must register a fresh task/project and rebuild from this branch.

## Standards

Independent review of `6fd9273...25a1af2` found zero documented-standard
violations and zero reportable baseline smells. The first review found the
adjacent plan-lifecycle inversion; the final review confirmed the four writers'
shared lock order, stale-plan handling, caller-edit preservation and adoption
skip behavior. Environment, identity and confidentiality constraints are retained.

## Spec

Independent review of the same final difference found zero omissions, scope
violations or incorrect implementations against this report's requirements.
The lifecycle extension follows reproduced deadlocks, and safe diagnostics do
not change timeout, classification, lease or recovery behavior.

## Limits

No claim of production recovery is made until a separately authorized release
is deployed and the original observation loop is rerun. The nine observed
timeout exits remain unclassified; the new stage diagnostics make a
later distinction possible. Production is unchanged by this repair task.

The guard deliberately retains dataset locking for an inactive plan
(`cancelled` with `realtime_enabled=False`). Publication of such a plan still
has the pre-existing reversed lock possibility if additional coverage later
arrives. Public history cancellation retains realtime enablement, and the
observed production plans remain reclamation-blocking; this inactive corner
was not reproduced in the original incident or claimed fixed here.
