# Issue #89 — OANDA equivalent observations and display snapshots

Status (2026-10-21): final native matrix, three correction repeats and independent
PR reviews passed. See [final closeout](closeout-20261021.md) for the authoritative
runtime, evidence, limitations and final-head CI status. The sections below are
the retained earlier-stage record; their pending states and image references are
historical and do not describe the final candidate.
Final integration/rollback baseline: v1.26.3 / `767cd4275a3be1d3ce27880dab1ef6dded3e11dc`.
Original investigation baseline: `762067a83fa2fca20c9158ea67cafae838861c19` (v1.26.2).
Branch: `fix/issue89-oanda-snapshot-semantics-20261021`.

## Scope and risk

F1: the change affects persisted provider-bar comparison, historical epochs and
indicator snapshot consistency. No schema or credential-format migration. #88's
alert editing, Yahoo resolve and UI error protocol remain independent; this
branch only adds an optional diagnostic response header in the shared chart API.

Both OANDA native writers now construct candles through the same contract.
Completed missing confirmation fields equal true; explicit false and forming
confirmation defaults retain their meaning. Exact valid decimal strings normalize
without float conversion. Other sources retain their existing semantics.

The commit boundary compares canonical old and new full payloads, including
volume, labels and completion. Equivalent observations preserve the exact stored
payload, history epoch, bar revision, changed_at, price freshness and frozen
indicator prefix; observed_at and dataset commit revision still advance. The
full payload comparison continues to reject actual historical input changes.

Snapshot rejection logs expose internal missing/ttl/identity/epoch/calendar/legacy
reasons and a hashed credential reference. `X-MW-Attempt-Ref` correlates the log
with the failed HTTP response. Tokens, account identity and price payloads are
not logged; public error code/message remain compatible.

## Verification

- Deterministic regression was red before the fix: equivalent completed flags
  expired an unexpired snapshot. Actual foreground/REST writer replay also
  exposed trailing-zero OHLC differences; it was red before decimal normalization.
- Broader backend regression: **132 passed, 26 skipped** (SQLite/local stage).
- Latest targeted SQLite run: **44 passed, 35 skipped** (PG explicitly unavailable
  to that invocation, not falsely reported as PG coverage).
- Dedicated task PG14.24: **100 passed, no skips** across
  `test_oanda_payload_semantics.py`, `test_oanda_provider_account_prices.py`,
  `test_provider_postgres.py` in 189.98s. This covers bidirectional actual writers,
  legacy flags/decimal strings, idempotency, volume retention, full mutation
  matrix, insert/delete, RR overlapping reads, lease competition and HTTP attempt
  correlation. Each case uses a disposable unique schema in this task's DB.
- After rebasing onto v1.26.3, the previous CI compatibility failures were fixed:
  canonical comparison still treats completed missing flags and exact decimal
  forms as equivalent, while new/changed rows preserve the incoming payload;
  legacy zero-valued provider text remains accepted at the foreground writer
  boundary. The focused PG14.24 rerun (diagnostic rollback plus OANDA,
  account-price and provider-Postgres suites) is **103 passed** in 131.29s.
- Additional tail/forming/completion/rollover regression: **2 passed** (SQLite and PG), including warm/cold values and old-price binding.
- Web tests from `web/`: `indicator-snapshot-recovery.cjs`,
  `provider-credential-recovery.cjs`, `display-recovery-lifecycle.cjs`,
  `indicator-display-snapshot.cjs`: **all pass**.
- Ruff changed Python files, browser script syntax and diff whitespace: pass.

### Rollback compatibility

`scripts/issue89_rollback_compatibility.py` verified the exact baseline source
artifact with unchanged locked dependencies in separate Python interpreters:
current write → baseline read/write → current read/commit. It used one task-owned
PG schema without clearing it between phases; old/new credentials, price rows and
cold indicator digests remained readable and equal. The final current commit
preserved old-writer payload exactly and did not rotate its epoch.

Baseline git archive SHA256:
`379515bde59eb35e4d71f266e1fa2d727fa4a5aaa5697002a1f026871007d642`.
All three phases passed. This is exact application-source compatibility, not a
production container switch or full disaster-recovery drill. Reverting to the
baseline reintroduces the false epoch rotation; that regression was asserted.
Rollback requires the old application artifact, no data rewrite or cache clearing.

