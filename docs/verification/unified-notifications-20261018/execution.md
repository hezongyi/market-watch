# Issue #75 V2 实施记录

日期：2026-10-18。分类 **F1 / R2 / D1**；原因是新增持久事件、提交有序变更日志和网页消费状态。验收浏览器使用 **Playwriter**，另做 PostgreSQL 迁移、源事务和兼容性检查。

## 基线与资源

- 源码：`v1.26.1 / 2fe919a23d4adcb97ca1a98caafbad8693a410d3`；开始时远端 main 相同。
- 实现分支：`feat/issue75-chart-notifications-20261018`。
- worktree：`/home/quant/repos/market-watch-issue75-implementation-20261018`。
- 方案：`docs/unified-notification-center-plan-20261016.md`；不复制 #85 的业务代码、数据库或测试结果。
- 主机：本机 Ubuntu；Docker project/task 拟为 `mw-issue75-v2-20261018`。
- 盘点：约 8.6 GiB 可用内存、49 GiB 可用磁盘；旧 `mw-issue75-20261017` project 仍运行五个容器，保留。
- 本轮拟用回环端口：`18275`（应用）、`18276`（图表来源）；数据库不发布端口。启动前重新检查。
- 服务预算：独立 PG14.24、API、通知投影 worker、Web、图表、TLS 网关；正常总内存上限 2.5 GiB、CPU 上限 1.5。D1 合成数据，不向外部手机投递。
- 许可资源只从干净主仓库复制到忽略目录，实际版本与原生运行时探针仍待实测。

## 当前门槛

W0 原生/资源/基线初步探针完成，完整应用负载测量随 W5/W6 补齐；W1 初版合同冻结；W2 **进行中**；W3–W6 **未开始**。A1–A20/B1–B9 均未宣称通过。

首次规范构建命令：

```bash
mw-docker build --repo . --component api --tag market-watch-api:issue75-v2-baseline \
  --task mw-issue75-v2-20261018 --project mw-issue75-v2-20261018 --purpose acceptance
```

该命令在写 `/home/quant/.local/share/market-watch-docker/ops.lock` 时返回 `EROFS`，尚未产生基线镜像。本会话可写范围只有仓库和 `/tmp`。已请求开放工具状态目录/Buildx 写权限，或确认使用任务独立状态目录且保持既有全局锁。后续已找到不改用户目录权限的任务状态适配办法，见下方；不以其他实例或旧镜像替代本轮 W0 证据。

Playwriter 安装使用 `/tmp` 下的 npm cache 和独立 runtime；尚未完成会话连接、真实图表或音频验证。

## W1 合同决策草案

1. 当前应用只有一个管理员主体：服务端从已验证会话推导 `admin`，不接受请求自行指定主体。会话代次只作取消栅栏；不充当事件身份。
2. 专业图表信号沿 `SignalRow.chart_alert_id → ChartAlert/ChartAlertVersion` 验证。`watch_id` 和无可核实关联的记录仅为兼容历史。`business.signals()` 不作中心接收入口。
3. 来源事务只记录可靠 Audit 事实，不调用投影表或投影器；投影独立领取未处理来源，以来源唯一凭据去重。每个来源的原身份、不可变判断证据和真实渠道事实保留。
4. 发布锁定单流计数行，投影、事故更新、变更与凭据同事务。分页以 H 为发布边界，游标绑定主体和筛选；JSON/SSE 共用 epoch/seq、过期/reset 语义。
5. 浏览器异常在实际失败尝试或有效终态处分配身份，不在 React render、轮询快照或错误文本变化处分配。取消、等待、需求释放、旧 generation 和成功快照恢复均不算失败。
6. 浏览器只可提交受控故障来源和网页/声音观察；不能伪造业务信号、手机接受、设备回执或任意授权动作。
7. 已认证路由上方的父页面 Module 持有待同步、恢复进度和声音；iframe 为展示 Adapter。当前会话停止后拒绝所有晚到结果。
8. 原生侧栏保留规则管理；通知为独立页签/入口。正常只一个锚定气泡，启动/原生失败才由父页面展示。保留原导航、图表高度和离开保护。
9. 网页已读/处理仅写新观察；停止手机提醒显式调用原 ack。旧 Shell 自动 signal 消费/发声退役；兼容历史不自动确认，不重弹、重响或重投递。
10. 声音启用偏好与 AudioContext 解锁独立；按主体/profile/event 唯一持久预留，Web Locks 协调。仅实时、规则允许且距服务器记录不超过 30 秒的候选可自动尝试。

## 生产者接缝清单

| 来源 | 现有入口 | 身份与去向 |
| --- | --- | --- |
| 图表业务告警 | `chart_alert_service.consume`；组合告警沿相同 SignalRow | signal ID / rule version；独立发生；原始精确证据保留 |
| 手机事实 | Notification/Outbox、DeliveryAttempt、DeviceReceipt；原 ack | 仅推进已接入图表事件的独立渠道；不产生新发生 |
| 工作区/偏好保存 | AdvancedWorkspace 的真实 API/本机保存失败；preferences/symbol-flags 保存链 | 请求 attempt / workspace revision；保留草稿、原值及安全重试 |
| 指标/快照 | `chart-indicator-state`、indicator coordinator | 当前 epoch/consumer 的终态 attempt；preparing、removed 与恢复中均为状态 |
| 图格历史/容量 | `chart-history-failures`、`capacity-notice`、native history load | 当前 epoch/request；等待与取消不计次；显式成功才恢复 |
| 数据中心 | 受控 `data-center-api`、后台任务终态 | 操作/任务 attempt；与后端已知根因关联；表单错误继续就地呈现 |
| 行情/连接 | provider subscriptions、`feed-poll-state` | 有效来源/请求身份；不逐 tick 写事件 |
| 主题/自选/收藏 | preferences、watchlist/symbol-flags 保存失败 | 实际最终失败尝试；自动冲突重试不重复计次 |
| 通知自身 | Module 传输/本地存储状态 | 有界降级状态；不递归报告新事件 |

