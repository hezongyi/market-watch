# Issue #75：v1.26.1 来源与事件合同复核

日期：2026-10-18。问题：原统一通知中心方案在 `v1.26.1` 上重新开发时，来源语义是否需要调整。本报告仅做仓库一手源码、Git 差异及既有测试定义的静态研究；未启动服务、未运行业务测试或浏览器验收。

结论：保留原方案的可靠来源日志、异步投影、独立变更流、父页面接收和渠道消费架构；重新固定 W0，并把 #74 新增的需求生命周期、可见完成、快照恢复和执行证据明确写入 W1。不能把这些状态消息直接全部转为通知发生。用户本次另行收紧范围：以专业图表为中心主动接收，旧守望主页告警/通知逐步退役；legacy 只保留存量证据、手机协议和必要历史深链的迁移兼容。持久化实现仍为 **F1 / R2 / D1**，原方案已明确这一点。[P1]

## 1. 固定研究对象

| 对象 | 固定版本与依据 |
| --- | --- |
| 原方案评审基线 | `b6fe6424853c8cbc325fb3ef02e7894aa680d412`，原方案注明业务代码同 `b53d2973cd70e8610154bc46a9d516e62ccdadd7`。[P1] |
| 原认可方案 | `e868fe6c9d0008ff32d46dbed2a125115a86cfe3` 中 `docs/unified-notification-center-plan-20261016.md`，使用固定提交引用，不依赖该文档是否存在于当前 main。[P1] |
| 新开发基线 | `v1.26.1^{commit}` = `2fe919a23d4adcb97ca1a98caafbad8693a410d3`。下文 `[S…]` 源码链接均固定到该提交。 |
| 当前 schema | 静态解析全部 52 个迁移的 `revision/down_revision`，唯一 head 为 `av49_indicator_demands`；源码迁移父节点为 `au48_display_indicator_tasks`，既有迁移测试也固定到 av49。[S1][S2] |

按用户本次决定，PR #85 的实现与验收不作为重开发依据；本报告不建议复用其代码或以其历史结果抵扣新验收。

主要新增来源合同可追溯到 `14e44d092da9c6639bdabbaacc5d601bfd9b522d`（需求生命周期）、`65984d13bbe734d06c49e8990a40640d459c6009`（取消屏障容量）、`c04612162a82052c9a53e23bcf681604af672f08`（有界精确前台重放）、`c43aac38f27b784ab54ced60b7630511d07b25ea`（实际提交执行证据）、`02169955b9259208fe2fa2e01843b8070a683d95`（冻结输入时间与持久前缀证据）、`05747581abf0e9694a464385732ef41a4687ad67` / `d56ffffc6662eff74d34091909419b236b4682fa` / `0eb0ef137154e40d35d4c3f45e4a07105d712c81`（快照恢复）、`e93a80e76322971b8c30fc61c811f5fa4ac1a853`（OANDA 账户蜡烛统一）。具体最终行为以以下固定行号为准。

## 2. 基线变化与当前范围要求补足的合同

### R1：需求释放、过期和取消是消费者生命周期

新增 `IndicatorDemand` 按 client + consumer 标识保存代次、run、snapshot、范围与用途；TTL 为 30 秒，取消屏障为 60 秒。释放清除的是该消费者需求，旧代次不能复活，晚到旧 release 也不能撤销新代次；取消屏障容量不足时会暂拒未知消费者。worker 仍保留无需求工作的有界服务份额及共享结果。[S3]

方案应明确：删除/隐藏指标、关闭图格、参数编辑、工作区切换、TTL 到期和 `HISTORY_CANCELLED` 不生成普通故障事件，不宣称后台共享计算已取消或已恢复。`INDICATOR_DEMAND_CAPACITY` 是可操作的容量拒绝，应按真实失败操作记录；每 10 秒续约和每 500 ms 协调检查不能各生成一次发生。[S3][S4][S5][S32][S33]

新接收 Adapter 必须保留 `indicator_consumers`、代次、update/release 及已有 transport cancel 通路，不能在整合通知时只保留旧版 data query。父页面和后端现在均有专用校验与路由。[S6][S28][S29][S33]

### R2：可见结果完成与持久任务完成分别判定

后端现在返回 `visible_complete`、`coverage/required_coverage`、`display_status`，且可在 durable run 尚未 complete 时，经有界前台精确重放返回完整可见结果。前端按这些字段判断是否继续等待，而非只看 run.status。[S7][S8]

