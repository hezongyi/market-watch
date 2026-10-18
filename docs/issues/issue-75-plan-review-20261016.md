# Issue #75 统一通知中心方案评审

> 2026-10-18 历史说明：下文保留 2026-10-16 评审及当时落实状态。v1.26.1 重新开发采用[修订方案](../unified-notification-center-plan-20261016.md)与[本轮分析](issue-75-v1261-reassessment-20261018.md)；PR #85 已按用户要求作废，其实现和验收不计入本轮。旧主页实时通知适配范围按本轮退役要求收紧。

评审日期：2026-10-16。目标：[Issue #75](https://github.com/hezongyi/market-watch/issues/75)，正文更新时间 `2026-10-16T17:13:17Z`，评审时没有评论。源码固定为 `origin/release/v1.25.8-20261016` 的 `b6fe6424853c8cbc325fb3ef02e7894aa680d412`；其业务代码与 `b53d2973cd70e8610154bc46a9d516e62ccdadd7` 相同，差异只有既有方案文档和 Issue 模板。

处理状态：用户已认可本评审。六项结论已落实到[修订方案](../unified-notification-center-plan-20261016.md)，合同、A1–A20 和阶段对应见其 §13。本文保留原方案的评审证据，不表示修订后仍有相同遗漏，也不表示业务实现或 W0 已完成。

原方案结论：统一入口、原始事件与展示分组分离、渠道状态独立和不改告警判定算法的方向合理；F1 / R2 / D1 的分类也合适。建议修订后实施。W0 的盘点和浏览器探针可以开展；W1 应先补齐以下四项 P1 合同，再进入 W2/W3。另有两项 P2 应列入验收，避免通知中心上线后仍然丢记录、误停手机提醒或重复响铃。

原评审为 P0，只增加本文，未修改业务代码、远端 Issue 或生产资源。后续文档修订和 Issue 更新按用户明确指示执行；以下是原方案需要补足的合同，不表示尚未实现的方案已存在相应线上缺陷。

## 1. [P1] 持久投影缺少可靠写入和断网接收协议

位置：目标 1、8，W2、W3，A7、A8。

方案定义了统一事件的读取、展示和留存，但没有说明后端事件何时可靠进入投影，也没有给浏览器产生的故障定义持久接收路径。这直接影响“失败仍可回查”：例如历史请求超时后网页产生错误，此时向同一后端上报也可能失败；刷新页面会丢失尚未入库的故障。另一个场景是原始告警已经提交，进程在写通知投影之前退出，源记录存在，通知中心却永久缺一条。

现有 [consume](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/backend/alerts/chart_alert_service.py#L353) 在同一事务中写 `SignalRow`、`Notification` 和可选 `Outbox`。而网页普通错误只存在于 [React 状态](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/web/src/advanced/AdvancedWorkspace.tsx#L143) 和 [iframe 内存 Map](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/advanced-host/chart-notices.js#L2)，目前没有可以自动补齐这些浏览器历史故障的数据库来源。

修订建议：

- 后端采用同事务写入，或从可靠源记录可重放地构建投影；明确唯一来源键、重复处理、崩溃恢复和旧数据回填范围。投影可用性不能成为告警判定或行情处理的单点依赖。
- 浏览器重要故障先取得稳定的客户端事件 ID，由可信父页面接收并立即展示；离线时进入有容量和期限限制的本地待同步记录，恢复后幂等补传。服务端已接收、仅本地保留和无法保存必须能区分。
- 对通知上报自身的失败采用退避和本地降级，避免“上报失败再上报一条失败”递归增长；旧版未记录的字段应标为未知。

补充验收：源记录提交后中断投影处理并重启；同一客户端事件多次补传；后端离线时产生故障、刷新、恢复网络后回查；本地存储不可用或达到容量时明确降级。

## 2. [P1] 新事件游标不能覆盖已有事件的状态变化

位置：目标 4、6、8，W2，A2、A3、A5、A6。

`event_id` 解决身份问题，不能单独承担变更进度。事件已经显示之后，手机发送成功、设备回执、网页查看/确认和故障累计次数仍会改变。若 `after` 只查询新事件，或以发生时间排序补拉，客户端就会漏掉这些更新及迟到事件；SSE 在线期间收到更新也不能替代断线恢复合同。

当前 [发送结果](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/backend/alerts/notify.py#L146) 更新同一 `Notification/Outbox` 并增加 `DeliveryAttempt`，[设备回执](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/backend/alerts/api.py#L672) 单独写 `DeviceReceipt`。两者都不产生新的 `SignalRow`，也不写对应的 `Audit`；旧 [通用 SSE](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/backend/alerts/api.py#L510) 只扫描 `Audit`，不能直接充当完整通知变更流。

定向运行现有实现确认：发送后状态从 `pending` 变成 `server_accepted`，新增一条 `DeliveryAttempt`，新增 Audit 为 **0**；设备回执后新增一条 `DeviceReceipt`，新增 Audit 仍为 **0**，原始信号仍只有一条。

修订建议：分开定义不可变事件 ID、展示组 ID、事件/渠道版本和可恢复的变更游标。创建、送达、回执、查看/确认、分组计数及保留期删除都须有增量表达；SSE 和轮询使用相同补拉合同。还要定义初始快照与订阅交接、过滤条件切换、同时间戳排序、游标过期后的重建，以及不会越过尚未提交事务的推进规则。不能仅用发生时间、随机 UUID 或未经处理的自增序号高水位承诺无遗漏。

补充验收：事件显示后断网，仅改变送达/回执状态，不新增告警，重连后仍能更新；超过 500 条分页期间并发写入、迟到事件和事务反序提交；游标落后于留存下限后明确重建，且不重新响铃。

## 3. [P1] 网页确认的兼容迁移需要落实到旧接口与操作文案

位置：目标 7，W2、W4，A5；“不破坏现有 SignalRow、Notification、Outbox”。

方案已提出独立渠道记录，但“网页确认不得无提示地取消手机投递”还需要具体迁移规则。当前 [ChartAlertsPanel.ack](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/web/src/advanced/ChartAlertsPanel.tsx#L203) 使用 `/notifications/{id}/ack`；其 [acknowledge](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/backend/alerts/service.py#L261) 会设置 `ack_at` 并把 Outbox 改成 `cancelled`。ntfy 操作按钮和 Android 确认也调用同一业务逻辑，Android 同步则依据 `ack_at` 移除待提醒事件。

直接复用会让“已读/已处理”意外停止手机提醒；直接修改旧接口为只标已读，又会使现有手机的“确认停止提醒”失效。这两个方向都与兼容要求冲突。现有测试和定向运行均确认旧确认的结果是 `acknowledged / cancelled`。

修订建议：分别定义收到、渲染、查看、业务确认和显式停止后续提醒。保留旧手机/旧接口的停止语义，为新网页阅读状态建立独立动作与存储；需要停止手机时提供含义明确的操作及作用范围，分组操作也不得默默确认全部原始事件。新旧网页共用相同语义 Adapter，并通过父页面校验过的接口调用。

兼容矩阵还应保留规则的 `notify_web`、`notify_ntfy`、`late_delivery=log_only` 和既有手机投递策略；“可在中心回查”不应自动变成“必须弹泡、响铃或手机推送”。

补充验收：网页查看/确认与发送、重试、设备回执并发；网页操作不改手机待投递状态；旧 ntfy/Android 确认仍停止对应事件的后续提醒；规则关闭网页或手机渠道后仍符合原设置。

## 4. [P1] 通知入口依赖 TradingView 就绪，缺少启动失败的独立降级路径

位置：目标 2、3，W0、W3，A1、A7；DOM 探针失效时的安全降级。

把正常通知放在原生外壳是合理的，但不能把故障展示的存活条件绑定到发生故障的图表。现有 [父页面](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/web/src/advanced/AdvancedWorkspace.tsx#L168) 在 `nativeReady` 后才发送通知，[bridge](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/advanced-host/bridge.js#L2549) 也只在 `ready` 时处理普通通知。父页面目前另有 `!nativeReady` 错误展示。原生 [侧栏 Adapter](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/advanced-host/native-alert-shell.js#L4) 更依赖固定版本、私有 widgetbar 和懒加载资源。

如果 iframe、许可资源、初始化或侧栏依赖加载失败，顶部原生入口可能根本不存在。只规定“DOM 探针失败仍可用”没有说明此时由谁展示和打开记录；若统一改造时撤去现有父页面错误区，会把用户最需要排查的故障隐藏起来。

修订建议：通知状态和接收不依赖 widget ready；明确启动中、初始化失败、外壳不可用时由可信父页面提供可操作的入口或就地错误区，并遵守不堆叠四角浮层的目标。图表恢复后切回原生入口，保留事件身份、未读和声音消费状态。降级例外应写入 A1，而不是保留一条无法覆盖启动故障的绝对要求。

补充验收：阻断 iframe、许可 JS 和原生侧栏 chunk；延迟 ready、销毁/重建侧栏与工作区；始终能读取原因并重试，恢复后不出现第二套通知或重复声音。

## 5. [P2] 按 event_id 去重还不足以保证刷新和工作区切换后不重复播放

位置：目标 4、8，W4，A3、A5、A6。

方案没有定义声音消费状态的保存位置、作用域与写入时机。内存 Set 随页面或 iframe 消失；把去重放在通知列表渲染中，还可能在筛选、补拉和旧工作台并存时再次触发。现有 [Shell](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/web/src/main.tsx#L187) 的声音开关和 `known` 集合是页面内存状态，新消费者不能把它当成跨刷新合同。现有原生告警 UI 已将业务状态放在 portal 容器之外，这一点应延续，但整个 iframe 销毁仍需独立处理。

修订建议：规定消费主体及跨标签页/跨设备策略，将接收游标、未读状态、声音尝试记录分别保存；历史回查、首次快照和分组更新默认不作为新响铃。声音调度应独立于侧栏生命周期，并明确用户手势解锁后是否补响及有效期限。默认建议同一浏览器同一登录主体共享响铃去重，各设备分别报告实际观察。

浏览器播放动作与数据库记录不能原子提交，需要明确选择重复抑制和崩溃时可能漏响的取舍。记录 `blocked/suppressed/attempted/started/failed/unknown` 等可观察结果；不能将 SSE 已收到视为网页已显示，也不能把 AudioContext 开始播放或 ntfy 接受视为用户已听到或手机已收到。当前 ntfy 原生渠道没有设备回执时应继续显示未知。

补充验收：已播放后刷新、A→B→A 工作区切换、侧栏关闭/重建、双标签页与旧工作台并开；静音、后台、播放被拒绝、手势解锁和播放前后退出页面。没有重复播放也不能掩盖“实际从未开始播放”。

## 6. [P2] 故障分组需要事件发生语义、上下文与通知风暴预算

位置：目标 2、6，W1，A1、A6；数据量风险。

`dedupe_key` 尚未规定哪些故障属于同一事故、恢复后再次故障如何重新提醒，以及多品种/工作区如何区分。现有 [chartNoticeStore](https://github.com/hezongyi/market-watch/blob/b53d2973cd70e8610154bc46a9d516e62ccdadd7/advanced-host/chart-notices.js#L5) 按错误文本合并，并把来源从快照消失后再次出现计为新一次。定向运行确认：EURUSD 与 GBPUSD 的相同“历史拉取失败”合成 **1 组、2 次**；同一列表重复更新维持 2 次，清空再重现变为 **4 次**。它不是可直接继承的业务事件计数合同。

另外，只限制“一次一个气泡”没有规定排队、替换和优先级；持续普通消息可能覆盖严重故障。保留每次原始事件意味着展示合并本身不会减少数据库写入量，留存期限也不能限制短时故障风暴。

修订建议：将请求重试的幂等键、单次发生 ID、故障分组键和事故生命周期分开。分组依据稳定故障码、生产者、业务对象及必要的品种/周期/工作区上下文，保留每次发生的详情；普通重复故障合并不能吞掉不同规则、版本或触发次数的业务告警。定义恢复/复发重新提示、严重级别升级、单气泡调度、入口未读计数，以及内存/本地待同步/服务端写入的容量与保留规则。一次渲染或一次补拉不应自动生成一次新故障。

补充验收：不同品种相同文本、同故障不同文本、恢复后复发、同事件重传、同规则多次有效告警；严重故障夹在大量成功消息中仍可见；持续断流/重试时记录计数正确，图表交互与资源占用保持在约定预算内。

## 建议实施顺序和验收补充

保留 W0→W1→W2→W3/W4→W5/W6。W1 的输出需要可供实现和测试共同使用的字段、动作及兼容合同；W2 先证明可靠接收、重放和独立渠道状态，再接展示层。通知 Module 的 Interface 应集中处理事件身份、可靠接收、变更读取和消费观察；父页面、原生外壳、旧工作台、声音和手机状态作为相应 Adapter 接入，避免每个生产者分别实现重试、分组和响铃。

| 原验收项 | 建议增加的具体场景 |
| --- | --- |
| A1、A7 | 图表未 ready/资源失败时仍能展示、定位和重试；降级入口恢复后唯一；气泡不抢焦点，键盘可打开/关闭中心并返回入口；集中读屏播报，重复更新不多处抢读 |
| A2、A6 | 状态更新补拉、快照/订阅交接、迟到/同时间戳/反序提交、筛选切换、游标过期、超过 500 条并发分页 |
| A3、A5 | 客户端观察时间与服务器接收时间分别保留；隐藏页面、自动播放阻止和 ntfy 无设备回执时显示准确的未知/受限状态 |
| A5 | 网页阅读/确认与停止手机提醒分离；旧手机确认兼容；规则渠道开关与迟到抑制保持有效 |
| A6 | 刷新、工作区切换、双标签页、旧工作台、播放前后退出；重放与分组更新不再次触发声音 |
| A6、A7 | 幂等重传与新故障发生分开计数；故障恢复/复发、上下文分组、严重消息调度与风暴预算 |
| A7、A8 | 后端不可达时本地待同步；源提交后投影处理中断、恢复与重建；不重复业务触发或手机投递 |

## 验证和限制

- 在本评审 worktree 执行：

  ```sh
  env -u TEST_POSTGRES_URL PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend \
    /home/quant/repos/market-watch/.venv/bin/python -m pytest \
    backend/tests/test_notify.py backend/tests/test_chart_alert_notifications.py \
    backend/tests/test_notification_test.py backend/tests/test_devices.py \
    backend/tests/test_chart_alert_service.py -q -p no:cacheprovider
  ```

  结果：**29 passed、1 skipped，4.13s**。跳过的是需要独立 PostgreSQL 的已提交事件精度测试。一个既有 Starlette/httpx 弃用警告不影响结果。数据库为测试进程的内存 SQLite，外部通知使用 MockTransport。
- 用实际 `notify.deliver_once`、`device_received` 和 `acknowledge` 在独立内存 SQLite 运行，确认发送/回执不产生新的 Audit、旧确认取消 Outbox；没有连接真实手机。
- 用实际 `chartNoticeStore` 做 Node 定向检查，确认跨品种同文本合并、快照重现计数和重建后无历史。这是现有逻辑的证据，不能作为新事件合同的验收。
- 已核对 Issue 引用的既有通知验证材料；其浏览器证据是 web-only、无外部 Outbox，不能替代本方案的跨渠道验证。
- 未实现新通知链路，未运行新 schema 迁移、独立 PostgreSQL、固定许可库真实浏览器及 R2 全链路验收；本文不宣称这些项已通过。

工作区：`/home/quant/repos/market-watch-issue75-review-20261016`。原评审提交为 `24703cd`；分支后续更名为 `docs/issue75-plan-revision-20261016`，用于发布修订方案及本评审并更新 Issue #75。
