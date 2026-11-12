# 新浪国内期货原生周 / 月周期核验

日期：2026-11-12。范围：用户澄清只接受上游已经返回的原生周期，不允许 Market Watch 本地聚合；新浪国内期货希望支持 M1 / M5 / M15 / M30 / H1 / D1 / W1 / MN。本轮只读查询公开网页、官方脚本及少量公开接口，不修改服务或业务代码，每次 HTTP timeout 12 秒。

## 结论

**新浪期货网页的周 K / 月 K 是浏览器读取日线后聚合出来的，没有独立请求原生周 / 月响应。** 已找到连续的第一手代码链路，不能把网页提供“周 K / 月 K”按钮作为服务端原生周期能力的证明。

本轮未发现可返回国内期货原生 W1 / MN 的服务端端点。有限探测也未成功，但这不是“所有未公开接口均不存在”的证明。按用户当前约束，不能将新浪国内期货标为八周期全部原生可用；已确认的分钟五档 + D1 与尚未证实的 W1 / MN 应分开报告。

## 第一手网页与代码链路

1. [新浪 RB0 报价页](https://finance.sina.com.cn/futures/quotes/RB0.shtml) 引用 `sf_sdk.js` 与 `moudler20200421.js`。[后者](https://n.sinaimg.cn/finance/futures/moudler20200421.js) 调用：

   ```javascript
   KKE.api('plugins.sinaTKChart.get', {
     symbol: 'nf_' + futures_app.code,
     dom_id: 'box-flash-wrap'
   });
   ```

2. [sf_sdk.js](https://finance.sina.com.cn/sinafinancesdk/js/sf_sdk.js) 的模块模板为 `https://finance.sina.com.cn/sinafinancesdk/js/$moduleName.js`，模块名中的 `.` 转为 `/`。[plugins/sinaTKChart.js](https://finance.sina.com.cn/sinafinancesdk/js/plugins/sinaTKChart.js) 对 `NF` 市场确实声明日 / 周 / 月菜单：`kd / kw / km`。这一层仅是 UI 场景，不是数据路由。

3. [datas/k.js](https://finance.sina.com.cn/sinafinancesdk/js/datas/k.js) 的 `NF` 配置只有以下 K 线数据路由：

   ```text
   DAYK_URL = http://stock2.finance.sina.com.cn/futures/api/jsonp.php/$cb/InnerFuturesNewService.getDailyKLine?symbol=$symbol&_=$rn
   MINK_URL = http://stock2.finance.sina.com.cn/futures/api/jsonp.php/$cb/InnerFuturesNewService.getFewMinLine?symbol=$symbol&type=$scale
   ```

   HTTPS 页面会用 `getSUrl` 将这些地址转为 HTTPS。`nf_RB0` 的实际上游 symbol 为 `RB0`。此配置没有周 / 月专用 URL 或周期参数。

4. 非分钟读取函数 `x(n,a)` 直接加载 `o.kUrl`（上面的 DAYK_URL），用日线 formatter 解析返回值，然后调用 `l(t,c,n)`。`l` 将日线 `t` 传给 `a.mw(t,i,v,c,r.endDay)`，其中 `a=e.kUtil`，并将三组结果返回为：

   ```javascript
   { day: d[0], week: d[1], month: d[2], ytd: d[3] || null }
   ```

5. `sf_sdk.js` 中 `kUtil.mw` 明确遍历日线数组，用 `H.gw` 判断同周、`H.gm` 判断同月，累计 OHLC / volume / amount，返回 `[l,u,c]`（周、月、年数组）。`high` 取最高、`low` 取最低、`close` 更新为末项、`volume` 累加。这是完整的浏览器聚合实现。

6. [chart/h5k.js](https://finance.sina.com.cn/sinafinancesdk/js/chart/h5k.js) 内嵌的数据模块也包含同一 `NF` 日线 / 分钟路由以及 `n.mw(...)` 的日线转周月调用，图表状态通过 `initDWMState` 装载各周期。由此同时核对独立数据模块与实际图表模块，避免仅凭某个旧独立脚本推断当前行为。

完整网页、脚本及原始响应以 `.gz` 归档保留原始字节，来源清单保存压缩包文件名及解压后 SHA-256；可用 `gzip -dc FILE.gz` 读取。来源 URL / SHA-256 和按字符位置摘录存于：

- [source-manifest.json](evidence/akshare-native-periods-20261112/futures/source-manifest.json)
- [source-excerpts.md](evidence/akshare-native-periods-20261112/futures/source-excerpts.md)

## 小规模原站实测

时间：2026-11-12 15:11—15:13 UTC。品种 `RB0`。只测试了已有第一手路由，并参考 A 股大周期参数作三次有限扩展探测；没有批量枚举服务名。

| 路由 / 参数 | HTTP / JSON 结果 | 周期判断 |
|---|---|---|
| `InnerFuturesNewService.getDailyKLine?symbol=RB0` | 200；4280 条；2009-03-27 至 2026-11-12；含 OHLC / v / p / s | 真实 D1 |
| `InnerFuturesNewService.getFewMinLine?symbol=RB0&type=60` | 200；1023 条；2026-03-02 23:00 至 2026-11-12 23:00 | H1 正常样本 |
| 同分钟路由 `type=240` | 200；1023 条；2024-10-08 11:15 至 2026-11-13 11:15 | 4 小时分桶，**不是 D1**；同日出现 11:15 / 15:00 多条 |
| 同分钟路由 `type=1200` | 200；JSONP `null` | 未获得周线 |
| 同分钟路由 `type=7200` | 200；JSONP `null` | 未获得月线 |

`type=240` 的尾部时间可晚于当前时间，说明服务存在分桶结束标签 / 未完成桶标记语义，不能把时间标签本身当作已完成柱的证明。A 股的 `scale=240/1200/7200` 可以对应日 / 周 / 月，**不能移植为国内期货的参数映射**。

原始响应与精简摘要：

- [fewmin-probes.json](evidence/akshare-native-periods-20261112/futures/fewmin-probes.json)
- [daily-probe.json](evidence/akshare-native-periods-20261112/futures/daily-probe.json)
- 其余原始 JSONP 位于同目录 `RB0-fewmin-*.txt.gz`、`RB0-daily.txt.gz`。

本轮没有重复测试所有 5 档分钟、所有合约和所有交易所；它们的现成 SDK / 官方声明及主任务的原站样本仍是各自证据。单个成功样本不能承诺其他合约、任意历史深度或长期稳定性。

## 建议边界

- 当前可按原生来源继续支持新浪期货五档分钟和 D1；W1 / MN 保持不可用，直到找到并验证直接返回周 / 月 OHLC 的真实上游接口。
- 不调用 `KKE.api('datas.k.get')` 后把其 `week / month` 对象当作服务端原生周 / 月，因为该对象已被官方浏览器代码本地聚合。
- 不在项目内复制 `kUtil.mw`，也不将聚合移到 worker / API 后宣称符合用户的“上游原生”限制。
- 如果最终需要期货原生 W1 / MN，下一步应核对另一个用户认可的上游，或由用户明确调整周期需求。不能静默混用其他来源，或因未知未公开接口而承诺八周期全部可做。
