# v1.20.1 行情错误根因与修复方案

分析日期：2026-10-11，时间均为新加坡时间（UTC+8）。源码基线为
`0cebcf5`，生产为正式 `v1.20.1`。本轮进行生产只读检查、Ubuntu 内存数据库复现和
修复候选对照；未修改生产配置、数据或应用实现。

## 结论

1. **组合 EURUSD 的 `Unknown source: composite` 是确定的应用路由缺陷。**
   旧实时采集器排除了显式数据集，却没有排除组合行情。组合的有效图表需求使其
   绕过 `enabled=false`，然后进入不支持 `composite` 的普通供源函数。
2. **BTCUSDT 的 SSL 错误发生在代理隧道中的 TLS 握手阶段。**
   历史审计与只读请求都记录了 `UNEXPECTED_EOF_WHILE_READING`；连接可以自行恢复，
   并非持续无法取数。已定位失败阶段，尚不能把责任确定到代理进程、代理后的网络
   或供应商的某一跳。当前证据没有出现证书验证失败。
3. **消除组合的错误路由，不代表组合实时接续已经就绪。**
   正确的 OANDA 目标已被独立采集器订阅，心跳仍在更新；但确认 M1 尚未恢复到当前，
   状态为 `recovering / m1_late`。代理后的 TLS 失败与未核实的会话规则是另外两项
   已观察到的问题，不能用普通采集器的过滤补丁掩盖它们。

两类原始错误均在此次发布前出现。`v1.18.0` 与 `v1.20.0` 中已有相同的组合选择条件；
`v1.18.0..v1.20.1` 的 Binance adapter、实时 worker 与代理配置代码没有变化。
这支持它们是既有问题；不能由此排除运行时网络变化。

## 生产事实与最小复现

11:49 的只读数据库快照：

| 对象 | 证据 | 含义 |
| --- | --- | --- |
| 组合 EURUSD | `source=composite`、`enabled=false`、无 MarketDataset 对应身份、2 条有效 MarketDemand | 普通采集器仍将其选中 |
| 组合 EURUSD | 近 24 小时 1,288 次 `Unknown source: composite` | 持续重复报错 |
| BTCUSDT | `receiving`、`error=null`，刚成功采入 M1 | 该时刻能够取数 |
| BTCUSDT | 近 24 小时 266 次 SSL EOF，另有 1,487 次错误文本为空 | 间歇故障；空文本无法追溯异常类型 |
| BTCUSDT | 11:45:56.828 发生 SSL EOF，11:46:10.392 记录恢复 | 下一轮可恢复；单次成功不代表链路一直健康 |

证据：[生产快照](../verification/provider-rootcause-20261011/production-snapshot.json)。

实际调用链为：

```text
realtime_worker.main
  → market.once(include_viewers=True)
  → MarketDemand / ChartHistoryPlan / ChartViewportDemand 合并为 viewers
  → 仅排除 MarketDataset.instrument_id
  → 禁用但有 viewers 需求的 composite 被选中
  → realtime_worker.fetch → market.fetch_source("composite", "EURUSD")
  → ValueError("Unknown source: composite")
  → Instrument.quality="error"，重复写 market_error
```

在 Ubuntu 的独立内存 SQLite 中，使用真实 `market.once` 与 `fetch_source`，仅放入
禁用组合与一条有效 MarketDemand 即可稳定得到同一错误。取消需求，或者仅在选择
条件加入普通供源范围过滤，错误消失。候选通过内存函数替换验证，没有改动仓库
应用文件；这不是完整实现或发布验收。

| 对照 | 结果 |
| --- | --- |
| 原实现 + 有效组合需求 | 退出 1，`Unknown source: composite` |
| 原实现 + 无需求 | 退出 0，无普通采集错误 |
| 候选选择过滤 + 同一有效需求 | 退出 0，无普通采集错误 |

复现脚本：[composite_repro.py](../verification/provider-rootcause-20261011/composite_repro.py)。
在项目已安装依赖的 Ubuntu Python 环境执行：

