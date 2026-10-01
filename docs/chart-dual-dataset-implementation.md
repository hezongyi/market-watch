# 双系列实施与验证记录

2026-10-01开始，2026-10-02完成本地交付。权威需求为 `chart-dual-dataset-plan.md`，按用户最新修订的“大多数冷首屏低于3秒”验收；不操作 Unraid 生产、不 push、不发送通知。以下旧快照保留当时的未完成状态和失败，不作为当前交付结论。

后续平台取数重构已获实施授权，以[平台取数方案](provider-fetch-service-proposal.md)和用户指定GPT-6.1-Sol/max的[独立复核](provider-fetch-service-review.md)为准。目标是实施并通过真实环境验收后交付，已取代此前暂不实现限制。`/tmp/market-watch-development-handoff-2026-10-01.md`顶部同步最新授权、方案与当前状态，旧交接保留为历史快照。

## 最新现场状态（覆盖以下历史开发快照）

### 2026-10-02 用户修订性能门槛并完成本地收口

- 用户明确：“不再以每次冷首屏都在3s为目标，因为代理等原因，大多数达到3s即可。建议不再虚耗时间，可以收口。”不再将代理/TLS/上游长尾的完全消除作为本地交付门槛，其余功能、完整数据库缓存小于1秒与资源隔离要求保留。
- 复核已有真实结果而不新增网络测试：九周期18项18/18低于3秒、部署后6项6/6、较早含慢样本矩阵17/18。原始passed=false、3769ms慢首屏及TLS/响应头长尾全部保留，评估汇总 `verification/dual-container/final-performance-policy-evaluation.json`。测试驱动改为多数判定，继续保存逐次耗时和慢样本，缓存/完整需求/工作区/错误断言不变。
- 构建源码提交 `a71439b34964fea9cf825d7a6e2d412bac071fc5`，三类1.3.0-candidate.1已统一部署，API healthy、七容器running。后端代码/迁移、web18静态文件和chart2943静态文件与对应验收版本逐字节一致，六项浏览器首屏1280–1829ms、数据库缓存需求到显示204–321ms，无新TLS。
- 最终本地镜像别名1.3.0-local复用完全相同ID，不为文档改动重建/重启。发布清单 `deploy/releases/v1.3.0-local.json`、非秘密env/Compose覆盖和同schema回退env齐全；构建时accepted=false标签作为历史保留，最终结论以发布清单为准。附注标签v1.3.0包含最终审计/交付记录，继续留在feature/advanced-charts，不合并main、不push、不部署生产。
- 43项完成审计及证据哈希见 `verification/dual-container/final-local-acceptance.json`；完整PG16后端303通过、VM35通过，八图/预警演练/手机画线/日期同步/故障恢复等证据已按源码内容关联。实际限制保留：外部网络长尾、非逐帧vendor文案覆盖、未作百万根吞吐承诺、未发送实际通知。

### 2026-10-02 代理链路关联与源码候选快照

- 只读发现 `192.168.7.33:9090` 为Mihomo v1.19.31；rule模式、mixed-port7890。`proxy-controller-summary.json` 确认实际OANDA链为OANDA行情→OANDA美国故障转移→美国01，Binance为日本专属→日本故障转移→日本02。没有修改共享代理配置或选择器。
- 新增 `diagnose_provider_proxy_connections.py`，把HTTPX TCP本机源端口与Mihomo connections.sourcePort关联，并可只读收集两家域名的info日志。首轮48请求出现4个真正Binance TLS超时，其后的8个PoolTimeout为未执行产品恢复的原始探针同池后果，不作独立上游失败。
- 补日志24请求中21成功，Binance一次真实TLS4秒超时，通过源端口40064对应的代理info日志确认当时走日本02。后两次PoolTimeout没有新连接，不扩大计数。见 `provider-proxy-connection-and-logs.json`。证明失败所经链路，不证明节点本身而非节点到上游路径就是根因。
- Python/web/锁文件版本统一1.3.0，CHANGELOG明确本地未验收候选；正在创建可审查的本地源码快照并构建三类同提交镜像。正式附注标签仍须全部验收通过；不合并main、不push、不改生产。

### 2026-10-02 发布轮转节奏复验

- 有界发布候选的八图测试再次失败，保留 `eight-chart-bounded-publication-failure.json/png`；聚合队列空时worker仍在每个发布目标之间休眠1秒，导致轮转延迟累积。现改为聚合或发布有工作时休眠0.1秒，无工作才1秒；实际worker循环两项回归先红后绿，相关34项与完整PG16后端303项通过、零跳过。
- API/三个worker统一 `provider-publication-cadence-20261002` / `sha256:a087d57ca79f66d31db2b6e130fd9547ddf0700e5b4b881e7517c656a69c362b`，web/chart未变更。运行镜像见 `publication-cadence-runtime-images.txt`；CPU/数据库池/额度预算均未扩大。
- 最新五分钟八图 `eight-chart-publication-cadence.json` 通过：29次采样、零页面错误，managed最大水位延迟91232ms。六个新文档冷PG首屏1206–1919ms；首次逐周期切入50–572ms、后续27次原生缓存切换p95=54.1ms。计时不是GPU绘制完成，也不证明每个TLS全冷请求达标。
- 最新 `roundtrip-publication-cadence.json` 验证同系列跨周期画线保留、跨工作区不继承、保存重开和手机只读修改不写回桌面。`managed-compatibility-publication-cadence.json` 验证真实历史价格触发、worker内部派发5163ms、演练真实OHLC与未来隐藏、导出恢复以及平台输入422。预警在八图结束后运行，不冒称同步负载或实际通知网络延迟；delivery=false且未发通知。
- 未变更的web/chart镜像上，`native-ui-bounded-publication.json` 验证原生周期按钮、比较及左右价格轴保存重开；`date-sync-bounded-publication.json` 验证四图混合日期同步、连续切换、历史视区保存重开与空闲无保存循环。前端VM35项通过。
- `blank-plot-product.json/png` 用无测试路由或翻译注入的产品，验证真实未维护USD_SGD拒绝维护后无新计划、绘图区无K线/Loading/No data/应用进度。产品已有公开custom_translate_function对列出的Loading/No data词返回空串；本轮只探查公开loading_screen/翻译接口，没有增加产品策略。不将稳定空图截图当作所有瞬时加载状态证明。
- Binance四官方入口32次原始HTTP对比 `binance-endpoint-comparison.json` 均可出现TLS超时，没有充分理由更换默认入口。该原始探针不做产品的失败池恢复；失败后的PoolTimeout不能当作独立上游慢样本，也不能用new_connection=false证明复用了连接。
- 当前18周期冷PG与新文档完整缓存矩阵 `first-screen-publication-cadence-18.json` 已全过：首屏1385–2597ms、完整缓存请求到显示199–490ms，页面错误0；18项都无新TLS，不能用此撤销冷连接失败。
- 最新 `publication-recovery-publication-cadence.json` 通过：真实M1输入在聚合写入后故意异常，旧已发布快照/修订不变；真实worker重启后续做成功、原两根不变、新增一根无重复，发布事务故意中断也完整回滚。
- 最新16次运行API历史缺口探针 `runtime-publication-cadence.json` 均200、cache_hit=false，276–4656ms。慢项为OANDA第7项，复用HTTP连接等待响应头4574ms，额度3.19ms、提交41.92ms；不是新TLS或DB/额度排队。长尾仍未解决，继续同一历史品种/端点直连与代理对照。
- `publication-cadence-source-impact.json` 对比旧startup-metadata镜像与最新候选的全部安装alerts模块，并逐字节确认当前候选与工作树无差异。功能差异为配置脱敏/读取兴趣上限、有界发布和worker节奏；其他差异为导入排序/未使用导入清理/显式同名reexport，已手工查看。该结果可用于历史SSE/修订证据的影响审计，不能替代最终源码提交/镜像发布清单。
- 原冷首屏超3秒长尾尚未解决，版本及最终源码/镜像关联未完成，整体目标仍未交付。
- 最新真实API重启 `restart-publication-cadence.json` 通过：重启16616ms、SSE恢复16679ms、完整持久缓存57ms，OHLC/排序和柱间距不变，pending=0，无reset或页面错误。
- 同一OANDA AUD_CAD历史M1端点直连/HTTP对照24次，HTTP12/12成功；六次新连接957–3520ms、六次复用297–784ms。直连12/12在TCP阶段失败，额外无认证HEAD确认 `[Errno 101] Network is unreachable`。见 `oanda-proxy-direct-historical.json`；不能用不可达的直连归因代理或上游，仍需代理端节点/连接日志。
- HTTP/1.1与HTTP/2同代理/历史端点交替48次 `proxy-http-version-historical.json`，两家均实际协商HTTP/2。OANDA两组12/12成功、复用耗时相近；Binance HTTP/1.1 11/12、HTTP/2 12/12，但HTTP/2仍有TLS2505ms长尾。每组仅六个新连接，不足以证明改善或消除复用响应等待；产品依赖/默认协议未改。
- 空图补测 `blank-plot-transient-publication-cadence.json` 通过：初始化至拒绝后23次原生文本采样无Loading/No data；采样间隔100ms，不声称逐帧全覆盖。当前变更/非忽略新文件611项实际本机密钥扫描无匹配，见 `candidate-known-secret-scan.json`，非Git全历史泛化扫描。