方案应明确：`pending/partial/preparing` 是状态；可见范围已完整时，不因后台仍 pending 记录失败或持续显示“计算失败”。同一请求签名等待超过 30 秒才由现有协调器产生 `INDICATOR_TIMEOUT`，随后停止该签名的自动重试，用户重试重置等待状态。[S4] 这里的计算等待 30 秒，与原方案声音候选的 30 秒时效是两个独立合同。[P4]

### R3：快照过期先进入现有恢复状态机

当前恢复检查工作区 epoch、图格对象、品种、周期和绑定 token。相同内容 token 续约后再次过期仍需新恢复；已被替换 token 的迟到错误直接失效。provider 如能逐根证明当前已接受 OHLCV、cache revision 和页面范围未变，只更新凭据；无法证明才走现有有界完整恢复，最多三次尝试并保留可见重试状态。[S9][S10]

方案应明确：`DISPLAY_SNAPSHOT_EXPIRED` 本身优先作为恢复生命周期状态；如保留诊断记录，不产生逐轮气泡或声音。当前上下文的恢复最终失败才形成故障发生。`ready` 可作为对应事故的恢复证据；`removed`、切页或 token 替换不能冒充恢复。通知的重试动作调用既有恢复/指标重试入口，并重新验证上下文，不能重新实现取数、替换旧价格下的快照或恢复已移除消费者。[S4][S9][S10]

`snapshot_id` 不能单独作为发生身份：同一内容 token 可续约并再次过期。建议以一次恢复/操作尝试 ID 识别发生，用品种、周期、消费者及故障码等稳定上下文分组，token、代次和 epoch 作为当时证据。

### R4：新增执行证据需要分层保存，短期凭据不能承诺长期回查

四类系列已有不同证据：provider 返回 dataset、provider snapshot、输入修订与 execution；managed 返回 publication revision；history/composite 返回 history version、revision、input revision、display snapshot、run 与 display task。原生提交保留实际执行证据。现有验收判据还要求参数、算法、来源、周期、计算起点、快照、覆盖逐根对应，不能只凭指标名或一个 `canonical_verified=true` 判断来源正确。[S4][S7][S8][S11][S12][S31]

方案应把这些字段映射到详情的脱敏最小证据/受权引用，保留十进制原文和当时版本，不重新读取当前图表结果替代告警输入。已有 `SignalRow.evidence` 中的规则、观察、实际价格和阈值仍是告警证据来源；#74 的展示执行证据只补充展示/计算故障排查，不覆盖业务告警证据。[S13]

provider 和 composite 展示快照租期均为 120,000 ms，快照可被回收；这一短期机制在旧基线已存在，不能声称它是本轮新增。新的具体义务是：使用 #74 新证据字段时，不能只保存短期 snapshot 引用却承诺默认 30 天后仍完整回查。保存最小不可变脱敏事实，或引用具有匹配留存和授权的长期证据；剩余内容到期应明确未知/不可用。[S14][S15][P5]

`execution.input_accepted_at_ms` 是当前冻结/执行阶段记录的时间，cache hit 也会产生当次记录；`calculation_steps=0` 可能表示复用，不能据此宣称无计算结果或把该时间当历史首次完成时间。[S8][S16]

### R5：provider 权威来源必须使用完整数据身份

OANDA 历史现在与 latest 使用已配置账户的 candle endpoint 和 `units=1`，价格规则版本切换为 `oanda-account-candles-units1-v2:` 加规则摘要，旧缓存被身份隔离。原生身份包含账户范围摘要、价格 basis、平滑及日/周对齐参数；同名 EURUSD 或相同显示标签不构成同一来源。[S17][S18][S30][S34]

方案应保留 `series_kind` 与规范来源身份，不以显示名、同文本错误或最新价格去合并事件；不同源、不同 basis 或参数的故障须保留上下文。源码验收对 provider 的不透明身份作大小写归一匹配，应使用既有身份合同而非任意改写 provider symbol。[S12] 账户范围使用已有脱敏身份，URL 中账户原文、token 或代理凭据不进入通知负载。

### R6：加性迁移从 av49 接续

新通知迁移必须以实际 v1.26.1 的 `av49_indicator_demands` 为父节点，并在新测试中更新唯一 head 合同；不能从旧方案时间点的 au48 新开分支。迁移需保留 indicator demand/schedule、固定结果/检查点、快照及旧通知表数据与原行为。[S1][S2][S3]

原方案已经要求加性迁移、旧应用读取新 schema、保留派生表数据的应用回退、投影重建及禁止重投递；这是重新固定具体前置 schema，不是重做迁移策略。[P6] 静态迁移图没有证明迁移在 PostgreSQL 上实际成功。

### R7：按专业图表归属筛选，旧守望只作退役兼容

