# 新浪、腾讯行情：只使用上游原生周期的可行性

日期：2026-11-12。项目基线 `c711132f`，研究工作树 `/home/quant/repos/market-watch-akshare-periods-20261112`。本次仅分析、取样和文档，不修改业务服务、不部署、不更新业务 PR。

## 用户确认的范围

- 新浪、腾讯沪深 A 股：M1/M5/M15/M30/H1/D1/W1/MN。
- 新浪国内期货：M1/M5/M15/M30/H1/D1/W1/MN，维持当前主力连续目录。
- 新浪、腾讯港股：只需 D1/W1/MN，不接港股分钟。
- **每个周期必须由所选供应商服务端直接返回对应 OHLC。** Market Watch 可以解析、缓存、保存、去重、分页，但不从 M1 或 D1 计算其他周期；在 API、worker、浏览器或官方 JS 内本地重采样都不符合本次要求。
- 供应商内部如何生成周月线不在项目控制范围；判断依据是 HTTP 响应实际已包含该周期，而不是网页菜单有没有周/月按钮。各周期保留独立来源、复权口径及原始时间标签。

## 当前结论

| 市场 / 上游 | 用户要求 | 已验证的服务端直接响应 | 尚未找到可用接口 | 结论 |
|---|---|---|---|---|
| 新浪 A 股 | 八周期 | 全部八周期 | 无（本轮样本范围） | 原生接入可行 |
| 腾讯 A 股 | 八周期 | 全部八周期 | 无（本轮样本范围） | 原生接入可行 |
| 腾讯港股 | D1/W1/MN | 三周期，raw/qfq 均成功 | 无（本轮样本范围） | 原生接入可行 |
| 新浪港股 | D1/W1/MN | D1 | W1/MN | 目前只能承诺 D1；网页周月由日线在浏览器生成 |
| 新浪国内期货 | 八周期 | 五档分钟 + D1 | W1/MN | 目前只能承诺六周期；网页周月由日线在浏览器生成 |

这是实际接口可行性，不表示业务代码已经实现。特别是 AKShare 1.19.3 没有这些全部周期的统一封装：新增薄适配器直连新浪、腾讯原站属于同一上游新增路径，不能称为 SDK 已有现成全周期能力。

## 更正第一轮结论

第一轮探测脚本 `qq()` 用 `period.startswith('m')` 判断分钟，导致 `month` 被误送到 `mkline`，构造了分钟格式参数；连指定其他 URL 的月线复测也带了错误参数。因此此前“腾讯原生月线未验证成功”没有成立的实验依据。已将旧脚本修为显式分钟枚举，并保留原始失败证据作为当时的错误请求记录。

修正路由后：腾讯 A 股 `month` 直接取得 `month/qfqmonth`；腾讯港股 `month` 直接取得 `month/qfqmonth`。港股 raw 与复权还必须分路由：raw 用 `kline/kline`，qfq 用 `hkfqkline/get`。旧报告用 raw 请求复权路由得出的失败，不能用来推断港股 raw 能力或 800 条是否超限。

本轮没有以本地聚合补缺周期。上一轮“可由 D1 聚合补齐”的建议已被用户明确排除，不作为接入方案。

## 新浪 A 股：八周期可以直接读取

成功端点：

```text
https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData
symbol=sh600519 或 sz000001
scale=1/5/15/30/60/240/1200/7200
ma=no
datalen=80
```

| 项目周期 | 原站参数 scale | 实际返回标签 |
|---|---|---|
| M1/M5/M15/M30/H1 | 1/5/15/30/60 | 来源本地日期和时间 |
| D1 | 240 | 每个交易日日期 |
| W1 | 1200 | 每周末个已观测交易日，当前周为最新交易日 |
| MN | 7200 | 每月末个已观测交易日，当前月为最新交易日 |

对两只沪深股票全部八周期分别请求，每次返回 80 条有序、无重复、OHLC 合法且正价的序列。W1 80 条范围为 2025-04-30 至 2026-11-12，MN 为 2020-04-30 至 2026-11-12。例如 sh600519 月线最后两个标签为 2026-10-30 / 2026-11-12，响应本身已给出每月 OHLC，并非下载 D1 后在项目重算。

