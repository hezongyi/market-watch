# ForexConnect 官方历史数据语义核对

核对日期：2026-10-24。范围仅为 FXCM 官方固定提交的 SDK 文档、Linux SDK 内接口/样例及 README 链接的配套源码。本研究未访问账户端点、凭据或发出交易请求；真实登录、目录和样本结果由主任务另存证，不以静态资料代替真实验收。

## 来源和证据等级

- **官方文档**：FXCM `ForexConnectAPI` 提交 `4c536d29fc722996d4a4bc40be247376f8c83eb9` 下的 `docs/help/CPlusPlus/`。固定提交可复查，不表示服务端配置永远相同。[官方文档树][docs]
- **SDK 随包来源**：同提交 `ForexConnectAPI-1.6.5-Linux-x86_64.tar.gz`，7,324,536 bytes，SHA-256 `a4c1ec512f0ede326afd0d63eb587c578b986b382cdd1e63900ce11a8c28f696`。哈希为本轮本地计算，不是官方签名。[固定下载][sdk]
- **配套一手样例**：FXCM README 指向 Gehtsoft 源码仓库；固定提交 `0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7`。[FXCM README][readme] / [配套源码树][samples]

## NoPrice 和无推送边界

**明确保证**：NoPrice 文档说 session 不再接收服务器 price updates；默认接收。`setPriceUpdateMode` 文档明确要求在 `login` 前调用，否则不生效。实现应以方法文档为准，不能照搬 TwoConnections 样例登录后调用的顺序。[NoPrice][noprice] / [setPriceUpdateMode][setprice]；SDK `samples/cpp/NonTableManagerSamples/TwoConnections/source/Connection.cpp:44–53`。

**不外推**：NoPrice 描述对象是价格更新，没有由此证明所有控制、账户或系统事件都不出现。table manager 是另一设置，不能替代 NoPrice。忽略 `onTablesUpdates` 也不能证明网络没有收到推送。真实证据应分别报告控制状态、目录/历史响应及价格更新计数，并注明观测区间。[IO2GSession][session]

## Bar 时间、volume 和完成状态

| 字段 | 官方含义 | 使用边界 |
| --- | --- | --- |
| `getDate(i)` | tick 时间或 bar 起点；UTC | 应保留来源时间，不重标成本地时间。[getDate][date] |
| `getVolume(i)` | bar 的 tick volume：该 timeframe 内价格变化次数 | 不代表已核实的成交手数或名义金额；tick 响应返回 0。[getVolume][volume] |
| `getLastBarTime()` | 最后 bar 最后一个 tick 的日期和时间 | 不是 bar 结束时间或逐柱 complete 标记。[getLastBarTime][lasttime] |
| `getLastBarVolume()` | 最后 bar 的 tick volume | 尾柱可不完整；部分服务器不支持而恒为 0，不能把 0 当作已完成或零交易。[getLastBarVolume][lastvolume] |

reader 没有逐柱 `complete` 字段。官方直接举例：m1 响应在 16:17:09 EST 到达时，尾柱只含该分钟 9 秒。应用若据当前时间、下一柱或周期结束推定完成，应标为**应用推断/策略**，不能冒称来源 complete 保证。[reader 方法清单][reader] / [尾柱说明][lastvolume]

SDK `PriceHistoryAPI/GetLivePrices/source/main.cpp:237–239` 将 last bar time/volume 传入 `PeriodCollection::finish`，随后合入历史请求期间收集的 ticks。`PeriodCollection.cpp:60–77,178–204` 使用最后分钟累计 tick volume 修正重复计数，说明它用于历史/实时衔接，不能据样例参数名将其解释成 H1/D1 周期结束。`include/quotesmgr/quotes_mgr.h:324–339` 的 lastMinute/lastMinuteVolume 属于 **QuotesManager 的另一接口**，不可混同 snapshot 字段契约。[GetLivePrices 源码目录][live]

## 页大小、时间范围和分页

maxBars 上限来自服务器配置；文档说多数服务器 300，但明确要求从 `timeframe->getQueryDepth()` 取得。`getQueryDepth() == -1` 表示该 timeframe 不支持；不能把 300 写成所有账户/周期固定协议。[创建 snapshot][create] / [getQueryDepth][depth]

`fillMarketDataSnapshotRequestTime` 的 timeFrom/timeTo 是 UTC OLE Automation DATE。timeTo=0 表示最近数据，timeFrom=0 表示请求最大柱数；范围超过上限时返回截至 timeTo 的最近一页。**第四 bool 是 isIncludeWeekends，不是 inclusive 边界开关**。false 请求 Monday–Friday；true 包含 weekend 数据。不含 weekend 时，返回条数可能少于 maxBars。[fillMarketDataSnapshotRequestTime][fill]

