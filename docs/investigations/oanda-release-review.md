# OANDA recovery patch: production release review

Subsequent execution: reviewed PR #22 was merged and annotated v1.14.2 pushed.
The tag-built backend was formally deployed with an Ubuntu-verified production
backup, one authorized retry and a complete 600s production window. Strict
acceptance remains failed. See `../oanda-v1.14.2-production-delivery.md` for actual
deployment and rollback evidence; the preparation record below is historical.

Status: **prepared on Ubuntu, not deployed**. This is a proposal for releasing
the validated local recovery repairs; it is not a claim that all external
timeouts or quote-quality failures have been resolved. Decision basis:
`/tmp/market-watch-oanda-priority-handoff-25selfw1/decision-analysis.md`.

Subsequent authorization: the user approved executing the recommendation and
requires PR review, merge and a pushed tag for the local patch. The formal
release will use **v1.14.2 built from its reviewed merge/tag**, superseding the
b7376b9 candidate below while preserving this preparation evidence. See
`../oanda-v1.14.2-source-delivery.md`. No deployment is implied by authorization.

## Fixed artifact and scope

- Runtime source: `b7376b9a067384789fe7b19344ae1f193502d1d4`, detached private
  Ubuntu release worktree. Later branch changes affect verification modules or
  investigation documents, not this runtime.
- Image: `market-watch-api:oanda-recovery-release-b7376b9`.
- Image ID: `sha256:2f6b70a242926e3bd46a85c022f3c393be6edbd65d669f7ca8e4d6e1f8ee95c7`.
- Ubuntu task/project: `mw-oanda-release-review-20261008`; built through
  `mw-docker`, purpose `release`, clean source, linux/amd64. Its lifecycle label
  has no expiry. The previously tested acceptance image is retained separately.
- Export SHA256:
  `ee9bd337b0848593dcfb2148e83719838c8810efc6a3910b7ae31de0942e0556`;
  304197120 bytes. Nothing has been transferred to or loaded on unraid.

The product diff against running v1.14.1 (`6fd9273`) contains six modules:
`chart_history_plan`, `history_retention`, `managed_dataset` (consistent reference
and lifecycle lock ordering); `oanda_stream` (owned stream pool cleanup and safe
transport/REST phases); `oanda_worker` (safe failure-stage diagnostics);
`live_pricing` (finite outcome after successful fenced transaction).
There are no dependency, migration, schema, identity, timeout, freshness or
authentication-gate changes. Detailed fixes and regressions are already recorded
in `oanda-stream-reconnect-fix.md` and `oanda-timeout-follow-up.md`.

All **126 installed Python modules** match fixed source. Every installed module,
Python version and dependency version also matches the tested acceptance image,
so the existing 72 installed-image checks and targeted PostgreSQL/pool regressions
are reused. The static comparison containers ran on Ubuntu with network disabled,
no database or account environment, and exited/removed. No new account window or
performance test was run during release preparation.

Four-layer network/chunk/record/publish wrappers remain verification-only. This
image provides bounded product failure logs, not continuously enabled four-layer
production instrumentation.

## Production configuration proposal

Current project: `market-watch`, root `/mnt/user/appdata/market-watch`, standalone
`compose.release.yaml`. The proposal changes the API image for nine running
services: `api`, `pricing-worker`, `chart-aggregation-worker`,
`chart-history-worker`, `history-worker`, `composite-aggregate-worker`,
`native-history-worker`, `realtime-worker`, `notify-worker`.
They share the ORM reference guard; replacing only pricing would leave other
writers on the old lock behavior. The migration service keeps its original image
and is not invoked by this patch. Web, chart-origin, maintenance backup image,
networks, mounts, ports and all service environment values are preserved.

The concrete **raw YAML** proposal preserves anchors, environment references and
the maintenance-profile backup service. Expanded comparison with all profiles
proves only nine runtime image values and their `x-app` image anchor differ.
Compose configuration validation passed on Ubuntu without creating instances.
Resolved JSON files are private comparison evidence, not deployment replacements
that would freeze future environment-file changes.

Original Compose SHA256:
`30bf9cffed1a983909eb49775c411d2a906a89755bf49e6766b5377108d577a4`.
Proposed raw Compose SHA256:
`47e101d678fc99aba343a8814ff5f7a4e5c952b80bd9a0146efebb70318adba6`.
Recheck before any switch; changes since preparation require regenerating and
reviewing the proposal, not overwriting somebody else's configuration.

## Current health and separate authentication hold

Read-only production checks at **06:03:52, 06:11:05 and
06:16:15–06:16:28 UTC on 2026-10-08** showed both symbols unavailable, epoch 352,
invalid owner lease and `owner.error=unauthorized`. Their confirmed and published
M1 watermarks did not advance in the final three samples. Database deadlocks were
**699 cumulative**, unchanged over those samples; this is not 699 new deadlocks
in this observation.

