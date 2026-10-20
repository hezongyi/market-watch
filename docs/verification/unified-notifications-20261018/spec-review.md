# Issue #75 V2：最终源码 Spec 复核

日期：2026-10-18。独立 Spec 复核；不替代 Standards review、CI 或 Ubuntu R2 验收。本轮只新增本报告，未修改产品代码、启动服务或向真实手机投递。

## 比较范围与结论

- 固定基线：`v1.26.1 / 2fe919a23d4adcb97ca1a98caafbad8693a410d3`。
- 需求依据：[Issue #75 V2 完整方案](../../unified-notification-center-plan-20261016.md)，以及记录 Issue V2 同步和重新开发边界的[基线重新评估](../../issues/issue-75-v1261-reassessment-20261018.md)。未把关闭的 #85 作为实现或验收依据。
- 工作树：`/home/quant/repos/market-watch-issue75-implementation-20261018`；分支 `feat/issue75-chart-notifications-20261018`；当前已提交检查点 `df6460cb978413ca003ad87c6f16d14bd2ddbe1a`。此前 da5a2eb 后的三项产品增量及最新浅色 severity CSS 修正均已限定复核，见下方增量说明。
- 比较命令：`git diff 2fe919a23d4adcb97ca1a98caafbad8693a410d3`。当前最终产品差异指纹为 `git diff BASE -- advanced-host backend/alerts web/src migrations compose.yaml compose.production.yaml | sha256sum`，结果 `1ec7c6d410da7ce36baa49782cb78aa1a7fe9621b0187e5e48583e54346246b7`；BASE 为上述固定提交。

**本次最终源码复核：未发现仍未解决的具体 P1/P2 Spec 问题。**此前提出的来源覆盖、错误恢复、定位动作及 Runtime 入口竞态均已复核修正。该结论表示当前已检查实现没有已知阻断级需求偏差，**不表示 A1–A20/B1–B9 全部通过，也不表示 W6、合并或发布已获签收**。

## 来源、动作与生命周期核查

| V2 要求 | 当前源码中的对应实现与复核重点 |
| --- | --- |
| §1.1、§2.2：专业图表来源准入，旧主页退役兼容 | `notification_sources._chart_signal` 验证 SignalRow→ChartAlert→ChartAlertVersion；旧 watch/未知来源不进入新主动来源。`main.tsx` 保留兼容查询和显式手机停止，旧 Shell 独立自动发声路径退出。网页未读与旧 pending-count 分开。 |
| §2.1、§4.2：认证根部接收、主体隔离、取消栅栏 | `NoticeProvider` 位于路由内容之上；Runtime 在退出/401 事件暂停，按 subject 保存本机记录，以 generation 拒绝晚到结果。工作区和原生侧栏切换不重建接收器。iframe 接口校验 origin/window/channel/session/workspace/epoch。 |
| §2.2：工作区、偏好与真实失败尝试 | `operationFault`/`operation` 包装实际请求；草稿本机写入失败独立报告。symbol-flags 的有界冲突重试不逐次生成故障，最终失败和后续明确成功接入。 |
| §2.2、§4.2：图格历史、容量、指标/快照 | native history 在成功的 Core 更新事务内追加来源；范围和图表业务上下文决定恢复关联。历史导航与容量使用实际 occurrence；指标消费者仅在恢复预算耗尽且上下文有效时报告，取消/释放/旧代次不形成新失败。 |
| §2.2：行情与连接 | providerSubscriptions 记录有效订阅的注册/连接状态和真实数据错误；识别 quotes 的失败行、非 ok fetch_status、bars 的 error/connection_error。composite 恢复采用明确连接、归属及可用数据状态。bridge 初始/轮询请求按有效 owner 与返回结果报告，连续 outage 不逐 tick 写入。 |
| §2.2、§4.1：数据中心、导出、供源配置及后台任务 | 数据中心受控请求、provider configure、容量与各父页面对话框接入包装器；ExportDialog 保留取消行为。导出在源事务以 chart_import_scope 绑定共享 ImportJob；HistoryVersion、图表计划和 VolumeBackfillJob 终态有可靠来源，已失败共享任务首次绑定可捕获。failed_task_ids 的前端表现不另建同根故障。 |
| §4–5、§9：可靠投影、变更、留存与事故 | 源事务只追加事实，独立 worker 投影；receipt、事件和 changelog 同事务，发布锁决定 seq。历史 highwater/游标与 JSON/SSE 使用同一读取合同；reset/tombstone 不回放即时提醒。未处理来源不因普通留存丢弃，重建保留过期凭据。 |
| §4.2、§9：浏览器发生→恢复→复发 | Runtime faultIngress 在 hash/IDB 之前按调用顺序串行，并在执行前检查 generation；本机 stage 顺序和服务端 acceptance 顺序独立于毫秒时间戳。恢复引用具体事件，旧恢复不能关闭较新失败；永久拒绝项与已接收但尚未投影项保持可见。 |
| §6、A7/B2：上下文动作与离开保护 | 原生入口按来源提供返回专业图表、数据中心、容量设置或来源图格动作；图格定位验证当前 epoch/index/品种/周期，缺 index 时只接受唯一匹配。跨工作区经父页面确认离开；告警定位沿原适配器，未新增自动业务重放。 |
| §7–8：网页观察、声音与手机渠道分离 | viewed/handled、声音 reservation/started/failed/unknown 与原手机状态独立。手机停止显式调用旧 ack，渠道事实不增加发生次数。声音先持久预留，按 subject/profile/event 协调，30 秒使用服务器时间估计；原生展示不可用时保留父页面降级入口。 |
| §12、B8：加性迁移和应用回退 | 新 revision 的 parent 为 av49；回退约定保留新增通知表与 #74 需求表。旧二进制期间写入的图表信号及手机渠道可回填/对账，不依赖破坏性 downgrade 或重发业务告警。 |

## 本复核独立执行的检查

最终源码上执行以下三项，均 PASS：

- `cd web && node tests/notifications-runtime.cjs`：包含并发 report→resolve→report 的真实 Runtime 入口顺序，以及拒绝、投影间隙和业务结果隔离。
- `cd web && node tests/advanced-provider-subscriptions.cjs`：包含订阅取消/旧代次、连接及报价故障恢复、composite 状态。
- `node web/tests/advanced-market-stream.cjs`：原生回调代次/顺序、报价传递及不使用轮询。

同时检查固定基线以来的产品差异、来源合同、对应后端合同测试和迁移定义；`git diff --check BASE` 无输出。后端/PG 的全套执行结果由实施者汇总，本报告未重复运行或把他人报告的通过数记为独立实测。

## 验收证据与限制

已读取本目录的 `playwriter-contracts.json`、`playwriter-save-durability.json`、`playwriter-sound-and-stop.json`，分别提供接口/分页/SSE、刷新后待同步/最终接受、声音观察与显式手机停止的部分证据。声音 started 只证明 AudioContext 开始，不能证明人已听见。

实施者另在进行 Playwriter 真实来源与边界验收；本复核读取了其任务临时目录中的 actual-producers-results.json 和 boundary-results.json。前者含收藏终态失败恢复、容量保存失败恢复及数据中心 create 失败；后者含实际 Store/Runtime 的数量/字节/TTL/单条限制、声音受限/失败/预留崩溃、暂停会话和存储不可用结果。临时文件尚不能代替已归档的最终源码/镜像验收台账，实施者应把选取的脱敏结果、命令和最终候选关联写入本证据目录。

本报告不把上述有限路径扩大成全部 A/B 签收。仍需由最终验收台账逐项区分：真实生产者与种子负载、最终镜像与中间镜像、独立测试与人工检查。尤其多图/多指标和风暴下的持续交互/内存/DB 增长、完整键盘/焦点/读屏、全部故障组合、应用回退与恢复链路，不能仅凭静态源码或组件探针宣称完成。本复核未访问生产、未验证真实供应商或真实手机送达，也未执行最终 CI；后续产品源码变化须重新评估本结论适用范围。

## da5a2eb 后的限定增量复核

2026-10-18 补充复核，范围严格限定为 `git diff da5a2eb -- web/src/notifications/runtime.ts web/src/notifications/native.tsx web/src/notifications/notifications.css`。同时核对该提交之后的产品路径，只有上述三项文件有变化。**本增量未发现具体 P1/P2 阻断项，前述验收限制仍有效。**

- **A13：epoch/reset。** Runtime 把换代恢复进度写入瞬态 `status`，保留已有真实 `gap`；重置 `nextHealth` 使下一次成功同步刷新健康状态。既有清空候选/气泡、重取历史基线和 epoch 传播路径保持，未新增历史事件重弹或声音尝试。新增回归验证 reset 后真实缺失信息保留、恢复状态最终回到已同步；本复核独立重跑 `cd web && node tests/notifications-runtime.cjs`，PASS。
- **A1：筛选布局与气泡锚点。** 筛选网格采用 `minmax(0, 1fr)`，输入/select 明确 border-box、min-width 和 max-width，约束 vendor 样式下的横向扩张；不改变过滤语义或图表高度。入口查找排除无布局框、visibility 不可见、aria-hidden 或 inert 的副本，气泡定位使用同一可见入口。
- **A20：焦点与增量影响。** 入口查找的同一修正用于关闭中心后及角标更新后的焦点恢复，避免选中 vendor 测量副本；不扩大动作权限、不改变主体/会话/来源接收与持久格式。`git diff --check da5a2eb --` 上述三项文件无输出。

本增量的前端重建、最终镜像 TypeScript/CI 结果和 Playwriter 实际焦点、窄屏筛选及气泡定位复验由实施者继续记录；静态核对和上述 Runtime 回归不替代这些浏览器结果，不据此签收全部 A1/A13/A20。

## df6460c：浅色严重级别文本限定复核

2026-10-18，检查 `git diff df6460c^ df6460c -- web/src/notifications/notifications.css`。该提交仅把 error/critical 与 warning 文本色提取为主题变量：暗色保留原值，浅色分别使用 `#b42318` 和 `#82580e`。变量定义在现有 `.nc-panel` 主题作用域，列表和详情的 severity 文本位于该作用域内；没有改变来源、严重级别含义、筛选、动作或接收生命周期。

**此 CSS 增量未发现具体 P1/P2 Spec 阻断项。**按源码中浅色纯色背景 `#fff`/`#f4f5f7` 计算，danger 对比分别约 6.57:1/6.03:1，warning 约 6.27:1/5.74:1，均超过普通文本 4.5:1。此为颜色值计算，不能替代最终样式镜像的 Playwriter 渲染截图检查。`git diff --check df6460c^ df6460c -- web/src/notifications/notifications.css` 无输出；按本次限定范围未重跑全量测试。A1 的主题可读性有所改善，A20 的完整无障碍和全部 A/B 签收仍以最终验收台账为准。
