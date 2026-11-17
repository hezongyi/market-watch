# Native provider history and live-tail recovery — 2026-11-17

Risk: F1, shared provider admission and durable background recovery; no schema or managed-series format change. Baseline `f341957e` preserves delivered notification, LWMA, mobile continuity and history-pool fixes. Acceptance uses the existing Ubuntu Docker `mw-dev`; no production changes.

## Reproduction

Private evidence: `~/.local/share/market-watch-dev/evidence/native-provider-bars-20261117/`.

- Actual AUDJPY FXCM 300-month snapshot reproduces `ValueError: Invalid OHLC extremes`: source 2011-02-28 22:00 UTC reports open83.254/high85.786/low74.026/close85.820. A160-month snapshot succeeds. The failure is a source record, not missing monthly capability.
- Source cooldown previously occupied the requesting thread until its full65s deadline. The helper classified every unsuccessful login wait as authentication, including timeout/session loss, and a20s idle exit forced re-login between60s native polling turns. These are independently reproducible code paths; the reason for the earlier18:39 cooldown was not persisted and cannot be retroactively proved.
- A150s live subscription baseline observes native refreshes from FXCM and OANDA, and advancing completed M1 bars from Dukascopy. A single recovered observation does not disprove the earlier failures.

## Changes

- Native FXCM pages quarantine invalid interior OHLC records with exact supplier evidence in `source_warnings` and a `gap_before` on the next bar. Valid prices are unchanged. Strict managed history still rejects invalid records; a bad tail still fails rather than advertising a fresh old candle. Ambiguous native-month fragments remain failures.
- The helper distinguishes explicit login rejection, login timeout/session loss and snapshot timeout. Ordinary request/session failures use10s shared cooldown; explicit login rejection retains300s. Shared cooldown records a bounded safe reason.
- Demand-driven helper idle life75s spans the existing60s polling interval; absent demand still logs out without additional supplier requests. The versioned private helper must be deployed together with the Python change.
- Admission reports the shared retry time immediately. Live polling, optional warming and durable history yield until that time. History does not consume no-progress stalls while cooling; actual request deadlines, consumer expiry and source rate limits remain enforced.
- The common admission fix applies to FXCM, Dukascopy and OANDA. No alternative provider prices or synthetic forming candles are inserted into a native series.

## Provider limits

Dukascopy JSON3 probes using the real pinned SDK headers return completed native candles: M1 advances after completion, while D1/MN currently stop at the preceding completed period. Backward, forward and official chart parameter comparisons did not return a native forming D1/MN candle. The public official chart enables `liveEmulation`; that is not evidence of an equivalent supplier-native forming-bar snapshot. Do not claim all Dukascopy timeframes have forming candles, or silently derive them from another timeframe/source. Exact request/result samples and discarded incomplete-header429 probes are separated in private evidence.

## Verification

Local adapter/cache/deadline/worker regressions:292 passed. Isolated PostgreSQL provider/native-history/shared-admission contracts:42 passed. Final candidate deployment and chart verification are recorded below after execution.

Helper build: `adapters/fxcm/Dockerfile`, private context contains `history.cpp` and the existing licensed ForexConnect1.6.5 `sdk/include` and `sdk/lib`; build via `mw-docker build`, task `mw-native-provider-bars-20261117`, project `mw-dev`, purpose `acceptance`. No SDK files or credentials are committed.

### Deployed candidate observations

- FXCM actual licensed professional-chart model and screenshots: M1/M5/M15/M30/H1/H4/D1/W1/MN all displayed. MN initial history succeeded;272 visible real bars were retained and invalid supplier rows were quarantined, not repaired into artificial prices.
- Actual M1 widget over100s: current start19:47→19:49 UTC, volume79→65 on the new bar. Actual D1 widget over180s: close107.306→107.302 and tick volume409065→409226; native session start remains2026-11-16 22:00 UTC. No page JS errors or prohibited preference/rule writes.
- One transient helper failure occurred during the first sustained multi-period test and recovered automatically with10s cooldown. Its precise native exception was not observable in the old generic code. The helper now emits only an allowlist of local failure codes, never supplier/account text; this improves diagnosis without claiming the old event's exact cause is known.
- A subsequent three-turn M1/D1/MN adapter observation, with61s idle gaps, reused the same helper PID and advanced prices/volume; warm M1 requests took0.37–0.40s and D1/MN1.4–1.5s. No failure recurred in that sample. This is bounded acceptance, not a long-term supplier uptime guarantee.
- OANDA: all9 periods returned160 valid native bars and current3-bar tails; a follow-up over a minute boundary advanced M1 and changed D1 price/volume. No equivalent parse/stall problem reproduced.
- Dukascopy: all9 periods returned160 valid native bars and3-bar tails; completed M1 advanced in the follow-up. D1/W1/MN remain completed-period snapshots as described above.
- Final expanded regression:326 passed; final isolated PostgreSQL run:43 passed, including preservation of quality evidence from multiple pages. Later historical pages now retain earlier FXCM warning records (deduplicated and bounded), instead of overwriting them.

Private task configuration snapshots, container/image manifests, rollback references and provider evidence remain outside Git. Entry: `https://quant.kookvv.com:8443/m/`, Ubuntu Docker project `mw-dev`, LAN HTTPS18443. No APK changes and no Unraid deployment. Original rule versions and notification/user preferences were fingerprinted before/after; web, PostgreSQL, TLS and ntfy containers were preserved.
