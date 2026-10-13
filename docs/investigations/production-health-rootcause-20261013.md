# v1.25.0 告警覆盖与来源时段文案根因

调查日期：2026-10-13（Asia/Singapore）。源码与生产基线：
`v1.25.0` / `027aa7095a34972d8a644a89a16ad79d4b6297df`。
本轮只读检查 Unraid 现有生产实例；反事实聚合及前端最小复现在 Ubuntu 本机运行。
未修改应用实现、生产数据或生产配置。此次完成诊断，原始失败仍存在。

## 告警 stale：上游缺柱与时段证据读取路径不同

活动告警的 D1 判定桶为 **2026-10-11 21:00 UTC 至 2026-10-12 21:00 UTC**。
整个桶位于组合拼接点之后，使用 OANDA v20 / Practice / EUR_USD / bid 接续来源。
当前聚合结果：观测 1425 分钟、未知 15 分钟、确定闭市 0 分钟。
`time_closed=true`、`source_confirmed=true`、`coverage_complete=false`。

生产现有 API 容器真实请求 OANDA Practice candles（M1、price=B、smooth=false），
HTTP 200；原始响应与 adapter 输出均为 1425 根，缺失时间与数据库的 15 个缺口完全一致。
没有 incomplete 柱，也没有完整柱被 adapter 过滤。SourceMinute 与当前
CompositeMinuteInput 的时间集合相同；这 15 个时间在两者及目标 M1 Bar 中都不存在。
因此本次缺口不能归因于本地解析过滤、采集漏写或组合漏传。

| 缺口（UTC，均为 2026-10-11；区间右端不包含） | 分钟数 |
| --- | ---: |
| 21:00—21:04 | 4 |
| 21:25 | 1 |
| 21:42 | 1 |
| 21:44 | 1 |
| 21:48—21:52 | 4 |
| 21:53 | 1 |
| 21:55—21:57 | 2 |
| 23:03 | 1 |

另一个确定的问题是时段证据的使用范围不同：

- 实时状态的 `live_session.effective_profile` 应用已核实的 OANDA 会话配置。
- `composite_series.read_window` 的 target profile 直接读取
  `Instrument.calendar_profile`，该目标当前为 `{}`；其身份仍为 `ny17-candidate-v1`。
- 聚合 `_closed` 因而没有使用实时状态已采用的闭市证据。

Ubuntu 使用生产同版镜像、捕获的同一组 1425 条输入，**仅改变 target profile**：

| profile | 观测 | 未知 | 确定闭市 | 覆盖完整 | 时段冲突 |
| --- | ---: | ---: | ---: | --- | ---: |
| 存储的空 profile | 1425 | 15 | 0 | false | 0 |
| 实时状态的有效 profile | 1425 | 11 | 4 | false | 0 |

有效证据只能解释 21:00—21:04 UTC 的 4 分钟，另外 11 分钟仍没有观测。
真实响应缺柱已确认，但供应商为何不返回另外 11 根，现有证据不能确定。
请求批次成功且有数据也不等于每个目标分钟均有柱；这些分钟已有多次成功查询尝试。

用户追问 REST 与实时流的区别后，再次只读查询生产同一判定桶，仍是来源与组合各
1425 根、缺口 15 分钟；扣除上述 4 分钟闭市后，11 个缺口在组合确认 M1 中全部不存在。
这 11 分钟的本地 `LiveMinute.quote_count` 也全部为 0，说明没有已记录的流报价；
不能据此断言供应商当时没有发送报价，也不能区分未发送、未订阅或未接收等原因。
流报价用于当前未确认的 `forming` 柱；正式组合确认分钟由 REST 确认路径
`live_pricing.commit_confirmation` 中的 `record` / `apply_minutes` 写入，流报价不会自动
升格为过去的完整确认柱。当前接续 `receiving` 与旧日线缺口可以同时存在。

`composite_alerts.py:291` 要求收盘判定桶同时满足时间结束、来源确认和完整覆盖。
本次失败的是完整覆盖门槛，保持 stale 符合当前安全规则。
修复证据读取不一致只能将未知从 15 降到 11，不能保证告警 ready。
后续需对剩余缺口取得真实补回的观测或适用的独立闭市证据；不能填造价格或把缺柱直接当作闭市。
证据接入还应遵守 [ADR 0002](../adr/0002-session-evidence-and-aggregation-phase.md)，
明确身份、日期适用范围及版本，不改写既有候选发布身份和回放含义。

