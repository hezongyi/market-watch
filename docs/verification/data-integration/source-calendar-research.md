# 来源交易日历核实

核实日期：2026-10-06。范围：OANDA v20 practice 的 EUR_USD / XAU_USD，Dukascopy Python 4.0.1 的 EUR/USD / XAU/USD。本文只研究公开一手资料，没有读取凭据、请求账户接口、联系供应商或更改业务日历。

## 结论与适用性

当前 `ny17-candidate-v1` 不能标为两个来源都已验证的官方交易日历。NY17 是聚合日界线；来源实际开闭市、常规维护和节假日另有分钟级规则。OANDA 新加坡公开资料明确与当前 `scheduled_open` 的整点规则存在差异，而已记录的 practice 边界报价又说明公告时刻不能直接用作禁止 M1 存在的裁剪边界。[1][2][3][7]

| 对象 | 公开资料已证明 | 尚未证明 |
| --- | --- | --- |
| OANDA Singapore EUR/USD | 通常周日 17:05 开、周五 16:59 收，纽约当地时间；每日 16:59–17:05 暂停。[1] | 当前 practice 账户所属 division、全部十年历史例外、每个开市分钟必有完成柱 |
| OANDA Singapore XAU/USD | 通常周日至周五 18:05–16:59，纽约当地时间；相邻通常会话间为 16:59–18:05。[1] | 同上；每次实际开始/结束的秒级边界；公告与 practice 报价的精确对应 |
| Dukascopy EUR/USD / XAU/USD | 当前 JForex 常规交易表为周日 21:00 GMT（夏）/22:00（冬）至周五同刻；XAU/USD 每日暂停 21:00–22:00（夏）/22:00–23:00（冬）。官方 rollover 用美国 DST。[9][10] | Python JSON3 历史 feed 的边界语义、历史规则变更、十年按品种的节假日档案 |

本轮取得的 Dukascopy CFD `Range of markets` 表含其他 CFD 的分品种时段，但没有 EUR/USD 或 XAU/USD 行；黄金的依据是另行找到的 JForex `General features` 页，不能把 CFD 表某行的暂停套用到黄金。[6][9] 公开页面或 SDK 调用返回空列表也不能证明休市。[4][5][8]

## OANDA 常规会话和当前实现的差异

[OANDA Singapore Hours of operation][1] 当前 HTTP 200 内容与仓库 2026-09-29 归档中的核心时段一致。原文：

> Forex instruments open on Sunday at 17:05 and close for the week on Friday 16:59 (New York time). There will be a six-minute break between 16:59 - 17:05

`All FX products (except TRY Pairs)` 行的时段为 `Sun-Fri: 17:05 - 16:59`；EUR/USD 属于这个公开产品类别。`XAU/USD` 明列为 `New York`, `Sun-Fri: 18:05 - 16:59`。TRY 与 NZD 的例外不能套到 EUR/USD；3–10 品种扩展时也不能把 EUR/USD 的规则无条件套到所有外汇品种。[1]

研究时的 `backend/alerts/domain.py:scheduled_open` 使用纽约星期/整点：外汇周日 17:00 开、周五 17:00 收，无每日外汇暂停；黄金额外把每个当地 `hour == 17` 判闭市。因此与上述公开交易时刻比较：

| 位置 | NY17 候选实现 | OANDA Singapore 公告 |
| --- | --- | --- |
| EUR/USD 周日开市 | 17:00 | 17:05 |
| EUR/USD 周五收市 | 17:00 | 16:59 |
| EUR/USD 工作日暂停 | 无 | 16:59–17:05 |
| XAU/USD 周日开市 | 18:00（17 点黄金暂停） | 18:05 |
| XAU/USD 周五收市 | 17:00 | 16:59 |
| XAU/USD 工作日暂停 | 17:00–18:00 | 16:59–18:05 |

表中是交易时刻的差异，不是对已有 M1 的删除指令，也不是所有公告暂停分钟都必须没有任何 feed 数据的证明。[1][7]

OANDA 美国帮助页明确要求选择签约 division，其内容写明 “You are currently viewing information relevant to OANDA Corporation” 和 “If you have contracted with another OANDA division, select that division ...”。同页也明确 “We do not guarantee to quote all instruments during our hours of operation”。因此 `practice` 端点和品种在目录中可用都不能单独证明新加坡交易表适用或开市区间每分钟必有报价。[3] 本研究没有识别当前账户 division，不能打开全局 `oanda_calendar_verified` 来消除这一限制。

## DST 与聚合相位

OANDA Singapore 表以 `New York` 本地时间给时段，页面说明时间会受夏令时及部分公共假日影响。[1] 应保存 IANA `America/New_York` 和来源规则版本，以当地时间生成再转 UTC。下面是时区换算示例，不是额外的来源保证：