```sh
PYTHONPATH=backend python docs/verification/provider-rootcause-20261011/composite_repro.py
PYTHONPATH=backend python docs/verification/provider-rootcause-20261011/composite_repro.py --no-demand
PYTHONPATH=backend python docs/verification/provider-rootcause-20261011/composite_repro.py --candidate-filter
```

该脚本固定使用内存数据库，并禁用通知；不会连接生产。

## TLS 归因与可验证假设

探针在已有正式 realtime-worker 容器运行，调用真实 `fetch_binance`，仅执行公共
行情 GET；不设置资源 lane，不调用生产入库、通知或采集循环。保持 `verify=True`、
`trust_env=False`，固定同一 Binance 主机、品种和 API。生产 `binance_proxy` 为空，
实际通过 `market_proxy` 回退取得代理。

| 假设 | 实测判断 |
| --- | --- |
| 组合被错误分派到普通 adapter | Ubuntu 红/绿对照与生产选择条件一致，已证实 |
| OANDA 目标没有被需求图订阅 | 实际 `desired_datasets` 含目标，排除“完全未订阅” |
| 代理连接或连接复用发生故障 | 新建代理连接也失败，故连接复用不是必要条件；故障定位到隧道后的 TLS |
| CA 或证书配置持续错误 | 相同配置下多次成功、失败为 EOF/握手超时，当前证据不支持 |

5 秒诊断探针：新建代理连接 12 次，10 次成功，1 次 SSL EOF，1 次握手超时；
复用代理连接 12 次成功；同容器直连 3 次成功。两次失败都完成了代理响应头读取，
随后出现 `proxy.start_tls.failed`，没有进入行情 HTTP 响应处理。

这里的 `proxy.start_tls` 是 **CONNECT 隧道内向目标主机进行 TLS 升级**，不等同于
“代理自身的证书无效”。HTTPcore 的事件名称也不能判断隧道另一端由谁断开连接。

诊断时的 5 秒超时比生产 Binance 的 15 秒更严格；该样本不能直接当成生产失败率。
另行恢复生产的 15 秒配置作冷连接对照：两批共 24 次代理请求，21 次成功，
**3 次发生相同 SSL EOF，均在约 5.06 秒的 `proxy.start_tls` 阶段失败**；同期直连
12 次全部成功。它证明 EOF 不是缩短诊断超时才产生的现象，且单纯把超时增大
不能解决对端提前关闭连接。部分成功的代理请求约 5 秒才完成。
结果见[第一批](../verification/provider-rootcause-20261011/binance-confirm-15s.jsonl)、
[第二批](../verification/provider-rootcause-20261011/binance-more-15s.jsonl)。
这些是顺序执行的小样本；请求密度、时间和生产常态不同，不作为故障率或长期
稳定性统计。12 次直连成功也不能保证未来始终可用。

生产 OANDA 的只读日志同时记录了 `phase=tls route=proxy_tls` 的 ConnectError 和
ConnectTimeout。可以把该公共链路作为优先调查对象，但没有证据证明两个供应商
的全部问题来自同一个节点。没有读取代理节点日志或抓取网络包。

## OANDA 接续的独立状态

11:52 的只读证据：组合目标在 `desired_datasets` 中，EUR_USD 与 XAU_USD 均被选中；
目标心跳约 3 秒前更新，连接世代 403，`connection=recovering`、`ready=false`、
`error=m1_late`。最后确认 M1 为 10 月 10 日 05:00，留存报价 `tradeable=false`。
账户没有进入鉴权暂停，但仍留有之前的 `unavailable` 状态。

`session_states` 对两个品种均返回 `market_session=unknown`、`calendar_verified=false`。
代码只有在当前 M1 获得确认，或存在确定闭市证据时，才解除恢复门槛。当前证据
不能证明所有缺失分钟都是网络漏数，也不能仅因周末、旧的不可交易报价或空响应
就把这些分钟标成正常闭市。需要分别核实实际来源会话与采集链路。

证据：[OANDA 状态](../verification/provider-rootcause-20261011/oanda-state.json)、
[脱敏阶段日志](../verification/provider-rootcause-20261011/pricing-worker-sanitized.json)。

## 推荐修复顺序

