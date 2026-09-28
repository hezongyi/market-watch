# OANDA Practice：交易时段与 2026 节假日日历的证据边界

研究日期：2026-09-29（本次会话提供的日期）。范围：EUR_USD 与 XAU_USD；仅公开一手资料；未读取 `.env`、未调用账户接口、未发送通知。

## 后续成功取证（2026-09-29）

用户已确认账户为OANDA新加坡。本次通过同一授权代理重新访问，SG主站常规时段与假日页均HTTP200；提取原文保存在docs/sources/oanda-sg-*-20260929.txt，含来源及原始HTML摘要。此前403的记录保留为历史。

常规表明确XAU/USD纽约18:05–16:59，外汇（TRY除外）17:05–16:59，并说明每日16:59–17:05六分钟暂停。假日页列出2026年4月3日金属关闭、5月25日14:29提前收市（黄金18:05重开）、6月19日及7月3日12:59收市、9月7日14:29收市。公告时区、分钟端点如何对应M1及Practice观测冲突需要在配置应用前继续核对；尚未据此修改业务日历。

## 本次能确认到哪里

**已成功获取 OANDA 官方帮助页和 API 文档，但未取得列明精确开闭市分钟的主站表格或 2026 年具体假日公告。** 直接联网返回 `Network is unreachable`；随后通过用户授权代理获取资料。主站 US/SG/UK hours-of-operation 页均返回 Cloudflare 403，`help.oanda.com` 根页返回 500，但下列具体帮助页返回 200。不能把 HTTP 200 的登录页误当成已获取公告。

成功获取日期：2026-09-29（新加坡会话日期；部分服务端响应时间仍为 2026-09-28 UTC）。页面未见明确公告发布日期，不能据页脚 © 2026 认定内容就是 2026 年假日公告。

### 已获取的一手资料

