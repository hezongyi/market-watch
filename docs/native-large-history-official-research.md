# Advanced Charts 大历史加载：官方资料核查

研究日期：2026-10-04；网络核查截至 11:03 UTC（Asia/Singapore 19:03）。

范围：解释原生大 `getBars` 请求、缓存、分页、实时订阅、历史修订、加载提示与取消合同；不修改产品、Docker 实例或行情数据。本文件是文档证据，不能代替浏览器与数据库实测。

## 结论

1. **没有在核查的一手资料中找到 Advanced Charts 总 bars 必须小于 20,000 的规定，也没有找到 60,000、200,000 或百万根的性能保证。**当前仓库的 `CAPACITY = 20000` 是应用策略。不能把“API 参数没有最大值”推导为“任何数量都能轻松处理”。
2. **按原生请求满足 `countBack`，通过数据源分页获取，再走正常历史回调，是官方合同允许的方向。**历史 range 初始化仍取到当前日期，是官方明确记录的行为，不应仅凭需求量大就认定原生出错。服务端单页容量与原生整体需求量是两种约束。
3. **库自身缓存历史数据。**PG 再请求变快和前端原生缓存复用是两层收益；PG 缓存不能消除重新传输、解析、库内数据处理及指标运算。官方没有量化这些成本。
4. **正常 `getBars` 路径不等于永不 reset。**官方要求历史 bar 修订通过 reset 缓存后重新请求；实时回调只允许修改最后一根或追加更新的 bar。应该避免无关范围、纯新增、重复通知误触发 reset，但不能取消真正的历史修订处理。
5. **官方公开历史 API 未提供下载进度或取消句柄。**后台加载、超时、用户转向后的废弃结果、取消与并发预算仍需应用负责；`unsubscribeBars` 是实时订阅合同，不能充当历史请求取消。
6. **加载 spinner 表示加载，并非进度、主线程流畅或一定会成功的保证。**是否等待可接受，需要分别测网络等待和数据到达后的 UI 处理。

## 版本与来源可靠性