### 2026-10-02 验收审计与有界发布

- 新增逐项审计 `chart-dual-dataset-acceptance-audit.md`，覆盖D01–D21、P01–P22；不能把已做功能替代完整目标。冷首屏长尾、原生空图限制、新版本/源码镜像清单仍未收口。
- 当前镜像历史修订复验通过：`revision-startup-metadata.json` reload3764ms、公开回调取得修订价格、视区/柱宽保留、fixture恢复。
- 两源普通/Python推送、九周期有限预热复验通过：OANDA24570ms、切D1/H4 383/406ms；Binance38660ms、切280/501ms；16秒无前端data轮询、关闭订阅归零。结果为 `prewarm-subscriptions-startup-metadata.json` / `binance-prewarm-startup-metadata.json`，来自此前明确的API镜像，不能默认为新有界发布镜像成绩。
- 审计补齐每会话读取兴趣上限配置 `ALERTS_PROVIDER_INTEREST_LIMIT` 默认16；只回收本会话旧读取兴趣，保留订阅和其他会话。Settings打印不再包含DB URL/上游令牌等秘密；失败测试artifact已按实际秘密脱敏，不改变失败结论。
- 新未维护CAD_CHF真实UI拒绝/起点提交成功，180秒观察M5未达到三屏474门槛；失败保留 `managed-browser-startup-metadata-failure.json/png`。M1下载已经推进，聚合发布落后。cProfile证实 `publish_once` 一次遍历63个品种周期23.283秒，worker每处理一段聚合即全量发布、历史CPU被其阻塞。不是把180秒变成自建维护完成承诺。
- 发布改为每轮一个品种周期、有界轮转；每段仍短事务、持久进度、重启可幂等重做。先红后绿，32项相关测试通过；全后端301 passed/零跳过，包含PG16。
- 新API/三个worker统一 `sha256:d1a7940e338be82ee7fa72bad16ee55ee459ec8331f63bea5b9780a7fc850dc3`，tag provider-bounded-publication-20261002；主站/chart未改。运行CPU约束不变。九次发布轮转总496.69ms，worker实际聚合/发布轮次初期0.115–0.471秒。新的未维护NZD_CAD UI复验通过：50805ms观察到M5三屏开放、整月历史initialized=false；拒绝不建任务、只填起点、取消历史仍实时及跨系列画线隔离全部通过，见 `managed-browser-bounded-publication.json/png`。这不是自建完成时间承诺，整体未交付。

### 2026-10-02 两项性能问题再次复核

- 本轮新增 [诊断复核](verification/provider-cache/diagnostic-recheck-20261002.md)：48次HTTP/SOCKS交替，新连接Binance再现TLS3.28/3.76秒慢及五次4秒TLS超时；OANDA全成功。HTTP新连接5/6、SOCKS2/6，保留HTTP代理。16次运行API未缓存历史窗口均200，API263–872ms；本轮未再现运行API8秒超时，不能宣称外部网络长尾消失。
- 六次真实空PG首屏1375–2176ms，首次行情请求950–1595ms，原生长任务169–361ms；两次chart frame CPU采样vendor约540/568ms，host约2.3/0ms。请求前初始化仍可复现，并非后端预取导致；六次全绿不能覆盖已有失败。
- 上轮五分钟八图 `mixed-eight-chart-startup-metadata.json` 已完成并通过；最新真实API重启 `restart-startup-metadata.json` 通过：重启14651ms、SSE恢复15216ms、持久缓存58ms、视区/柱宽保留。lint后107项回归通过、ruff通过。本轮transport四项回归通过。新诊断工具不改产品镜像，最终scope审计/源代码版本交付仍未完成。

### 2026-10-01 19:10 UTC：旧布局兼容与启动元数据优化

- 旧格式无 `_mwSync` 的日期同步重开已真实复现拒绝，1秒延迟无效。限定旧格式在首次getBars前通过公开date/time同步开关暂停，数据与视区恢复后恢复用户选择；不改原生布局字段。先红后绿回归、部署后的最新视区/一日前历史視区/原有绘图保留均通过，见 `date-sync-legacy-{latest,history}-deployed.json`。普通保存重开/手机只读通过 `legacy-chart-roundtrip-mobile.json`。
- 自维护11脚本合并为内容哈希静态资源；vendor不动，主库与原生缓存策略不变。三次对照只减少下载请求，没有凭此宣称启动显著变快。
- 初次工作区限量响应附带当前平台品种元数据，桥接只消费一次、异步交原生解析回调。后续resolve仍调用后端；系列隔离、不提前取bar、不可用品种回落正常错误路径已有回归。完整后端 **298 passed零跳过**，前端 **35项VM通过**。
- 当前API/三worker `15f097b09e6dc1f3833084428b7d4cdf5d9610bcdb565e6e1920f5ce7a7bd779`、web `f77b6fa8a6cca9b90fb818fbee4955c15c7ca50dd8b8057a943d15a89debc3fd`、chart `e801e1e776db6e3aed8b552c9dc521b2a8e8de9b394a4817e731e78f22b50aa4`，见runtime-images文件。
- 最新18周期矩阵 `first-screen-startup-metadata-18.json` **全部通过**：每项清空独立平台PG缓存/new native document；首屏1446–2290ms，随后另一个原生文档完整PG缓存需求到显示202–382ms。HTTP池是运行状态，不能叫每条TLS全冷。第一轮该候选有多条3秒失败，保存为 `first-screen-startup-metadata-workspace-load-failure.*`：驱动每项前后读取460个完整工作区约8.55MB，4核机器CPU等待压力约33%；复跑用已有native-charts元数据检查数量/身份，后台服务没有停。产品没有删工作区、没有把失败判绿。
- 最新立即冷周期/连续切换 `rapid-switch-startup-metadata.json` 通过：两源首屏1686/1627ms，即切562/398ms；各20次冷周期重叠加20次热重叠无拒绝/errors，最终pending=0。OANDA冷序列总体8781ms、Binance4542ms，包含1.6秒操作序列；这不是每次冷切都在1秒内。当前新镜像旧布局兼容、八图负载及完整scope审计继续；整体未交付。

