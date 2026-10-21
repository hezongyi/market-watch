# Multi-chart restore verification — 2026-10-21

The saved five-chart XAUUSD workspace now restores on mwa. Playwright performed a real UI login and two page reloads against the deployed image; all five native charts reported dataReady, canvases rendered, no uncaught page exceptions occurred, and the complete saved workspace document remained equal at revision 26. See [report](mwa-browser.json) and [screenshot](mwa-five-charts.png).

## Sequence and source identity

1. PR #90 was merged at `6fa36b6582a8d198a6bad13ad101c19345e4c6d9` with all CI checks successful; the remote v1.26.4 tag points to that merge. Issue89's preview had no shared database-volume references. Repository `deploy/ubuntu/mw_docker.py retire` preview and apply archived configuration, all non-template databases and global roles, actually restored the dumps, and checked table counts and sorted content fingerprints before deleting its five containers, two networks, and owned PG volume. The installed older retirement script rejected pinned infrastructure references, so the repository version was used without replacing the installed build tool. Source/evidence and the two explicitly retained API/Chart images remain.
2. All 13 mwa application services were replaced with clean images built directly at v1.26.4, including Web built for `https://192.168.7.232:18281`. API/PG were healthy; readiness, worker/history heartbeats, notifications health, and live OANDA candle data succeeded. Pure v1.26.4 still reproduced `Value is null` in `beginResolve` and timed out waiting for native readiness: [baseline](baseline-browser.json).
3. The original patch was rebased onto v1.26.4 as `a2236acb49cd96cfd0b9db359ad7d5584ea928b0`. Its clean Chart image was tested through an isolated Ubuntu chart-only project, with browser routing replacing only chart assets: [candidate](candidate-browser.json). The initial preview attempt used an internal network that did not expose its loopback port on this Docker version; changing that isolated static preview to a normal dedicated bridge resolved the connection refusal. No app code changed for this setup correction.
4. Only mwa's Chart container changed after the v1.26.4 baseline. API/workers/Web remain the tag's clean images. Final browser verification used the real origins directly, with no candidate routing. [Image identities](images.json), [baseline audit](baseline-audit.json), [final audit](candidate-audit.json).

Host: Ubuntu `quant-server`; long-term project `mw-issue75-v2-20261018`. Main origin `https://192.168.7.232:18280`, Chart origin `https://192.168.7.232:18281`. User workspace: `/advanced-charts/7d72eead-6be5-41a4-b3d5-bfdfff98b2bb`.

## Cause and change

During native multi-chart restore, chart APIs become visible before every internal model has attached. `beginResolve` read `chart.resolution()` outside its guarded metadata request and threw `Value is null`; the native resolve callback never completed. A widget-wide accessor catch could also discard healthy peers when one chart's symbol accessor threw.

The bridge now captures symbol/resolution per chart in a guarded snapshot, skips unavailable peers, and compares the captured resolution during lifetime checks. Matching charts still share in-flight lifetimes; all-target detach and workspace changes continue to reject stale results. No native library or saved workspace changes are needed.

## Regression checks and self-review

`node /path/to/fix/web/tests/multi-chart-resolve-init.cjs` from the pure-v1.26.4 `web/` directory failed with `Error: Value is null` at `beginResolve`. The same test from the fixed worktree passed. It executes the complete shipped feed, covering partial attach, symbol accessor failure, parallel same-symbol callbacks, partial/all-target detach, no attached models, and workspace epoch changes. CI runs this regression.

The following nearby checks also passed from `web/`: `resolve-recovery.cjs`, `advanced-startup-metadata.cjs`, `advanced-watchlist-metadata.cjs`, `advanced-market-stream.cjs`, `advanced-provider-subscriptions.cjs`, `advanced-history-empty-failure.cjs`, `advanced-refresh-range-cancellation.cjs`, and all eight `chart-alerts-bridge.test.cjs` tests. `git diff --check` passed.

Self-review: the new `resolveCharts` snapshot has only two consumers, both updated together. Per-chart exceptions remain scoped to native accessor availability. Shared callbacks, workspace epochs, resolution matching and late-response fencing retain their existing semantics and are covered by tests. F0 requires self-review and Ubuntu R1 smoke; no independent F1/F2 review was needed.

The opt-in browser test needs `MW_CHART_TEST_URL` and a private `MW_CHART_LOGIN_FILE`; it uses a disposable browser context, protects workspace/alert writes, acknowledges preference saves only inside that context, and checks the complete saved workspace before/after. Credentials and browser state are excluded from evidence. It is intentionally not run in public CI against a private instance.

## Preservation and operations

All 15 mwa containers are running, API/PG healthy, restarts zero. All environment variables and mounts match the before-update snapshot exactly; PG and gateway IDs are unchanged. No seed, migrate, or database reset ran. Existing notification delivery remains disabled. Existing backup health is unknown and is not claimed fixed. The protected browser was left intact.

Private Issue89 archive: `~/.local/share/market-watch-docker/archives/mw-issue89-20261021-20261021T142952-65906818` (0700); [public retirement summary](retirement-summary.json). Private dumps, environment, TLS material and raw inspect are not committed.

Durable mwa operation entry: `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`. Start uses fixed image IDs and the preserved private environment; only application services are selected. `rollback` restores only Chart to pure v1.26.4; `pre-upgrade` restores the 13 prior application images/configuration. The older notification-batch operation entry delegates to this entry so a later start cannot silently downgrade mwa. Full-stack recreation is not verified; never use an arbitrary historical Compose file for it.

This is an Ubuntu acceptance update; no merge, formal release tag, or production deployment was performed. Browser checks demonstrate this workspace and repeated reloads over a short observation window, not long-term provider availability.