### 1. 修复普通采集器的身份边界

- 在 `market.once` 的选择入口排除组合身份及显式数据集；普通供源列表和实际支持
  的采集能力保持一致。为传入 `symbol` 的强制采集入口做相同校验。
- 检查 `queue_initial_history`、`import_once` 等普通任务创建/执行入口，避免未来
  为组合或其他独立处理的身份错误创建普通供源任务。目前没有组合 ImportJob。
- 保留组合图表/预警的需求租约，继续由 `market_usage.composite_targets` 解析目标，
  由 OANDA 独立采集器与组合输入/聚合模块维护尾部。
- 已有的 `Unknown source: composite` 状态需要按组合真实健康状态重算或做精确的
  旧状态清理；停止写入不会自动消除历史残留。保留历史审计，不把 `quality` 直接
  改成 `receiving`。不要把组合的 source 改为 oanda 或将其价格写入普通 Instrument。

### 2. 为 Binance 修复供源路由并补齐有界恢复

- 优先为 Binance 设置经冷连接验证的独立稳定出口，避免全局代理调整影响 Yahoo
  和 OANDA。当前将 `ALERTS_BINANCE_PROXY` 清空仍会回退 `ALERTS_MARKET_PROXY`。
  若采用本轮短窗成功的直连，需要新增明确的 `direct` 路由模式，并在 Settings
  统一解析，覆盖实时、历史与原生图表入口。现有短窗不足以宣称直连长期稳定。
- 关联 TLS 失败时刻与代理的 CONNECT/出口节点日志，确认重置或超时来自哪一跳；
  若无法取得这些证据，将责任归因保留到“代理路径 TLS”，不指定供应商背锅。
- 对只读 GET 的确定瞬时网络故障考虑轮换失败 client，并最多追加一次重试；
  受本轮总时限、共享请求额度和退避控制。证书、鉴权和 429 继续按独立策略处理。
  重试是恢复措施，不能代替路由治理；新建连接已复现故障，单改连接池不够。
- 复用已有的安全阶段诊断思路，记录异常类型、阶段、路由、耗时和恢复结果；
  不仅保存 `str(e)`，避免再次留下无法分类的空文本错误，不记录凭据或完整 URL。

### 3. 按来源证据补齐 OANDA 会话与就绪判断

- 核实当前 Practice 产品、品种、账户范围和生效日期对应的会话规则，再通过现有
  显式会话 profile/修订流程生效；保持不可变历史与组合拼接点的原有含义。
- 分开呈现“流心跳在线”“报价是否可交易”“当前 M1 已确认”“已证实闭市”，
  处理账户/Instrument 残留故障状态，但保留真实 `m1_late` 与未就绪保护。
- 继续使用已有 OANDA 阶段日志调查 REST TLS；不能用新增第二个生产 pricing stream
  做调试，也不能因为修复了普通采集器就解除依赖缺失数据的告警保护。

## 实施后的验收条件

1. Ubuntu 隔离回归覆盖有效 MarketDemand、实时 ChartHistoryPlan、有效/过期
   ChartViewportDemand、强制 symbol 和组合历史任务入口；组合不进入普通 adapter，
   普通标的仍采集，组合需求仍解析到正确的固定修订/目标。
2. Ubuntu 验证同一组合的历史基线、拼接点、来源身份和预警绑定未变化；确认尾部
   与独立 OANDA 目标一致，状态清理不伪造健康或完整覆盖。
3. 对 Binance 选定路由验证冷连接与复用连接，注入一次 TLS EOF 验证有界自动恢复、
   额度/退避与错误分类；保留证书验证，确认 Yahoo/OANDA 的配置不受影响。
4. 生产发布后仅对正式实例做短窗读取：`Unknown source: composite` 不再增长；
   BTCUSDT 确认 M1 持续更新、故障能在约定窗口内恢复。OANDA 在经核实的开市时段
   验证可交易报价/确认 M1，在确定闭市时段验证闭市状态，未核实区间保持 unknown。
   心跳或一次成功 GET 不能替代这些条件。

当前完成的是根因分析和方案；尚未实现应用修复、调整生产代理或发布新版本。