### 后续复核：五分钟八图通过，首屏仍保留超标证据

通道隔离后完整后端重新执行：297 passed、零跳过，见 `backend-transport-lanes-full-pg16.txt`。第二轮连续切换 `rapid-switch-transport-lanes-second.json` 也通过两源首屏与即切 SLO：首屏1762/2030ms，即切未缓存周期444/385ms，无页面错误/拒绝，最终pending=0。

`mixed-eight-chart-transport-lanes.json` 五分钟八图混合29次采样通过，managed最大延迟87008ms，27次热原生切换p95=40.3ms。六次新原生文档启动1459–3109ms，其中3109/3047ms超过三秒；该驱动等待ready，不能将功能passed当作首屏SLO通过。两个慢品种各重复三次空库首屏 `slow-symbol-init-lanes-untrusted.json` 为1512–2017ms，本轮没有复现三秒超标，但不撤销原记录。

公开回调计时又复现1392ms才发出首个行情API，其中resolve API仅17.4ms，原生执行及跨窗口消息/调度占主要部分。最新18周期矩阵首轮因驱动取iframe早于导航而中断，失败保存为 `first-screen-transport-lanes-frame-navigation-failure.*`，已修正驱动等待实际#chart并复跑。两项诊断证据见 [诊断记录](verification/provider-cache/timeout-and-initialization-diagnosis.md)。整体仍未交付。

完整矩阵复跑已结束，`first-screen-transport-lanes-18.json` **passed=false**：18项均200、页面错误0、17项首屏低于3秒，OANDA M5为3769ms。该项请求前1303ms、API2047ms，其中复用连接等待响应头1925.63ms，额度5.34ms、提交44.88ms，无新TLS；返回至显示419ms。这是复用连接的正常响应等待波动，不是池耗尽。18项新原生文档读取完整PG缓存需求到显示161–324ms均通过。首屏稳定性门槛仍未通过，不能按此前全绿矩阵交付。

### 2026-10-01 18:00 UTC：传输按通道隔离与复验

前台、实时、预热池现在按 source/proxy/lane 独立，分别容量2/1/1，总4不变，避免后台TLS失败换代时影响健康前台连接。回归先红后绿，55相关项通过，并验证后台池失败不会替换前台池。最新API及3worker为 `sha256:0879187f2e16f1d687be25c3a1dfb875e8977669d3885f4203aa7b156b157967`。

此前同一池的18周期首屏 `first-screen-pool-recovery-18.json` 全过（1566–2001ms、DB需求到显示153–393ms），但随后连续切换BTC冷M15出现3979ms及503/TLS7669ms；失败保留，不能只引用矩阵宣称稳定。隔离池后首轮真实SLO连续切换复验 `rapid-switch-transport-lanes.json` 全过：两源首屏2023/1916ms，首屏后立刻请求尚未缓存周期764/403ms，40次/源连续切均无拒绝、无页面错误、最终pending=0。18周期/更多轮/多图最终验收仍在推进。

真实重启 `restart-pool-recovery.json` 通过（PG缓存95ms，API重启15.526s、SSE恢复17.156s）；真实历史修订 `revision-pool-recovery.json` 通过且原payload已恢复。日期同步新snapshot在原始双源与历史窗口均通过。旧格式首次兼容仍需审计，整体未交付。

### 2026-10-01 17:30 UTC：池耗尽、预算与同步生命周期修复

- 已确定性复现运行 HTTP CONNECT 池耗尽：可控代理连续四次 TLS 超时后，第五次出现 PoolTimeout 且没有任何网络 trace，见 `failed-tunnel-pool-exhaustion-red.txt`。新 `provider_transport` 在 ConnectError/ConnectTimeout/PoolTimeout 后替换池，原有在途读者保留旧池直到完成；旧失败不影响新代池，已经持有旧句柄的等待者原子转向当前池。相同可控场景修复后五次均发起网络请求，未再池耗尽，见 green 及 safe-rotation-green。前台、缓存读取、初始化 HEAD 和空闲 HEAD 都使用该机制。
- 后端传输层独立维护两源连接：现有代理不变、每池并发4不变，保留4个空闲连接；空闲20秒才用历史额度发 HEAD，遇前台或正在请求就让位，不拉行情、不存bar。先前真实80s探针 Binance 复现 PoolTimeout、OANDA 复用393ms，新恢复候选正在复跑，不能凭模块代码声称性能达标。
- 接口累计8秒截止已涵盖元数据/等待/HTTP/响应，超时返回503，已经发出的共享页可以继续完成供其他读者使用；退避不超过剩余预算。真实订阅更新从误用 chart 保留额度改为 realtime，回归均先红后绿。
- 日期同步不修改 vendor 或 opaque锁：`captureChartLayout` 用公开开关暂时关闭同步，由公开 widget.save 生成原生状态，自有 `_mwSync` 记用户选择，完成后还原；原生重开不在时间刻度尚未初始化时触发同步，待全部数据和自有视区恢复后再启用。WeakMap 串行快照防止并发保存误记临时关闭状态。原始 OANDA/Binance 四图快速切换及重开、OANDA历史锚点、10秒无保存循环全部真实部署通过，见 `date-sync-public-snapshot-{deployed,history,original}.json`。旧未重存布局没有该新元数据，兼容路径仍待最终审计，不隐瞒旧候选失败。
- 完整后端 **297 passed，零跳过**，含真实PG16备份恢复（`backend-pool-recovery-full-pg16.txt`）；34前端VM通过，快照与并发保存回归先红后绿。PG17工具对PG16服务端的备份测试曾失败，换匹配PG16工具后通过，失败保留，不作为产品修复。
- 当前统一 API/三个worker：`sha256:8267353500a5ed456fdfcf9ac0cb63fba51a7b40522630949d7b0a9da9cb23fe`；chart：`sha256:259bf4e5b79f1fc95c107a9fc050307531c6275115d415b74ba957906e115d26`；web仍`9d44eb...`。池维护最后一项小改由42相关测试覆盖，尚未跑完最终18周期和兼容矩阵，整体目标未完成。

### 2026-10-01 15:50 UTC：HTTP 超时与初始化复现

[最新诊断及证据](verification/provider-cache/timeout-and-initialization-diagnosis.md)：运行 API 的 Binance M1/198 根在 8511ms 失败，TLS 建连 7729ms，ConnectError + ConnectTimeout，额度排队仅 6.57ms。HTTPX 对照 HTTP/SOCKS 各八次 Binance 均 6/8、OANDA 均 8/8，不能更换协议就宣称解决；直连对照也不能把所有失败归为代理节点。

宿主专业图表页面取消懒加载，工作区请求发起从 344–383ms 提前至 51–58ms，实测省约 300ms。验收 TLS 对图表静态来源转发改 HTTP/1.1，gzip 生效，原生主库首次传输约 2.66MB 降为 812KB。没有改变 vendor/datafeed 取数策略。六次 OANDA AUD_CAD M1 空数据库首屏 1849–2247ms 通过，首次行情请求 979–1180ms，零页面错误；这不是所有提供商/九周期稳定低 3s 的最终证据。原生脚本执行、Binance 网络稳定性、累计 HTTP 预算和日期同步重开仍待收口。

