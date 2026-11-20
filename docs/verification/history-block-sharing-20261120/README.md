# Immutable period block sharing — 2026-11-20

## Goal and scope

After an incremental self-built history update, unchanged materialized period
blocks previously had to be read, decompressed, rebound to the new version,
compressed, and written again. Retain the original immutable payload and give
the new version its own lightweight block index instead. All configured
periods still materialize in the background before maintenance completes;
there is no demand-based deferral or change to the chart fetching policy.

Baseline: `c7ccf0b3`, continuing draft PR #146. Risk **F1** because this adds a
persistent block representation and modifies the materialization/read chain.
Minimum checks: focused SQLite and PostgreSQL contracts, real migration and
reclamation checks in isolated schemas, differential materialization benchmark,
independent Standards/Spec reviews, then persistent Ubuntu development smoke.

Sharing applies to the v1 M1-derived artifact builder (Dukascopy/Binance).
The v2 `native_periods` / `base_d1` builder only receives the metadata-only
manifest finalization improvement in this change; its payloads are not shared.

## Storage and lifecycle

- Add nullable `source_block_id`, `input_count`, and `complete_count` to
  `market_history_artifact_blocks`; no rewrite or backfill of existing payloads.
- Inline blocks continue to own compressed content. Shared blocks keep their
  own version's ordering/range/count/checksum and empty content, referencing
  the original **inline** block directly. Third and later generations do not
  build reference chains.
- Only published sources with matching dataset, timeframe, aggregation rule,
  frozen price policy, range, count and checksum are eligible. The source
  payload remains byte-for-byte unchanged. Dataset reference fencing and a
  self FK protect it against reclamation races and partial deletion.
- Durable counters make subsequent adoption metadata-only. The first adoption
  of legacy blocks decodes up to eight payloads per tick to recover counters;
  later generations can reference up to 64 known blocks per tick.
- The original overlap/recheck interval remains authoritative. Changed or
  partially rebuilt blocks use the existing M1 aggregation path. A first
  H4/D1/W1/MN bucket starting before the requested history start is eligible
  only when parent and child have identical history starts. This fixes the old
  `start >= cursor` lookup, which could silently skip that first block.
- Reads stream inline and shared payloads in one joined query, verify original
  checksum and scope, and return the requested version's provenance. Finalizing
  a manifest selects metadata columns only, in both builders.
- Retention currently reclaims an entire unreferenced dataset. Canonical and
  referencing blocks are removed together in the existing transaction. No
  production/development data is reclaimed to validate this change.

## Controlled PostgreSQL benchmark

`benchmark.py` creates and drops its own unique PostgreSQL schemas. It uses
60,001 M1 fixture observations, nine periods (M1 through month), and two
incremental generations; each generation revises the last two minutes and
adds one minute. No real supplier is contacted. The non-sharing control runs
the copy/decode/recompress path using the same candidate reader.

| Second incremental generation | Copy payloads | Share payloads |
|---|---:|---:|
| Materialization | 4.233 s | 1.745 s |
| SQL statements during materialization | 1,997 | 697 |
| Period payload SELECTs during materialization | 97 | 0 |
| Compression calls | 107 | 10 |
| Newly stored compressed bytes | 533,872 | 2,930 |
| Shared blocks | 0 | 97 |
| Full nine-period read SQL statements | 54 | 54 |
| Full nine-period read | 1.191 s | 1.211 s |
| Returned bars | 79,309 | 79,309 |

For this fixture: approximately **2.4×** materialization throughput, **99.5%**
less new compressed payload, with no additional read SQL. Every returned field
except the necessarily different parent version ID has the same SHA-256 digest
across all three variants. Existing legacy blocks without counters take
2.221 s on first adoption and 1.577 s on the following generation. These are
controlled local samples, not a promise of end-to-end supplier latency; the
shared host also ran isolated PostgreSQL regression tests during sampling.

## Verification

```bash
PYTHONPATH=backend pytest -q \
  backend/tests/test_history_artifact_sharing.py \
  backend/tests/test_history_artifacts.py \
  backend/tests/test_history_retention.py \
  backend/tests/test_native_history_retention.py

# Only with an isolated TEST_POSTGRES_URL; never the persistent mw-dev database.
PYTHONPATH=backend pytest -q \
  backend/tests/test_history_artifact_sharing_postgres.py \
  backend/tests/test_history_artifacts_postgres.py
PYTHONPATH=backend python docs/verification/history-block-sharing-20261120/benchmark.py
```

