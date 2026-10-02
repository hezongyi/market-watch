# 平台首屏性能卡点：根因复核与解决方案

> 本文保留最初只读诊断阶段的事实和未实施方案。用户随后授权以 v1.3.0 建立独立
> worktree 修复，最终实施与验证见 [连接池修复报告](../../provider-first-screen-latency-fix.md)。

本文承接 `/tmp/market-watch-provider-blockers-handoff-2026-10-02.md`，区分确定事实、可证伪假设和未实施方案。本轮完成剩余长尾的诊断与方案，不改变已有发布验收判定。

## 结论

首屏超时存在两条已确认的故障路径：**新连接等待代理出站准备及 TLS 完成**，以及**已有连接等待真实上游响应头**。数据库冷缺口必须同步取得完整、新鲜的原生数据，原生初始化又已消耗约一秒；外部等待直接进入三秒首屏的关键路径。

本轮新增的关键归因是：**Mihomo 的 CONNECT 200 先于出站准备完成，HTTPX 的 `proxy.start_tls` 因而包含代理前置处理、出站拨号及可能的节点协议握手/内部重试。它不能全部解释为 Binance 服务器处理 TLS。** 一个新取得的 3817.14ms 成功请求，其代理 tracker 到请求开始后约 2823ms 才创建；客户端 TLS 阶段总计 3635.83ms。主要延迟已经发生在 tracker 创建之前。

当前代理 Fallback 以测试 URL 的活性选择节点，并不按实际行情 TLS/响应头时延判定是否合格。这解释了节点仍被标记 alive、仍被选用，却不能满足行情首屏预算的现象。它是现有自动恢复策略的能力缺口；尚不能据此断言某一具体节点、DNS、嗅探或出口运营商是所有故障的最终原因。

OANDA 的 4574.18ms 复用连接响应头长尾已经由运行 API 证据确认；本轮未再次复现这个量级，也没有取得该旧慢样本的节点关联，不能把它归入 Binance 的出站准备问题。

## 重建后的任务与现场

- 接手时为 `feature/advanced-charts` / `a71439b34964fea9cf825d7a6e2d412bac071fc5`，候选 `1.3.0-candidate.1` 的构建清单 `accepted=false`。诊断期间 HEAD 前进到 `b9d69dd4c7ff8e873c4c75f07054eac29c94b996`；这不是本轮诊断产生的提交。原未跟踪材料已由该提交纳入本地交付记录，仍完整保留。
- 新交付文档记载用户将性能标准修订为“大多数冷首屏低于3秒”，最终状态见 `deploy/releases/v1.3.0-local.json` 和现行43项审计。两次提交之间没有 backend、web/src 或 advanced-host 产品源码变化；浏览器验收驱动和发布文档有变化。本文保留旧严格三秒标准作为长尾诊断信号，不把单次长尾重新定义成现行发布验收失败。
- 两家九周期首屏争取 2s；完整且新鲜的 PostgreSQL 缓存需求到显示 <1s。数据库冷、静态资源冷和提供商连接冷分别测量。
- datafeed 只转发原生需求；缓存、分页、订阅及预热在后端取数层；平台周期直接取供应商原生数据。维持数据库、请求额度和连接并发预算。
- 本轮主站、图表来源和 Mihomo 控制 API 可访问，控制版本 `v1.19.31`。OANDA 当前走美国01，Binance 当前走日本02，与交接相符。
- 当前沙箱下 `sg docker` 和直接 Docker socket 均不可用，因此没有声称本轮重新 inspect 七个容器。候选镜像关联引用已有 `candidate.1-runtime-images.json` 和内容等价证据，现场补证来自实际 API/浏览器。

## 反馈循环与本轮证据

历史首屏失败的最小分解来自 [first-screen-transport-lanes-18.json](first-screen-transport-lanes-18.json)：OANDA M5，初始化 1303ms + API 2047ms + 显示收尾 419ms = **3769ms**。其中响应头 1925.63ms、额度 5.34ms、数据库提交 44.88ms，无新 TCP/TLS。对这个保存样本执行 `<3000ms` 断言得到原门槛失败，保留该事实。

新增诊断脚本 [diagnose_provider_egress.py](../../../scripts/diagnose_provider_egress.py) 只读上游和控制接口，串行、有界、请求开始间隔至少一秒；失败后关闭原始诊断池，避免把污染池的后续 PoolTimeout 计作新上游故障。它保存域名与源端口精确匹配的连接字段，日志只保存本次源端口的提供商记录。