当前 API/三 worker：`sha256:dee32c5bf7b9155d0cdc4dabaee34c0cfd7bd3ded98b80563eb9c9cb4d50a5ab`；web：`sha256:9d44ebd9a107315250716d86cd09ee3a86ab743ad911c7b56b1f30f856628455`；chart 仍为 `25b823...`。Web tsc/Vite Docker 构建成功、provider_chart 29 passed；此前完整后端 291 passed 未在这一轮重新全部执行。所有失败保留，整体未交付。

### 2026-10-01 最新继续验收（覆盖本节旧镜像/计数）

最新补充：日期同步候选改为完整多pane保存状态且dateSync=true时，等待全部dataReady+2RAF，再仅对activeChart调用setVisibleRange，原生自行传播；独立/部分历史刷新仍按原方式恢复。两次OANDA混合探针及原始OANDA/Binance组合探针全部通过，见date-sync-active-restore*.json；test-only源路由和生命周期探针已清理，33VM再次通过。实际chart已部署`sha256:25b823be08504caf14e644a51a55bf17a1f97bb70e3b927b2a7209882766b0db`。部署原始组合及OANDA缩小场景均遇上游HTTP预算超时/503，未走到重开，不能认定完整部署同步通过。失败日志表明排队通常3–27ms、HTTP约7.6–8.5秒，另有lease等待4秒，共同缓存占用也须排查；运输诊断仍在继续，整体未收口。


- 后端预热线程过去每次处理目标后固定等待1秒，已完成缓存目标也消耗一整秒；48条会话兴趣下历史20目标在241.8秒只完成3项。现在完成/推进目标后50ms继续轮转，空闲或前台忙仍退避1秒，上游每源历史1并发/1次每秒仍由跨进程额度控制。九会话共用缓存的真实worker控制流回归修复前额外等待9秒、修复后不足1秒，完整隔离PostgreSQL **291 passed，零跳过**，见`backend-postgres-pacing-and-timings.txt`；最新33项VM通过，见`frontend-vm-sync-final.txt`。
- 历史锚点真实空缓存验收通过，见`historical-prewarm-paced-cold.json`：2026-08-28周五20:55 UTC锚点，200根M5直接API返回2139ms；20项有限目标57027ms完成，右侧实有1000/4000根且连续覆盖已证，九周期同日期API缓存读取22–70.3ms，两个会话共享价格/缓存；显式九周期读取产生的新有限缓冲也完成后，15秒观察无继续扩张。独立严格根数/真实边界复核通过，自建批准起点/开关保持。此脚本测后端API，不是原生显示时延。
- API失败日志增加提供商、周期、根数、异常类型/HTTP状态及安全分段时间，不输出URL/凭据。API和三worker当前统一`sha256:44ef579e189bae6c4535379c978f5162ec1e8d3b98077d433e291f154fe51dc3`，web仍`sha256:2a9238d79f84e32d5d3bf0c08b19ab7f58ecd0c888f9d7bd8c4aaceb562fe8d3`，chart当前`sha256:591a35972a8285cacc477426dc350b23b0b303f4004425002c2f694a3e12207d`。容器已inspect一致、健康后重启web/TLS。
- 日期同步修复仍未确认：额外视区恢复关闭则没有原生undefined，但历史位置错误；等待全pane和两帧、同时关闭日期/时间sync、再把toggle变动延到等待后，个别轮通过而完整重复仍失败，失败证据全部保留。源码当前含这项候选等待/保护，不可记为完全修复。正在检验日期sync启用时只恢复activeChart范围、由原生传播，不再逐pane干扰同步。未改opaque布局锁字段、未修改vendor、未吞异常或降低零错误断言。
- Binance原场景出现真实503导致未ready，必须另外诊断；直接隔离进程HTTP六样本1153/590/217/221/465/496ms全200，另一冷连接read5216ms（上游4940ms），不能据热连接数据宣称原API稳定。此前冷首屏3秒失败仍保留。整体目标未完成；最终一致镜像矩阵/快速切换、相关SSE/修订复核、managed/手机/预警演练兼容、文档及本地版本交付仍待完成。


平台持久缓存及n15已部署本机隔离项目；普通及Python行情订阅均走后端SSE，已修复冷周期快速切换误取消。下方“未部署”“尚未迁移Python”等描述属于历史阶段，不是当前状态。

- 后端最新完整隔离PostgreSQL **287 passed，零跳过**；n15真实迁移回退/升级证明既有bar保留且changed_at正确回填。33项VM通过；主站终止SSE恢复回归修复前失败、修复后通过。
- Binance九周期有限预热约69秒达到4000或真实边界；D1/H4/M5切换1032/579/31ms；普通/Python SSE、无前端数据API轮询及关闭租约释放通过。D1超过1秒样本保留，不能称所有缓存切换均达标。平台操作没有改变BTCUSDT批准的自建起点与实时开关。见`verification/provider-cache/binance-prewarm-subscriptions.json`。
- 实际API重启暴露EventSource自动重连遇代理错误后进入CLOSED且永久停更；浏览器状态跟踪复现。主站传输层现在只在终止状态重建流并恢复最后交付游标；原生CONNECTING仍由浏览器处理。真实重启修复后通过：服务恢复14477ms、推送恢复15540ms、持久历史读取55ms、OHLC逐根相同、无reset、视区/柱宽保留/pending0。见`restart-persistence-sse-fixed.json`，所有原失败保留。
- 隔离库临时注入一根BTC M5历史修订并最终恢复原价格；公开reset在忙碌时保留待处理状态，随后真实getBars重读修订价格，原生dataReady及视区/柱宽保留；新添更早缓存不reset。见`historical-revision-deferred-reset-callback.json`。直接原生exportData验证因当前供应商包缺少zh.20866资源404而失败，已按既有“原生导出暂不可用”限制记录，未改供应商bundle。
- 修正上游请求排队后仍复用旧HTTP超时预算的问题；新回归修复前得到7秒、修复后仅剩2秒，排队计入总预算。API及workers已统一重建部署该修正。
- 最新九周期复测出现真实超标：OANDA M1完整冷首屏4149ms（API2273ms），另一轮3008ms；与此前18项全绿并存，不得删去失败或宣称3秒已稳定达标。新文档缓存请求多数26–258ms、需求到显示282–499ms；测试驱动最初混入预备请求，另一次原生countBack多一根造成冷缺口，都保留原记录并修正驱动条件。
- 资源跟踪发现初始化下载全部工作区约3.8MB；候选已改为首次只读取最近一个工作区，保留原完整列表接口。原生带哈希静态资源采用浏览器immutable缓存，不改bundle。正在重建镜像及复核，尚不能把这项优化记为性能达标。

仍需完成最终一致镜像冷/热矩阵、历史缓冲与跨周期锚点/多会话、并发让位与八图负载、managed及同步保存手机/预警演练兼容、最终文档和本地版本。整体目标未完成。

### 后续收口与真实失败（2026-10-01 12:33 UTC）