该表在 W0 实测后补充实际动作与稳定 attempt 传播位置，完成 W1 后才进入 W2/W3。

## 工具适配与 W0 探针进展

- 使用 `/tmp/mw75-docker.py` 调用已安装 `mw-docker` 的原实现；仅将台账/Buildx 状态放到 `/home/quant/repos/.mw-issue75-v2-tool-state`。外层以只读 fd 对原 `ops.lock` 持有 `LOCK_EX`，与原工具锁同一 inode。构建时仍校验本机 Ubuntu、专用 builder、标签和归属；没有修改已安装工具。
- 本会话的 Docker socket 映射为 `nobody:nogroup` 且当前主体已有读写权限；原工具误走 `sg docker`，被 sandbox 拒绝。适配器仅在实际 socket 读写已允许时直接执行工具原 Docker 命令，不变更组、不申请额外权限。
- Playwriter 0.8.0 在 `/tmp/mw75-playwriter-runtime`，使用自己的直接 CDP 会话，浏览器为独立 Ubuntu Docker Chromium 153，未使用旧任务页面或浏览器状态。
- Ubuntu 主机 `quant-server`，22.04.5 LTS；组件探针地址 `http://127.0.0.1:18277`，图表独立来源 `http://127.0.0.1:18278`。这是组件探针，不是应用候选地址。
- 实测许可库：`TT v31.1.0 / 6b804c486857f27920cf761aa7eb6e29d9bb6362`；公共 header button、原生 alerts page factory 均可用。1440×1000 下侧栏挂载成功，保留观察清单、数据窗口和对象树入口。截图 `w0-native-dark.png`。
- Chromium 首次 AudioContext 为 `suspended`；原生 iframe 点击后，经跨来源 postMessage 请求父页面 resume，实测 `suspended → running`，父页面 `userActivation.isActive=true`。这仅证明该浏览器/设置下可以解锁，产品仍需保留 blocked 和显式父页面解锁入口；不代表用户听见音频。
- 探针稳态一次采样：浏览器约 458 MiB，Nginx 约 9.2 MiB；组件数据为合成样本，不能当作多图/多指标或故障风暴预算。
- 浏览器 image ID：`sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`；Nginx image ID：`sha256:201aafcbd9cdd5385d5aaf610b45389944d8c2269c4a6f10e6fdf39f76cab592`。
- 停止探针：`docker stop mw-issue75-v2-native-probe mw-issue75-v2-browser`；不删除旧任务资源。启动可用 `docker start` 恢复这两个已命名容器，私有探针文件在 `/tmp/mw75-native-probe`。

## W1 初版冻结

接口前缀 `/api/notification-center`：`events`（浏览器可靠接收/历史分页）、`events/{id}`（详情）、`events/{id}/timeline`、`observations`、`changes`、`stream`、`health`。浏览器来源与后台可靠 Audit 分别扫描未处理凭据；事件、事故、发布游标、观察独立持久。服务器从现有单管理员会话推导 `admin`。

预算沿用 V2 §9：单事件16 KiB、本机1000条/10 MiB/七天、浏览器接收60/min突发120、摘要200/气泡20、投影及默认页100、API上限500、事件30天/日志七天。浏览器风暴验收额外冻结：新通知处理不能触发图表数据重新加载，空闲不写通知事件；1000条积压由100条批次恢复。实际吞吐与交互延迟在最终镜像下记录，不能用组件探针预先宣称满足。

来源特殊约束：原生历史任务的最终写入是 Core update，必须在该事务显式记录可靠事实，不能依赖 ORM after_update。固定指标后台 pending/visible_complete 不直接投影；仅当前消费者恢复预算耗尽的终态生成浏览器故障。通知接收失败不递归进入来源。

来源恢复要求真实成功和同一上下文；客户端恢复引用具体失败事件，过期恢复不得关闭已出现更新失败的事故。专业图表业务告警使用独立发生身份；渠道变更不增加发生数或提醒版本。

## 实施中间检查（未签收）

- 通知模块与原生侧栏已实现初版，工作区/偏好最终失败、指标恢复耗尽、原生历史失败等接缝接入中；旧 Shell signal 自动声音路径移除。
- 新增单测 14 passed；相关 chart-alert 单测合计此前 24 passed / 1 skipped，新增 4 项后待最终重跑。
- Docker PostgreSQL 专项 4 passed：反序来源提交、发布锁/回滚、并发幂等、av49→aw50 重复加性升级。测试每次使用任务库中的独立临时 schema。
- 本任务 PG/API/projector/Web/chart 均已启动。API/PG/projector 位于无默认出网的 internal 网络；仅 Web/chart 另接本任务 browser 网络用于回环端口发布。原有任务保留。
- 通用 D1 的旧 managed 图格不能作为本轮原生来源验收数据，另用本任务新建的固定历史版本和 mw75-a/b 工作区。生成脚本 seed.py 无供应商连接，不使用 #85 数据。
- 原生启动实际联调发现首次 dataReady 可无限等待，已改为有界等待并保留父页面入口；待最终镜像重验。
- 全套 Docker 测试、Playwriter、独立 Standards/Spec review 与最终镜像仍进行中；此提交是可审查的实现检查点。
