# Chart reload repair and native drawing visibility rollback

2026-10-13. Worktree `market-watch-chart-reloads-20261013`, branch `diagnose/chart-indicator-reloads-20261013`, baseline v1.25.2. Local implementation and Ubuntu isolated acceptance complete; no production release performed.

## Final behavior

Accepted, fresh, tradeable source quotes create durable `ObservedMinute` fragments. After admission, quote age, minute rollover, disconnection or owner change cannot erase their candles. Confirmed composite input takes precedence; observations are reclaimed only when every matching composite can read the confirmation. Reconnection selects the newest epoch fragment without inventing its missing OHLC. True missing minutes remain missing. Old raw forming OHLC is not certifiable; upgrade adopts only a revalidated persisted last quote and records an audit marker.

Price reads, seek pagination, stream and Python indicators use an exact `DisplaySnapshot`: immutable confirmed input revision, copied observations, rules and clock boundary. The actual AdvancedWorkspace parent forwards and validates its credential. Sequential isolated indicator replay begins at the checkpoint before the earliest pending dependency and covers the full subsequent suffix, including later confirmed bars. Fixed checkpoints and alert evaluation remain separate; display retention cannot restore quote_ready or authorize an alert.

For ordinary composite events, native `subscribeBars` updates the current candle or appends newer candles. A bounded per-symbol/resolution queue accepts one price credential, waits for its Python/native indicator work, then coalesces later quotes while preserving intervening minute candles. Multiple panes sharing that scope accept the same credential. Waiting is limited to five seconds; hidden/deleted studies, resets and identity changes cancel/fence old work. This is not atomic cross-engine rendering: price can render before its study. It avoids permanent starvation under frequent quotes and slow indicator HTTP.

An identical REST handover changes input provenance without resetting price history. An actual earlier OHLC/volume correction still uses public resetData and full dependency replay. Native indicator suffix invalidation preserves unaffected rows. No private atomic main-price replacement was introduced. Preparing notifications are quiet; actual indicator errors retain their retry button.

Snapshot expiry and capacity return typed recoverable errors. Price re-read recovery is bounded to three attempts. Observations freeze new minutes at capacity and report degradation rather than silently discarding existing candles. Replay tasks have leases, shared IDs, three-failure termination, 10,000 output rows, 256 tasks, 64 MiB compressed output and 8 MiB state limits. Task budget and row locks follow one order. First legacy adoption runs before the shared source read lock: a real PostgreSQL test exposed a two-reader lock-upgrade deadlock and passed after this correction.

## Drawing visibility rollback requested by user

Removed the nine-period adapter, script/build entries and runtime installation. New licensed bundles retain their original interval evaluator and property definitions. The patcher recognizes verified older mask installations only to remove them; original-bundle digest verification and rejection of partial/tampered assets remain enforced.

Drawing properties now show the native continuous minute/hour/day/week/month ranges. Undo, redo, multi-selection and pane synchronization are owned by the native engine. Existing drawings are retained. A saved mwMask is no longer authoritative: original intervalsVisibilities category flags and bounds control visibility. Consequently, a drawing previously configured only through the nine checkboxes can become visible at different intervals after rollback; review its native range settings. No lossy conversion of noncontiguous masks to continuous ranges was added.

## Verification

Results are recorded in [acceptance summary](verification/chart-reloads-20261013/acceptance-summary.json). Private logs and full browser state remain under `/tmp/mw-chart-reload-implementation-20261013` (0700), excluded from the repository.

- Backend broad regression: 235 passed; PostgreSQL expanded recovery/D1 matrix: 37 passed. These were followed by targeted checks after the final legacy-lock change.
- Final PostgreSQL display suite: 32 passed, including concurrent confirmation, first-use legacy handover, bounded task failures/capacity and additive migration roundtrip/nonempty downgrade protection.
- Final targeted backend regression: 82 passed, including price retention, recursive Supertrend, actual confirmation, gaps, pinned pagination, alerts and migrations.
- Node contracts passed: actual parent snapshot forwarding; high-rate bridge/coordinator; shared panes and bounded batches; expiry recovery; queued commit fencing; native range events; shared reads exceeding twelve specs split into bounded requests.
- Native engine browser: original drawing range UI, pane sync, undo/redo, cancel, old layouts, all nine chart resolutions and multi-selection passed. The actual built application also passed range edit, undo/redo, save/load and resolution change.
- Native bundle installation contract passed: original, historical installs including v1.25.2, repeated install, disable, partial/tampered rejection and cache URLs. Browser indicator checks cover null/zero/negative results, revisions, prefix retention and detach.
- Actual isolated API/history/stream worker restart preserved the exact price credential and complete bar sequence.
- Final current-image browser check after the legacy-lock fix: 90222 ms, 5,177 animation frames, 28 accepted native indicator commits, zero empty frames/backwards callbacks/value mismatches/resets/page errors and clean process exit. All backend module hashes and bundled host modules match the worktree; workers use the same API image. Synthetic publishers have finished.
- Two real-parent browser windows are distinguished in the acceptance report. The earlier 612-second window passed all continuity assertions but its process exited with an in-flight route cleanup error; it is not reported as a clean run. The subsequent clean 611867 ms run sampled 34,811 animation frames and accepted 193 indicator commits, with zero empty frames/backwards callbacks/value mismatches/resets/page errors. It fixes cleanup and covers 5/20/90-second synthetic confirmation delays, 5 Hz quotes, 1.8-second indicator HTTP latency, an 18-second pause and same-minute reconnect.

Numerical references compare the Python sequential implementation with its full-vector algorithm, not an independent Pine engine. The original production M1 time regression still lacks that individual event's raw payload; local monotonicity verification does not supply retrospective causal proof. Production remains unchanged.

## Ubuntu acceptance instance

Actual host: Ubuntu local Docker; project/task `mw-chart-reloads-20261013`. Web `http://127.0.0.1:20287/advanced-charts`, chart origin `http://127.0.0.1:20288`, API `127.0.0.1:20289`, PostgreSQL `127.0.0.1:20290`. Binding is loopback; these URLs refer to the Ubuntu host. Isolated synthetic data, external deliveries and supplier streams disabled. No MT4 resources changed.

Start and stop from this worktree (private env is not printed or committed):

```bash
sg docker -c 'docker compose --env-file /tmp/mw-chart-reload-implementation-20261013/acceptance.env -p mw-chart-reloads-20261013 -f deploy/ubuntu/chart-reloads.acceptance.yaml up -d --no-build'
sg docker -c 'docker compose --env-file /tmp/mw-chart-reload-implementation-20261013/acceptance.env -p mw-chart-reloads-20261013 -f deploy/ubuntu/chart-reloads.acceptance.yaml stop'
```

Images: task-owned `market-watch-api:chart-reloads-20261013`, `market-watch-web:chart-reloads-20261013`, `market-watch-chart-origin:chart-reloads-20261013`; concrete running IDs and source hashes are in the acceptance summary. Additive migrations are `at47_display_observations` and `au48_display_indicator_tasks`; nonempty downgrade refuses destruction and requires verified backup. At acceptance completion, no commit, push, PR, production deployment or task-resource deletion had been performed. The subsequent user request authorizes committing and opening a PR; production deployment remains separate.