- 初始化只读取最近工作区、带哈希静态资源缓存及短月线边界缓存修正已部署。一轮18项全部数据库缓存需求到显示 **185–264ms**，均重新加载页面、后端cache_hit=true，排除原生bar内存缓存；浏览器静态资源缓存仍正常使用。冷首屏17项1940–2562ms、OANDA M1一项3215ms，故矩阵passed=false。API该项1672ms，导航到发起API1367ms，返回到显示176ms；1672ms不是已拆出的纯OANDA请求耗时。见`cold-and-fresh-cache-matrix-optimized.json`。
- 当前响应增加`timings_ms`，拆分有效租约等待、上游额度等待、HTTP完整接收、JSON解析、数据库提交及读取总耗时；数据不含请求URL/认证，未展示在产品流程。以前样本不能凭新增计量倒推纯上游耗时。正在补OANDA M1三次真实冷库分解。
- 已补齐历史右侧预热的实际根数与覆盖检查：自然时间仅作查询估计，休市造成不足时向固定激活时刻有界延伸，不将左侧旧bar算成右侧缓冲。独立回归验证闭市后补到实际目标、结束后不再请求。尚需真实历史锚点验证。
- Python订阅前置历史若跨不连续缓存会被误拼接；新回归修复前失败、修复后通过，缺口现在转公开reset重读，不输出跨缺口指标。最新完整后端 **290 passed，零跳过**；对应API及三个worker统一7d9c73995578、web2a9238d79f84、chart5a80abb1a732，完整ID最终再次inspect。
- 最新八图provider/managed混合5分钟通过，29次现场采样、零页面错误、柱宽6px保持、自建实时水位前进及历史任务运行。六个冷OANDA M5文档首屏最近秩p50=1569ms/p95=2982ms；27次热原生周期切换p50=29ms/p95=35.9ms。这是原生缓存参与的切换指标，不能当作数据库读取时延。见`mixed-eight-chart-soak-final.json`。
- 日期同步四图及快速切换范围正确，重开后仍复现原生未处理`undefined`拒绝；因此完整同步验收失败，不能以四图已经显示或soak通过掩盖。原失败见`date-sync-reopen-undefined-failure.json`。驱动早期ready变量尚未定义的独立错误另存，不混为产品缺陷。

仅本机候选，目标active未完成。API重启/修订证据来自之前明确的镜像；后续修改需要按影响范围最终复核，不能把所有旧结果贴到新版本上。

三次OANDA M1冷库分解通过：首屏2152/2190/2144ms；上游HTTP287.73/330.67/282.92ms；整个浏览器API462/439/393ms；短事务58.93/51.74/48.97ms；新页面DB缓存需求到显示306/222/237ms，见`oanda-m1-decomposed-timing.json`。这些是新的三次样本，不倒推旧3215ms失败样本的上游时间。

同步重开缺陷在跳过快速切换时仍可复现；浏览器独立Promise构造跟踪定位到原生`gotoTimeRange`的deferred拒绝。用公开同步开关在onChartReady之前访问模型失败、在onChartReady期间暂停并等待全部图表也未解决；两项实验均已撤回，不进入候选源码，不修改bundle或吞掉异常。继续定位，目标仍未完成。

## 平台后端取数重构：早期开发快照

2026-10-01 09:52 UTC核对：

- 新增独立平台数据集、bar和会话关注模型及`m14_provider_cache`迁移；缓存读取、供应商分页、覆盖合并和带代次租约已写入候选源码，网络请求在数据库事务之外。尚未验证真实PostgreSQL迁移或部署。
- 桥接已移除平台countBack乘三、首屏600根预取及平台业务分页，转交原生请求参数；后端按countBack加Python历史准备数据。普通平台订阅已有后端尾部刷新、SSE和公开历史重载候选通路；平台Python合成订阅仍需迁移，异步订阅/取消及重连生命周期仍需验证。
- 后台有限目标为当前周期优先、其他周期按D1→W1→H4→M5→M1→MN→H1→M30→M15，先1000基本窗口再4000深度；OANDA单页最多4000、Binance最多1000。默认值及限制见有效方案，均为待实测候选。
- 当前代码验证：新缓存7项测试及相关提供商回归共43 passed；TypeScript/Vite构建通过。范围证明、并发共享/取消、订阅间隙/历史修订、多会话与清理仍需专门验证，不据此宣称新方案完成。
- 当前容器仍是此前候选镜像，未包含这些改动；既有首屏、managed及兼容测试仅证明当时版本。新方案需重新完成真实冷/热九周期、预热负载、持久缓存重启、订阅恢复及兼容验收，保留失败样本。

以下各节保留此前实现和验收的追溯记录。旧countBack乘三、前端600根预取/分页/轮询、不写平台bar等描述不再是有效实施规则。

## 平台缓存新取得证据及连续切换问题

- 真实冷库18项（OANDA/AUD_CAD及Binance/BTCUSDT各九周期），导航到dataReady加两帧1.977–2.975秒；数据API328–1225ms，前台约198根countBack，BTC月线111根并确认真实边界。见`verification/provider-cache/cold-first-screen.json`。这些样本来自m14候选；最新n15及取消修正需后续最终复核。
- OANDA后台九周期约38秒到4000根或真实边界；D1/H4/M5切换532/478/33ms；普通与Python订阅SSE更新、无前端数据API轮询、退出后订阅租约归零、测试品种自建bar/job为零。见`prewarm-subscriptions.json`。首次断言误用全库managed行数（持续实时worker正常新增）导致失败，原失败保留，改为测试品种隔离断言。
- 立即切换未预热周期一次样本：OANDA H1 1134ms、Binance M15 2450ms；逐个加载九周期后各20次80ms间隔重叠切换成功，末周期正确、pending0、无页面错误。见`immediate-and-warm-rapid-switch.json`，不能当作冷周期快速连续切换证明。
- 补测首屏后尚未缓存周期连续20次切换：OANDA发生60秒后仍未dataReady，无页面错误；见`cold-rapid-switch-initial-failure.json`。正在最小化与定位，不能宣称连续切换稳定。缩小为W1→M1两次的当前复现成功，仍需找到必要触发序列。
- 最新后端完整隔离PostgreSQL284 passed、零跳过；新增n15区分实际changed_at与重复observed_at，修复历史重复观测误reset；SSE重连恢复交付游标，HTTP取消停止等待/后续分页而不取消其他租约。导出内部同步读取调用在异步路由改造后的4项回归失败已修正，全量284通过。最新运行镜像需按现场inspect核对。

## 冷周期连续切换修复

最小失败为W1→M1→W1，每次80ms；原生对W1/M1只调用getBars一次，桥接按当前显示周期取消两次，切回W1时原生复用已失败的周期缓存，未再请求数据，dataReady保持false。唯一周期六次序列及两次切换通过，说明重复进入正在读取的周期是必要触发。

修复：平台getBars按工作区epoch管理取消，临时周期变化不取消原生仍持有的getBars；完成后交原生回调，不因当前公开周期不同丢弃结果。自建旧取消及工作区替换取消保留。新`advanced-provider-request-lifetime.cjs`修复前红、修复后绿；33项VM通过。真实最小同序列修复后1559ms就绪，见`cold-rapid-switch-minimum-fixed.json`；完整20次原始冷周期场景及之后20次热周期场景均已完成：OANDA首屏2322ms、立即切H1 449ms，冷20次总4138ms、热20次总1673ms；Binance首屏2473ms、立即切M15 2088ms，冷20次总3720ms、热20次总1672ms。总耗时包含约1.6秒点击序列；最终周期正确、dataReady、pending0、页面错误0、全部公开Promise完成。见`cold-and-warm-rapid-switch-fixed.json`；每源仅一轮，不等于任意负载稳定性保证。