本轮已执行的可重复失败判定：

```bash
python scripts/diagnose_provider_egress.py \
  --replay docs/verification/provider-cache/root-cause-egress-20261002.json
```

```text
UPSTREAM STAGE BUDGET FAIL: 38/40 requests returned 200 within 3000ms
binance repeat=0 status=200 elapsed_ms=3817.14 source_port=53412
binance repeat=3 ConnectTimeout elapsed_ms=4006.27 source_port=41840
```

这是已经发生过的真实上游等待的确定性回放，不是注入网络故障。上游阶段超过三秒足以否定三秒首屏；阶段通过不能证明完整首屏通过。随后补日志八次新连接全部成功、最大 1887.19ms，其回放输出 PASS；两组结果同时保留，没有用后一组撤销失败。

| 场景 | 本轮结果 | 证据及限制 |
| --- | --- | --- |
| 新原生文档、OANDA USD_CHF M5，实际缓存缺口 | 首屏 1927ms；请求发起 1217ms；API 426ms | [root-cause-first-screen-20261002.json](root-cause-first-screen-20261002.json)；没有清库，以响应 `cache_hit=false` 确认该次缺口，不代表九周期矩阵 |
| 运行 API，16 个未测历史窗口 | 全部 200、全部 `cache_hit=false`；Binance 最大 481.40ms，OANDA 最大 527.51ms | [root-cause-runtime-20261002.json](root-cause-runtime-20261002.json)；仅证明该小样本正常 |
| OANDA 同一诊断连接 32 次 | 32/32 成功，31 次确认复用，复用 283.07–872.56ms | [root-cause-egress-20261002.json](root-cause-egress-20261002.json)；最慢复用样本按源端口 46392、连接 ID 匹配美国01，未重现 4.574s |
| Binance 八次新诊断连接 | 7/8 成功；一个 TLS 超时 4006.27ms，一个慢成功 3817.14ms | 同上；慢成功端口 53412 精确匹配日本02。超时端口 41840 未取得 tracker，不能直接赋予该失败具体节点链 |
| Binance 八次新连接、补只读日志 | 8/8 成功；最大 1887.19ms | [root-cause-egress-logs-20261002.json](root-cause-egress-logs-20261002.json)；匹配日志 7 条，仍不构成全冷稳定性证明 |
| 现有传输层回归 | 4 passed in 0.48s | `PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_provider_transport.py`；单独真实 CONNECT 失败回归 1 passed in 0.44s |

## 新发现：CONNECT 成功不等于代理出站已经就绪

核查了控制 API 报告版本对应的官方源码。URL、下载内容哈希和关键行记录在 [root-cause-mihomo-source-20261002.json](root-cause-mihomo-source-20261002.json)。

