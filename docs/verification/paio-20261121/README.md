# PAIO implementation and acceptance (in progress)

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
- Ubuntu Docker backend regression: **386 passed (71.95s)**, including isolated PostgreSQL strict/observed restart tests, legacy indicator regressions, all ten conditions, and actual chart-closed persistent alert events. After the final native calendar fence, native+provider input regressions: **36 passed**. No tests target the persistent development database.
- Actual licensed chart browser: two instances, six plots, all 66 inputs, save/load, PV color and EMA offset changes, removal/late-promise cleanup; 375/412 light/dark and 375px enlarged-font settings screenshots pass. The fixture is generated from Python outputs, **not an independent numerical oracle**.
- Actual React rule form: six collapsed groups, ten source outputs, exact/empty text and boolean editing, default close/above-zero saved snapshot pass. All writes terminate in a fixture adapter.
- TypeScript and frontend runtime regressions pass. Independent Standards and Spec reviews found and drove the fixed-foreground, late-dependency, snapshot, calendar and empty-checkpoint fixes, then rechecked them in Docker.
- Deployment, final build and PR CI: pending.

## Acceptance environment and deployment fence

Ubuntu Docker only. Persistent development instance remains `mw-dev`, `https://quant.kookvv.com:8443` (`192.168.7.232:18443`). Remote DB migration is preserved; do not recreate local PostgreSQL or reset data.

Current deployed API/notification image `781f21d1d3046643509916eea99b8e1c39ce9be7ed52e09140ed3763275f10f0`, data-worker `e1b48c618fa5437d83bb9b2b975407c7da4494b9ddaf02c8bfa865ac90c169cc`, market-runtime `58287792e73ce88d0f691957f188eb6bc2d9b73c2d0ad8d55a7b3942b992290d`, web `461262e3306e424e2a19f9f879e330bf758351ae8fccffda272488cc2cf41ad3`.

Deployed work includes `a43affe7` not contained in remote baseline. A PAIO-only main-based image must not overwrite it. Integration acceptance must retain deployed alert/timezone work and private DB config. No deployment has been performed for PAIO yet. Before switching, record exact Compose files, candidate image IDs, services and rollback command here. Do not run down-v or mutate real notification/rules during acceptance.

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
