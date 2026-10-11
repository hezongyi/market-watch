# Market session details implementation record

Date: 2026-10-10 UTC

> 2026-10-11 PR #37 后续修复与复核：main `75f8f34` 已集成，后端237项通过，
> 真实浏览器41功能断言及范围恢复通过，两轴无剩余阻断。末次runner的取消事件分类
> 断言失败已单独如实记录；最新结论见[PR修复报告](market-session-details-pr37-fix-20261011.md)。
> 下方168/36等是此前基线的历史验收。

> 2026-10-11 最新状态：用户授权按审查建议修复并完成验收后，已实施身份认证、
> 观测冲突、统一报价／时间契约、host 缓存与运行日历修复。
> 最终 API 相关八套测试 168 passed，host 回归与构建通过；原生浏览器 36 场景通过，
> 连续周期加载 15 次通过，页面错误为空。Ubuntu 项目已备份、实际恢复校验并精确退役。
> 完整结果以 [本轮验收记录](market-session-details-acceptance-20261011.md) 为准。
> 以下早期完成描述与受限验收是历史记录，其中 Binance 已认证、复核到期即 unknown 等
> 结论已被修正。此处记录验收收口时状态；用户随后授权提交 PR，未合并或发布。

Development baseline was rechecked before implementation:

- local `origin/main`: `8c65edfdee15f0281750e888711cf8ecd20de1a0`
- worktree: `/home/quant/repos/market-watch-market-session-details-impl-20261010`
- branch: `feat/market-session-details-20261010`
- Ubuntu Compose project reserved for acceptance: `mw-market-session-details-ubuntu-20261010`
- the GitHub remote could not be refreshed because DNS was unavailable; the local remote-tracking commit matches the handoff snapshot

Native chart capability verification against the pinned library archive (`library-manifest.json`, archive SHA `e4eabc20e156000b2a8fda7747044fd82b95c714526c7ab7f34bcfe62abaf9ee`):

- `chart().getTimezone()` and `chart().setTimezone()` are public.
- No public details-widget status slot or session-status callback was found in the checked type declarations.
- The details widget consumes symbol metadata such as `description`; native session labels are derived from `symbolInfo.session`.
- The implementation must keep historical bar labels/OHLC independent from session-status presentation and must provide an explicit host-owned status when the calendar is unknown.

Implementation completed in this worktree:

- Added `backend/alerts/market_calendar.py` with versioned Dukascopy, OANDA, Binance and Yahoo registry rows. Unknown, expired and unmapped identities remain `unknown`; managed Dukascopy spellings such as `xauusd` normalize to the verified `XAU/USD` rule.
- Added quote provenance/session fields through platform, Yahoo and managed quote paths. Native M1 prices retain the source candle start and are labeled as `source_m1`; provider quote timestamps remain distinct from fetch time.
- Added cached quote reformatting on public timezone-change events. All resolved source metadata is retained for exchange-timezone formatting, and UTC/UTC+8/IANA offset labels are generated from the stored epoch without refetching.
- Disabled the native market-status legend because the verified host-owned status is not available through the checked public library API; the status remains in the quote description/details text.
- Added the authenticated `/api/market-data/center/calendars` endpoint and the data-center `交易日历` tab with source filtering, symbol search, expandable evidence and official links.

Verification completed after the latest fix:

- In the isolated API image: `backend/tests/test_market_calendar.py` and `backend/tests/test_market_data.py`: 53 passed.
- Authenticated API check on the running Ubuntu project: managed `XAUUSD` on 2026-10-10 returns `market_session=closed`, reason `周末`, verified calendar `dukascopy-spot-v1`; calendar source/search filtering returns the expected row.
- `npm run build --prefix web`, `node --check advanced-host/bridge.js`, `python3 -m compileall`, `node web/tests/chart-price-format.cjs`, and `git diff --check` pass.

Browser acceptance completed after copying the same-version authorized ignored charting-library archive into this worktree. The chart-origin image was rebuilt with `market-watch-ubuntu`; the web image was rebuilt with `VITE_ADVANCED_CHART_ORIGIN=https://127.0.0.1:15444` so the HTTPS iframe used the tested chart image. A real authenticated browser harness entered the data-center window through the chart host, selected `Dukascopy`, searched `XAU`, expanded the `XAU/USD` rule and verified the official evidence link at 375, 768 and 1440 pixel widths. Horizontal overflow was zero at all three widths. The host and chart-origin frames loaded without page errors in the checked path.

Browser task/project: `mw-market-session-details-browser-20261010` / `mw-market-session-details-browser-ubuntu-20261010`. Runtime was Ubuntu Docker only, bound to loopback HTTPS `https://127.0.0.1:15443` (chart origin `https://127.0.0.1:15444`, static origin `http://127.0.0.1:15187`). The project used an isolated PostgreSQL 14 volume and network. `mw-docker retire --task ... --project ... --apply` completed with archive `/home/quant/.local/share/market-watch-docker/archives/mw-market-session-details-browser-ubuntu-20261010-20261010T182944-adb2faac` and `restore_verified: true`; the containers, volume and network were removed. Production and unraid were not touched.

