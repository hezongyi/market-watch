# PAIO implementation and verification

Baseline: `origin/main@f4a3279aff0bd75ed4e2ab48e67bc898fc69af9a` (`v2.0.16`). Implementation branch: `feat/paio-source-replication-20261121`. Classification **F1**: durable algorithm state and background indicators; no schema migration.

**Not yet a completed source-compatibility acceptance.** Independent Pine runtime export/replay is not available in this environment. Deterministic source-formula fixtures are not presented as a Pine oracle. Seed/security/runtime GC equivalence remains unverified; PAIO returns `canonical_verified=false`.

## Modules and source behavior

| Group | Outputs / behavior |
| --- | --- |
| Gap Series | Six raw booleans independent of drawing switches. Body-down Except branches preserve source asymmetry. |
| Bar Index | Calendar bucket counter; string split without trimming; Specific bypasses Use; Step=2 means modulus3. |
| Moving Average | Three independent source/length/offset/request periods; first-value EMA seed; gaps_on request plus nonrecursive fallback from last requested EMA. |
| Previous Values | Three independent frames/sources; chart-based prior OHLC; security CurrentOpen intentionally maps to close; line and plot paths. |
| I & O Bar | Source equality exceptions and ordered II/OO/IOI branches; merged text retains original label identity/anchor and detection time. |
| H & L Count | Ordered pullback updates; outside bar may create H and L; Use controls advancement; 100-bar SMA distance, including na-coordinate label quota. |

All original input keys are covered by an inventory test and [66-input table](inputs.md). Original empty EMA period is represented by explicit `Chart`; it is the same current-period selection. Source input length0 is rejected; host limits are explicit in the parameter schema (EMA10000, offset±500, text1024, drawing widths1–10). Only supported time frames and built-in price sources are offered. Native settings use original group prefixes; rule editing collapses six groups. Automatic font sizing/abovebar spacing depend on host font/scale metrics.

Each instance shares 500 labels/500 boxes/500 lines. Backend owns IDs, formulas, time anchors and quotas; frontend applies styles and disposable ownerStudyId shapes, excluded from save/undo/object tree. Confirmed checkpoints precede the mutable chart tail; preview runs on an isolated copy. Fixed/observed/snapshot suffixes use the same frozen request mapper. Artifact readiness is part of durable run identity, so late dependencies rebuild missing modules. Missing dependencies stay explicit null/readiness states.

Ten original conditions are boolean; default rule is close-confirmed, condition above0; continuous true may fire on each new bar, same-bar ticks deduplicate. No extra EMA/PV/HLC conditions and no automatic rules. Existing ATR/price type constraints remain intact.

## Evidence status

- Original source hash checked; MPL attribution retained.
- Pure numerical, request mapping, exact strings/branches, rollback/quota and alert dedup tests pass in Ubuntu Docker.
- Fixed strict and observed tests resume 37-bar pages on the same persisted state; late publication changes run identity.
- Provider checkpoint test checks full replay equality and one-row work for unchanged tail.
- Ubuntu Docker backend regression: **392 passed (73.92s)**, including isolated PostgreSQL strict/observed restart tests, legacy indicator regressions, all ten conditions, and actual chart-closed persistent alert events. This final run includes the native calendar fence and truncated fixed-terminal regression. Separate integration alert preset/timezone/notification regression: **29 passed, 1 skipped** (PostgreSQL-only test in the SQLite integration invocation). No tests target the persistent development database.
- Actual licensed chart browser: two instances, six plots, all 66 inputs, save/load, PV color and EMA offset changes, removal/late-promise cleanup; 375/412 light/dark and 375px enlarged-font settings screenshots pass. The fixture is generated from Python outputs, **not an independent numerical oracle**.
- Actual React rule form: six collapsed groups, ten source outputs, exact/empty text and boolean editing, default close/above-zero saved snapshot pass. All writes terminate in a fixture adapter.
- TypeScript and frontend runtime regressions pass. Independent Standards and Spec reviews found and drove the fixed-foreground, late-dependency, snapshot, calendar and empty-checkpoint fixes, then rechecked them in Docker.
- Full integrated API/web builds and deployment to Ubuntu `mw-dev` passed. Draft PR #148: https://github.com/hezongyi/market-watch/pull/148. Final CI status is recorded below.

## Acceptance environment and deployment fence

Ubuntu Docker only. Persistent development instance remains `mw-dev`, `https://quant.kookvv.com:8443` (`192.168.7.232:18443`). Remote DB migration is preserved; do not recreate local PostgreSQL or reset data.

Pre-PAIO API/notification image `781f21d1d3046643509916eea99b8e1c39ce9be7ed52e09140ed3763275f10f0`, data-worker `e1b48c618fa5437d83bb9b2b975407c7da4494b9ddaf02c8bfa865ac90c169cc`, market-runtime `58287792e73ce88d0f691957f188eb6bc2d9b73c2d0ad8d55a7b3942b992290d`, web `461262e3306e424e2a19f9f879e330bf758351ae8fccffda272488cc2cf41ad3`.