这是用户本次明确的新范围，不归因于 #74。新中心主动来源限定专业图表/图格/指标、图表数据中心、图表保存与图表告警。legacy monitoring、旧 Signals/Shell 不再是同等长期 Adapter，也不把旧全量 signals 的网页声音和通知消费延续为新中心长期链路。

当前 signals 表分别有 `watch_id` 和 `chart_alert_id`；图表 consume 写真实 ChartAlert 外键、规则/观察证据和 `chart_alert_signal`，旧 watch 的 record_signal 写 watch_id 和 `signal` Audit。`business.signals()` 现状是不区分来源的混合最多 500 条读取，所以不能把它直接当新中心权威来源或初始回填全集。[S13][S35][S36][S37]

W1 应冻结服务端来源归属白名单：沿 `SignalRow.chart_alert_id → ChartAlert/Version` 关系验证图表事件归属，再关联 Notification、Outbox、DeliveryAttempt 和 DeviceReceipt；不相信浏览器传入的 `chart_alert=true` 就提升为后端权威。旧 watch 信号和与其关联的渠道事实默认不产生新中心未读、气泡、声音或新主动事件。存量记录保留原证据与协议，必要历史访问明确标 legacy/迁移历史；来源无法确定时不能默认提升为专业图表事件。[S13][S20][S21][S22][S35]

退役是 UI/消费者与来源接入的有序收口，不隐含删除原信号、批量 ack、取消旧 Outbox 或修改设备协议。应冻结旧入口/轮询/声音消费者的退出顺序和兼容窗口，保证深链/手机确认继续能定位原事件，同时没有新旧两个活跃声音消费者。原 A16 关于旧工作台“长期共同消费”的部分需按此次范围重写为退役窗口兼容检查；图表双 tab/profile 的持久声音去重仍保留。[P3][P4]

## 3. 已覆盖并应保留的合同

| 原合同 | 当前源码核对与结论 |
| --- | --- |
| 可靠来源、异步投影、按未处理凭据领取；不能把 Audit.id 当提交顺序 | 原方案已明确；当前 `/api/events` 仍仅按 Audit.id 补拉，并只发送 kind/at，不能直接当新通知变更流。[P2][S19] |
| 网页已读/处理不停止手机；明确停止沿用旧 ack | 当前 acknowledge 仍设置 ack_at、取消 Outbox；这一行为在两基线间未变。保持动作分离，但旧工作台仅作退役窗口兼容，不新增长期主动消费目标。[P3][S20] |
| 手机接受、失败/未知、设备回执分别记录 | 当前投递仍写 `DeliveryAttempt`，设备 received 仍写独立 `DeviceReceipt`，这些路径未新增完整 Audit 变更流。原方案要求补可靠来源记录仍然必要。[P2][S21][S22] |
| 历史/回填不重触发告警或重新投递 | consume 明确将历史输入当 baseline，不作为事件；真实信号保留稳定 event key、late/渠道规则。旧工作台 replay 仅写 Replay 的 signals。不能因新增前台数值 replay 路径而将其视为告警发生。[P2][P3][S13][S23] |
| 自身观察、投影与传输状态不再生成发生 | 原方案已规定幂等 received/rendered、回填/reset 不提醒和有界传输错误。要在新的来源白名单与新测试中具体落实，不能由“全量接入 Audit”替代。[P2][P4] |

## 4. 新 W0/W1 应冻结的接收矩阵

下表是基于源码提出的接收规则，尚非已实现行为。一个真实指标失败当前可能同时经过 `chart-indicator-state` 和全局 error 文本两条通路；不能由两个 Adapter 各分配新 event_id。现有普通消息还会只传 error.message/String(error)，所以结构化故障码、操作 ID、来源上下文需要在生产者边界保留，而非在通知中心解析中文错误文本。[S4][S5]

