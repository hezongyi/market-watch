# Chart price alert workflow — 2026-11-17

Approved design: https://pages.kookvv.com:8443/p/page-46e81e56c27f3c100848/

## Scope and compatibility

F1: shared chart price-alert creation, editing and lifecycle controls. Baseline `1550b7f6` retains the previously deployed native-provider, notification and mobile-continuity fixes. No schema or stored-format migration; API `control_revision` is optional for older clients. Drawing/indicator association remains workspace-scoped. Fixed-price rules use complete series identity across matching chart panes/timeframes; the configured evaluation timeframe is unchanged. Mobile settings remain separate from desktop workspace data.

The native price-axis plus opens a menu. Quick creation uses cross/intrabar/once and actual phone-delivery availability; success adds a line without opening an editor or saving layout. Only eligible realtime composite series can create rules. Native series show an explicit maintenance entry, never substitute another source. Tap a line for pause/resume/edit/end; dragging previews, aligns to the native tick and commits once on release. Escape cancels an unsubmitted gesture. Ambiguous writes remain pending verification, including when an immediate read still shows the old revision.

## Verification

- Backend: **120 passed** across capabilities, execution, close, reliability, settlement, service and composite-alert suites. Includes edit/lifecycle revision races and actual phone capability. Isolated test databases/fixtures; no real user-rule writes or notifications.
- Node: **30 passed** across price edit, narrow RPC, bridge, native UI and operation-budget suites. Covers lost response, delayed commit, malformed success response, stale reads and lifecycle uncertainty.
- DOM/browser: drag and native-price-line suites passed, including pointer cancellation, uncertain-result retention, re-opening controls and subsequent verification.
- Licensed TradingView v31.1.0 workflow: real price-axis menu, cancel, quick create, one drag write/lost-response recovery, pause/resume, H1→M5 persistence, complete editor, two matching panes, native-source exclusion, disabled realtime and unavailable phone transport all passed against synthetic API fixtures.
- Built MobileApp + licensed widget: real CDP touch drag, tap management, same-rule editor/save; 375/412px, light/dark and 100%/150% text. Saving button bounds checked inside viewport. Screenshots reviewed after animations.
- Desktop/mobile isolation: actual licensed widgets retain desktop settings, RSI parameters and workspace while mobile changes timeframe/theme/navigation.
- Production frontend build passed; `git diff --check` passed.
- Independent F1 Standards and Spec reviews passed after fixes for operation budgets, uncertain writes, reopening controls and blocked-state display.

Screenshots below use synthetic prices and rule identities. They demonstrate browser/WebView geometry, not Android system keyboard behavior or actual ntfy receipt.

## Representative screenshots

- [Quick-create menu](menu-dark.png)
- [Same rule in matching panes](two-panes-light.png)
- [Mobile price lines](price-created-412-dark.png)
- [Mobile editor, light 412px](price-editor-light-412-font14.png)
- [Mobile editor, dark 375px, 150% text](price-editor-dark-375-font21.png)

## Deployment

Target: persistent Ubuntu Docker project `mw-dev`, https://quant.kookvv.com:8443/m/ (LAN https://192.168.7.232:18443/m/). Commands: `mw-dev status`, `mw-dev up`, `mw-dev stop`. Only API and Web are replaced; workers, PostgreSQL, TLS, ntfy, FXCM helper, downloads and private environment remain in place. No production Unraid changes, merge or formal tag.

Deployment digest, configuration backup, container identities and read-only rule/preference fingerprints are recorded privately under `~/.local/share/market-watch-dev/evidence/chart-price-alert-workflow-20261117/`. Rollback replaces only the API/Web image references with the recorded previous digests in the active persistent run configuration, then uses `docker compose -p mw-dev -f <private-run.json> up -d --no-build --no-deps api web`; do not restore an entire old environment over newer private settings.

Deployment verification pending below; Android touch/system keyboard and an actual user-created notification remain user acceptance items. Existing real rules are read-only throughout this task.
