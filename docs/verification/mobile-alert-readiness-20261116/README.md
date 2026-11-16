# 手机告警运行可靠性与可确认状态验收

日期：2026-11-16
分支：`feat/managed-live-rollover-20261113`
环境：Ubuntu 本机 Docker，`mw-managed-live-rollover-20261113`，`https://192.168.7.232:18447/m/alerts`

## 交付结论

告警功能已完成本轮生产级稳定性收口并部署到本验收实例。启用规则、后台接管、逐规则检查、最近判定、来源等待、通知投影/保留/投递/归属/健康状态现在分开表达；页面不再把“服务器在线”误报为“该规则正在监控”。规则详情首屏显示最近检查与最近判定，服务或来源异常显示对应原因，过期健康响应不会覆盖新状态，离线会立即进入“离线待确认”。

当前真实规则本身保持不变，没有创建、编辑、暂停、归档或触发真实规则。重启验收服务后，原规则仍保留原身份、版本、配置、状态和计数，后台检查时间继续推进。重启后的即时状态为“等待数据/确认来源不可用”，这是 OANDA 上游实际 HTTP 401 的真实状态，不伪造为“监控中”；告警执行服务仍在工作，检查时间在重启后继续推进；来源恢复后按既有自动恢复机制接续。

手机端应用内告警记录可以独立使用。当前实例未配置 ntfy/外部推送，锁屏手机通知尚未验收，不能将其描述为已完成的手机推送能力。

## 已实现

- 健康接口兼容返回 `enabled`，并保留实际心跳、owner/run_id 和规则运行证据；运行中的 owner 不被静态关闭配置覆盖。
- 规则返回 `activity` 与价格规则 `execution.last_outcome`，记录接管、检查、实际新输入判定、结果；重复读取同一输入不会冒充新判定。
- 非价格规则也能显示实际接管与最近检查；关闭、等待来源、暂停、到期、基准建立和投递问题分别映射到相应状态。
- 告警页采用独立健康请求超时与 generation 防旧响应覆盖；规则读取有界超时；离线事件立即使当前会话进入离线并中止待处理刷新。
- 列表与触发记录使用稳定游标分页；详情判断结果只在版本/运行/判定变化时刷新；操作反馈写入应用日志而非顶部闪动浮窗。
- 实例补齐并启用 `market-runtime` 告警执行与 `notification-worker` 五个后台角色；保留数据库、TLS、APK 下载和其他服务。未执行 Unraid、PR、CI、合并、tag 或生产发布。

## 验证证据

- `notification-final.log`：通知中心、投递重试、实际 PostgreSQL 链路，84 passed。
- `runtime-postgres.log`：实际 monitor、PostgreSQL 提交、触发幂等、暂停/恢复、通知 503→200、非价格判定元数据，59 passed。
- `backend-targeted.log`：健康、运行 owner、并发与 API 目标回归，17 passed。
- `workflow-final/`：完整手机告警工作流、表单、规则生命周期、分页、记录、离线与通知配置回归。
- `status-complete-final/`：慢健康响应竞态、服务停滞、心跳过期、来源等待、休市、基准、离线恢复，375px 浅色与 412px 深色 150% 字号截图。
- `deployed-runtime/probe.json`：部署后真实规则与五个通知角色均健康，规则检查持续推进。
- `deployed-ui/`：真实部署页面只读截图与检查，无业务写入、无页面错误。
- `after-start/probe.json`：部署启动后初次观察，规则已接管并检查。
- `/tmp/mw-alert-readiness-20261116/recovery-observation.json`（本机临时证据）：后台服务重启后规则检查继续推进；OANDA 随后多次返回 HTTP 401，规则保持 `recovering/confirmation_source_unavailable`，没有伪造成功。
- `deployment.json`：镜像摘要、shell 版本、严格 TLS/APK CA、服务保留核对。
- `original-failures/`：初始故障红证据，仅用于说明收口前问题，不作为通过证据。

部署镜像：

- API：`market-watch-api:mobile-alert-readiness-20261116`，digest `sha256:2d1b3ce3fef1708e3a0fe53beeff356c9661e7bafa957a1533532fae5ed0a1c0`
- Web：`market-watch-web:mobile-alert-readiness-final-20261116`，digest `sha256:bd377139f12cadbca080ebf5bf72ed5f2d97d8161766262d04b2f84749816b72`
- Mobile shell：`d737795427509fa5`；APK 仍为 `0.1.4`，无需重装，应用内“更多 → 检查更新”。

## 边界与后续

本次修复没有改变阈值、判定语义、数据 schema 或通知渠道配置。若需要锁屏推送，需要后续为该实例配置独立 ntfy 并用 Android 真机验证；在此之前应用内告警记录仍可正常使用。当前真实来源的 401 已如实显示为等待数据，不能用一次独立探针成功替代正式流恢复证据。