官方 non-table-manager GetHistPrices 样例用 runtime query depth，收到一页后以 `reader->getDate(0)`（最早时间）作下一次 timeTo，空响应、起点不再变化或到达下界时结束。它证明官方示例的反向游标形态，**没有精确定义等于端点的 bar 是否包含**。对外若承诺 `[start,end)`，应明确执行应用过滤及按 UTC 起点去重，防止空页/游标停滞；不能以任意 epsilon 冒称官方协议。精确端点、weekend 短页和跨页一致性仍需固定样本实测。[GetHistPrices main.cpp][hist]

## 原生 H1/D1 相位和 DST

**官方 timeframe 说明**：What is Timeframe? 明确 m1 在分钟 00 秒开始，H1 在该小时 00 分 00 秒开始；D1 从市场关闭并重开时开始，外汇通常为 New York 17:00，UTC 为 21:00 或 22:00，取决于 New York 夏令时。多小时周期按交易日起点对齐，例如 H6 的 NY 17:00/23:00/05:00/11:00。这是明确的官方 calendar 依据；其中 D1 使用 usually，不能扩展成所有 CFD/账户的无例外保证。[What is Timeframe?][timeframearticle]

CandlePeriod.getCandle 的 startHourOffset 例子写明 FXCM 交易日从前一天 17:00 NYT 开始（offset -7）。返回 start/end 对该方法的输入时间满足 start <= time < end。但这是 QuotesManager candle calendar 的说明，不是 snapshot 参数 inclusive 约定，也不是账户所有品种相位的实测保证。[CandlePeriod.getCandle][candle]

SDK `PriceHistoryAPI/GetLivePrices/source/PriceUpdateController.cpp:69–116` 读取系统属性 END_TRADING_DAY（UTC），用会话 time converter 转为 EST 后计算 trading day offset，缺属性时示例默认 -7。`PriceData/PeriodCollection.cpp:128–140` 在该时区下计算 candle，再转回 UTC。样例注释强调 New York 交易日及夏令时；文档将 EST 枚举命名为 Eastern Standard Time，但没有在该枚举页精确定义 DST 转换算法，不能仅凭 EST 名称把整个历史固定为 UTC−5。[GetLivePrices 源码目录][live] / [time converter][convert] / [EST 枚举][est]

**可落实结论**：snapshot getDate 已明确 UTC，因此保留来源 H1/D1 起点；D1 不能自行平移到 UTC 00:00，不能用自行聚合的 M1 取代来源 native H1/D1。H1 的整小时对齐和外汇 D1 的 NY 17:00/DST 变化已有上述官方说明；特定账户、全部历史、各类品种和交易假日的精确相位仍须按实际来源时间与跨 DST 样本确认，不将外汇 usual 规则写成所有品种固定 UTC 相位。[getDate][date] / [What is Timeframe?][timeframearticle]

## 请求取消、退出和恢复

- **IO2GSession snapshot 路径**：公开方法清单及 SDK `include/forexconnect/IO2GSession.h:125–130` 有 sendRequest、setRequestsTimeout/getRequestsTimeout，没有按 request ID 取消的公开接口。setRequestsTimeout 单位是毫秒，作用于所有请求；文档未保证超时会在服务器端撤销工作。listener 等待超时、取消本地 Future、停止读取响应均不能写成官方确认的 request cancellation。[session 方法清单][session] / [setRequestsTimeout][timeout] / [sendRequest][send]
- **正常退出**：logout 只开始关闭连接，应观察状态直到 Disconnected。官方 Session Statuses 特别要求 Linux 在释放 session/关闭应用前等待 Disconnected。随包头文件另有 forceClose，注释为开始退出、等待完成并关闭 session，但没有给出最长期限或单请求撤销保证；不把它当成取消 API。[logout][logout] / [Session Statuses][statuses]；SDK `IO2GSession.h:214–216`。
- **另一路 API**：PriceHistoryCommunicator 明确提供 cancelRequest，且有 onRequestCancelled 回调。这是 pricehistorymgr API 的请求类型，不能套到 IO2GSession 的 snapshot request 上。该 API 会在 ForexConnect/QuotesManager 之间路由，并使用本地缓存；如果未来改用它，应重新核对缓存、请求和生命周期边界。[cancelRequest][cancel] / [onRequestCancelled][cancelled] / [Price History API][historyapi]
- **连接恢复**：官方说明 Reconnecting 会尝试恢复连接，失败后 SessionLost，随后到 Disconnected；文档中的“currently 20”属于所固定文档的描述，不硬编码为现时服务保证。未找到未完成 snapshot 自动重放、持久 cursor、exactly-once、重连后自动续页的保证。应用如在新 session 重试某个有限区间，应自行保存成功页游标、去重并报告失败/恢复状态，注明这是应用实现。[Session Statuses][statuses] / [Reconnecting][reconnecting]

**有界停止的准确表述**：进程退出或 helper 终止能够限定本地资源占用，是应用的故障隔离机制；它不能证明远端请求已被 SDK 撤销。本轮未执行取消、终止或断线恢复试验。

## Linux SDK 许可和再分发

