# OANDA SG／v20 Practice 会话证据与有限运行配置建议

研究日期：2026-10-11。范围为 EUR_USD、XAU_USD 的**当前状态和 worker 调度**，不是历史覆盖认证。本研究仅访问无鉴权的官方网页、阅读仓库实现与既有官方快照；未读取凭据、查询生产账户、创建实例或修改实现。

## 可确认的时段

OANDA 新加坡官方常规时段表写明：

| 产品 | 官方纽约当地时间 | 周末 | 工作日暂停 |
| --- | --- | --- | --- |
| 外汇（TRY pairs 除外；EUR/USD 属此组） | `Sun-Fri: 17:05 - 16:59` | 周五 16:59 收市，周日 17:05 复市 | 16:59–17:05 六分钟暂停 |
| 黄金 XAU/USD | `Sun-Fri: 18:05 - 16:59` | 周五 16:59 收市，周日 18:05 复市 | 16:59–18:05 暂停 |

来源：[OANDA SG — Hours of operation](https://www.oanda.com/sg-en/trading/hours-of-operation/)，本次约 2026-10-11 04:06Z 经已授权生产代理取得公开页面 HTTP 200，原文与既有 [2026-09-29 小时表](../sources/oanda-sg-hours-of-operation-20260929.txt)一致。表内原文为 `All FX products (except TRY Pairs)`、`New York`、`Sun-Fri: 17:05 - 16:59*`，脚注明确周日和周五的端点。黄金行原文为 `XAU/USD`、`New York`、`Sun-Fri: 18:05 - 16:59`。页面另写 `All instruments will be closed from 16:59 - 17:05 (New York time) daily`；这段全品种暂停不能缩短黄金自己的更长暂停，也不能推广成 TRY 或其他产品的完整时段。本研究仅阅读已取回的公开 HTML，未接触代理凭据。

本次在 `2026-10-11T04:06:54.186606Z` 重新取得 [OANDA Asia Pacific 官方支持页](https://help.oanda.com/sg/en/faqs/hours-of-operation.htm)，HTTP 200，页脚实体为 **OANDA Asia Pacific Pte Ltd**。原文：

> The trading hours are subject to change during daylight saving time and certain public holidays.
>
> We do not guarantee to quote all instruments during our hours of operation.

因此 `scheduled_open` 只表示已审核的计划时段；不证明当时一定有报价、账户可以交易、M1 已确认或告警依赖已完整。官方页明确地区/实体适用范围，不可将 SG 表通用于其他 OANDA 实体。

## 2026-10-11 周末的 UTC 与 M1 边界

换算使用 IANA `America/New_York`。下表由本机 Python `zoneinfo` 实际计算；2026-10-09 和 10-11 为 UTC−4：

| 事件 | 纽约当地时间 | UTC |
| --- | --- | --- |
| 两品种公布的周五收市 | 2026-10-09 16:59 | 2026-10-09 20:59Z |
| 保守闭市内区间起点 | 2026-10-09 17:00 | 2026-10-09 21:00Z |
| EUR/USD 复市前边界分钟 | 2026-10-11 17:04 | 2026-10-11 21:04Z |
| EUR/USD 公布的复市 | 2026-10-11 17:05 | 2026-10-11 21:05Z |
| XAU/USD 复市前边界分钟 | 2026-10-11 18:04 | 2026-10-11 22:04Z |
| XAU/USD 公布的复市 | 2026-10-11 18:05 | 2026-10-11 22:05Z |

按现有 [会话实现](../../backend/alerts/live_session.py) 和 [会话测试](../../backend/tests/test_live_session.py)，保留公布收市所在分钟与复市前一分钟为 `unknown`，只把完整内部分钟标成 `closed`。此次周末建议的半开闭市内部为：

- EUR_USD：`[2026-10-09T21:00Z, 2026-10-11T21:04Z)`。
- XAU_USD：`[2026-10-09T21:00Z, 2026-10-11T22:04Z)`。

若有限审核窗口覆盖这些时刻，两个品种在周日 04:00Z 均为 `closed`。EUR 在 21:04Z、黄金在 22:04Z 为 `unknown`；下一分钟才进入 `scheduled_open`。现实现的 `next_session_at` 是**已证实闭市区间的结束边界**，会返回 21:04Z／22:04Z，不应把它展示为保证可交易的官方开市瞬间；worker 应在边界恢复探测。

根因证据中的 `confirmed_end=1791579600000` 是 2026-10-09 21:00Z 的**结束边界**。它本身不能证明交易发生在纽约 17:00 后。现有 [OANDA candle adapter](../../backend/alerts/oanda_stream.py) 保存供应商 candle 的开始时间；一根 `[20:59Z, 21:00Z)` 的已确认 M1 可以在此时结束。报价证据的 `quote_source_time` 约为 20:59:05Z，亦应与收市边界分别理解。若实际查到 `MinuteRow.timestamp=21:00Z` 的柱，应保留该观测并独立核验，不能用本研究删柱或重算既有覆盖。

## 可供审核的周分钟区间

`WeeklyClosure` 使用纽约本地星期一 00:00 为 0、星期日为第 6 日；不是 UTC 周分钟。下列区间与现有 [生成器](../../scripts/oanda_live_sessions.py) 的保守规则一致：

| 品种 | 周一内部 | 周二内部 | 周三内部 | 周四内部 | 周五至周日内部 |
| --- | --- | --- | --- | --- | --- |
| EUR_USD | `[1020,1024)` | `[2460,2464)` | `[3900,3904)` | `[5340,5344)` | `[6780,9664)` |
| XAU_USD | `[1020,1084)` | `[2460,2524)` | `[3900,3964)` | `[5340,5404)` | `[6780,9724)` |

DST 由 IANA 时区在执行时解析。按当前时区规则，2026-11-01 周日纽约 17:05 对应 22:05Z，18:05 对应 23:05Z；不能把全年纽约时刻固定为 UTC−4。上述换算不是 11 月具体假日安排的认证；本次有限 profile 不应覆盖到 11 月。

## 当前取证与适用性边界

本次新鲜 HTTP 200 的支持页确认 SG 实体、DST／假日例外及报价不保证。主站 hours／holiday 本机直连失败，但主任务随后经已授权既有代理重新取得**两份精确时段和假日页面 HTTP 200**。已检查响应正文及 SG 实体页脚，小时表没有变化；不是将网络错误页或登录页当作公告。官方 v20 introduction／development-guide 直连仍超时，未将其核实日期推进。

| 材料 | 一手来源与当前证据 |
| --- | --- |
| 新鲜 SG 支持页 | https://help.oanda.com/sg/en/faqs/hours-of-operation.htm；HTTP 200；抓取 2026-10-11 04:06:54Z；原 HTML SHA256 `f68b52ee83bc9f1d43394c5c513b1efbabd0220151b1e38b53193fc084774ae1` |
| 新鲜 SG 精确小时表 | https://www.oanda.com/sg-en/trading/hours-of-operation/；HTTP 200；抓取约 2026-10-11 04:06Z；461666 字节；原 HTML SHA256 `efa5ac5093ca6309fab619a3cf4390d7b3ad0450f0f9b4dbbbbbd267bbbbaf93` |
| 新鲜 SG 假日公告 | https://www.oanda.com/sg-en/trading/holiday-trading-hours/；HTTP 200；抓取约 2026-10-11 04:06Z；216740 字节；原 HTML SHA256 `f9162f1a28514e46c1ebb3fb8ce4c7f7bd6f6ddb7a795de3a49024a29b84a92c` |
| 已存 SG 精确小时表 | https://www.oanda.com/sg-en/trading/hours-of-operation/；抓取 2026-09-29；记录的原 HTML SHA256 `122d302314e77274601fe1bad6e7a6baae93be0c42aa7745ecc9d874737dd347`；正文文件 SHA256 `13b090d5d843b2a31121cf1759e6d4ef18f2bb76e41ceb9c69387437ad346630` |
| 已存 SG 假日公告 | https://www.oanda.com/sg-en/trading/holiday-trading-hours/；抓取 2026-09-29；记录的原 HTML SHA256 `99e35583b10663cce04f54812b99470742f42a6a12ee9df182e536e962655c7e`；[正文](../sources/oanda-sg-holiday-trading-hours-20260929.txt) SHA256 `64a2271421272133dd1897f124961c9c5b6970e298cc96854c833c9d6ea006a8` |
| v20 可用实体边界 | [官方 introduction](https://developer.oanda.com/rest-live-v20/introduction/)；既有[研究记录](../oanda-calendar-sources.md)引用 `available to all divisions except OANDA Global Markets and OANDA TMS BROKERS S.A.`；本轮未重新取得，不视为新鲜确认 |
| Practice 环境入口 | [官方 development guide](https://developer.oanda.com/rest-live-v20/development-guide/)；本轮连接超时；环境域名不能证明账户法律实体或 Practice 的时段完全等同 live |

尝试支持门户的 demo-account 候选 URL 虽返回 HTTP 200，但重定向 `https://help.oanda.com/secure/sg/alert?type=PageNotFound`；该响应已排除，没有把错误页当作 Practice 适用性证据。

既有[账户时段研究](../oanda-calendar-sources.md)记载用户已确认账户为 OANDA 新加坡，这是目前 SG 适用性的用户证据；本研究没有重新验证账户。上线前应使用已配置账户的**同一不透明指纹**与 EUR_USD／XAU_USD 账户目录映射核对。目录中的可用品种可以证明该账户产品映射，不能单独证明每分钟开闭市；Practice 域名和单次 `tradeable=false` 都不能证明整段闭市。

尚未取得官方公开文字保证“当前实际 SG v20 Practice 账户在所有日期采用上述 live 小时表”。本次运行审核可以依赖用户已给出的 SG 账户声明加新鲜官方 SG 常规时段，严格限定为该实际账户的**计划**状态与调度依据；把这一判断写进 `applicability`，同时保留定期复核、运行观测与确认 M1 保护。无需重新询问已经确认的 SG 实体，但不能将有限运行判断描述为 API 返回了账户的完整交易日历。尤其不要把美国 OANDA Corporation、英国 OANDA Europe 或 COMEX/CME 的时段替换进来。

新鲜 SG 假日公告原文为 `Below, you will find the changes in trading hours for upcoming holidays. Note that all times are in Eastern Time.`，2026 年 10 月列出的调整只有：

- `Friday, 30 Oct 2026 – All Saint Day (SE)`：`SE Share CFDs: Early close at 06:54`。
- `Monday, 19 Oct 2026 – Chung Yeung Festival (HK)`：`CHINAH, HK33: Closed and reopening 21:16`。
- `Thursday, 1 Oct 2026 – National Day (HK, CN)`：`CHINAH, HK33: Closed and reopening 21:16`。

来源：[OANDA Asia Pacific — Holiday trading hours](https://www.oanda.com/sg-en/trading/holiday-trading-hours/)，本次新鲜 HTML 与既有快照在这些条目上相同。此表在当前 10 月 11–17 日窗口没有列出 EUR_USD／XAU_USD 例外，可以与新鲜常规表共同支持该短窗口的正常计划规则；不能据此声称未来数月无例外、某分钟必有报价，或将其他品种例外写成这两个品种的关闭。没有证据支持为 10 月 12 日自动加入美国法定假日整日关闭。

## 建议的有限 profile 与生效条件

只使用现有 `ALERTS_OANDA_LIVE_SESSION_PROFILES` **运行配置**；不修改历史 `MarketDataset` 身份、固定 composite 修订、拼接点、历史 `calendar_profile` 或覆盖凭据。

**推荐的七天有限运行方案**：两个品种统一采用 `reviewed_start=2026-10-11T00:00:00Z`、`reviewed_end=2026-10-18T00:00:00Z`。本轮已重新取得 SG 精确小时表和假日公告，用户已确认 SG 账户；结合实际账户指纹及目录产品映射，以上证据足以审核这七天的常规计划状态和暂停调度。窗口符合生成器最多七天限制。`closures=[]` 表示当前窗口没有匹配的已发布例外加入配置，不表示证明所有分钟的报价／假日覆盖完整。

**证据冲突时的降级方案**：如果实际账户产品或 Practice 运行观测与上述计划冲突，先缩短审核范围／保留 `unknown` 并调查，不覆盖观测。若发布时只能确认当前周末闭市，可分别将 EUR_USD 到期设为 `2026-10-11T21:04:00Z`、XAU_USD 设为 `2026-10-11T22:04:00Z`；到期恢复探测。不得为方便 worker 同时唤醒而使用一个品种的复市时间代替另一个。

每个 profile 必须精确绑定：

- `source=oanda`、`channel=v20`、`environment=practice`。
- `provider_symbol=EUR_USD` 或 `XAU_USD`，不可用图表逻辑代码代替。
- `account_scope=sha256:<当前已配置账户的64位十六进制摘要>`；不用 `public`，不记录明文账户 ID。
- `timezone=America/New_York`，上述有时区的有限 `reviewed_start`／`reviewed_end`。
- `evidence_url=https://www.oanda.com/sg-en/trading/hours-of-operation/`，新的运行配置 `revision`；`applicability` 明示 SG／实际账户／Practice 审核依据、仅状态与调度、边界分钟未知、不证明历史覆盖和报价。
- `closures=[]`，除非另外取得同一实际身份、日期准确的官方例外；不要将以前年度/其他品种的例外照抄到本次短窗口。

审核窗到期、身份不匹配或新资料冲突时，保持 `unknown`。这会要求维护者再次核对；不能为了消除 `m1_late` 无期限延长、关闭 TLS 校验或伪造确认 M1。

## 验收依据

Ubuntu 隔离验收至少核对：当前周末闭市内部、两种不同的复市边界、下一分钟 `scheduled_open`（仅使用获准覆盖复市的 profile）、审核窗到期、错误账户／实体／环境／品种不匹配、DST 后的换算，以及原始 M1 与 immutable 历史身份未改变。现有 `test_live_session.py` 已提供边界、expiry、DST 和跨周区间示例，真实部署配置还需逐字段核对。

生产闭市验收只能确认当前状态及调度按身份正确闭市，不能宣布未来开市数据链路已通过。到了获核实的开市时段，还需独立证明可交易报价、确认 M1、完整接续与告警恢复；心跳在线不是这些条件的替代品。