Stored audit/minute results locate an unauthorized confirmation outcome at about
**06:00:45 UTC**, followed by disconnection at **06:00:53 UTC**. The existing
classification maps upstream HTTP 401/403 to `unauthorized`; retained old-version
results do not identify which code, response category or origin was responsible.
Production account/token/proxy configuration equals that of the earlier successful
Ubuntu window. That equality does not establish current credential validity or
exclude a transient/intermediary rejection.

`live_pricing.claim()` refuses an unauthorized owner even after its retry deadline
expires. This is the existing intentional auth fence, not a new regression. A
container restart or this patch alone does **not** clear that persisted hold.
There is an existing authenticated `POST /api/market-data/live/retry` action
which resets expired configuration faults without changing identity or credentials.
Any recovery plan must explicitly include an operator-approved single retry, or
leave the hold intact and report that pricing remains unavailable. Do not clear
rows directly, ignore 401/403, or repeat retries to obtain a green sample.

## Formal switch and rollback, only after explicit authorization

Prepared private files live on Ubuntu at
`/home/quant/repos/.production/mw-oanda-release-review-20261008/`:
`release-manifest.json`, image tar, `production-compose-proposal.yaml`, the exact
`production-compose-before.yaml`, configuration comparison, read-only health
capture and `path-preflight.json`. Env and resolved configuration remain private;
they are not committed. Current backup scripts and old image IDs are captured.

Authorized switch sequence:

1. Recheck actual production image/config hashes and account experiment lock;
   abort if another account experiment or release is running. Verify the export
   hash, load the fixed image and verify its full image ID. Preserve the current
   image and exact raw Compose. This is a formal production switch; do not create
   an unraid test/debug instance.
2. Stop the nine affected services, confirm they exited, and invoke the current
   production `deploy/unraid-backup.sh`. Its maintenance-profile service uses
   existing `market-watch-backup:v1.14.1-6fd9273`, image ID
   `sha256:44cf3295a201604287d1e1ff2783bacf0a05dfcef92cc9db91b212840d832755`.
   Verify the new dump/configuration archive and perform actual restore checking
   only on an independent Ubuntu PG14 database. If it fails, resume the original
   services without switching. Do not grant production CREATE DATABASE rights.
3. Replace the standalone raw Compose with the reviewed proposal; validate it
   privately. Start the explicit nine services with `--no-build --no-deps`.
   Do not run migrations or rebuild on unraid. Restart existing web to refresh
   its API upstream after the API container IP changes.
4. Verify all nine actual image IDs, unchanged web/chart/backup images, current
   schema `aq44_aggregation_service_order`, API readiness and authenticated reads.
   If explicitly authorized, use the existing authenticated retry action once
   for the expired auth hold. Confirm catalog/status outcomes from safe new logs.
   A repeated 401/403 ends recovery attempts; preserve the hold and its evidence.
5. Run one fixed **600-second production stability check** using existing logs,
   leases, snapshots and per-symbol confirmation/publication watermarks. Report
   local deadlock/pool recovery, connection continuity, confirmation, publication
   and quote quality separately. No four-layer wrapping is installed in production.

The core service commands, for this authorized switch or application rollback,
are:

```sh
cd /mnt/user/appdata/market-watch
./tools/docker-compose -p market-watch -f compose.release.yaml stop -t 30 api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker
# Back up and verify on Ubuntu before changing the Compose file.
./deploy/unraid-backup.sh
# After installing the reviewed candidate (or exact prior Compose for rollback):
./tools/docker-compose -p market-watch -f compose.release.yaml config --quiet
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker
./tools/docker-compose -p market-watch -f compose.release.yaml restart web
```

Application rollback uses the exact saved original Compose and image ID
`sha256:eef235c1020d0de799dfa4115bfcef8c59be727cd8bc5d02065f7d135418b65a`,
tag `market-watch-api:v1.14.1-6fd9273`, verified still present on unraid.
Stop the affected services, preserve current data, restore original raw Compose,
start the same explicit services and restart web. No schema downgrade, historical
data restore or auth-hold rewrite is part of this application rollback. It brings
back the known old deadlock/pool risks; it is not a promise of healthy pricing.

## Health decisions and residual risks

Rollback for a patch-caused API/startup regression, new fencing/publication
failure, installed-content mismatch or recurrence of the validated deadlock/pool
pattern. External TLS/header/body failures and repeat auth rejection require
their own evidence; reverting the local patch is not presumed to cure them.
If the auth hold remains, report unavailable rather than invoking retry repeatedly.

Strict acceptance continues to require all existing gates. The last Ubuntu
600.025-second real window failed EURUSD freshness, although transport,
confirmation, publication and database checks passed in that window. Pausing
EURUSD root-cause work does not turn that failure into acceptance. A release may
be approved as a limited delivery of local recovery repairs with remaining risks;
it must not be described as complete end-to-end acceptance.

No release, production restart, auth retry, notification test, resource retirement
or new account request was performed in preparing this proposal. Formal release
and the optional existing retry action remain separate explicit authorization
items.