该成功端点未证明 qfq 分钟/周月，已实测的是默认价格口径。现有平台默认“新浪前复权”不能无说明地复用原始响应；实施时应明确 raw 身份，或另验同源上游前复权周期响应。不要调用 AKShare 的本地日线比例变换后宣称为上游直接前复权。

证据：[sina_a.jsonl](evidence/akshare-native-periods-20261112/sina_a.jsonl)。这里的 `240/1200/7200` 是本端点的股票周期参数，不能推广到期货。

## 腾讯 A 股及港股：所需周期均可直接读取

腾讯原站以不同路由区分分钟与日周月，不能拿分钟 URL 或参数请求 `month`。

| 市场 / 口径 | 实测成功路由 | 参数与响应 |
|---|---|---|
| A 股分钟 raw | `https://ifzq.gtimg.cn/appstock/app/kline/mkline` | `param=sz000001,m15,,80`；`data.sz000001.m15` |
| A 股日周月 raw/qfq | `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get` | `param=sz000001,month,,,80,qfq`；`qfqmonth` |
| 港股日周月 raw | `https://web.ifzq.gtimg.cn/appstock/app/kline/kline` | `param=hk00700,month,,,80,`；`month` |
| 港股日周月 qfq | `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get` | `param=hk00700,month,,,80,qfq`；`qfqmonth` |

A 股分钟参数为 `m1/m5/m15/m30/m60`，日周月为 `day/week/month`。响应 OHLC 数组的顺序是日期、开、收、高、低、量，不能按日期、开、高、低、收、量读。分钟日期格式为 `YYYYMMDDHHmm`，日周月为 `YYYY-MM-DD`。

代表样本：

- A 股 `sz000001 / sh600519`：八周期 raw，以及日/周/月 qfq，各 80 条，全部有序、唯一、OHLC 合法且正价。
- 港股 `hk00700 / hk02318`：日/周/月 raw 与 qfq，各 80 条，全部有序、唯一、OHLC 合法且正价。
- 每个周期都是独立请求且响应直接返回该周期；没有用日线替代周月线。
- 更深历史要另行验证起止日期和 count 边界。本轮 80 条不是供应商容量上限；此前分钟 800 条成功样本仍有效，但不能据此承诺任意多年 M1。

上一轮已验证腾讯分钟属于 raw：170 个有区分度交易日的 H1 日末价全部匹配 raw D1，不匹配 qfq D1。因此“八周期原生都能取”不等于“八周期原生前复权都已验证”。当前请求允许原生周期读取，但价格口径必须显示真实状态，不能为统一标签在本地自动复权或切换来源。