准确来源是固定 tar 内 `ForexConnectAPI-1.6.5-Linux-x86_64/doc/license.txt`：GEHTSOFT USA, LLC SOFTWARE END USER LICENSE AGREEMENT，Copyright 2019，Version 1.0 August 2018。以下是条款摘意，供实现选择核查，不替代许可原文。[官方 tar][sdk]

| 原文位置 | 明确条件 |
| --- | --- |
| §3，lines 28–29 | 可安装和使用任意份数用于设计、开发、测试自己的应用。 |
| §4.1，lines 31–37 | 允许复制/修改/分发 samples 内 Sample Code；允许复制/分发构成 Software 的 code/docs，受随后分发条件约束。 |
| §4.2，lines 38–43 | Distributable Code 需用于自己的程序，不能独立分发；除 Sample Code/另行开源组件外应原样分发；下游保护条款、赔偿及支持责任适用。 |
| §4.3，lines 44–46 | 不暗示官方背书，不移除或遮蔽版权、商标、专利通知。 |
| §5，lines 48–49 | 第三方及开源组件受各自独立许可约束。 |
| §11，lines 66–73 | 限制逆向、反编译、反汇编；不得违法、未经授权使用，不能损坏/过载服务器或干扰其他用户。 |
| §14–15，lines 81–85 | 包含许可终止及条款变更约定。 |

FXCM README 另要求 ForexConnect/Trading Station 账户和先签 FXCM EULA；Gehtsoft 源码仓库的 Open License 不能覆盖 binary SDK tar 的 EULA。公开可下载或账户登录成功都不能单独证明所有分发、数据再展示/存储用途已经获许可。本轮不提交 SDK 二进制、不发布包含 SDK 的镜像；仅记录可追溯的官方包来源及许可条件。具体用户同意情况、账户合同、费用、行情存储/再分发权和当前线上 EULA 适用性仍未知。[FXCM README][readme] / [源码 Open License][openlicense] / [FXCM EULA 入口][fxcmeula]

## 仍需实测或确认的边界

1. 固定端点时间是否包含、跨页重叠、短页是否仍有更老数据及无进展停止行为。
2. 账户 native H1/D1 的跨 DST/假日相位，以及当前末柱的应用完成策略。
3. 取消/超时后服务端行为、失联和重新登录后的区间重试；不能用静态文档代替恢复试验。
4. 用户及后续分发方式实际适用的 FXCM 与 Gehtsoft 条款。

本文件确认了公开官方语义，不改变主任务的账户实测事实、验收授权或发布边界。

[docs]: https://github.com/fxcm/ForexConnectAPI/tree/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus
[sdk]: https://raw.githubusercontent.com/fxcm/ForexConnectAPI/4c536d29fc722996d4a4bc40be247376f8c83eb9/ForexConnectAPI-1.6.5-Linux-x86_64.tar.gz
[readme]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/README.md
[samples]: https://github.com/gehtsoft/forex-connect/tree/0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7/samples/Linux/cpp
[noprice]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/O2GPriceUpdateMode.NoPrice.0.html
[setprice]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GSession.setPriceUpdateMode.html
[session]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GSession.html
[date]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GMarketDataSnapshotResponseReader.getDate.html
[volume]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GMarketDataSnapshotResponseReader.getVolume.html
[lasttime]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GMarketDataSnapshotResponseReader.IO2GMarketDataSnapshotResponseReader.getLastBarTime.0.html
[lastvolume]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GMarketDataSnapshotResponseReader.IO2GMarketDataSnapshotResponseReader.getLastBarVolume.0.html
[reader]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GMarketDataSnapshotResponseReader.html
[live]: https://github.com/gehtsoft/forex-connect/tree/0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7/samples/Linux/cpp/PriceHistoryAPI/GetLivePrices/source
[create]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GRequestFactory.createMarketDataSnapshotRequestInstrument.html
[depth]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GTimeframe.getQueryDepth.html
[fill]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GRequestFactory.fillMarketDataSnapshotRequestTime.html
[hist]: https://github.com/gehtsoft/forex-connect/blob/0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7/samples/Linux/cpp/NonTableManagerSamples/GetHistPrices/source/main.cpp

[candle]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/quotesmgr.CandlePeriod.getCandle.0.html
[convert]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GTimeConverter.convert.html
[est]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/O2GTimeConverterTimeZone.EST.0.html
[timeout]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GSession.setRequestsTimeout.html
[send]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GSession.sendRequest.html
[logout]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GSession.logout.html
[statuses]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/SessionStatus.html
[cancel]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/pricehistorymgr.IPriceHistoryCommunicator.cancelRequest.0.html
[cancelled]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/pricehistorymgr.IPriceHistoryCommunicatorListener.onRequestCancelled.0.html
[historyapi]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/pricehistory.html
[reconnecting]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/O2GSessionStatus.Reconnecting.0.html
[openlicense]: https://github.com/gehtsoft/forex-connect/blob/0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7/GEHTSOFT%20USA%20OPEN%20LICENSE%20v1.0.md
[fxcmeula]: https://www.fxcm.com/uk/algorithmic-trading/api-trading/terms/eula/

[timeframearticle]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/whatisTF.html