Deployed work includes `a43affe7` not contained in remote baseline. A PAIO-only main-based image must not overwrite it. Integration acceptance must retain deployed alert/timezone work and private DB config. The first integration candidate was deployed as recorded below; the final backend correction is recorded separately. Exact Compose files, images, services and rollback are retained. Do not run down-v or mutate real notification/rules during acceptance.

## Known compatibility boundaries

These are explicit limitations, not silently substituted calculations:

1. No independent Pine v6 runtime/export is available. EMA first-value seed, `request.security` historical/realtime mapping and shared-object GC have deterministic source-derived fixtures, but no external runtime oracle. Numerical output therefore remains `canonical_verified=false`, including the bounded foreground path.
2. FXCM/Dukascopy native starts come from the same source's actual periods. FXCM terminal high-period `end` is only an elapsed upper bound; it is **not** treated as a verified close. If the next native close cannot be established, PV values/other modules continue, and the corresponding future projected line is omitted with `NEXT_NATIVE_CLOSE_UNVERIFIED`. No UTC0/NY17 substitution. Newly established boundaries invalidate historical presentation prefixes. Configured OANDA native periods retain their explicit identity/alignment.
3. Source-specific holidays/RTH and future session projections need matching runtime/session evidence. Source-date inputs cannot reconstruct unsupported intraday series; missing dependencies remain explicit module readiness gaps. Settings list only host-supported periods and built-in price sources.
4. Native settings provide original group prefixes, while the React rule editor provides six collapsible groups. Native text geometry/automatic font sizing follow the licensed chart host, not a pixel-equivalence claim. Parameter values are excluded from the compact chart legend, but remain editable in settings.

## Reproducible checks

Task-only PostgreSQL: `mw-paio-test-postgres` (`postgres:14.24-bookworm`), network `mw-paio-tests`, tmpfs PGDATA, no published port; schema-isolated test fixture. No persistent dev/production data is copied or reset.

Backend (source mounted readonly):

```bash
docker run --rm --pull never --network mw-paio-tests \
  --mount type=bind,src=$PWD,dst=/workspace,readonly --workdir /workspace \
  --env PYTHONPATH=/workspace/backend --env PYTHONDONTWRITEBYTECODE=1 \
  --env ALERTS_DATABASE_URL=sqlite:////tmp/paio.db \
  --env TEST_POSTGRES_URL=postgresql+psycopg://paio_test@mw-paio-test-postgres/paio_test \
  market-watch-api:paio-20261121 python -m pytest -q --tb=short -p no:cacheprovider \
  backend/tests/test_paio.py backend/tests/test_paio_inputs.py \
  backend/tests/test_paio_alerts.py backend/tests/test_paio_postgres.py \
  backend/tests/test_paio_native_calendar.py backend/tests/test_fixed_indicators.py \
  backend/tests/test_fixed_indicator_display.py backend/tests/test_observed_indicators.py \
  backend/tests/test_provider_indicator_inputs.py backend/tests/test_provider_cache.py \
  backend/tests/test_provider_display_snapshots.py backend/tests/test_indicator_state.py \
  backend/tests/test_chart_indicator_contract.py backend/tests/test_chart_alert_domain.py \
  backend/tests/test_composite_alerts.py backend/tests/test_nr_breakout.py
```

Browser fixture generation (inside API Docker, `PYTHONPATH=backend`):

```bash
python backend/tests/fixtures/paio_native_input.py /evidence/native-input.json
```

Inside Ubuntu Node/Chromium Docker, with existing installed `web/node_modules`, licensed `advanced-host/charting_library`, source mounted readonly and `/evidence` writable:

```bash
PAIO_CHROMIUM=/usr/bin/chromium node tests/paio-native.browser.cjs
PAIO_CHROMIUM=/usr/bin/chromium node tests/paio-alert.browser.cjs
node tests/paio-display.cjs
node tests/paio-restart.cjs
node tests/nr-breakout-display.cjs
node tests/nr-breakout-restart.cjs
node tests/indicator-snapshot-recovery.cjs
```

These tests do not send notifications or create real user rules. Screenshots attached here contain only synthetic prices/identity. Browser acceptance does not replace Android WebView device testing.

## Initial development switch (performed)

Integration branch `acceptance/paio-dev-20261121@d964b3d0` combines the PAIO commit `d28a3127` with deployed `a43affe7`; the PAIO PR remains based on remote main `f4a3279a`. Conflicts retain both the existing previous-day preset and PAIO boolean defaults/styles. Integration backend checks: **107 passed**, including previous-day preset, timezone and notification regressions. Full API/web builds passed; mobile shell `3092f35edc2b6360`.

Private Compose path remains `~/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json`. Image mode: no source/frontend mount; the existing FXCM and APK-download mounts remain unchanged. Remote Unraid database settings are retained, with all app services still on Ubuntu. The switch updates all four backend writers/servers consistently plus web; TLS, ntfy and database remain unchanged.