- 本地许可包 `advanced-host/charting_library/package.json`：`TT v31.1.0`，构建时间 `2026-04-08T18:21:25.992Z`。本研究只引用声明中的接口说明，不复制许可实现或资源。
- [官方 Version 31.1.0 公告](https://www.tradingview.com/charting-library-docs/blog/version-3110)：发布于 2026-04-08，与本地版本匹配；公告没有大 bars 性能数据。
- 官方 `latest` 文档是滚动更新页面，访问时导航已包括 v32.2.0；不能当作 v31.1 的冻结文档。与本地 v31.1 声明一致的合同，可双重佐证；只有现行文档出现的细节注明为现行合同。
- `/v31/connecting_data/Datafeed-API/` 与 `/v31/introduction` 本次返回 404，未声称取得冻结的 v31 网页。
- 访问 TradingView 官方网站通过网络代理成功，HTTP 200、完整 Docusaurus 正文；响应 gzip 需要解压。最初解码失败不是内容被拦截。代理未用于部署实例。

## 历史请求为何可能很大

### `countBack` 的优先级

[官方 PeriodParams](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Datafeed.PeriodParams/#countback) 定义：

> The exact amount of bars to load, should be considered a higher priority than `from` if your datafeed supports it.

本地 v31.1 `datafeed-api.d.ts:915` 起的 `PeriodParams` 同样定义 `from`、非包含的 `to`、`countBack` 与 `firstDataRequest`，没有 `maxBars`。

[官方 Required methods / Correct amount of data](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/#correct-amount-of-data) 明确：

- 库计算所需数据量；实现应以请求的 bar 数量优先于精确匹配 `[from,to)`。
- 应包括请求范围内的既有数据；范围中不足 `countBack` 时，返回更早的 bars 补足。
- 范围内多于 `countBack` 时，官方建议返回该范围全部 bars，勿仅截断为 `countBack`。
- 返回不足时，库会再次调用 `getBars` 获取缺失数据。
- 只有服务端确实无更多历史，才应设置 `noData: true`；容量限制、超时和供应商暂时失败不能冒充历史耗尽。
- 指标可能需要可见区以外的额外历史。

[Datafeed common issues / getBars is called multiple times](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Datafeed-Issues/#getbars-is-called-multiple-times) 给出 329 根需求分多次补足的具体日志。**少量返回可以触发继续补齐；它本身不要求重建窗口。**不过，刻意每次少量返回是否更有利，应实测，不能忽视官方减少重复请求的建议。

[官方 WidgetOptions / timeframe](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.ChartingLibraryWidgetOptions/#timeframe)：

> When using a range the chart will still request data up to the current date. This is to enable scrolling forward in time once the chart has loaded.

这直接支持“远历史视图可能需要目标至最新之间的连续数据”的设计解释。它描述的是初始化 `timeframe`；某一次跨周期跳转的确切需求仍应以 v31.1 原生日志为准，不能把此句当所有导航内部算法的证明。

### 单页容量与整体需求不同

[官方 UDF adapter / Constructor](https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#constructor) 支持 `limitedServerResponse`：

- `maxResponseLength` 是服务器**单次响应**的最大 bars。
- 官方明确：这个配置不影响或改变库请求多少 bars，只让 datafeed 正确处理服务器截断响应。
- `expectedOrder` 区分 `latestFirst` 与 `earliestFirst`。

[UDF / Bars](https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#bars) 说明服务端 `countback` 优先于 `from`，正确处理它有助性能并避免空时间范围的重复请求。

因此，大需求不要求行情商提供一个大页面，也不要求应用使用独立历史窗口。可以保留原生历史合同，内部聚合供应商页面。UDF 的文档不等于当前自定义桥接层已经实现了此机制。

## 缓存、指标与性能边界

### 两层缓存

[Required methods / getBars](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/#getbars)：

> The library caches historical data. Therefore, you do not need to implement a client-side cache.

此句描述原生库的前端历史缓存，不是 PG、持久化跨页面缓存或供应商缓存承诺。完整刷新页面会创建新 widget；PG 命中仍需向新 widget 交付数据。原生窗口是否保留已有走廊、同数据集多图如何共享，应测当前实际布局。

### 指标并非只处理可见 bars

[Required methods](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/#correct-amount-of-data) 与 [FAQ](https://www.tradingview.com/charting-library-docs/latest/getting_started/Frequently-Asked-Questions/) 都说明指标可能需要额外历史。FAQ 特别指出 VWAP、Pivot Points 可能需要大量历史，取得所需数据后才绘制；库不预取所有历史以免过多请求。

[官方 IContext / setMinimumAdditionalDepth](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IContext/#setminimumadditionaldepth) 说明 SMA 10 至少请求额外 10 根；链式指标可显式设置更多历史需求。

本地 v31.1 的 `PineJSStd.max_series_default_size` 为 `10001`（`charting_library.d.ts:17552`），说明是 **default maximum size of a pine series**。它不是主图总 bars 最大值；`IContext` 又允许不同深度的临时存储。不能把 10001 当成图表总容量或处理超过 10001 的性能证明。

### 未发现的保证

已核查：现行 Datafeed API/Required methods、PeriodParams、WidgetOptions、UDF、Datafeed issues、FAQ、31.1 公告、官方 sitemap 以及本地 v31.1 声明。**未发现**：

- 图表整体 20,000 根硬上限；
- 总 bars 推荐数量或 60k/200k/1m 的跨硬件性能基准；
- 数据量增长与内存、指标耗时的官方公式；
- 对四图或多指标的大历史吞吐与响应时间 SLA。

官方 sitemap 未列出专门 performance 页面；猜测的 `/getting_started/Performance/` 返回 404。因此本报告没有“官方保证能轻松处理几十万根”的结论。TradingView 网站套餐的历史 bars 权益和 Lightweight Charts 其他产品的性能资料，均不用于证明本许可库 v31.1 的容量。

仓库 `backend/alerts/provider_history_policy.py:3` 的 `CAPACITY = 20000` 是应用明确设置的容量；将它改变或移除属于另一个实现决定，本研究没有实施。

## 回调、实时更新与 reset

### 历史交付并非公开流式协议

本地 v31.1 `IDatafeedChartApi.getBars(..., onResult, onError): void`（`datafeed-api.d.ts:340`）；`HistoryCallback` 为 `(bars: Bar[], meta?: HistoryMetadata) => void`。公开 `PeriodParams` 不含取消信号或进度字段。

[官方 Required methods 示例](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/#getbars) 先构造 bars 数组，再调用历史 callback；连续更新属于 `subscribeBars`。没有找到支持“同一 `getBars` 回调每下载一页就调用一次、将它当进度流”的公开合同。

严谨区分：本次找到的“only once”明确文字主要针对 `getMarks`、`getTimescaleMarks`、`getServerTime` 等，**没有把这些接口的文字错误套用到 `getBars`**。当前大历史实现若拟在同一个历史 callback 多次推页，必须另有库合同或专门验证。

[Datafeed API / Asynchronous callbacks](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/#asynchronous-callbacks) 要求 datafeed callbacks 异步执行，在不同 MacroTask 调用，避免 `Maximum call stack size exceeded`；库也可能修改传入 bars，因此应给副本。

### 真正的历史修订仍需刷新

[Required methods / subscribeBars](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/#subscribebars)：

- 更新只能修改最新一根或加入更新 bar；不能用实时 callback 修改历史 bar。
- 修订历史应 `resetCache` 再 `chart.resetData()` 重新绘制，否则可能 `putToCacheNewBar: time violation`。

本地 v31.1 `subscribeBars` 包含 `onResetCacheNeededCallback`（`datafeed-api.d.ts:351`）；`resetCache` 声明说明它等效于对全部 symbol/resolution 调用此 callback（`charting_library.d.ts:12422`）。

本地 `resetData`（`:10893`）说明强制重新请求数据，调用前要清除缓存。这证明 reset 的作用是失效/重新请求，不是“历史窗口天生每隔几秒需要 reset”。当前 backend SSE 的 `reset` 事件名称与库 callback 同名，也不意味着每个事件都代表已加载历史确实更改。

[Datafeed issues / Internet connection issues](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Datafeed-Issues/#internet-connection-issues) 明确断线恢复由应用处理，可以 resetCache/resetData。

现行文档与本地 v31.1 均提供 `request_only_visible_range_on_reset`：默认 false；启用后重置只重新请求可见范围，而非已加载的整个范围（本地 `charting_library.d.ts:29737`）。这属于可以研究的原生能力，**不是本次已采用的方案**；连续滚动及指标行为仍需专门验证。

### 订阅延迟退订与取消

[官方 Datafeed subscriptions](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/datafeed-subscriptions/) 说明切换 symbol/resolution 后通常约 5 秒才退订旧数据集，以便快速切回时复用流、减少加载闪烁；收到确切 ID 的退订前应维持其更新，不能把新订阅当旧订阅已结束。

这只描述实时订阅。公开 `getBars` 返回 void，未提供 AbortSignal/历史下载 cancel handle。不能据此声称用户切周期后供应商下载已自动取消。对于后台大需求，取消旧任务、禁止旧结果污染新图、并发共享和超时收尾需要应用处理并实测。

## 加载提示能说明什么

[WidgetOptions / loading_screen](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.ChartingLibraryWidgetOptions/#loading_screen) 允许配置 loading spinner 的前景/背景色；没有进度百分比或“任意等待时长仍持续流畅”的保证。本地 `onDataLoaded`、`dataReady` 能观察数据加载完成（`charting_library.d.ts:10717`、`:10802`）。

用户看到的三个点可帮助区分正在加载和静止页面，但官方公开资料没有明确保证每次大历史 `getBars` 全程都展示这一特定动画。因此本轮浏览器实测应记录真实 loading 展示与结束。

[W3C Long Tasks API](https://w3c.github.io/longtasks/) 将约 50ms 以上 UI 主线程任务作为长任务，说明它们可阻塞输入、影响动画与滚动。等待异步网络和数据交付后大量同步处理是不同阶段。动画可用不能替代耗时、长任务、输入延迟及内存测量，也不能保证加载有进展。

## 数据源分页与可得性

| 来源 | 一手证据 | 已核实内容 | 限制与解释 |
|---|---|---|---|
| Binance Spot | [官方 REST docs / klines](https://github.com/binance/binance-spot-api-docs/blob/828ca74b809cfedbd5602df328b5f706368d483b/rest-api.md#klinecandlestick-data) | `GET /api/v3/klines` 默认 500、最大 1000；weight 2；支持 startTime/endTime；按 open time 唯一标识 | 是单页限制，不是总体图表 bars 上限；60k 至少约 60 页，200k 约 200 页，1m 约 1000 页，实际有重叠/缺失及预算 |
| OANDA v20 | [官方 OpenAPI](https://github.com/oanda/v20-openapi/blob/70324cfee31ff0074ed0bf1f93e67d8ee6c84444/yaml/separate/v20_instrument.yaml)、[官方 Python SDK](https://github.com/oanda/v20-python/blob/master/src/v20/instrument.py) | `/v3/instruments/{instrument}/candles` 支持 count、from、to；同时指定起止时不应再指定 count；支持 includeFirst | 公开 OpenAPI 版本 3.0.25、提交日期 2018-09-28，本文件 count 未声明 maximum。常见“最大5000”本次没有取得有效官方网页佐证；不能写成已核实当前规则 |
| OANDA 连接建议 | [官方 Best practices](https://developer.oanda.com/rest-live-v20/best-practices/) | 建议新连接≤2/s、持久连接请求≤100/s；建议 keep-alive 降低握手成本 | 是推荐，不是保证所有分页和代理链路都达到该吞吐；并行请求仍需产品预算 |
| Yahoo Finance | [官方历史下载帮助](https://help.yahoo.com/kb/SLN2311.html) | 可用历史数据有范围边界；该帮助介绍网站 CSV 下载 | 未找到与当前 chart endpoint 对应的正式稳定分页/吞吐 API 合同；网站下载帮助不能用作 intraday API SLA |
| Yahoo chart 第一方响应 | 下列只读请求，2026-10-04 实际 HTTP 422 | 5m 最近60天；1h 最近730天；1m 每次请求最多8天 | 是本次观察到的端点校验，不是永久政策承诺；“单请求8天”不等于“总保留8天” |

Yahoo 第一方错误观察：

- [5m，range=1y](https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=5m&range=1y)：`The requested range must be within the last 60 days.`
- [1h，range=5y](https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1h&range=5y)：`The requested range must be within the last 730 days.`
- [1m，range=1mo](https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1m&range=1mo)：`Only 8 days worth of 1m granularity data are allowed to be fetched per request.`
- [1d，range=1mo](https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=1mo)：HTTP 200，证明端点可访问。

当前应用 `backend/alerts/provider_capabilities.py` 的页容量 OANDA/Yahoo=4000、Binance=1000 是实现策略；Yahoo 的4000不能当第一方固定分页上限。读取原生需求时，供应商真实可得性和交易时段必须纳入计算。

OANDA `https://developer.oanda.com/rest-live-v20/instrument-ep/` 本次确实返回 Page Not Found/HTTP404；根站、instrument-df、pricing-ep、account-ep 与 best-practices 可访问。没有用旧地址404来宣称整个官方站不可访问。若进一步用真实 OANDA API确认 `count=5001` 失败，应报告为有时间戳的第一方接口观察。

## 对实验及后续取舍的含义

文档支持优先比较“保留原生路径、内部分页聚合”与当前窗口策略，**不支持仅凭上限20000直接否定前一种，也不支持无条件去掉所有容量保护**。

需要与实测汇合的判断：

- 冷加载：供应商页数、外部请求/重试预算、取消后仍在运行的任务数、PG写入成本。
- 热加载：PG读取、HTTP响应字节、JSON解析与构造、原生交付处理、指标计算、内存。
- 前端复用：同一 widget 已加载区域再次跳转与新开页面，分别计时；二者不能合并成“第二次加载”。
- 用户体验：四图原布局、指标、加载提示、点击与hover同步，不能只测空白单图。
- 极端量：60k/200k/1m 每图及四图，不因某个单图测试快就推广为四图性能保证。
- 修订/失败/取消：真正的范围内历史更正仍反映；纯最新追加不重建；旧请求结束后不污染已转向的新图；失败后还能继续操作。

这些能力通过后，原生方案通常可减少自定义窗口状态，但实际是否更快、更稳，由同版本、同硬件、同布局的结果决定。

## 访问记录

以上所有官方网页/原始仓库资源/第一方 Yahoo 响应均于 2026-10-04 10:48–11:03 UTC 经 HTTP只读取得。Binance 文档固定到提交 `828ca74b809cfedbd5602df328b5f706368d483b`（2026-09-18）；OANDA OpenAPI 固定到 `70324cfee31ff0074ed0bf1f93e67d8ee6c84444`（2018-09-28）。现行 TradingView 资料以 URL 和访问日期标注，版本边界以本地许可声明补充。