| 来源或状态 | 默认入库/提醒规则 | 身份与恢复依据 |
| --- | --- | --- |
| preparing、pending、partial、续约、普通 ready 快照 | 更新当前操作状态；不增加发生/未读/声音 | client/consumer/generation、当前输入与可见 coverage |
| release、removed、HISTORY_CANCELLED、旧 epoch/token 回包 | 生命周期结束或丢弃迟到状态 | 不能作为故障或“已恢复” |
| 真实当前操作的超时、容量拒绝、计算/网络失败 | 每次真实失败尝试可保存一个发生；同一失败的两条显示通路合一 | stable fault/context + operation/attempt ID；传输重试沿用 event_id |
| snapshot expiry 与凭据续约 | 恢复状态；可选无打断的诊断转换 | 恢复尝试 ID；不是只按 snapshot_id 去重 |
| 当前 snapshot recovery 最终失败/后续 ready | 失败发生；ready 作为该事故明确恢复 | token、epoch、图格对象、品种/周期均须仍匹配 |
| 有服务端 ChartAlert 归属的真实 SignalRow/Notification | 权威图表后端发生，沿用原稳定来源身份及渠道资格 | 源事务中的稳定信号键、规则/观察/版本及原证据 |
| 已纳入图表事件的 DeliveryAttempt/DeviceReceipt/旧 ack | 更新该事件渠道时间线，不造第二个告警 | 尝试/回执/动作的来源键，晚到结果保留 |
| 旧 watch/legacy signal 及其渠道事实 | 默认不进入新中心主动发生/未读/气泡/声音；仅保留迁移历史与原手机协议 | 服务端 watch/chart 归属，必要深链指向原始证据 |
| Audit 心跳、设置/操作审计、notification 自身观察/发布/清理 | 无来源白名单即不生成普通发生 | 专用可靠来源种类；不能笼统将全库 Audit 映射为通知 |
| 数值前台 replay、历史演练、回填、JSON/SSE reset | 不是实时告警；历史结果禁止气泡/声音/重投递 | 保留 backfill/replay 来源标记及原始发生时间 |

W0 先对每一行采样真实产生频率、实际消息路径及代码上下文；W1 冻结准入类型、规范故障码、发生/状态/观察区分、尝试 ID、证据留存、恢复动作和渠道资格。W2/W3 只在该矩阵冻结后进入实现，符合原阶段门槛。[P5]

通知投影器不能调用 chart consume、数值 replay、market acquisition、notify.deliver_once 或已有业务判定来补造证据/通知。`PublicationWakeup`/PostgreSQL NOTIFY 的名称虽含通知，但其合同只是提交后唤醒提示，可靠状态仍在数据库，不是用户事件或持久变更流。[S24]

## 5. 对新验收的具体增补

在原 A1–A20 中追加具名场景或新编号，下面全部**待新开发后运行**：

1. **状态与失败分离（A7/A18）**：持续 500 ms 协调检查、10 秒续约、run pending 但 visible_complete，均不制造故障；超过既有等待门槛才出现一次 timeout；同次 error/state 双通路仅一个发生。源码已有的 pending 和等待控制可作为测试输入。[S4][S5][S7][S32]
2. **共享消费者取消（A4/A18）**：两图格共享 run，取消 A 不影响 B；取消后迟到 HTTP 不复活 A；旧 release 不取消新代次；取消屏障压力不导致通知洪泛。既有需求测试定义涵盖源合同，但没有证明新通知接入后仍成立。[S25]
3. **快照恢复顺序（A11/A15/A18）**：同 token 成功续约后再次过期；A→B→C 后迟到 A 错误；离开工作区后成功/失败回包；只有当前事故可更新，removed 不关闭事故。现有恢复测试仅作为待复用的源合同测试清单。[S26]
4. **凭据续约与价格修订（A4/A15）**：完全相同 OHLCV/cache revision 只续约；价格、volume、范围或 revision 改动走原完整恢复。通知 retry 不重置正确图表、不擅自绑定新凭据。现有测试定义提供两组输入。[S27]
5. **证据留存与来源（A3/A4）**：provider/managed/history/composite 的当时 source/algorithm/params/coverage 与原生提交对应；过 120 秒、快照清理后仍能读取约定最小证据，短期附加内容准确标过期；OANDA basis/对齐/账户范围变化不能串组。不得用当前图表价格补旧证据。[S12][S14][S15][S17]
6. **无回放/观察反馈（A9/A13/A14）**：重建、历史回填、数值 replay、告警 baseline、Audit 心跳、自身 received/rendered/sound/read 更新都不会新增业务发生或再发手机；手机尝试晚到仍只更新原图表事件。[S13][S19][S21][S23]
7. **av49 迁移与回退（A20）**：真实旧形状 av49 数据 → 新 schema → 重复 upgrade → v1.26.1 应用读写新 schema → 新应用恢复；保留需求、检查点、通知/Outbox/回执，恢复投影不重发。不要只用当前 ORM 创建一套“旧 schema”宣称兼容。[S1][S2][P6]
8. **资源公平性（A19）**：通知投影/来源日志风暴下测数据库积压与图表交互，确认新通路不占用或改变现有前台/维护/预热的服务预算；记录实际阈值与测量结果。[S3][P5]
9. **图表归属与旧入口退役（A2/A14/A16/A20 修订）**：同库混合 chart/watch 信号，默认中心仅纳入白名单图表来源；watch 事件、旧全量 signals 轮询不增加新中心未读/声音；伪造浏览器图表标记不能越权；必要 legacy 深链、在途手机投递、旧 ack 和设备回执仍按原协议生效，且退出兼容窗口后旧网页消费者停止。[S13][S20][S21][S22][S35][S36][S37]