To repeat, supply `TEST_POSTGRES_URL` privately for the task PG and set
`ISSUE89_TASK_PG=mw-issue89-20261021`; run the script with the repository's locked
Python environment. Do not point it at a shared or production database.

## Independent review and self-review

Two independent axes reviewed baseline→`c6526f9`, then `c6526f9`→`c689e7e`.

### Standards

One P2 finding: volume preservation compared raw legacy OHLC to canonical new
OHLC. Fixed by comparing canonical old payload, with regression. Follow-up:
**zero outstanding findings** and no new documented-standard violations.

### Spec

Two P2 findings: the same volume-retention edge, and a log-only random UUID that
could not identify its HTTP attempt. Both fixed with regression coverage and
matching exception/header reference. Follow-up: **zero outstanding findings**.
Browser rendering and rollback evidence were outside these code-only reviews.

Final tooling review (`c689e7e`→`ee0d87b`): Standards found no actionable
standards/privacy/isolation findings. Spec found two P2 gaps in the **unexecuted**
native harness: stage-specific request/result association and proof of correct
native values/coverage/rendering. The harness now asserts each stage's own
structured 422/attempt, same-study acceptance with matching HTTP credential
reference/input revision/generation, and compares every native main-series row
against an independent full-range HTTP calculation bound to the exact accepted
credential and origin. Follow-up static review caught a valid first-read
origin-establishment generation transition and partial-tail comparison; the
harness now records the explicit origin-only handle transition and requires
reference values for every claimed row. These new assertions have only
passed syntax validation; execution and target-layer screenshot assessment are
still pending. Do not interpret prepared assertions as acceptance evidence.
Static follow-ups through `d3506b0`: Standards **zero actionable findings**;
Spec **zero new actionable findings** after those assertion fixes. Neither axis
certifies runtime or rendered-layer acceptance.

Self-review checked full-payload invalidation, preserved frozen prefixes,
non-OANDA isolation, explicit false, volume/labels, unchanged public errors,
secret exclusion and no dependence on #88.

## Ubuntu isolation and native R1

Host: Ubuntu local Docker, task/project `mw-issue89-20261021`, independent network,
volume, PG database, credentials and ports. No Unraid activity, no changes to #88
or the protected long-term `mw-issue75-v2-20261018` instance.

- App: <https://localhost:18389>
- Licensed chart origin: <https://localhost:18390>
- Services: PG, API, web, chart-origin, TLS; no live provider/delivery workers.
- Resource limits: PG512MiB/API512MiB/web64MiB/chart64MiB/TLS64MiB, CPU bounded.
- PG14.24 pinned to
  `sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`.
- Final API image built: `market-watch-api:issue89-20261021`, config
  `e237c6489d2ca40c4978335aa1469d5bd4b11d84cc9adb31ad7f5a7144f5429f`.
  **Not yet confirmed running:** preview update refused high host load. Do not
  attribute the existing container's results to this final image.

Commands (from this worktree):

```sh
python3 deploy/ubuntu/mw_docker.py preview up --task mw-issue89-20261021 --project mw-issue89-20261021
python3 deploy/ubuntu/mw_docker.py preview stop --task mw-issue89-20261021 --project mw-issue89-20261021
```

The stop command preserves the task volume. Do not retire/delete permanent data
or other task resources. Private preview state lives under the user's
`.local/share/market-watch-docker/previews/mw-issue89-20261021/`; never commit it.

R1 fixture: `scripts/issue89_acceptance_fixture.py`, guarded to this exact task.
It seeds synthetic offline AUD_JPY H1/H4 inputs; it proves protocol/cache/native
behavior, not real OANDA transport or market correctness. Copy it to the task API
container as `/tmp/issue89_acceptance_fixture.py`, then run `seed` there.
`web/tests/issue89-native-recovery.browser.cjs` drives real React/RPC/API/PG and
the licensed native adapter, wrapping and calling the actual `applyBatch`.
It prepares H1 Supertrend/H4 Swing native data checks and screenshots, equivalent writes,
real TTL expiry/unchanged-price renewal and real early OHLC correction recovery.
It classifies 422 by structured code and requires stage-specific same-study
accepted results. Raw credentials and response values remain in process memory;
the evidence file keeps hashed credential references and bounded comparisons.

Pending before acceptance is complete: confirm final running image, execute
native R1 including tail/rollover and bounded-failure retry UI, preserve rendered
evidence, complete PR CI. No merge, release tag or production deployment authorized.
