# Yahoo 原生行情验收与交付

日期：2026-10-03（Asia/Singapore）。实施分支 `feat/yahoo-native-market-data`，基线 `5dd196e`，隔离目录 `/home/quant/repos/market-watch-yahoo-native`。实施依据为 [原始方案](../../yfinance-native-market-data-plan.md)。未部署、推送、合并或正式发布；主仓库及其他 worktree 未修改。

## 实现范围

接入 `yfinance==1.7.0`，通过既有 provider 调度、范围缓存、租约与 SSE 提供 M1/M5/M15/H1/D1/W1/MN。Yahoo 只提供平台系列。美股/ETF 开启自动复权，其他类型保持供应商价格；所有历史请求关闭 repair、back_adjust 和 prepost。中文预置目录、有限远端搜索、报价短期缓存、图表指标、画线保存恢复及带价格口径的 CSV 均接通。按实施期间新增要求，所有源的品种搜索暂时只显示平台行情，选择结果统一使用 provider ticker；中文名称参与本地匹配并显示在结果中。`market_names.py` 提供常见 OANDA 外汇/商品/指数及 Binance 品种的中文名，Yahoo 别名增加英伟达、特斯拉、亚马逊、谷歌及 Meta。

源能力集中在 `provider_capabilities.py`；SDK 的代理、cookie/crumb、绝对 deadline、标准整理和错误转换集中在 `provider_yahoo.py`。操作单并发、源启动间隔至少一秒，跨进程使用既有数据库源预算。报价与历史共用该预算，429 冷却共享并处理 Retry-After。SDK 已发出的操作有界结束，取消后不扩展下一窗口；预热按页给前台让位。

正式加法迁移 `q18_yahoo_catalog` 从实际 head `p17_volume` 派生，仅为 MarketCatalog 添加 JSON 元数据。缓存身份包含匿名 Yahoo 环境、供应商 symbol、周期、价格 basis、复权模式、时区/会话规则版本和负载版本。分钟窗口保存在临时元数据中，不设置永久 earliest。分红/拆股事件变化撤销全部相关复权覆盖并递增 generation/revision；旧用户窗口每日按有界同周期重叠重验证，明确修订可以替换旧已完成 bar。指标由每次有效输入重新计算，没有跨 revision 保留的指标缓存。

## 验收证据

| 方案要求 | 当前证据及结果 |
|---|---|
| 七周期、价格参数、无聚合 | `test_provider_yahoo.py`，六品种 × 七周期 `adapter-live.json`；浏览器 AAPL 七周期均 200，并验证从既有源 H4 返回已解析的 Yahoo 品种时切换至 H1。未生成 Yahoo M30/H4；真实 API 两者均 422。 |
| SDK 与认证走代理 | `sdk-probe.json` 记录 fc.yahoo.com、crumb、quoteSummary、quote、chart 各请求 host/path/status 和 proxied=true，不记录代理地址。SDK Session 对每次请求应用同一代理和剩余 deadline；无代理、超时与认证错误的离线行为已验证。 |
| 有限搜索、中文和身份 | `search-live.json`、`api-live.json`：NVDA 搜索与按需元数据成功；浏览器中文黄金搜索只返回平台系列，原代码 GC=F 正常显示。范围过滤与稳定 ID 的大小写规范化有回归覆盖；新增中文搜索后 67 项后端检查通过（`search-final-tests.txt`），原生搜索弹窗截图见 `chinese-search.png`，OANDA/Binance/Yahoo 搜索结果均只含平台行情。 |
| 源调度、共享需求与停止 | `test_provider_service.py`、`test_provider_cache.py`、Yahoo 合约测试以及 PostgreSQL 租约回归；`runtime-expiry.json` 验证真实 30 秒兴趣租约过期后 warm/live 不继续取数。报价在途合并、60 秒 freshness 和失败保留上次行情时间有行为测试。 |
| 窗口、空窗和失败语义 | `window-probe.json`：M1 20–13 天前成功，31 天前被拒；M5 59 天前、H1 729 天前成功，超过 60/730 天被拒。离线测试区分成功休市空覆盖、生命周期、可重试分钟左界、429/认证/超时；失败不提交成功覆盖。 |
| 时间、末根与价格/量 | DST、按交易所日期输出 UTC 零点、真实跨月结束、后续原生 bar 结束证据有测试；未确认末根保守形成中。缺失/SDK 零量保持不可用。真实 CL=F 2020-04-20 负价见 `postgres-live.json`、`negative-oil.csv` 和 `negative-oil.png`。 |
| 延迟报价、显示和口径 | `exchange-delays.json`、`sdk-probe.json`、`browser.json`：报价行情时间、抓取时间、报价自己的前收盘价；图表公开 delayed_streaming/delay 字段；详情描述显示时间和延迟。涨跌与自动复权历史分开。 |
| 修订、复权与 generation | Yahoo 事件变更失效、过期 owner 被拒、已完成 bar 的显式修订、旧窗口重验证及源 revision 导致原生 reset 有离线回归；PostgreSQL 并发租约/generation 检查通过。未来真实分红/拆股无法在本次日期人为触发，使用供应商事件输入的确定性行为验收。 |
| 既有功能回归 | 后端相关 208 项通过，随后最终 provider 子集 132 项通过；PostgreSQL 15 项通过。四项前端系列/原生保存/订阅/请求生命周期检查通过（`frontend-contracts.txt`）；TypeScript + Vite 构建、ruff/diff 检查（`static-checks.txt`）及依赖兼容检查（`dependencies.txt`）通过。 |
| 浏览器、保存与负价轴 | `browser.json`：实际 SDK + 实际 PostgreSQL + 当前源码运行；七周期、Python SMA、画线保存后刷新恢复、黄金报价；先打开对数轴再导航到负价窗口，轴自动切回线性且价格范围包含负值；可见错误及页面错误均为空。 |
| 维护与通知隔离 | `api-live.json` 记录维护请求 422；`postgres-live.json`、`runtime-expiry.json` 验证 candles/history plans/publications/import jobs/watches/outbox 数量为零。没有启动 managed worker、策略或通知服务。 |
| 迁移与回退 | PostgreSQL 测试实际执行 q18 upgrade/downgrade，已有目录行保留。Yahoo 开关关闭后不创建新预热任务；工作区及价格缓存保留，其他源继续原有行为。 |

