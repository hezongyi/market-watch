# 连切正确性与平台分段测量

用户于 2026-10-23 选择继续：先解决连续切换未就绪并建立回归，再细分平台任务认领、填充、轮询与结果应用，按证据调整局部调度。不授权全系统重写、合并或生产发布；此前 mwa 更新并验收授权继续适用。

## 固定起点与范围

- 原集成基线 `983b402`；本轮增量起点 `63e6908`；开始时 mwa 产品为 `defdcf9`。
- 沿用既有独立 worktree、分支和长期 mwa，保留真实数据、配置、MCP、网络、端口、TLS、原工作区 revision 78 与受保护 profile。
- F1：涉及原生数据读取、指标取消围栏与后台任务。没有 schema、持久格式或供源语义改变；结果轮询新增兼容的能力标记和最终进度元数据。
- 先保留既有并发限额及统一桥接队列。取消围栏不能丢失或降低世代，合批不能超过现有 64 行 HTTP 校验上限。
- 报价只共享尚未完成的同集合读取；每个消费者保留独立取消及 reset 判断，完成后的下一次读取必须重新获取。

## 已取得的复现与最小回归

`deep/probe-rapid.cjs` 使用全新临时浏览器，阻止保存工作区、偏好、告警与通知。失败关闭浏览器前保存图表、父页生命周期、桥接排队/派发和 HTTP 证据。私有结果在 `.mwa-watchlist-latency-20261022/rapid-*`，不入库。

原候选第一轮诊断：前两轮完成，第三轮 M5 90 秒未就绪，其他四图 ready；末尾 parent admitted/cleaning/queued 与 bridge pending/queued 均为零。捕获到 `图表请求过多，请减少指标`。第二轮较短复现同时出现 H1/M5 未就绪；两轮持久状态哈希均未变。

队列达到 64 项时，报价占约 42–53 项。既有单飞只限制执行，无法合并重复读；失效请求只在被选中时回收，忙碌通道中的旧请求仍占排队容量。当前首屏 getBars 被拒绝后，原生线程并不会在队列归零后自动重新发起该请求。

最小真实桥接/datafeed 回归命令：`cd web && node tests/advanced-watchlist-quote-pressure.cjs`。原实现不足 1 秒确定失败；只修失效项回收后，重复的有效报价仍能使第二个断言失败；加入同集合在途共享后通过。

四轮浏览器价格通过后仍发现 40 项指标释放积压。`advanced-indicator-release-batches.cjs` 经真实 coordinator release 回调复现相同准入失败；合并未派发释放、保留每个消费者最高世代后通过。`advanced-quote-snapshot-sharing.cjs` 验证消费者取消、不同符号顺序、完成后新读、对象 reset 世代隔离。

加入上述三项修复后的临时浏览器覆盖连续 6 轮、30 次切换，五图价格全部完成。该结果尚不等于原指标、翻页、报价、回收与已部署产品全部验收通过，也不是稳定窗口 p95 或正式 SLA 结论。

## 测量合同与后续验收

1. worker 记录安全的任务 ID、世代、创建/认领/提交时间、认领事务、填充和提交耗时。填充即使以 HistoryPending 结束也保留实际供源/租约/提交计时。
2. 同循环价格认证单独记录耗时，用于判断是否推迟历史任务认领；不得仅凭函数顺序改调度。
3. 浏览器关联桥接排队、提交、状态轮询、最终 result、datafeed 回调返回和原生 onDataLoaded，按同任务区分阶段；价格 ready 不代表 Python 指标完成。
4. 定向 Python 与前端回归、构建和独立 Standards/Spec review 后，固定候选镜像更新 mwa；复跑原始五图/指标/翻页/连切/报价/回收，并核对持久状态与运维配置。
5. 仅对测量证明的等待位置修改局部调度；缺少证据则保留测量和结论，不以增加并发或全局重构代替诊断。

## 当前验证边界

前三组前端 runtime 合计 53 条命令最终均通过。`advanced-capacity-boundary.cjs` 在共享负载下首次触发原有 5 ms/一轮事件循环时序断言，单独复跑及剩余组复跑通过；该测试只加载未修改的 native-navigation，不能隐去首次失败。后端 42 项定向测试与 7 项真实隔离 PostgreSQL 测试通过；后者覆盖新增 pending 回合计时及既有指标取消、容量与锁合同。任务 PG 已停止，volume 保留。首次 PG 连接使用未实际发布的本机端口，测试未执行；改用隔离容器地址并确认 TCP 就绪后全部通过。部署业务验收及阶段测量待补录。

## 独立审查跟进

`63e6908...5c03861` 的 Standards 未发现硬性规范违规，提出诊断脚本状态核对失败会跳过浏览器关闭的 P2；已捕获核对错误，并以独立 finally 保证关闭及保留原失败信息。消费者世代归并的重复代码为可选 P3，本轮不扩大重构。