1. [HTTP listener](https://github.com/MetaCubeX/mihomo/blob/v1.19.31/listener/http/proxy.go#L68) 先写 `200 Connection established`，随后才调用 `HandleTCPConn`。
2. [TCP tunnel](https://github.com/MetaCubeX/mihomo/blob/v1.19.31/tunnel/tunnel.go#L519) 在 tracker 之前执行元数据处理、可能的嗅探、规则解析、`proxy.DialContext` 和需要时的惰性握手。拨号函数还位于内部 retry 中；源码存在重试不等于本次样本已经证明发生重试。
3. [tracker](https://github.com/MetaCubeX/mihomo/blob/v1.19.31/tunnel/statistic/tracker.go#L119) 在上述步骤成功后以 `time.Now()` 记录 `Start`。`/connections` 中的 `start` 是这个时间，不能当作入站 HTTP CONNECT 到达时间。

本轮源端口 53412、tracker `f5184f05-9bf4-4d2d-bfa1-01d0f3e8875b` 的慢成功请求：

| 事件 | 相对本机请求开始 |
| --- | ---: |
| 本地 TCP 完成 | 0.86ms |
| CONNECT 响应头完成 | 1.44ms |
| 客户端开始 TLS | 1.48ms |
| Mihomo 创建 tracker | 约 2823.08ms，尚须扣除跨机时钟偏差 |
| 客户端 TLS 完成 | 3637.31ms |
| 真实行情响应头完成 | 3816.48ms |
| 完整请求结束 | 3817.14ms |

以控制接口 HTTP Date 的秒级截断和本机请求起止时间计算，代理时钟减本机时钟的区间为 **[-59.19, +30.71]ms**，见 [root-cause-proxy-clock-20261002.json](root-cause-proxy-clock-20261002.json)。核对发生在同轮诊断之后；不能追溯证明时钟从未调整。补日志样本中日志本机接收时间比 tracker 的代理时间大约 11–12ms，也与近似同步相符。在没有中途时钟跳变的条件下，慢样本的 tracker 前等待约 **2792–2882ms**，足以排除它只是时区或数秒时钟偏差。

因此，原“本地 CONNECT 很快，所以代理内部建连已经完成、全部四秒都属于对端 TLS”的推断不成立。当前可确定的大段是**代理 tracker 前的出站准备**；其内部是否为 DNS、规则/嗅探、VLESS 节点拨号、节点协议握手或重试，仍需分段计时或隔离对照。

`sniffing=true` 本身也不证明本次域名走了嗅探：对应源码还检查 `shouldOverride` 等条件。没有修改共享嗅探、节点或选择器来制造结论。

## 按证据排除及保留的假设

| 假设 | 可证伪预测 | 当前判定 |
| --- | --- | --- |
| 外部路径等待主导长尾 | 去掉浏览器/数据库后仍出现数秒 TLS 或响应头等待 | 已由本轮最小读探针及旧运行 API 慢样本支持；新连接进一步定位到 tracker 前准备 |
| 原生初始化消耗预算 | 网络正常时，行情 API 仍在导航约一秒后才发起 | 支持；本轮 1217ms，此前 904–1595ms；vendor CPU 两次约 540/568ms，不能把余下调度/GC 全算成 vendor 执行 |
| 数据库或额度争用主导旧慢样本 | 长尾时租约、额度或提交等待应接近主要延迟 | 对所分析样本不支持；OANDA 4656.37ms 样本响应头 4574.18ms、额度 3.19ms、提交 41.92ms |
| 已修复池耗尽仍是所有故障来源 | 实际重现无网络尝试的 PoolTimeout，相关回归应失败 | 本轮四项回归通过；不支持用扩池处理当前独立 TLS/响应头长尾 |

已复用连接的 OANDA 样本确实没有新 TLS 阶段，不能用预连或保活解释其 4.574s 响应头等待。相反，本轮独立 Binance 探针没有任何数据库活动仍失败，数据库扩池不触及它的故障阶段。

## 解决方案与实施顺序

### 第一步：对实际行情出口做隔离对照，修复外部等待

优先保留当前源端口/连接 ID 关联，并取得代理内部“入站接收→规则/嗅探结束→节点拨号完成→节点协议握手结束→tracker 建立”的分段时间。这能区分 tracker 前的多个原因，客户端 HTTPX TLS trace 无法替代它。

建立只供本机行情使用的独立测试代理监听，不改共享 Mihomo 的节点/选择器。使用两个合规、可访问目标提供商的候选出口，对同一域名、同一历史窗口、同一 HTTP 协议做交错单变量对照：先固定现有出口作为基线，再仅改变出口；如果仍慢，再单独对已知域名的嗅探处理做对照，不能同时改节点、DNS和协议。独立实例应关闭无关订阅活动及自动选路，记录真实链路。需要外部代理配置或节点配置的操作另行形成可审查变更；本轮只给方案。

既有 `ALERTS_OANDA_PROXY` 和 `ALERTS_BINANCE_PROXY` 支持分别指定专用 HTTP 代理入口，见 `backend/alerts/config.py:23–28,45–46`。候选出口应以**真实目标的 TLS 与原生 candles 响应头**评估，不以通用测速 URL 或根路径 HEAD 的成功代替行情请求性能。

当前 [Fallback 选择代码](https://github.com/MetaCubeX/mihomo/blob/v1.19.31/adapter/outboundgroup/fallback.go#L105) 检查 `AliveForTestUrl`。本轮日本02仍 alive，最近健康延迟约 155–167ms，见 [root-cause-proxy-health-20261002.json](root-cause-proxy-health-20261002.json)，但同轮真实行情请求已有秒级长尾。后续出口选择需要按实际行情的错误率、TLS/响应头长尾和时间预算判断，换路应优先作用于未来连接，保持现有在途读者完成；不能通过每次请求重复竞速或额外叠加重试挤占已有额度。

若所有可用出口在同窗口都出现 OANDA 复用响应长尾，应携带提供商 RequestID 和 UTC 时间寻求上游侧处理时间；只有代理端的加密字节计数不能区分上游应用处理与远端链路等待。新探针没有重现这个旧慢样本，不能虚构已完成归因。

### 第二步：缩短可控初始化，但按测量决定是否改动

本轮 widget 在导航约 222ms 已开始构造，首个 `getBars` 到约 1215ms 才发生。已有懒加载、首次元数据和静态传输优化保留；首次 metadata 回调的 `setTimeout(0)` 是必须异步的回调，并非人为设定 300ms 延时。

继续只在宿主和公开 widget 配置做单变量对照：并行准备不相互依赖的工作区/目录/偏好、避免首次初始化执行无关迁移或重复解析；任何 UI 功能延后方案须验证 watchlist/details、八图、保存和恢复。没有新测量支持时不修改 vendor、不同步调用原生回调、不移入 datafeed 预取。

先以 `T首屏 = T初始化 + T API + T显示收尾` 规划预算。以本轮 1217ms 初始化和 284ms 显示收尾为例，API 只剩约 **1499ms**。这只是该样本的预算分解，不是新的验收门槛。旧 3769ms 样本的 API 余量仅 1278ms，上游响应头 1925ms 已足够导致失败。

因此，即使消掉数百毫秒宿主开销，也无法单独抵消本轮 3.636s TLS 或旧 4.574s 响应头长尾；第一步对出口与上游等待的处理应优先。

### 第三步：在取数层减少等待暴露，保持正确性

保留按需先返回、持久覆盖缓存、有界后台预热和活跃尾部更新。已有完整且新鲜的缓存请求不应进入上游路径；窗口缺口只补本次所需数据、已有窗口仅补尾部。这些策略已经实施，不能作为尚未存在的新修复重复承诺。

连接代际恢复、chart/realtime/history 隔离和闲置保活继续保留，见 `provider_transport.py:35,69,92`。启动预连当前每提供商顺序 HEAD 建立一条连接，而 chart 池容量为二；两个冷请求重叠时仍可能创建第二条冷连接。因此“服务已预连”不等于“所有前台连接都热”。若真实八图/并发 trace 证实此路径明显触发失败，可在现有总连接预算内研究启动预连完整前台容量，并测量代价；这仍无法解决复用响应头长尾。

API 8s 总截止是有界失败与共享工作的机制，不是 3s 首屏承诺。把截止从 8s 改成约 1.5s只会让慢请求更快报错；在没有可用数据或已验证出口的情况下不能算首屏成功。外部路径暂不能达到预算时应保留可重试错误及数据新鲜度证据，不能返回伪造的 noData、陈旧数据或半页以通过验收。

## 验收与仍未完成的部分

- 保留未修复基线和本轮两个超三秒样本。针对单项出口/初始化改动再重跑原反馈循环；冻结样本回放只核查失败事实，不证明实际网络已经修复。
- 改动后分别检查两平台九周期的完整浏览器首屏、提供商连接冷/热、数据库缓存冷/热。包含进程启动、失效代际后首次连接、双前台请求和八图/后台预热负载。
- 计时结束仍为公开 dataReady 加两帧；完整且新鲜数据库缓存的需求到显示仍 <1s。记录失败、最大值、分位数、样本数量和冷暖条件，不靠全绿小样本给所有冷连接下保证。
- 可控代码修复应在真实调用链的正确边界保留先红后绿回归；外部出口改变以交错对照和完整首屏复验作为证据。
- 本轮不能证明每次冷首屏稳定 <3s；这与现行“大多数低于3秒”的本地发布验收标准不同。已有 v1.3.0 本地交付状态保留。本轮产出是根因复核、诊断脚本及脱敏证据；产品源码和运行镜像没有新修复。

进一步只读探针命令（正常情况下不要重复全量采样）：

```bash
python scripts/diagnose_provider_egress.py \
  --oanda-reads 32 --binance-cold-reads 8 --controller-logs \
  --output /tmp/provider-egress-recheck.json
```

默认严格阶段判定会在上游请求失败或超过三秒时返回 exit 1；上游阶段通过仍需完整浏览器验收。脚本不打印认证头、token、密码或完整代理/订阅配置。本轮新增 JSON 已与本机私密配置中的实际敏感值比对，未发现匹配。