## 6. 研究验证边界

已完成：固定版本源码阅读、旧基线至 v1.26.1 的相关路径差异核对、52 个迁移的静态父链检查、原方案合同对照、现有测试定义盘点。两基线间 `chart_alert_service.py`、`service.py`、`notify.py`、旧 ack/回执的核心业务合同没有本轮直接变更；后续新开发需回归这些合同。

未完成：新通知实现、独立 PostgreSQL 迁移/兼容运行、真实 Chromium 消息采样与故障注入、时间线/声音/主体隔离/R2 验收、性能预算实测。源码字段标为 `oracle_equivalent/canonical_verified` 是生产者声明；本次静态研究不把它表述为已实测通过。旧 #74 测试及历史验收材料不代表新 #75 已验收。

## 一手来源

所有 `[S…]` 均为 `2fe919a23d4adcb97ca1a98caafbad8693a410d3` 的源码；`[P…]` 为原方案 `e868fe6c9d0008ff32d46dbed2a125115a86cfe3`。

[P1]: https://github.com/hezongyi/market-watch/blob/e868fe6c9d0008ff32d46dbed2a125115a86cfe3/docs/unified-notification-center-plan-20261016.md#L3-L24
[P2]: https://github.com/hezongyi/market-watch/blob/e868fe6c9d0008ff32d46dbed2a125115a86cfe3/docs/unified-notification-center-plan-20261016.md#L43-L80
[P3]: https://github.com/hezongyi/market-watch/blob/e868fe6c9d0008ff32d46dbed2a125115a86cfe3/docs/unified-notification-center-plan-20261016.md#L82-L97
[P4]: https://github.com/hezongyi/market-watch/blob/e868fe6c9d0008ff32d46dbed2a125115a86cfe3/docs/unified-notification-center-plan-20261016.md#L103-L123
[P5]: https://github.com/hezongyi/market-watch/blob/e868fe6c9d0008ff32d46dbed2a125115a86cfe3/docs/unified-notification-center-plan-20261016.md#L127-L156
[P6]: https://github.com/hezongyi/market-watch/blob/e868fe6c9d0008ff32d46dbed2a125115a86cfe3/docs/unified-notification-center-plan-20261016.md#L181-L189
[S1]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/migrations/versions/av49_indicator_demands.py#L1-L60
[S2]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/tests/test_alerts_mcp_migration.py#L14-L82
[S3]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/indicator_demands.py#L1-L189
[S4]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/indicator-coordinator.js#L155-L306
[S5]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/bridge.js#L280-L320
[S6]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/chart_api.py#L94-L149
[S7]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/fixed_indicators.py#L326-L445
[S8]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/fixed_indicator_display.py#L25-L112
[S9]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/bridge.js#L324-L360
[S10]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/bridge.js#L362-L444
[S11]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/provider_cache.py#L864-L950
[S12]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/tests/fixtures/indicator-parity-evidence.cjs#L24-L68
[S13]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/chart_alert_service.py#L302-L388
[S14]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/provider_display_snapshots.py#L17-L88
[S15]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/display_snapshots.py#L16-L94
[S16]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/provider_indicator_inputs.py#L136-L197
[S17]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/provider_capabilities.py#L49-L62
[S18]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/provider_chart.py#L232-L252
[S19]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/api.py#L516-L529
[S20]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/service.py#L261-L274
[S21]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/notify.py#L129-L172
[S22]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/api.py#L678-L701
[S23]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/service.py#L344-L405
[S24]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/publication_wakeup.py#L1-L31
[S25]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/tests/test_indicator_demands.py#L52-L157
[S26]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/tests/display-recovery-lifecycle.cjs#L10-L36
[S27]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/tests/provider-credential-recovery.cjs#L30-L44
[S28]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/src/advanced/AdvancedWorkspace.tsx#L1302-L1326
[S29]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/chart_api.py#L418-L441
[S30]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/native_series.py#L13-L47
[S31]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/managed_dataset.py#L659-L710
[S32]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/indicator-coordinator.js#L8-L46
[S33]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/bridge.js#L618-L653
[S34]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/provider_chart.py#L296-L309
[S35]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/storage.py#L787-L820
[S36]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/business.py#L264-L309
[S37]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/service.py#L409-L444