| 公告时刻 | EDT UTC−4 | EST UTC−5 |
| --- | --- | --- |
| EUR/USD 17:05 开市 | 21:05 UTC | 22:05 UTC |
| XAU/USD 18:05 开市 | 22:05 UTC | 23:05 UTC |
| 16:59 收市 | 20:59 UTC | 21:59 UTC |
| NY17 日界线 | 21:00 UTC | 22:00 UTC |

仓库 `scripts/oanda_schedule.py` 已把新加坡黄金的公告会话建成独立纽约时区类，且输出明确为交易时刻，不能当成完整 M1 闭市配置。已有记录给出 2026-03-06 开市 23:05 UTC、2026-03-09 开市 22:05 UTC 的跨 DST 例子。[7] Dukascopy 自己的 overnight 页支持美国 DST 的 21:00/22:00 GMT 日切，但没有据此证明 Python 历史高周期接口的每种相位；NY17 本地聚合配置仍应版本化。[10]

## 公告端点、边界分钟与实际数据

仓库 [日历库评估记录][7] 保存的既往 practice 只读核对结论：黄金 2026-09-27 的首根 S5 为纽约 `18:04:55`；2026-09-25 最后两根 S5 为 `16:59:00` 与 `16:59:05`。同文还报告黄金 `18:04` / `16:59` 起始 M1，外汇 `17:04` / `16:59` 起始 M1。这里引用的是仓库已有核对记录，本研究没有重新请求这些账户窗口，也没有从公开公告独立证明这些秒级观测。[7]

这些已有观测与公告并非允许粗暴选择其中一项覆盖另一项。交易时刻、报价可观测时刻和完成柱覆盖是三个问题。M1 `[16:59,17:00)` 可能包含收市端点附近的合法来源报价；开市前一分钟也可能有源返回的观测。应保留来源实际提供且校验通过的柱，把边界分钟与确定暂停的内部分钟分别处理；缺失边界分钟不应被不适用的整点模型直接判为实时漏采。[1][7]

当前十年历史报告的 `unknown` 也不能仅凭一个当前公开时段表全部改成已闭市。候选规则、已确认闭市例外、来源真实覆盖和未核实区间必须分开记录。正常每日维护不能与假日缩短混为一种语义，否则容易把每日 H4 都判为假日缩短。[7]

## 节假日证据的范围

[OANDA Singapore Holiday trading hours][2] 明确为 `OANDA Asia Pacific`，且说明所有时间为 Eastern Time。本轮页面含 2026、2025 的若干公告，不能据此宣称 2016–2026 连续档案完整，也不能把页面没有列出的日期认定普通开市。

可直接读到的 2026 示例：Good Friday（4 月 3 日）`US Energies and metals: Closed`；7 月 3 日 US energies/metals `Close at 12:59`；5 月 25 日写 `Close at 14:29; reopen at 18:01 (Gold, Silver and their crosses reopen at 18:05)`；9 月 7 日 US energies/metals 14:29 早收、18:01 重开，后者没有在该行同样逐一明确黄金例外。[2] 因而每项产品映射和重开时刻需要单独核实，不能拿统一 `US metals` 行机械覆盖金银具体产品，更不能把这张当前新加坡表变成全账户、全历史、全品种日历。

Dukascopy [Trading Breaks Calendar][4] 原文说会显示因假日变化的特殊 GMT 时段，且 “holiday hours ... are believed to be accurate but not guaranteed and may be subject to change”。抓到的 HTML 含 `DukascopyApplet`、`type: trading_breaks` 和官方公共加载器，但静态页面没有返回按 EUR/USD / XAU/USD 的逐日事件表。本研究没有取得十年历史例外，不应把“官方存在日历功能”写成“历史例外已验证”。

## Dukascopy 通道和可用官方接口

[Dukascopy General Features][9] 当前 JForex Accounts 的交易时段原文：

> Most of the instruments are traded on a 24 hour basis without interruption, from market opening on Sunday, 21:00 GMT during Summer Time (22:00 GMT during Winter Time) until market close on Friday, 21:00 GMT during Summer Time (22:00 GMT during Winter Time).

下面的 `Trading Breaks` 表明确 XAU/USD 为夏令时 `21:00–22:00`、冬令时 `22:00–23:00`；EUR/USD 没有列为有日内暂停的例外。黄金脚注明确 US national holidays 夏令时 `17:00–21:00`、冬令时 `18:00–22:00` 不可交易。[9] 因此当前 JForex 常规规则与 NY17 候选的外汇整点周边界及黄金 17:00–18:00 纽约暂停大体相符；它与 OANDA Singapore 的分钟级规则不同。但脚注没有列出十年逐日 US national holidays、提前收市/重开例外，不能靠泛化美国国家节假日库声称完整验证。