- [OANDA Asia Pacific — Hours of operation](https://help.oanda.com/sg/en/faqs/hours-of-operation.htm)：页面明确适用于 OANDA Asia Pacific；页脚实体为 **OANDA Asia Pacific Pte Ltd**。原文："The trading hours are subject to change during daylight saving time and certain public holidays." 同时指出："We do not guarantee to quote all instruments during our hours of operation." 该页把具体时段链接至 SG 主站；本次主站返回 403。因此这两段证实需要考虑夏令时/假日和报价例外，不能证明 17:05 或 18:05。
- [OANDA Corporation — Hours of operation](https://help.oanda.com/us/en/faqs/hours-of-operation.htm)：明确适用于 **OANDA Corporation**，包含同样的假日/夏令时及不保证所有品种报价说明；产品导航为 Forex、Cryptocurrencies。不可拿该美国页作为 XAU_USD 时段的证据。
- [OANDA Europe Limited — Hours of operation](https://help.oanda.com/uk/en/faqs/hours-of-operation.htm)：明确适用于 **OANDA Europe Limited**；同样列出假日/夏令时及报价例外。没有在本次取回文本中找到具体 17:05/18:05 时刻。
- [REST v20 Introduction](https://developer.oanda.com/rest-live-v20/introduction/)：原文说明 v20 trading account "is available to all divisions except OANDA Global Markets and OANDA TMS BROKERS S.A." 因此不能用 Global Markets 的公开时段无条件推断 REST v20 Practice。该介绍文档不提供 2026 假日表。
- 尝试 `https://help.oanda.com/sg/en/faqs/holiday-trading-hours.htm` 返回 HTTP 200，但内容是 **Secure Login**，不是可核验的假日日程。本研究未登录。

| 问题 | 本次证据结论 | 是否可以据此直接启用 |
| --- | --- | --- |
| EUR_USD 周日是否于纽约 17:05 恢复 | 未取得适用实体官方原文；17:05 待确认 | 否 |
| EUR_USD 工作日是否存在 17:00–17:05 暂停 | 未核实；不得由周日 17:05 推导每天均有五分钟维护 | 否 |
| XAU_USD 周日是否于纽约 18:05 恢复 | 未取得适用实体、产品和平台官方原文；18:05 待确认 | 否 |
| XAU_USD 每日是否于纽约 18:05 恢复 | 未核实；必须分别核对暂停起点、恢复点、适用星期与周五收盘 | 否 |
| 2026 年节假日提前收盘/延迟开盘 | 无可验证的日期准确公告 | 否 |
| 同一时段是否适用于 Practice 与 live | 未取得同实体、同产品、同平台的一致性声明 | 否 |

`api-fxpractice.oanda.com` 这一主机名本身不应当被当成法律实体、产品可用性或节假日安排的证明。必须确认实际 Practice 账户所属实体、平台/账户类型，以及 `XAU_USD` 对该账户是否适用。不能把美国站、英国站、新加坡站或其他地区站的时段无条件互换；也不能用 CME/COMEX 黄金期货日历替代 OANDA 的现货金属/CFD 安排。

## 官方待核验入口与取证方法

以下主站 URL 返回 403，因此仍只是待人工查看的入口。支持门户的具体可读页面见上文；开发者文档已成功读取，但不包含交易日历。

| 候选入口 | 计划核对的证据 | 适用范围须记录 |
| --- | --- | --- |
| https://www.oanda.com/us-en/trading/hours-of-operation/ | 常规交易时间、节假日调整链接 | 美国站对应法律实体；不可直接证明 XAU_USD 的安排 |
| https://www.oanda.com/sg-en/trading/hours-of-operation/ | 新加坡站常规时段及节假日公告入口 | 页脚实体、账户产品和平台 |
| https://www.oanda.com/uk-en/trading/hours-of-operation/ | 英国站常规时段及节假日公告入口 | 页脚实体、账户产品和平台 |
| https://help.oanda.com/sg/en/faqs/hours-of-operation.htm | 按实体/产品选择支持门户，查 Trading hours、Holiday trading hours、Market hours | 不采用错误地区或错误平台页面 |
| https://developer.oanda.com/rest-live-v20/introduction/ | 官方 REST v20 环境及 Practice 说明 | 环境说明不能替代某账户的交易日历 |

获取日期准确公告的步骤：

1. 从实际账户所属实体的 OANDA 官网进入支持或交易时段页面，确认页脚法律实体和平台，而不是只按搜索结果标题判断。
2. 找到包含 **2026 年具体日期**、商品行和时区说明的 holiday trading hours 公告。区分整日关闭、提前收盘、延迟开盘和恢复正常交易；特别检查跨日时段及纽约、伦敦、服务器时间的差异。
3. EUR_USD 应匹配外汇产品行；XAU_USD 应匹配该实体的黄金/贵金属现货或 CFD 产品行。不要因“美国假日”“黄金”字样就认为适用。
4. 保存公告原文或 PDF、原始 URL、公告发布时间、获取时间、法律实体、产品/平台、公告所写时区与具体日期。动态更新的“下一个假日”网页不足以证明已被覆盖的历史假日。
5. 若公开网页已替换历史 2026 公告，向用户索取当时的官方邮件、PDF 或支持回复作为人工证据。本研究没有自行联系 OANDA 或发送消息。若只有网页存档，应注明这是官方原文的第三方存档，以及存档时间和缺失附件等限制。
6. 官方资料仍不能判定 Practice 适用性时，保留待确认状态；没有成交报价并不自动证明“官方休市”，单个可见报价也不能单独证明全时段可交易。

## 时区实现中可以独立确定的部分

采用 IANA 时区 `America/New_York` 解析纽约当地时间，不把 EST 全年固定为 UTC−5，也不把 ET 一律解释为夏令时。按该时区现行规则，2026 年夏令时于 3 月 8 日开始、11 月 1 日结束；这是时区换算规则，**不是 OANDA 对这两个周末开市分钟的承诺**。

待官方确认某个当地开市时间后，才可以换算：

| 待确认的纽约时间 | EDT（UTC−4）对应 UTC | EST（UTC−5）对应 UTC |
| --- | --- | --- |
| 17:05 | 当日 21:05Z | 当日 22:05Z |
| 18:05 | 当日 22:05Z | 当日 23:05Z |

这些换算关系可以用于实现和测试；表中开市时间本身仍不得当成已确认配置。节假日公告若使用其他时区，应从公告原始时区换算，不能先假定为纽约时间。

## 建议的人工闭市区间格式

将节假日例外存为明确的半开区间 `[start, end)`，每条只影响指定账户环境/实体/平台和品种。起点表示已关闭，终点表示该例外结束；例外结束不应强制宣布市场开市，仍应通过常规交易时段及数据健康检查。

下列是**字段模板，含占位符，不能直接部署**：

```yaml
schema_version: 1
closures:
  - id: "<stable-unique-id>"
    environment: "practice"
    legal_entity: "<actual-OANDA-legal-entity>"
    platform: "<actual-platform-or-account-type>"
    instruments: ["XAU_USD"]
    start: "<YYYY-MM-DDTHH:MM:SS+HH:MM>"
    end: "<YYYY-MM-DDTHH:MM:SS+HH:MM>"
    source_timezone: "<timezone-explicitly-stated-in-notice>"
    reason: "<holiday / early-close / delayed-open / maintenance>"
    source_url: "<official-notice-URL>"
    source_published_at: "<date-or-unknown>"
    source_retrieved_at: "<actual-fetch-timestamp>"
    evidence_path: "<saved-notice-file>"
    verification_status: "pending"
    verified_by: "<reviewer>"
    verified_at: "<timestamp>"
```

只加载已核实条目；拒绝没有时区偏移、结束不晚于开始、来源缺失或适用范围不明的条目。跨午夜和跨多个自然日的停市用一个连续区间表示；多个不连续暂停分别列出。FX 与黄金调整不同则分别列出，不设置未经证实的“全部品种假日关闭”。确认使用 UTC 存储后仍保留原公告时区，便于审计。

## 可直接启用与待确认清单

**本次新增研究没有提供任何可以可靠直接启用的 OANDA 2026 节假日闭市日期或精确常规开闭市分钟。** 可直接采用的是时区处理方式、来源记录要求和明确区间的数据格式；这些不是实际交易时段数据。

待确认参数至少包括：EUR_USD 周日恢复分钟、周五收盘分钟、是否存在工作日维护；XAU_USD 周日恢复、每日暂停起止、适用星期、周五收盘；所属实体及 Practice 适用性；每一份 2026 假日公告中的具体日期和调整。不能因为尚无公告就把美国法定假日、交易所休市日或公历节日自动写成 OANDA 闭市。
