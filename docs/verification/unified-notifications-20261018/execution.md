# Issue #75 V2 实施与验收

更新：2026-10-18 16:01 UTC。**最终验收进行中**，不代表全部 A1–A20/B1–B9 已签收。实现分支 `feat/issue75-chart-notifications-20261018`；基线 `v1.26.1 / 2fe919a23d4adcb97ca1a98caafbad8693a410d3`。#85 已关闭、远端分支已删除；没有复用其实现、数据库或验收结果。

分类 **F1 / R2 / D1**：新增持久事件、提交有序变更日志与网页消费状态，需加性迁移、旧二进制兼容及独立 Standards/Spec 审查。专业图表是产品入口与主动来源；旧主页只保留历史/手机协议兼容。本次不合并、不发布、不建立正式 tag，不操作 Unraid。

## 实际环境与候选

主机为本机 `quant-server / Ubuntu 22.04.5`，不是远端 SSH 转发实例。独立 task/project `mw-issue75-v2-20261018`，独立 worktree、PG14.24、网络与 volume。旧 `mw-issue75-20261017` 原样保留。D1 数据由本目录 seed.py 和任务专用脚本建立，无外部手机投递；Yahoo/OANDA 外部行情流关闭。

- 应用：<http://127.0.0.1:18275>；图表独立来源：<http://127.0.0.1:18276>；PG 不发布宿主机端口。
- 私有运行配置：`/home/quant/repos/.mw-issue75-v2-tool-state/runtime/compose.json`；凭据、env、完整浏览器状态不入库。
- 启动：`docker compose -f /home/quant/repos/.mw-issue75-v2-tool-state/runtime/compose.json -p mw-issue75-v2-20261018 up -d --no-build api projector web chart postgres`。
- 停止：同一命令前缀加 `stop`。保留任务数据，不执行 down -v 或全局清理。
- 浏览器：Playwriter 0.8.0 + 本任务 Docker Chromium 153；CDP `127.0.0.1:19275`。CLI 独立 session 2。组件探针使用过 18277/18278，不把其当成完整应用候选。
- 图表许可库实测：`TT v31.1.0 / 6b804c486857f27920cf761aa7eb6e29d9bb6362`。没有修改许可库源码。

构建统一走已安装 mw-docker 的原实现，使用 `market-watch-ubuntu` builder，并标注 task/project/purpose=acceptance。适配器 `/tmp/mw75-docker.py`（持久副本位于私有 runtime）只把台账/Buildx 写入任务状态目录，仍锁定原全局锁同一 inode；socket 已可读写时直接执行原 Docker 命令。未绕开资源归属、Ubuntu 和 builder 校验。

当前候选 image ID（2026-10-18 15:38 UTC 部署，包含最终 Runtime ingress、producer、native range 修复）：

| 组件 | image ID |
| --- | --- |
| API / projector | `sha256:4656033bc4806dcc3a2cf6e78d18daad8c3fdf0587c5b7470813132af17aeb6c` |
| Web | `sha256:52ec20300a6173a74b308df23d43ea8dde6d9fb9e30e70ddbf45c38ab242c207` |
| Chart | `sha256:aa96eccd50fdec2e5e035bf28d8014cf2a0510ff26ef0c00f41370e82d0803ad` |

镜像构建于实现检查点 67d24ac 之后的未提交源码，标签含 dirty=true；不能声称镜像标签已经对应最终提交。独立复核报告记录产品 diff SHA-256，后续提交只整理同一产品源码与证据。

## 实现合同与来源

W0 原生/音频/许可探针、W1 合同冻结完成；W2–W4 已实现；W5/W6 最终验收和 CI 进行中。

