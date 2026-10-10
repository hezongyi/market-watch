# OANDA recovery and native startup acceptance

Implementation: `25e6d4cba175bb878bb75c3e4461865b32398540` (`fix/weekend-recovery-20261010`). Baseline: `e933ed4`. Production stays at v1.15.0; this patch has not been merged, tagged, or deployed.

## Completed behavior

1. Saved-layout startup no longer throws `Value is null`. The native toolbar unmount used the currently linked widget after its model was destroyed or replaced. It now unsubscribes the exact delegate captured at mount. The private patch verifies the original SHA256, is reversible/idempotent, rejects tampering, and keeps the symbol-name feature enabled. Both modified native bundles contribute to the cache URL.
2. A 401/403 still pauses collection, but a shared account lease permits a low-frequency authentication probe. The configured account summary, account instrument catalog, and every requested instrument's pricing payload must validate before the hold is released. Account-list HTTP 200 is insufficient. A maintenance/timeout result retains the hold. Probe reservations survive worker failure; token/expiry fences reject obsolete results. Network I/O stays outside transactions. Closed-market pricing validates access without marking quotes or completed candles ready.
3. Data center and composite status distinguish authentication holds, explicit upstream maintenance, verified closure, and unknown sessions. Explicit REST 503 JSON maintenance assertions are classified separately; generic or unread streamed 503 remains unavailable. Verified closed sessions pause collection and retain stored history. Unknown/out-of-scope/expired evidence cannot declare closure. Reopening returns through the existing fresh quote and confirmed-M1 recovery gates. Composite quote/temporary-bar/alert readers also respect the hold and closed state.

The data-center panel reads stored status every 10 seconds using its existing polling mechanism and creates no live demand. The original live SSE endpoint remains compatible with snapshot consumers and additionally exposes provider status.

## Actual environment and evidence

Ubuntu host `quant-server`, Docker project/task `mw-weekend-recovery-20261010`, dedicated network/PG14 volume/database and ports. No test/debug instances were created on unraid. Production credentials and original acceptance project `mw-unified-sse-20261008` were not changed.

- Web: http://127.0.0.1:15673
- Native charts: http://127.0.0.1:15674
- API: http://127.0.0.1:15671
- PostgreSQL: 127.0.0.1:15675

Private Compose/configuration/login and restored user layout are under `artifacts/weekend-recovery/`, excluded from git. Local licensed assets are also excluded. The source acceptance fixture uses an explicit synthetic account and never calls a supplier or supplies supplier prices. Synthetic `SSEFIXTURE` history verifies browser/chart lifetimes; it is not live OANDA evidence.

Validation:

- Related source regression: 161 passed; additional finite-session/DST/closed-rate cases passed (15-case targeted suite includes overlapping recovery cases).
- Real isolated PostgreSQL: 33 passed, including competing probes, crash takeover, stale startup/probe fences, controlled 401 → maintenance → valid account pricing recovery, quiet closed worker, and composite quote/alert regressions.
- Licensed toolbar lifetime and cache contracts passed; actual bundle is used privately, never published.
- Actual browser: saved single chart, saved four-chart layout, and empty workspace all load without uncaught exceptions; repeated layout restoration, status transitions, and mobile status layout are checked in `browser.json`.
- TypeScript/Vite Docker build and scoped Ruff/diff checks pass.

Baseline failures and fixed runs are recorded in the JSON files beside this document. Fake upstream HTTP responses use the real adapter/worker and real PG transactions; they prove implementation behavior, not supplier uptime.

Final task images are `market-watch-api:weekend-final-25e6d4c`, `market-watch-web:weekend-final-25e6d4c`, and `market-watch-chart-origin:weekend-final-25e6d4c`, all built through `mw-docker` / `market-watch-ubuntu`. Their image IDs and commit labels are recorded in `images.json`; actual container IDs/health are in `runtime.json`. Web/chart have `dirty=true` metadata because this verification directory was untracked during those builds; application source had no changes after the implementation commit (`git diff --name-only` was empty). These are acceptance images; a formal release should build from its clean release checkout.

## Start and stop