`checks.json` 及相邻检查日志列出最终检查结果。`adapter-initial-failure.json` 是已解决的 SDK firstTradeDate Timestamp 初版诊断记录。最终合约测试验证了该类型；最终浏览器验收包含页错误及用户可见 datafeed 错误断言，均为空；检查所有嵌套 frame 加载完成后的实际文本，确认中文名、原代码、报价时间与延迟可见且没有内部身份哈希。原生详情在首次真实报价到达前可能短暂以内部 ticker 为占位标题；名称回调不能完全覆盖图表库这个初始化阶段，图表标题和搜索结果始终保留中文名及原代码，不填造价格来消除占位。browser.json 记录运行时间及 bridge.js/series.js 的 SHA-256，checks.json 会核对它们与最终源码一致，避免沿用修改前的成功结果。

## 实际时延与上游限制

`postgres-live.json` 是清空 **独立验收库 Yahoo 缓存与目录元数据后** 的冷读，包含认证/元数据及调度等待。AAPL 首次约 6.8 秒，其余五样本约 1.9–2.1 秒；第二次命中约 12–58 毫秒。首次 SDK 探测含 cookie/crumb，AAPL 元数据 + M1 约 3.2 秒。浏览器首次显示/跨周期时延在 browser.json 中记录，不将暖会话、缓存命中或 SDK 外的认证时间冒充冷启动指标。Yahoo Session 记录认证、历史、搜索、元数据/报价请求耗时；缓存线路记录租约等待、提交及读取耗时。

真实矩阵共 42 个请求，38 个窗口通过 OHLC 校验。以下窗口收到上游不一致的 OHLC，按方案保持 repair=False 并返回明确 invalid_data，整页不写成功覆盖：GC=F 旧月线；EURUSD=X 所请求日、周、月历史。示例：黄金 2003-04 月线 Close 339.100006 > High 338.399994；欧元 2025-12-03 日线 Close 1.162790656 < Low 1.162817717。这不关闭该周期，也不宣称该标的所有窗口不可用。未补造、重采样、改价或删除负价格来掩盖源异常。

M1 客户端默认 8 天不能当作总保留窗：本次 8 天请求因排他右界舍入略超过跨度而被拒，7 天分页成功；约 30 天总窗、M5/M15 60 天、H1 730 天是当前出口的可配置策略和带时效证据，不是永久全历史起点。曾缓存的更早分钟历史保留可读。指数/汇率和不同交易所未来仍可能出现某周期无数据、访问拒绝或限流。

黄金与原油快照 `exchangeDataDelayedBy=10`（分钟），但 Yahoo 官方 COMEX/NYMEX 表仍写 30 分钟。分别保留报告延迟与官方声明延迟，显示保守最大值 1800 秒。未知延迟保留未知，不填零。日/周/月自动复权和期货换月遵循 Yahoo 本身口径，不承诺跨周期复权一致或自行修复上游数据。

## 本地重现与交付边界

1. 在独立环境安装 `requirements.lock`，`PYTHONPATH=backend`。迁移至 q18，显式配置 `ALERTS_YAHOO_ENABLED=true` 及 Yahoo/market 代理；不可复用生产数据库。
2. [真实后端验收脚本](../../../scripts/yahoo_acceptance.py) 只允许 PostgreSQL 数据库名 `market_watch_yahoo_acceptance`，会清空该独立库的 Yahoo 缓存/元数据进行冷测。运行前停止这个验收库的 API/worker。代理配置从进程环境读取，不输出凭据。
3. [浏览器验收脚本](../../../web/tests/advanced-yahoo.browser.cjs) 默认 API 经 Vite `127.0.0.1:16202`，图表独立来源 `127.0.0.1:16201`。本次后端为 `127.0.0.1:16200`，Vite 同时代理 `/api` 与 `/readyz`；默认自选列表的既有 OANDA 来源通过受限验收环境只读配置访问；本地密码只在权限受限的 `/tmp/market-watch-yahoo-acceptance/password`。需要已有合法图表库及可运行的 Chromium。
4. 本次 Docker socket 与旧验收 PostgreSQL 不可访问，使用本 worktree 虚拟环境内 pgserver 启动独立 PostgreSQL（`/tmp/market-watch-yahoo-pg`），没有调整系统权限或生产容器。浏览器复用现有临时依赖库，未安装系统包。交付后停止本次 API、Vite 和静态图表服务，独立 PostgreSQL 及受限配置文件保留供本机复现，不纳入 Git。

默认源开关关闭，验收环境已显式启用。生产开关、迁移应用、部署、推送和发布仍是单独动作。本次不修改生产环境文件、数据库或运行服务，不沿用历史任务的生产授权。