- 当前单管理员主体由服务器从认证会话推导，客户端不能指定主体。根部 NoticeProvider 持有当前主体 Runtime，跨路由/工作区/iframe 重建不重建接收器。generation 只作为取消栅栏。
- 源事务只写可靠 Audit，独立 worker 使用处理凭据投影；事件、事故、stream seq 与变更同事务发布。JSON/SSE 共用 reader。迁移 `av49_indicator_demands → aw50_notice_center` 加性接续。
- 浏览器发生身份来自实际 attempt；report/resolve 入队顺序、IDB stage order 与服务器 acceptance order 分别持久维持因果顺序。同毫秒发生→恢复→复发不反序。瞬态失败不得被后项越过，永久拒绝证据保留。
- 网页 viewed/handled、声音观察与原手机 ack 独立。原生与父页面展示共用同一 Runtime；正常原生入口与失败降级互斥。旧 Shell 全量 signals 自动声音路径已移除。
- 声音由父页面持久预留，subject/profile/event 去重；需启用、规则允许、手势解锁、可见、Web Locks 和服务器时间估计 30 秒窗口。started 不代表人已听见。

| 真实生产者 | 身份/恢复/动作 | 本轮证据 |
| --- | --- | --- |
| 图表业务告警及手机渠道 | 核验 SignalRow→ChartAlert→ChartAlertVersion；signal ID、源版本；不重算原证据；显式停止沿旧 ack | live service signal + Playwriter detail/stop；baseline compatibility；notification tests |
| 工作区/本机草稿保存 | 实际请求 attempt + workspace；成功关闭对应事故，失败保留草稿 | playwriter-save-durability.json 与截图 |
| 自选/收藏偏好 | 原生 symbol-flags 有界 409 重试后的终态；成功显式恢复 | playwriter-actual-producers-results.json |
| 指标/快照 | 现有消费者协调器恢复耗尽的终态，当前 epoch/consumer；取消/旧代次/成功恢复不报错 | Runtime/provider/display tests；最终应用实际添加 Python STOCH 失败并重试恢复（证据补录中） |
| 历史/容量 | Core 终态事务写可靠源；恢复键包含范围；当前有效定位只接受唯一匹配 | source/market contracts；实际容量保存失败与重试 |
| 行情/连接 | 实际订阅注册/EventSource 及合法 generation+sequence 载荷；明确 open/健康数据恢复；owner 不能串组 | playwriter-connection-result.json、playwriter-market-result.json |
| 图表数据中心 | allowlist 实际写操作、配置、容量；保留就地错误与核查重试 | 实际 create 503→核查未发现→保留表单；草稿关闭 cancel；playwriter-data-center-failure.png |
| 图表后台任务/导出 | 可靠源绑定图表计划、导出共享 ImportJob scope、HistoryVersion/VolumeBackfill 终态；与 failed_task_ids 去重 | source-contracts.log（实际业务服务/源事务测试）；不把1000种子来源当作生产者验收 |

预算冻结：单条16 KiB/context或evidence各12 KiB；pending每主体1000条/10 MiB/七天；浏览器接收60/min突发120；摘要200/气泡20；投影/默认页100，API上限500；事件30天/变更七天。上报错误不递归产生来源。

## 已执行验证

### 后端与迁移

- 最终来源专项 **51 passed**：[source-contracts.log](source-contracts.log)，包括23项通知单测、6项独立 PG 测试及任务/历史相关合同。
- 最终行情专项 **63 passed**：[market-contracts.log](market-contracts.log)，覆盖 stream worker、quote/composite/native history。
- 全量首轮 **2614 passed / 7 failed / 3 skipped**，约2502秒。4项因隔离实例 history_health_workers=[] 与测试默认不同；3项旧可逆迁移跨越新迁移的保留数据 guard。旧迁移测试固定原 av49 边界，并在测试命令明确恢复默认 health workers；7项及关联复验 **20 passed**：[full-failure-recheck.log](full-failure-recheck.log)。不能把此表述为一次全量绿灯。第二次全量正在同任务 Docker 中运行。
- PG 专项证明反序源提交、stream 锁/rollback、并发幂等、av49重复加性升级、手机对账与并发 ack 锁序、同毫秒恢复序。
- 实际干净 v1.26.1 API 镜像无 NoticeEvent 模型，读取新 schema，创建/消费图表 signal 并写设备/尝试/回执/ack；候选恢复后仅回填一次、保留渠道事实、不外发手机：[baseline-compatibility.json](baseline-compatibility.json)。保留新增表的应用回退，不运行破坏性 downgrade。