Run on this Ubuntu host from the task worktree:

```bash
cd /home/quant/repos/market-watch-weekend-recovery-20261010
sg docker -c 'docker compose --env-file artifacts/weekend-recovery/config/compose.env -p mw-weekend-recovery-20261010 -f artifacts/weekend-recovery/compose.yaml up -d --no-build api web chart-origin market-stream-worker'
sg docker -c 'docker compose --env-file artifacts/weekend-recovery/config/compose.env -p mw-weekend-recovery-20261010 -f artifacts/weekend-recovery/compose.yaml stop api web chart-origin market-stream-worker'
```

The acceptance instance is retained for review; its Docker lifecycle task is not marked finished. For later retirement preview with `mw-docker retire --task mw-weekend-recovery-20261010 --project mw-weekend-recovery-20261010`, then apply only after review ends. That workflow must back up the volume and actually restore/compare it before deleting task-owned resources. No global prune.

## Incremental cost

Measured on the same isolated PG database and two synthetic visible states, 60 samples per revision after warm-up, relative to `e933ed4`:

| Item | Before | Patch |
| --- | ---: | ---: |
| SQL per live snapshot | 8 | 10 |
| Median snapshot read | 6.822 ms | 8.933 ms |
| Snapshot JSON bytes | 1,733 | 2,635 |
| Extra constant processes | — | 0 |
| New database migrations/volumes | — | 0 |

New data-center display: 6 API requests/minute per open tab; in this two-state fixture, 12 SQL reads/request including provider status, about 72 reads/minute and 17 KB/minute of response body. This is an additional panel relative to the prior data-center route, so all of those display reads are incremental there. Existing live-snapshot consumers add two owner/probe reads per snapshot. Dataset count and startup fault visibility affect the actual query count; no whole-production CPU/RSS percentage was measured. Builds were running on the host during measurement, so the latency difference is indicative, not a production SLA.

Authentication probing adds no requests while healthy. During an auth hold, default interval is at least 300 seconds: at most 12 probes/hour and 36 upstream requests/hour (a summary 401 stops after the first request). Verified closed failed probes use up to the 900-second interval, bounded by the next session check: at most 12 requests/hour for full three-endpoint attempts during a long closure. Generic open-market reconnect behavior remains bounded separately. A successful probe is followed by normal recovery, whose candle requests are existing recovery work. Each completed probe adds one audit row: at most 288/day at the five-minute interval, normally fewer; no disk-size estimate was invented.

## Operational session evidence and release limits

`scripts/oanda_live_sessions.py` generates an opt-in, finite account-fingerprinted SG profile for EUR_USD/XAU_USD, using the official https://www.oanda.com/sg-en/trading/hours-of-operation/ page. Its published forex Sunday 17:05 / Friday 16:59 and gold Sunday 18:05 / Friday 16:59 New York times were retrieved during this task. Fully closed interiors exclude boundary minutes. The reviewed interval is limited to seven days; expiry becomes unknown and resumes conservative probing. Confirm jurisdiction, configured account, product applicability, and holiday exceptions before applying a production profile.

`ALERTS_OANDA_LIVE_SESSION_PROFILES` controls status/scheduling only. It does not change immutable dataset calendar identity, history coverage, gap evidence, or published versions. It is separate from `ALERTS_OANDA_CALENDAR_PROFILES`. Default unknown sessions remain unknown.

Remaining external verification: next market opening, observe actual OANDA pricing stream/heartbeat, fresh Bid/Ask, confirmed-M1 recovery and browser propagation. Weekend closure cannot prove new-price advancement. This opening check was item 4 and is outside the authorized implementation items 1–3. No production auto-recovery has been claimed before this patch is released.

## Subsequent formal release

PR26 review repairs, merge/tag and the authorized v1.15.1 production deployment are recorded in [production acceptance](v1.15.1-production.md). The original acceptance above is a pre-review snapshot; it does not claim real reopening.

The Ubuntu acceptance project above was subsequently retired after verified backup/restore and content checks. Its localhost URLs and images are no longer active; use the formal production URLs in the release record.