腾讯第一手港股图表脚本的 `getKlineUrl` 也使用上述港股 raw/qfq 两种路由，参数中直接传 `day/week/month`。源码链接：[zxgweb-chart-9fc1788a8403.js](https://st.gtimg.com/quotes/hk/zxgweb-chart-9fc1788a8403.js)。证据：[tencent.jsonl](evidence/akshare-native-periods-20261112/tencent.jsonl)、[源码摘录](evidence/akshare-native-periods-20261112/source-excerpts.json)。

## 新浪港股：网页周月不等于有独立响应

[新浪 00700 报价页](https://stock.finance.sina.com.cn/hkstock/quotes/00700.html) 调用：

```javascript
KKE.api('plugins.sinaTKChart.get', {
  symbol: 'rt_hk' + symbol,
  dom_id: 'h5symbol'
});
```

其 [chart/h5k.js](https://finance.sina.com.cn/sinafinancesdk/js/chart/h5k.js) 的 HK 配置为：

```text
HK.DAYK_URL = http://finance.sina.com.cn/stock/hkstock/$symbol/klc2_kl.js?d=$rn
HK.MINK_URL = ""
```

该图表模块读取并解码日线，然后执行 `n.mw(t,s,_,c,r.endDay)`，得到 `g=v[0]`、`k=v[1]`，输出 `{day,week,month}`；`n` 是 `kUtil`，`mw` 在浏览器按周/月累计 OHLC。这证明所查网页的周/月展示由客户端生成，不能将它作为上游原生周/月取数入口。

直接将港股代码 `hk00700/rt_hk00700/00700` 传给已成功的新浪 A 股原生周线端点，本轮均为 `null`；这只说明该股票路由不能直接套港股，不证明新浪所有未知接口不存在。没有找到官方引用且实际成功的港股 W1/MN 响应，按本次要求保留不可用，不本地补齐。

证据：[源码摘录](evidence/akshare-native-periods-20261112/source-excerpts.json)、[有限参数探测](evidence/akshare-native-periods-20261112/sina_hk_candidates.jsonl)。新浪港股 D1 的成功样本沿用第一轮 `stock_hk_daily('00700')`，本轮无需重复下载整段日线。

## 新浪国内期货：网页周月由浏览器计算

详见 [期货专项核验](akshare-futures-native-periods-20261112.md)。已核对 RB0 官方网页 → `plugins.sinaTKChart` → 图表数据模块 → `kUtil.mw` 的完整链路：

```text
getDailyKLine?symbol=RB0
  → 返回 D1 数组
  → 浏览器 kUtil.mw 按周/月计算
  → 网页展示周 K / 月 K
```

`getFewMinLine` 的 `type=1200/7200` 均返回 `null`；`type=240` 返回的是跨日 4 小时分桶（同日多条），不能套用新浪 A 股的 D1 参数。当前已证实的期货原生能力仍是 M1/M5/M15/M30/H1/D1，未找到成功的 W1/MN 服务端入口。

不能调用官方 JS 得到其聚合后的 `week/month` 对象，再称“上游原生直取”；那仍是在本机执行聚合，与用户要求冲突。

## 建议

1. **直接实施已证实部分时**：新浪、腾讯 A 股八周期，以及腾讯港股 D1/W1/MN，按选定周期分别请求原生响应。未新增本地聚合逻辑；各周期共享相同请求缓存但不混同原始序列。业务代码修改仍需用户后续要求，本轮不实施。
2. **新浪港股和国内期货保留已确认周期**：港股先 D1，期货先六周期。W1/MN 不以聚合或腾讯替代后挂新浪标签；如果要补齐，继续寻找经过实际响应验证的新浪服务端接口。
3. **如果需要港股原生日周月**：当前证据支持优先使用腾讯港股独立来源。新浪保留作日线核对，不自动合并双方数据。
4. **价格口径是单独验收项**：原生周期和原生前复权分开报告。raw 不冒充 qfq；D1/W1/MN qfq 请求返回的历史可能有负价，不能将上游合法的复权价格误当传输错误，或让当前正价校验静默丢行。本轮 80 条正价样本不是所有历史都符合正价约束的证明。补充的 320 条月线请求中，000001 / 00700 各有 89 / 109 条非正价格记录，见[深历史复权样本](evidence/akshare-native-periods-20261112/deep-qfq-month-observations.json)。
5. **刷新不增加固定空闲负载**：按当前查看/告警/维护需求请求对应周期，使用共享缓存与有界请求。后台不为了八周期全部可选而固定轮询八条链路。

上游都不是当前项目的账户授权行情 SLA。这里只记录接口可用性和有限样本，不推断全品种覆盖、长期稳定性或深历史完整。未来若选择其他期货周月来源，必须作为独立来源验证，不能静默拼入新浪。

## 本轮验证环境与范围

Ubuntu 本机，使用固定已安装依赖的 `market-watch-api:dev-watchlist-changes-r3-20261112` 镜像（image ID `sha256:3a9cfc3be9ddce668051c2baf296ee6c4876b9bf9b0b94f77358f1c602aee9f3`）运行无状态临时容器。独立 network/project 为 `mw-akshare-native-periods-20261112`，无数据库、无应用配置挂载，脚本只读挂载，12 秒请求超时，0.5 CPU / 768 MiB 限制。无需启动 Web 或登录，故没有新的应用验收地址；现有开发服务未被修改。

[新探测脚本](evidence/akshare-native-periods-20261112/probe.py) 与 [机器可读汇总](evidence/akshare-native-periods-20261112/summary.json)：53 个有限案例，50 个取得 OHLC（全部 80 条，时间有序无重复，OHLC 校验通过），3 个新浪港股套 A 股路由为空。期货另有 5 个已有路由样本，详见专项证据。脚本没有聚合函数或调用业务数据库。

HTTP 200 不作为行情成功标准；同时检查业务码、非空对应周期数组、字段映射、时间序列及 OHLC。没有用 mock 替代上游真实响应。

研究分类 **P0**。仅对脚本语法、证据 JSON、diff 做检查；没有业务代码变化，不需要构建镜像或部署开发实例。本轮只修改研究脚本和文档，不触发业务实现、合并、tag 或生产操作。