### 前端与独立 review

tsc 与 CI 中全部非浏览器 Node suites 已通过；provider subscriptions/runtime 专项最终修复后重跑通过。Ruff 变更后端文件与 git diff --check 通过。最终两轴独立审查均无剩余具体 P1/P2：[Standards](standards-review.md)、[Spec](spec-review.md)。审查结论不替代最终验收。

Store 另由独立审查者使用实际代码 + fake-indexeddb6.2.4验证六项 TTL/order/原子性：[结果](store-probe-results.json)、[脚本](store-probe.cjs)。复现需在脚本可解析的位置安装 fake-indexeddb6.2.4，传入仓库绝对路径；脚本通过仓库 web/package.json 解析 esbuild。

### Playwriter 已完成场景

- 最终应用真实 native Save503 + intake503：本机待同步、刷新保留、恢复后同 ID 一次接受/计数：[save durability](playwriter-save-durability.json)。截图分别为 pending/accepted。
- 800×700 紧凑弹窗可点击实际行，返回宽屏原生侧栏；正常列表 flex 收缩修复已实测：[窄屏截图](playwriter-narrow.png)。
- 原生手势解锁父页面 AudioContext；同 profile 双 tab、刷新/关闭重开仅一次 sound_reserved/sound_started：[sound and stop](playwriter-sound-and-stop.json)。不声称人已听见。
- 真实网页查看/处理不停止手机；显式停止后原手机状态更新。时间线保留独立事实：[详情截图](playwriter-notice-detail.png)。
- 未认证401、无CSRF403、伪造业务来源/手机事实422；1000条跨10页唯一、JSON/SSE同reader游标一致：[contracts](playwriter-contracts.json)。该记录在最终追加来源前采集，后续发生不改变其当时结果。
- 真实连接和行情生产者：控制网络传输故障/状态载荷，不直接写通知表；持久事件 count1、明确恢复 closed_at：[connection](playwriter-connection-result.json)、[market](playwriter-market-result.json)。
- 原生收藏失败→明确成功、容量保存失败→成功、数据中心真实提交503并保留原输入：[producers](playwriter-actual-producers-results.json)、[数据中心截图](playwriter-data-center-failure.png)。关闭时草稿保护“继续编辑”保留输入，后续核查重试成功。
- 阻断整个 chart origin：父页面仍查询记录；解除阻断点击重新加载后 parentFallback=0、nativeEntry=1、原生通知 region=1，状态接续：[阻断](playwriter-fallback-blocked.png)、[恢复](playwriter-fallback-restored.png)。
- 实际 Chromium 的独立 localhost 测试 origin 编译真实 Store/Runtime，验证数量/字节/TTL/单条上限、存储拒绝、显式受限提示、声音 muted/locked/expired/coordination/failed/unknown、跨 Runtime 原子预留和 pause：[boundary results](playwriter-boundary-results.json)。该模块探针不冒充真实业务生产者；隔离 origin 不污染127.0.0.1应用IDB。

## 负载与资源（已测范围）

1000条可靠任务种子仅作补充负载：提交1.17秒，最后投影19,512ms，pending source=0，DB49,704,283→55,389,531字节（约5.7MiB）；API100条/页，共10页、1000唯一，75–191ms/页。[开始](backlog-start.json)、[结果](backlog-result.json)。尚不以此代替真实生产者或完整风暴交互签收。

2026-10-18 16:01 UTC，完整应用+第二次全量测试运行时一次采样：API159.9MiB/768、projector98.2MiB/384、PG307.5MiB/512、浏览器620.6MiB/1GiB；各容器未达内存上限。最初资源盘点可用8.6GiB内存/49GiB磁盘，实际服务无端口冲突。后续还需归档持续交互/风暴观测与全量结果。

## 尚待收口

剩余浏览器场景：跨路由A→B→A/replay/settings/signals、设置/图表离开保护、401与重登、分页中的epoch reset、历史来源及风暴交互/键盘焦点/主题多图。需逐项映射A/B并记录未测边界。新Draft PR及CI待创建；全部完成前不把目标标记完成、不报告可合并/可生产发布。