另修复不连续的较早缓存减小直接请求根数的问题，并补测试；缺口请求未覆盖时取完整countBack，不能扣掉隔着未查询空隙的旧bar。最新候选已重建并部署，最终运行ID与测试以现场记录为准。

## 当前源码

- 裸 ticker 永久代表 managed；平台 ticker 为 `MWP:<基础品种>`，包括带目录前缀的 `MWP:OANDA:EUR_CHF`。旧工作区及原生保存状态没有重写，也没有复制画线。新工作区默认平台黄金。
- `advanced-host/series.js` 和 `backend/alerts/chart_series.py` 固定身份规则；搜索先列平台，再列自建。Python 合成 ticker 保留基础系列；普通数据请求显式提交 `series_kind`。原生 ticker 不同，因此画线共享键区分两类行情；同工作区跨系列画线已通过真实容器浏览器验证；跨工作区、保存重开完整验证仍待做。
- `provider_chart.py` 参数化 OANDA 和 Binance 九种周期，独立内存缓存和同键在途合并，账户/目录、来源、周期、价格口径、分桶版本参与缓存键。不写 managed Bar、覆盖或导入任务。
- OANDA 使用 Bid、非平滑、NY17 与 Sunday 周界线；原生周期 OHLC 用于历史和形成中订阅更新。日周月 `chart_time` 与原始 session start 分开。真实行情查出并修正了 NY17 月线从前一自然日开始导致月底被错误算成翌日的问题，已加 DST/跨年回归。
- 平台数据失败走错误，不伪装历史结束；仅成功的原生 count/to 查询返回不足页时声明真实上游边界。请求有总时间预算、限量并发及退避。桥接旧请求可按工作区和当前系列/周期取消，父页面对普通 data 请求也传递 AbortController。
- 平台 Python 指标调用同一 Python 算法，前置历史按实际周期读取；CSV 也保留系列。平台 watchlist 查询不续租自建 M1 活动需求。平台不会经过旧 viewport 自动补数通路。

Docker 权限已恢复，通过 `sg docker` 操作。本机独立项目 `market-watch-dual-acceptance` 已运行三类同一候选版本镜像，独立数据库 `market_watch_dual` 位于本机隔离 PostgreSQL 容器；旧 `market-watch-acceptance` 项目保留原样。候选代码仍在更新，最终版本验收尚未完成。

## 已取得的证据

1. 后端既有全量测试：235 passed / 7 skipped（跳过隔离 PostgreSQL 所需用例）；之后新增月底回归及工作区隔离用例，相关 25 项全部通过。最终完整 PostgreSQL 验收尚未执行。
2. 前端 TypeScript/Vite 构建通过；新增身份/搜索默认/平台 datafeed 测试通过。已有 VM 回归发现两个旧测试假对象缺少实际公开刷新接口；补全对象后保留原断言并通过。
3. 真实上游只读验收：EURUSD、XAUUSD、账户目录 EUR_CHF、BTCUSDT，四品种 × 九周期，全 36 项通过。见 `verification/provider-series/native-periods-live.json`。每组仅一个样本，冷请求约 0.31–1.88 秒；热数据来自此进程缓存，不能充当浏览器网络性能分位数。
4. 本机真实浏览器：候选源码 + 当前供应商原生包 + 真实 OANDA/Binance + `/tmp/mw-dual-provider-acceptance.sqlite` 隔离库，入口 `http://127.0.0.1:16100` / 图表 `http://127.0.0.1:16101`。六周期切换、SMA、2020 年历史跳转、八图同时请求通过；每图实际品种/周期/视区有断言。见 `verification/provider-series/native-browser.json`、`native-browser.png`。这不是最终一致镜像容器验收。
5. 浏览器结束后隔离库 candles/import_jobs/market_data_demand/chart_viewport_demands/chart_aggregation_jobs 全为 0，证明该次平台行为没有写入自建数据或创建维护需求。

八图初始失败保留在 `/tmp/mw-provider-browser-failure.json`。定位到并发测试沿用回调形式并不断激活不同图表，原生 Promise 被忽略，产生未处理拒绝和非目标周期。改用该包公开的 Promise 接口及 `doNotActivateChart:true`，并新增逐图精确品种/周期断言；缩小复现及原始完整序列均通过，没有删除错误断言。仍需覆盖真实原生 UI 快速操作及更长时间运行，不能由此宣布全部竞争条件已解决。

## 自建持续维护和发布：已实施候选

- `managed_dataset.py` 提供明确起点提交、按NY17/UTC0交易日期解析、持久实时启用、固定初始化水位、各周期发布及只读分页。新增 `l13_managed_publication` 可逆迁移；`chart_published_bars` 保存可见快照，原 `candles` 用作获取/聚合输入，失败或待生成修订不会替换此前可见K线。
- `ChartHistoryPlan.cursor` 倒序推进。每次仅调度一个600分钟段，并等待较新缺口处理；分段是工作单位，首次开放仍按实际绘图区宽度 / 柱间距的三倍完整根数。完整到达批准起点后允许真实的较少完整K线；指标不足另行判断。
- 图表已替换旧自动扩大历史目标、等待动态补齐及后台自动重置逻辑。维护表单只有历史起点，提交开启持续维护；拒绝不建任务、不切换系列。明确刷新载入新历史并保留视区/柱间距；会话历史左边界冻结，右侧订阅持续读新发布数据。
- 历史取消只取消回填，实时开关不变。最新轮询和近24小时缺口修复由 realtime-worker 独立执行，修复任务每段最多120分钟；更旧缺口优先级50，不能整体提升多年历史预留。历史任务在实时修复排队时让位。
- `market_resources.py` 使用数据库短事务维护跨进程上游令牌和可过期租约：每源历史1个并发/每秒1次，实时预留2个并发/每秒2次；网络等待不持有数据库连接。每服务数据库池1/overflow0，历史/聚合CPU各0.5，实时独立1CPU。资源参数及真实负载还需继续调优验证。
- 旧已有且有覆盖证明的本地历史由发布器采用，不下载新历史、不改变旧维护开关。新搜索/报价不会给未批准品种续租M1需求。未经覆盖证明的孤立bar不拼成完整历史。
- 任务界面显示历史起点、倒序位置、初始化覆盖、实时维护水位/失败、各周期完整根数及范围；已打开周期显示实际尺寸门槛，其他周期明确标记示例。搜索结果显示维护状态。
- 应用加载/进度状态转为屏幕阅读器状态，任务信息在独立界面。原生文案使用公开 `custom_translate_function`，针对正式原文 `No data here` / `No data` / `Loading` / `Loading...` 返回空串；不修改bundle。真实无数据截图已确认绘图区无占位文字，其他原生加载场景仍须核实。
- advanced CSV只导出已发布范围，未维护范围返回明确409，不为导出或指标擅自向批准起点之前创建任务。传统轻量图表接口仍保留原兼容路径，advanced请求明确带 `published:true`。

## 新取得的真实容器证据