| Service | Candidate immutable image ID | Previous image ID |
|---|---|---|
| api / notification-worker | `sha256:7e9f83849dc1dd8c1bdd5139cfe107a29c3caad3b141f44b1a02672c23eddfdd` | `sha256:781f21d1d3046643509916eea99b8e1c39ce9be7ed52e09140ed3763275f10f0` |
| data-worker | same API candidate | `sha256:e1b48c618fa5437d83bb9b2b975407c7da4494b9ddaf02c8bfa865ac90c169cc` |
| market-runtime | same API candidate | `sha256:58287792e73ce88d0f691957f188eb6bc2d9b73c2d0ad8d55a7b3942b992290d` |
| web | `sha256:92a89282632ad2e6457b8d7328f998dd1b089e45252d241f23e70029b6c1070b` | `sha256:461262e3306e424e2a19f9f879e330bf758351ae8fccffda272488cc2cf41ad3` |

Current configuration and container/env/mount evidence, immutable candidate list, business-state hashes and a guarded rollback script were saved privately before mutation at `~/.local/share/market-watch-dev/evidence/paio-20261121/deployment/`. The script checks that this candidate is still current, then changes only its service images back. No schema migration; no destructive restore/reset.

After updating only those five image references in the existing private Compose object, the switch command used was:

```bash
docker compose -p mw-dev \
  -f ~/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json \
  up -d --no-build --no-deps api data-worker market-runtime notification-worker web
```

Operation: `mw-dev status`; start/recreate those services with the command above, stop only when intentionally needed with `mw-dev stop api data-worker market-runtime notification-worker web`. Narrow rollback (not executed):

```bash
python ~/.local/share/market-watch-dev/evidence/paio-20261121/deployment/rollback.py
```

A rollback restores prior application code without deleting PAIO state/config. Older versions do not understand PAIO rules; none are created in the persistent instance by acceptance. All automated rule/notification writes use isolated fixture adapters.


## Fixed-window terminal bucket correction

Real authenticated acceptance found a deterministic defect on a short published H4 history: the immutable version ended within the last H4 bucket. Strict calculation refused the bucket; observed calculation correctly marked `PARTIAL_PERIOD`, but both erased the previously confirmed PAIO state and all drawings. The same shared full-prefix replay also erased drawings when `before` selected only earlier complete bars.

The fixed-input adapter now marks only a fixed version's truncated terminal bucket (`start < version.end < end`). PAIO returns all 19 values as null without advancing or clearing its confirmed state. Observed input retains `PARTIAL_PERIOD` and `initialized=false`; this is neither a live preview nor confirmed OHLC. Real interior invalid inputs/gaps still reset. A previous preview is discarded before returning the confirmed presentation. Algorithm `paio-fengyangsi-v6-state-v2` prevents reuse of previously emptied checkpoints. No other indicator's quality policy changes.

Regression evidence includes strict/observed × foreground/durable H4, EMA+PAIO mixed requests, earlier `before` pages, new transaction/engine reconstruction, and genuine interior resets. The development M1 request independently covered a 4,114-row full prefix with two PAIO specs alongside EMA; all six modules were ready, all 20 visible rows were covered, and `canonical_verified=false` remained explicit. After the final deployment, the same real H4 version passed both strict and observed reads: null tail values, confirmed objects retained, and earlier-page presentation retained.

## Configuration and business preservation

Before/after readonly audit: all 16 immutable alert versions, rule lifecycles, and 387 historical versions (including manifest hashes) were identical. Compose changed only the five application image references. All seven inspected services retained identical environments and mounts, including TLS/ntfy, the remote database, FXCM source and APK-download mounts. Runtime heartbeats, source confirmation watermarks and maintenance cursors changed naturally; no user rules or notification tests were created.

Trusted-domain browser smoke verified login, `/readyz`, session, PAIO catalog (48 calculation +18 style inputs), mobile display settings and Android update manifest, all HTTP200; `/m/` loaded with no page errors. Real identities, authenticated browser state and raw chart results remain private. This does not certify mobile device interactions or external Pine equivalence.


## Final deployed candidate and verification

- Implementation commit `2055bd72`; integration commit `47efa86c` retains deployed `a43affe7` functionality.
- All four backend services use `sha256:233bb3384e3196ac8a0add86e7500d8e4b424f4cd1dcf099ea4668b3a5a2a845` (algorithm v2). Web remains the verified initial candidate `sha256:92a89282632ad2e6457b8d7328f998dd1b089e45252d241f23e70029b6c1070b`, shell `3092f35edc2b6360`.
- Only the four backend references changed for the terminal correction; startup used the same Compose command above with `api data-worker market-runtime notification-worker`. Final candidate metadata and the existing guarded rollback script are synchronized; rollback still restores all five pre-PAIO application images.
- Post-switch authenticated smoke: [development-smoke.json](development-smoke.json). M1 two-instance/module readiness and strict/observed H4 terminal/earlier-page checks passed; no mobile page errors. API healthy; application services run on Ubuntu, database remains on Unraid.
- Final independent Spec review found no remaining confirmed code blockers, including terminal preview cleanup. The previous Standards review remains applicable; latest Ruff check and `git diff --check` passed.
- Draft PR #148 CI run `44926125002` is still running at documentation time. Merge/tag/production publication have not been performed.