[Dukascopy Overnight Policy][10] 明确多数品种交易日更替为 `21:00/22:00 GMT, depending on US daylight saving time in March and November`；NZD 另有其本地 DST 例外。该来源支持使用纽约 DST 解释多数品种 rollover，而不是欧洲夏令时。但 rollover/结算时刻、可交易时段、JSON3 M1 feed 可观测性、H4 标签仍是分别需要证据的问题。[9][10]

[Dukascopy Market Hours wiki][5] 描述 JForex `IDataService.getOfflineTimeDomains(...)` 返回过去/未来市场 offline 时间域，示例取过去三周、未来一周。这个来源证明 JForex API 有市场离线查询机制；示例不带 EUR/USD/XAU/USD 分品种日历查询参数，也不证明 Python SDK 使用的公开 JSON3 feed 与某个离线域集合完全相同，更不证明十年回溯覆盖。

选定的 [dukascopy-python 4.0.1][8] 维护者源码定义的是 chart JSON3 分页取数、时间单位和重采样；本轮读到的该版本模块没有提供来源交易日历或历史假日验证方法。SDK 的普通分页成功/空响应只有请求语义，不包含已闭市证明。官方另有 CFD、加密等页面，各自产品和渠道范围应保留，不能互相借用。[4][5][6][8]

## 实施前可采用的判断

- 保持来源身份内的候选日历版本和“未完全验证”标记；不要把不适用的公告提升为账号级已验证日历。
- OANDA 官方公告可作为具名、具日期/产品/division 范围的外部证据。结合该账号边界报价和 complete M1，再形成不可变会话配置；保留来自同源的有效边界柱。
- 做两个交易日实时验收时，完整列出正常交易、公开维护内部、边界待确认、假日和未知分钟。无法证明应存在的分钟不能冒充已知应存在分母；又要分别报告失联、缺失、迟到和未知，不能用 unknown 隐去失败。
- Dukascopy 十年数据按真实拉取范围和 unknown 报告；未取到来源历史日历前，不从 OANDA 会话或 COMEX/CME 通用日历反向解释 Dukascopy 缺口。

具体可落地的保守配置建议：

1. 分开保存 `aggregation_calendar`、`candidate_session_rules` 和 `confirmed_closures`。已验证闭市必须带来源 URL/内容版本、provider/channel/instrument、UTC 半开区间、适用 division/account 依据及已审核日期范围。未知 division 的 OANDA SG 表仅用于“可能维护”标签，不能直接把缺失改成闭市或排除失败分母。
2. 对已证明适用的 source-backed closure，仅将没有来源观测冲突的暂停内部完整分钟判为确定闭市；保留开闭市附近的边界分钟和所有实际返回且校验通过的柱。现有 SG 黄金核对支持先保留 16:59 与 18:04 起始 M1，并核实内部 `[17:00,18:04)`；这只是有边界证据的候选，不是未知账号的自动确认。[7] 外汇同理保留 16:59/17:04，内部候选为 `[17:00,17:04)`。
3. 边界或适用性冲突保留 unknown 和理由，不能以减少迟到/缺失数字为目的自动接受配置；采集仍读 REST 并保留状态。如果已声明闭市内部实际收到合法同源柱，记录冲突并撤销其确定闭市解释，不丢柱。
4. `tradeable=false` 只证明该报价事件的不可交易状态，不单独证明整个 M1 区间或未来会话。成功空 candles 返回仍是 empty_success。新鲜同源 tradeable 报价、真实完成柱和已确认会话分别提供不同证据，不互相替代。

## 证据与引用

本轮公开响应 URL、HTTP 状态、内容 SHA256 与关键原文摘录保存在 [source-calendar-public-evidence.json](source-calendar-public-evidence.json)。全量公开缓存由父进程写到 `/tmp/market-watch-calendar-public/`；永久证据不依赖该临时目录。只保存公开网页信息，没有账户标识、token、代理地址或请求头。2026-09-29 两张完整文本已存在于 `docs/sources/`，无需重复保存。

[1]: https://www.oanda.com/sg-en/trading/hours-of-operation/
[2]: https://www.oanda.com/sg-en/trading/holiday-trading-hours/
[3]: https://help.oanda.com/us/en/faqs/hours-of-operation.htm
[4]: https://www.dukascopy.com/swiss/english/marketwatch/trading-breaks-calendar/
[5]: https://www.dukascopy.com/wiki/en/development/strategy-api/instruments/market-hours/
[6]: https://www.dukascopy.com/swiss/english/cfd/range-of-markets/
[7]: ../../calendar-library-evaluation.md
[8]: https://github.com/Eghosa-Osayande/dukascopy/blob/09eb716e7e31dfb8eb5ee9c6fa27ee5501d42c7c/python/dukascopy_python/__init__.py
[9]: https://www.dukascopy.com/swiss/english/forex/forex-trading-accounts/link/
[10]: https://www.dukascopy.com/swiss/english/forex/forex-trading-accounts/overnight/