1. 完整后端 + 本机隔离PostgreSQL：248 passed，零跳过。见 `verification/dual-container/backend-postgres.txt`（持续更新记录）。SQLite迁移回归保留旧起点、状态，真实隔离容器执行 `upgrade head → downgrade k12 → upgrade head` 均成功。
2. 三类候选镜像 `dual-wip-20261001`，入口 `https://localhost:15453` / `https://127.0.0.1:15454`；worker只连接独立隔离数据库，通知强制关闭。运行时API/三个worker合计4条连接，未扩大共享预算。
3. 平台原生浏览器：六周期切换、Python SMA、2020年历史跳转、八图并发通过；零页面错误、零managed历史请求。见 `verification/dual-container/provider-browser.json` / PNG。
4. 自建浏览器：账户EUR_CHF从未维护状态进入，拒绝后无任务；只有历史起点的表单加入维护；实际绘图区948px / 柱间距6px门槛474根，14.198秒时已有624根完整M5，并在整月回填未完成时开放。明确刷新柱间距仍6px；取消历史后实时启用；同工作区managed/provider画线永久隔离。见 `verification/dual-container/managed-browser.json` / PNG。
5. 浏览器关闭、历史已取消后再次独立读取，实时发布水位继续前进7分钟；运行期4条服务连接。首次真实验收发现桥接作用域错误（readonly未定义），已复现、修正并补managed VM回归，原失败证据保留 `/tmp/mw-managed-container-failure.json`。
6. 真实运行发现旧实时查询覆盖带秒/毫秒起点，会污染倒序游标；覆盖读取现统一向内取完整M1边界，新增回归防止小数分钟分段。最新源码较上述首次容器验证有后续修正，需重建再验证，不能把旧证据当最终版本证据。

## 仍需完成

- 最新一致镜像重新验收；重启/断线/近期修复积压和历史让位、长时间负载及通知内部延迟的量化验证。
- 最早历史检查已加入新维护提交；仍需核对旧迁移计划遇上游边界的恢复状态。
- 平台冷/热首屏、快速真实UI操作的分位数及较长运行，不用单次和进程缓存毫秒结果作网络SLO承诺。
- 跨工作区/跨周期画线、比较、原生工具/Python指标、保存重开、手机、预警/演练完整兼容回归。
- 所有验收条目收口后补使用/版本/回滚文档、本地Git提交；不push、不操作生产。

## 追加验收

- 最新后端全量隔离PostgreSQL 248 passed；managed/series VM通过。
- 真实容器重启保留原历史起点、固定初始化端点、取消状态和实时启用；发布记录保留，四个服务连接预算不变。
- 同系列M5→M1画线共享、不同工作区画线隔离、保存重开后保持品种/周期/画线、手机单图只读临时切换不改服务器文档/修订，全部通过。见 `verification/dual-container/roundtrip-mobile.json`。首次保存驱动在原生切换守卫尚未释放时调用保存，被既有“等待图表就绪”保护拒绝；驱动等待实际保存条件后同一断言完整通过。
- 新维护在数据库事务之外查询提供商真实最早M1；OANDA使用正数epoch+1秒（from=0被上游当成省略，会误返回最新），Binance使用startTime=1。真实API提交BTCUSDT的2000-01-01起点返回422，明确最早M1为2017-08-17T04:00:00Z，原批准起点和状态完全保留。见 `verification/dual-container/unreachable-start.json`。

## 2026-10-01 后续修正与实测

- 旧覆盖采用现在使用与发布器相同的完整分钟证明，不再直接采用带毫秒的查询边界。新增1ms、1234ms、59999ms回归，证明短历史能完成初始化并开放；不足完整一分钟不建立采用计划，已有明确批准的计划不被采用器改写。隔离验收库中两条未交付候选采用的EURUSD/XAUUSD记录已单独向内规范化，EUR_CHF/EUR_GBP用户提交起点未修改。
- 当前完整后端隔离PostgreSQL结果 **255 passed，零跳过**，见 `verification/dual-container/backend-postgres.txt`。31项VM通过，见 `verification/dual-container/vm-tests.json`；TypeScript/Vite构建通过。
- 新旧维护起点都检查实际上游最早M1。旧计划检查在数据库事务之外执行；不可达状态保留原批准起点、已发布快照和实时启用，阻止新历史下载。用户在维护表单明确提交可达起点后才纠正该不可能起点。真实BTCUSDT隔离实验通过，见 `verification/dual-container/legacy-boundary-live.json`；实验结束恢复原验收计划。
- 任务界面补充起点边界错误、下载/聚合失败区间、异常类型、尝试次数和自动/手动重试状态。空结果或失败回调恢复公开`captureTerminalCompletion`，防止原生未触发`dataReady`造成范围同步守卫挂起。忙碌时拒绝明确刷新先保留当前managed会话，避免删除会话使实时轮询停更；同系列同周期多图只刷新一次。
- 原VM测试中的`historyQuery`自动补数模拟已按新规格换为已发布数据读取，保留大countBack、去重、独占截止、游标不推进、旧工作区取消、月线短/空历史、空结果释放同步守卫等断言。周线后台完成不自动重置视区，显式刷新才载入；失败保持错误，不能返回noData冒充历史边界。历史活动租约故障断言换为持久维护不依赖视区租约的断言。旧progressive模块的独立兼容测试仍保留，不能用其通过来证明新产品会自动补数。
- 当前一致候选镜像上，隔离库备份后删除最近150分钟M1获取记录及相应覆盖，保留发布快照；真实Binance轮询自动发现缺口，形成优先级0修复。临时延迟修复执行时，历史队列没有新增任务/推进，最新M1继续前进；本次收盘后入库延迟5.910秒。释放后4.014秒补齐全部150分钟，随后新历史分段恢复并继续发布，M1唯一键无重复。见 `verification/dual-container/recovery-live.json`，可重跑`scripts/verify_dual_recovery.py`；它强制检查本机隔离库身份，不操作共享库。
- 在提供商浏览器请求和历史任务负载旁，真实已观测BTCUSDT交叉创建内部监控，由实时worker14.056秒内处理，生成一条signal及outbox并立即确认取消发送。无通知worker/真实发送。该数字是已观测历史交叉的worker调度等待，不能宣称收盘至外部通知SLO。真实API演练的未来隐藏、M5单步、与managed OHLC一致、导出重开，以及拒绝把`MWP:BTCUSDT`传给旧预警/演练均通过，见 `verification/dual-container/managed-compatibility-live.json`。
- 真实浏览器性能与5分钟八图混合负载正在验收。初步完整冷文档首屏明显长于上游单请求，仍需网络/原生初始化分解。原生日期同步会按不同数据集重新拟合小数柱宽，资源负载实验改用独立视区严格保留6px；日期同步兼容必须另外验证，不用独立视区结果替代。失败原始证据保留在`/tmp/mw-dual-stress-*.json`，不能据此宣称长时间负载已通过。

- 八图混合负载已完成5分钟并通过：provider/managed并行、历史回填继续、已取消历史的品种实时发布继续；独立视区柱宽均保持6px，观测实时发布水位距当前未超过120秒。见`verification/dual-container/stress-browser.json` / PNG / log。该结果覆盖5分钟资源负载，不等于更长稳定运行或日期同步验收。
- 这轮完整冷文档样本均为 **OANDA平台M5**，六个未维护品种分别14.392、25.613、24.002、23.589、16.890、11.780秒；计时从页面导航到桥接ready且原生dataReady，包含网页/原生初始化，不是单独上游耗时或GPU绘制完成。不能代表其他周期、Binance或自建维护时间。此前报告的p50为最近秩算法16.890秒；六样本普通中位数为20.2395秒，小样本不作总体SLO承诺。
- 用户再次明确：自建数据首次维护/准备不承诺完成时间，验收按三屏/批准边界开放、任务进度、已发布范围和持续实时更新判断。
- 原生实际周期菜单连续点击M1→M5→H1→D1→M5、最终就绪，以及平台BTC/XAU比较、独立百分比轴保存重开通过，零页面错误。见`verification/dual-container/native-ui-browser.json` / PNG / log。初次驱动的ReferenceError已修正且原失败保留；本次点击ms仅表示UI响应至周期切换，不是行情加载完成时延。
- 原生UI轮的M5完整初始化为11.764秒；首个K线HTTP读取在导航后1.603秒发出，2.026秒收到；后续初始化发生第二次K线读取，导航后8.640秒发出，3.111秒收到。该迹象要求分开核对初次数据显示与工作区完整初始化，不把11.764秒全算作上游网络等待。重复初始化、报价排队和桥接通道竞争仍需分别验证。