## 来源时段文案：前后端状态名称不一致

生产 `/api/market-data/live/status` 已返回
`market_session=scheduled_open`、`calendar_verified=true`。
但 `web/src/market-data/LiveProviderStatus.tsx:36` 仅识别 `open`，
因此真实的 `scheduled_open` 进入默认分支“时段尚未核实”。
后端 `live_session.py:46` 返回 `scheduled_open`，不是 `open`。
首次引入该页面的提交 `0716ff8` 已有同样判断，因此不是本次发布新引入或浏览器缓存造成。

在 Ubuntu 提取实际 Session 函数并使用捕获的真实接口状态渲染：

```text
node /tmp/mw-production-health-rootcause-20261013/repro-session.cjs
input: scheduled_open, calendar_verified=true
html: <span class="dc-source-session">时段尚未核实</span>
exit 1: AssertionError: Confirmed scheduled_open is displayed as unverified

node /tmp/mw-production-health-rootcause-20261013/repro-session.cjs open
html: <span class="dc-source-session">已核实交易时段</span>
exit 0
```

重复运行结果一致；只改变状态名称即改变输出。
修复方向是按后端契约识别 `scheduled_open`，保留 `closed` 与 `unknown` 的不同语义。

## 纠正此前组合 waiting 的报告

此前报告使用了旧兼容 `Instrument.quality=waiting`，不能据此判断组合接续健康。
普通采集器已排除组合；该兼容字段不代表独立组合运行状态。
当前组合管理接口实际返回 `receiving` / `connected`，报价与确认尾部均就绪，
准备状态为 `queried`；未就绪的是告警依赖，策略状态为 `pending_dependency_validation`。
旧错误修复路径 `market.clear_misrouted_composite_errors` 会把兼容 quality 设为 waiting。

## 净化后的证据

- [真实供源结果与缺口](../verification/production-health-rootcause-20261013/upstream-probe.json)
- [仅改变 profile 的聚合对照](../verification/production-health-rootcause-20261013/counterfactual.json)
- [时段与组合状态摘要](../verification/production-health-rootcause-20261013/status-summary.json)
- [同账户原生 D1 与组合 OHLC 核对](../verification/production-health-rootcause-20261013/native-d1-account-probe.json)

完整输入与只读诊断脚本留在本机私有目录
`/tmp/mw-production-health-rootcause-20261013`；账户范围、凭据及完整价格输入不写入报告证据。
前端复现没有启动服务；聚合对照容器在 Ubuntu 运行，使用 `--network none --rm`，已退出移除。

## 用户追问后的补充：稀疏分钟不等于日线价格失效

11 个缺口中，10 个位于计划开市边界后 21—52 分钟，另一个位于 119 分钟后。
低流动性导致自然无柱是合理假设，尚不能从缺柱与本地 quote_count=0 单独确认。
代码还将来源断线、报价过期、日线覆盖不足共同归入告警 health=`stale`；
此次触发的是日线覆盖门槛，不能据此说当前接收的报价已过期。

进一步使用与生产确认 worker 相同的 **account-scoped candles endpoint**，
只读请求同一桶的 D1、`price=B`、`smooth=false`、`dailyAlignment=17`、
`alignmentTimezone=America/New_York`。HTTP 200，返回一根 `complete=true` 的 D1：

| 值 | 来源 D1 | 组合 1425 根 M1 聚合 |
| --- | --- | --- |
| open | 1.11850 | 1.11850 |
| high | 1.12167 | 1.12167 |
| low | 1.11521 | 1.11521 |
| close | 1.11549 | 1.11549 |

四值按 Decimal 比较完全一致。这提供了本桶高周期 OHLC 的独立来源确认，
不提供缺失分钟的价格、分钟内路径或成交量完整性证明。
早先试探的非账户 endpoint 价格不同，不用作组合认证证据。

因此，当前按逐分钟覆盖拒绝判定符合已有实现，但对只依赖该已确认 D1 OHLC 的规则
是过于严格的策略。合理调整方向是分别记录当前报价新鲜度、M1 稀疏覆盖及高周期价格确认；
同身份、同口径、同边界的来源高周期确认且 OHLC 一致时，可为对应 OHLC 依赖提供替代证据。
仍需逐项验证指标实际依赖的其他桶，不全局绕过覆盖检查、不补造 M1、不把 unknown 改成 closed。
这属于待实现的规则变更，本轮没有修改规则、重置告警或发布生产。