The browser probe verified the calendar window and responsive layout. It did not assert the full historical chart-ready state because the isolated database has no provider history and the page can remain in the expected history-loading state. Native details/status presentation remains host-owned as designed: no public library details status slot or session callback was found in the pinned declarations, and native automatic session labels stay disabled to avoid treating unverified `24x7` metadata as open.

Final audit additions in this worktree:

- OANDA status now delegates to the existing identity-bound `live_session` profile; malformed, expired, unverified, or symbol-mismatched profiles return `unknown`.
- Binance certification is limited to the mapped `BTCUSDT`; `ETHUSDT` and other unmapped symbols remain `unknown`. OANDA rows expose resident `EUR_USD` and `XAU_USD` mappings while retaining their unverified status.
- Provider M1 quote reads preserve the last successful page on refresh failure, expose `fetch_status`, `read_at`, and the successful `fetched_at`, and keep the source M1 start as the data timestamp.
- Yahoo, provider M1, and managed M1 snapshots use `session_conflict` and `session_conflict_reason` when a reviewed closure conflicts with an observed event; the observation remains visible.
- Added focused tests: `test_market_calendar.py` now has 10 passing tests, including session conflict detection, and provider quote cache fallback has 2 passing tests. The local virtualenv cannot collect the full market-data suite because `yfinance` is unavailable; the isolated container run recorded earlier remains the authoritative 53-pass baseline for that suite subset.
- Final task `mw-market-session-details-final-20261010` built API, chart-origin, and web images with `market-watch-ubuntu`, then ran `mw-docker finish` and exact task-scoped cleanup preview/apply. No runtime project or volume was created by this final build; the images were removed after verification.
- A follow-up API-only task `mw-market-session-details-final2-20261010` rebuilt the final account/channel/environment-isolated quote cache key, then completed the same exact cleanup flow.
- Added a public `activeChartChanged` binding in `advanced-host/bridge.js`; it re-runs the same stored-epoch quote formatter used by timezone events and is unsubscribed on `pagehide`. The pinned library declaration confirms this event and `setActiveChart`/`activeChartIndex` APIs.
- Final3 task `mw-market-session-details-final3-20261010` built API, web, and chart-origin images with `market-watch-ubuntu`, ran an isolated PostgreSQL/TLS Compose smoke, and retired it with `restore_verified: true`. Direct API smoke passed login, four-source calendar retrieval, and the Saturday `XAUUSD` closed snapshot. Chromium UI smoke could not start in the host shell because `libatk-1.0.so.0` and related desktop libraries were absent; the libraries were only unpacked under `/tmp` for a retry, and no system packages were changed. The project was retired after this limitation was recorded.

## 2026-10-11 接续审查

审查当时实现仍未提交，状态为待修正及补验收。审查见
[market-session-details-review-20261011.md](market-session-details-review-20261011.md)。
审查复现了冲突条件反向、实际账户身份未校验、建议复核日期误作失效、
托管详情状态文案不一致、历史／组合契约遗漏及 host 缓存问题；部分既有测试固化了错误行为。
用户授权 `sg docker` 后，使用新的 Ubuntu `mw-docker` API 验证镜像运行相关三套测试，
结果为 **115 passed, 1 failed**；唯一失败是旧断言仍要求 M1 柱尾时间。
Web 构建和静态检查通过；完整活动图表浏览器验收仍待受控历史 fixture。
此前通过记录保留为历史证据，不能据此将本轮当前实现记为全部验收完成。
产品改动未在该审查阶段修改，生产发布仍未执行。

## 2026-10-11 授权修复与验收收口

审查后的实施记录见 [acceptance](market-session-details-acceptance-20261011.md)，
四来源证据与未知例外范围见 [calendar maintenance](market-session-details-calendar-maintenance-20261011.md)。
后端 168 项覆盖原生／自建／固定／组合报价契约、实际身份隔离与只读日历；host 回归覆盖
时区重复格式化、全部订阅刷新、迟到 HTTP、reset 和订阅撤销。固定许可图表在窄屏隐藏
整个详情栏时，由沿用同一报价订阅的 host 紧凑状态条保持状态与时间可见。

验收项目改为 `mw-session-details-fix-ubuntu-20261011`，位于 Ubuntu 本机，使用独立网络和 PG 卷。
供应商历史为受控 fixture，应用／数据库／worker／许可图表均实际运行。
不据此认证供应商线上可用性、生产账户范围或未来三个月节假日完整性。
所有变更保留为当前分支可审阅的未提交实现；后续正式集成与发布需按相应授权接续。
