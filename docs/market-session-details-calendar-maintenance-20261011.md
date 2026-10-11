# 交易日历集中维护记录（2026-10-11）

此次完成四来源的规则、运行身份和缺口清点。没有把一次公开网页读取失败当成规则失效，也没有把来源名称登记当成全部品种已经核实。当前注册规则的 `checked_at` 保留原记录；本轮失败的官方重查不推进核实日期。

## 官方依据和适用范围

| 来源 | 已有依据和本轮结果 | 已认证映射 | 仍待核实 |
| --- | --- | --- | --- |
| Dukascopy | General Features、Trading Breaks Calendar、Overnight；公开缓存于 2026-10-06 抓取并保存摘录和 SHA256。此次直接 HTTPS 重查连接失败 | 公共 JSON3 来源的 XAU/USD、EUR/USD 常规周时段；黄金纽约 17:00–18:00 每日暂停 | 其他目录产品；逐日假日、提前闭市、临时调整；不能把 JForex 交易表当成历史 M1 缺口完整性证明 |
| OANDA | 已保存 SG hours / holidays 公告；本轮重查连接失败。v20 instrument endpoint 是账户目录依据，不能单独认证交易时段 | 仅实际 source/channel/environment/account/symbol 全部匹配且处于有限审核范围的配置 profile；验收没有生产账户配置 | 实际账户实体和所有未匹配品种。SG 公告不得通用于其他实体／账号 |
| Binance | 官方 Spot API 文档是需要核对的入口；本轮连接失败。原 FAQ 地址没有可验证的响应证据 | 暂无。BTCUSDT 保留候选，改为 unverified | 24x7 常规计划的可靠官方证据、每个实际交易对状态、临时停牌／维护；连接故障不证明休市 |
| Yahoo | 按交易所／资产类别建立映射的入口；本轮返回 HTTP 429 | 暂无通用规则 | 各证券交易所常规／扩展时段，外汇、加密、期货分别核实；行情成功不认证会话 |

公开旧证据见 [研究记录](verification/data-integration/source-calendar-research.md) 和 [原响应摘要](verification/data-integration/source-calendar-public-evidence.json)。本轮每个请求时间、HTTP 状态或连接错误类型见 [official-refresh.json](verification/market-session-details-fix-20261011/official-refresh.json)。没有账户凭据或代理配置进入证据。

## 当前运行清单

日历读取 Instrument、MarketDataset、已保存 MarketCatalog、实际使用的 ProviderDataset 缓存和配置中的 OANDA profile／resident symbols，不调用供应商、刷新目录或写入需求。同代码不同自建数据集分别保留；原生缓存按身份去重，不能因未登记到目录而漏掉已使用品种。无效 profile 保持未核实，不能令整个页面返回 500。

Ubuntu 验收实例的完整清单见 [calendar-inventory.json](verification/market-session-details-fix-20261011/browser-final/calendar-inventory.json)：Dukascopy 的 XAU/USD、EUR/USD 为 verified；Binance BTCUSDT 为 unverified；OANDA EUR_USD、XAU_USD 为 unverified 且未启用；Yahoo 启用，17 个保存品种分别为 unverified（AAPL、AMZN、CL=F、EURUSD=X、GBPUSD=X、GC=F、GOOGL、META、MSFT、NVDA、QQQ、SI=F、SPY、TSLA、^DJI、^GSPC、^IXIC）。每个未核实品种明确保留 unknown。

这是隔离实例及代码的实际配置清点，没有重新查询生产账户或声称生产全部目录已经认证。生产 Yahoo 的持续启用要求仍由正式发布配置保证。

## 已公布例外与后续三个月

旧 SG 公告保留 2026-04-03 Good Friday、05-25 Memorial Day、07-03 Independence Day observed、09-07 Labor Day 的范围和 URL。它们是 SG 公告参考，未被提升为当前未确认账号的闭市规则。账户 profile 自己的明确 closures 使用同一身份的原规则和版本。

检查目标为 2026-10-11 至 2027-01-11。此次未取得这些日期的新官方公告：Dukascopy 动态日历旧缓存没有逐日事件表；OANDA 缓存的已保存条目到 9 月；Binance／Yahoo 未取得可认证的新材料。这表示例外覆盖未核实，不表示已确认未来没有例外。页面逐行提示该缺口；常规规则仍只能描述“交易时段内”，不宣称当前可成交。

## 接续维护

维护执行者为用户指派的 agent。每月、重要假日前或供应商变更后，重查以上官方入口，先核对实体、通道、环境、账户指纹及品种；保存官方摘录与摘要、具体 UTC 半开区间和原始时区，再更新有证据的映射／版本。无变化可更新核实记录；访问失败保留旧证据并报告缺口。

建议复核日期是提示，实际 valid_until／有限 reviewed_end 才是适用边界。DST 使用 IANA tzdata，不手填年度 DST 日期；依赖更新按 `deploy/timezone-maintenance.md` 核对。新规则不改写固定历史、来源柱标签或覆盖证明。每次维护在 Ubuntu 校验闭市内部、边界分钟、账户不匹配、过期和界面后，再按当次授权处理发布。