SQLite: **34 passed**. PostgreSQL: **16 passed**.
Additional migration-chain checks: **8 SQLite passed** (six old branch entry
points, joined-head preservation, and anonymous-FK bootstrap roundtrip), and
**2 PostgreSQL passed** (actual predecessor upgrade and safe/unsafe downgrade).
These sets overlap the focused suite and are not an additive total.
Contracts cover three generations/direct roots, pagination, unchanged parent
manifest/payload, revised tails, legacy adoption, corruption detection,
dataset/price-policy/frame separation, no reference chains, whole-dataset
reclamation, disabled shared writes with continued reads, additive SQLite
upgrade, PostgreSQL FK protection and migration roundtrip/downgrade refusal.
Spring and autumn NY17 DST cases compare all nine periods to full M1
recomputation, excluding only parent version ID.

Independent Standards and Spec reviewers both completed final review with no
blocking findings. Private raw logs, credentials/config snapshots and runtime
inventory stay outside Git at
`~/.local/share/market-watch-dev/evidence/history-block-sharing-20261120/`.

## Deployment and rollback contract

Target: existing Ubuntu `quant-server` Docker project `mw-dev`,
<https://quant.kookvv.com:8443>, local HTTPS 18443. Preserve database, supplier
settings, live/notification configuration, Web image and APK download mounts.
Before deployment the derivation snapshot showed **zero pending artifacts**.

Deployment order:

1. Save the current launcher and exact container image IDs privately. Build the
   clean candidate through `mw-docker build --task history-block-sharing-20261120
   --project mw-dev --purpose development`.
2. Stop only data-worker briefly so that no new-format artifact can be written.
3. Apply the additive migration, then deploy candidate API and market-runtime
   readers before starting the candidate data-worker. All artifact readers
   must support the new representation before sharing writes begin.
4. Update the persistent launcher, including its migration image. Verify ready,
   authenticated dataset/chart reads, worker health, artifact representation,
   pending queue and resource use. Exercise an existing incremental maintenance
   update through its normal API if no scheduled update runs during acceptance.

**After any references exist, do not roll back to an old artifact reader or
downgrade the schema.** To disable this optimization, retain the shared-capable
candidate and set `ALERTS_HISTORY_BLOCK_SHARING_ENABLED=false` on data-worker
(and the persistent configuration). Existing references remain readable and
future builds use inline payloads. Migration downgrade deliberately refuses
while references exist. No conversion, deletion or historical data rewrite is
required for this fallback.

Keep the current shared-capable image available as the rollback reader.
`mw-dev status` checks the persistent instance; `mw-dev stop data-worker` stops
only maintenance, and a targeted Compose `up -d --no-build --no-deps data-worker`
using the recorded `run.json` resumes it. Do not use a generic old-image rollback
or the helper's all-service `up` during this staged deployment.

## Persistent development acceptance

Artifact reader/writer commit: `19cd5da7`; exact image:
`sha256:65c468a3ecca5bbccaecb4d242089a19ad8666c4b76e5eccb206e399751d327e`.
API, market-runtime and data-worker use this candidate. The final migration
compatibility patch does not change application code; its rebuilt image is
recorded separately in the launcher's migration service. Schema is
`bf59_history_block_sharing`.

- Authenticated domain API reads: **135/135 published periods**, 47–149 ms
  per small chart request, no pending data. An initial audit attempt hit a
  transient TLS EOF before completion; the complete rerun passed without
  changing TLS, proxy or supplier configuration.
- A normal existing BTCUSD/Dukascopy incremental maintenance was submitted
  through its authenticated API with an idempotent request ID. It completed
  in **15.14 s**, all nine periods published. The version holds 119 blocks,
  **103 shared**, with 170,197 newly stored compressed bytes. This includes
  the normal two-day refresh interval; it is not compared with an artificial
  one-minute production update.
- Explicit old-history chart reads inside shared blocks: **9/9**, 43–78 ms,
  nonempty bars and `pending=[]`, including weekly/monthly periods.
- After acceptance: **zero pending artifacts**, no active unfinished history
  maintenance. No development data was deleted or replaced.
- Post-acceptance resource sample at approximately 08:09 UTC: host busy
  **15.57%** over five seconds (four logical CPUs); API 0.12%, market-runtime
  4.80%, data-worker 7.22%, PostgreSQL 4.69% in Docker's per-core units. This
  brief idle/ongoing-runtime sample is not a controlled CPU reduction claim.
- Web, notification-worker, PostgreSQL, TLS and ntfy retain their original
  container identities and mounts. The Android update manifest still returns
  HTTP 200. No APK rebuild/install is needed for this backend optimization.
- Isolated task PostgreSQL was stopped after tests; its existing volume is
  preserved. Private safety snapshots include the actual launcher, exact
  container inventory and schema-only dump. Shared-reader fallback config is
  retained beside them.

CI initially identified a stale migration-head expectation. Both affected
tests now follow the new head, and fresh/legacy upgrade paths are explicitly
verified. Final CI status must be checked against the updated PR head; the
initial failing run is not reported as a successful check.

This task does not authorize merge, release tags, production deployment,
historical data cleanup or unrelated service retirement.