Spec 发现共享报价的晚加入消费者用较晚观察边界处理较早 HTTP 操作，可能将期间收到的 SSE 行情误标为失败，或在时间戳相同／缺失时被旧结果覆盖。真实 bridge 回归已先红后绿：共享操作保存建立时的观察边界，结果与失败均使用该边界；消费者取消和 reset 仍分别检查；共享完成后新请求的真实失败仍必须标错。相关七项前端回归复跑通过，增量独立复核待取得结论。

上述两项 P2 已由原 Standards／Spec reviewer 分别复核关闭。`b7ef7be` 的 API／10 worker 与 Chart 已更新到原 mwa；Web 保留 `defdcf9`。部署后原五图、原 study 有限值、三类价格、两类翻页、三轮加载中连切、报价、资源回收与持久状态检查共 13 项通过。此为短时业务验收，不能外推长期无退化。

## 依测量调整结果轮询

`b7ef7be` 第一轮两次平台切入关联到 10 个原生历史任务：创建至首次认领 53–2709 ms、单回合填充 511–1453 ms；首轮 ready 提交至浏览器观察 101–1671 ms，额外结果 HTTP 79–2488 ms。图表回调返回和原生 data-loaded 均为毫秒级。同循环未观察到实际认证任务或 ≥250 ms 认证调用，暂无依据改变认证／历史调度次序。

第二轮增加 Playwright 网络时序：45 个 history HTTP 中，发出前等待中位约 0.975 ms、最高 2210.742 ms；发出至响应头中位约 336 ms、最高约 946 ms。API／market-stream-worker 有不同程度 CPU 节流；不能把全部等待归给任一处。探针、缓存、供源时点和共享负载未控制，不能声称受控 A/B 或稳定分位数。

局部改动使用现有 `/history-loads/{id}/result` 作为轮询入口：未完成仍返回 load，完成则同次返回 result 与最终 load 页数。`history-capabilities.result_polling=true` 声明该能力；字段缺失时新前端保留旧 status→result 流程，旧前端继续兼容新增元数据。轮询间隔、四生命周期、清理、取消、期限、缓存重新验证和供源口径保持；减少的是观察 ready 后的额外一次 HTTP，不增加并发。

真实 TS loader 的新轮询回归先红后绿，覆盖最终页数、重新等待、错误和轮询中取消，并保留旧协议测试。后端新增结果进度合同及真实 PG 测试。补跑中曾因主机默认解释器／editable 安装指向其他 worktree、以及误写测试文件名未执行目标测试；已固定共享 venv 加本 worktree `PYTHONPATH` 并核对真实模块路径，最终 18 项 native／capacity 测试、2 项真实 PG 测试通过。两个未纳入 CI 的旧 VM 脚本因缺少 document／composite bootstrap 在加载阶段失败，未进入断言；不混入 CI 已通过计数，不扩展为本轮产品修复。

本增量完整复跑 CI 的 Watchlist bridge 组 20 条命令均通过；TypeScript／Vite／data-center 构建、Ruff 与 diff check 通过。Vite 保留既有大 chunk 提示。任务 PG 已停止，数据卷保留。

## 最终复核、部署与复验

局部轮询固定为 `914525a`。Standards 无硬性违规／具体缺陷，Spec 无新增 P1/P2，并独立复跑 history-loading、history-admission 通过。API／Web 标准 Ubuntu builder 干净构建，检查来源与 chart origin；Chart 保留 b7ef7be，不冒充三组件同提交。

保存紧邻前版实际环境和精确回退后，部署 12 应用服务，持久 candidate 同步。15 服务运行、API／PG healthy，Chart／PG／gateway 与保护浏览器未替换，环境键值、挂载、网络、端口、命令、资源上限、Yahoo／MCP 保持。长期登记同步真实镜像和标签，清除前轮登记中矛盾的旧 ID／labels。

新分段测量四场景完成，关联 10 个任务，普通 status 轮询 0、ready 后额外结果往返 0/10。活动 H1 两次 bridge 排队均 0 ms；创建至认领 559–2606 ms，填充 416.86–1493.68 ms，ready 至结果头 462–1289 ms；回调本体 2–24 ms、至原生 data-loaded 3–25 ms。末尾生命周期及 bridge 归零、工作区保持、无浏览器错误；因超过 3 秒诊断线 exit 1，不当作正式 SLA 失败。

2026-10-23T01:41:43.595Z–01:43:20.616Z 业务复验 13/13，三轮 15 次连切恢复最终价格／原指标；两类翻页、报价、容量、工作区及偏好通过，无 pageerror 或意外 HTTP 失败。原生 admitted／cleaning／queued／cleanupFailures 全 0；业务末次 bridge 采样 pending=2、queued=0，独立测量最终 pending=0，不把前者称为全空闲。

脱敏数据与变慢反例见 [业务验收](continuation-business-acceptance.json)、[分段测量](continuation-stage-measurements.json)、[最终建议](CLOSEOUT-20261023.md)。建议按本轮批准范围收口；剩余平台／指标数秒等待，由代表性重复窗口和目标决定是否继续改造。未合并、打正式 tag 或发布生产。