以上仍是候选阶段。最新镜像集完整功能、性能结论、日期同步兼容、使用/版本/回滚文档与本地提交仍待最终收口，整体目标未完成。

## 平台首屏性能目标收紧后的候选

用户确认平台全部支持周期首屏应低于3秒、最好2秒，常见首屏约200根，并准备约三屏600根浏览缓冲；自建首次维护时间仍不作承诺。

- 新真实浏览器反馈环`web/tests/advanced-provider-first-screen.browser.cjs`，分别记录原生dataReady+两帧机会的数据显示、工作区完整初始化、首个HTTP页根数与实际绘图区/柱距、provider取得时间；严格检查3秒、三屏或真实上游边界、保存不创建重复工作区。
- 基线OANDA/AUD_CAD/M5：首屏5.561秒、完整初始化12.700秒，首次198根且重复读取188根，失败证据`/tmp/mw-first-screen-baseline.json`。
- 新工作区初次身份绑定改为公开`saveChartToServer`返回服务器ID，不再`save→load`重载；仅该初始化保存可绑定已有空工作区ID，后续另存仍创建副本。首页按原生countBack取三屏，provider高周期取消managed专用3M限制。身份/保存真实回归已证明不增副本；完整跨工作区/手机回归待最新镜像再次执行。
- 新文档首屏报价等主K线首请求完成/错误后才发出；桥接只允许一个报价请求在途，K线/工作区请求优先，仍限制4个总在途。OANDA同样M5真实首屏降到2.928秒且594根，但Binance本次仍5.997秒，不能称全部周期达标。
- 提供商请求槽按OANDA/Binance分别限流，避免独立提供商互相阻塞，数据库实时预留和每源预算不变。确定性并发回归已先失败后通过。按API生命周期复用有界HTTP连接池，关闭时释放；报价按15秒轮询窗口合并缓存，不写managed数据。相关29项后端回归通过，完整后端和九周期容器性能矩阵待本轮镜像验证。

- 后续资源修正：交互图表和历史/报价分开跨进程额度，每源2实时+2交互+1历史并发及每秒预算，实时预留与数据库预算不变；新额度隔离回归先失败后通过。首屏不再排在自选列表或历史回填之后。脚本/JSON保留每轮失败，没有提高3秒门槛。
- 一轮18个真实冷页中OANDA九周期全为1.575–2.681秒，Binance单个M15仍4.957秒；见`verification/dual-container/first-screen-candidate.json`，**passed=false**。其他轮仍有OANDA3秒以上的网络波动，不能据一次OANDA全绿宣布性能完成。
- Binance直连官方data域名拆分：本机额度等待4–7ms，HTTP约1.23–2.67秒，另有直连4.268秒样本；候选改用已有授权代理后进程HTTP池的九周期热连接读取约0.18–0.41秒，冷连接3.269秒。主站冷文档仍须重新验证；没有把热连接/上游小样本当成完整首屏结果。其他官方api/api1域名连接失败，未切换到非官方源。
- API启动仅预建HTTP传输连接（HEAD根路径、无认证、无K线预取/缓存）；实际冷页仍检查as_of新取得时间。初次测试驱动错误调用尚未ready的activeChart已修正为等公开onChartReady；原失败证据留在`/tmp/mw-first-screen-proxy-warm.json`。后续候选出现Binance 503，仍在诊断，不记为完成。
- 最新完整隔离PostgreSQL **261 passed，零跳过**，31个VM均通过，前端容器构建成功。新形成中bar回归确认完整前缀、未收盘不计入开放数量、实时更新不重复；发布事务中断保留快照/修订。最新画线跨周期/工作区、保存重开、手机只读真实回归通过，见更新的`roundtrip-mobile.json`。
- 真实隔离PostgreSQL复制15根已观测BTC M1到临时品种：延迟聚合时不扩展发布；真实聚合写入后注入异常，事务回滚且attempt/error持久保存，旧两根M5及修订不变；重启真实聚合容器后补成三根，前两根不变/无重复；发布提交前中断再次证明回滚。见`publication-recovery-live.json`，脚本`verify_publication_recovery.py`；临时品种全部清理，worker恢复。
- 日期同步四图实际日期范围对齐通过；快速周期切换最终M5通过。但重开出现原生未处理undefined拒绝；缩小复现又暴露Binance请求失败造成未就绪。两个问题分开诊断，保留`/tmp/mw-dual-range-sync-*-failure.json`，不能将资源独立视区或范围对齐结果替代完整同步验收。
- 新使用/本机候选回退文档已写：`chart-dual-dataset-user-guide.md`、`chart-dual-dataset-local-delivery.md`。明确候选未交付和迁移回退需备份；最终版本元数据、镜像ID、提交/标签仍待验收收口。

## 首屏并行取数及一致镜像复核

- 新平台工作区在原生初始化时同时请求所选周期最新600根，首次`getBars`复用这次请求；原生`countBack`更大时继续正常分页，首次目标仍为`countBack × 3`。该倍数是应用datafeed策略，不是原生库默认行为。保存了历史位置的工作区按原生exclusive `to`向左读取。当前不做其他周期或更早历史的后台预热，切换周期按需读取、按系列/品种/周期/范围缓存；订阅每15秒读取当前周期最新3根。
- 并行策略的一轮真实18项首屏全通过：OANDA/AUD_CAD九周期1.361–2.064秒，Binance/BTCUSDT九周期1.339–1.519秒，17项低于2秒。见`verification/dual-container/first-screen-browser.json`。计时为页面导航至公开原生`dataReady`及两帧机会，不代表GPU完成，也不证明网络所有样本都满足3秒。
- 新未维护品种OANDA/EUR_CAD真实维护完整用例通过，更新`managed-browser.json`/PNG/log；拒绝不建任务、单起点持续维护、三屏开放、取消历史保留实时、刷新柱距及画线系列隔离均通过。实际948px/6px门槛474，479根完整M5允许该视区开放；默认960px对应480根尚不足是独立几何判断，自建不承诺首次完成秒数。
- 清除临时性能日志后，API及三个worker已经统一部署到同一镜像`sha256:b154e5527e347fc9dcf19fec083e5df44bf9e4e12ce38d53e01e7e581e942132`，API健康后重启web/TLS。最新31项VM全部通过，`diff --check`通过。
- 一致镜像18项重复矩阵未全通过：17项首屏1.301–2.209秒，Binance月线6.350秒，HTTP页耗时5.592秒，导航后0.612秒发出；页面错误为零，返回111根及真实上游边界。见`verification/dual-container/first-screen-clean-final.json`/log。这一失败必须保留，不能以此前全绿样本宣布所有周期性能已收口。继续核对调度等待和上游网络波动。
