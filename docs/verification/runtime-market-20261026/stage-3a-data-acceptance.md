# 阶段 3A：data-worker 验收

日期：2026-10-28。实现基线从 PR #108 的 `e373f11c` 起步；CI 修复提交 `001564f4` 在 PR #108 分支并随本阶段堆叠。当前集成分支包含统一图表 SSE 提交，以及 data-worker 职责迁移。本记录只签收阶段3A，不代表阶段3B、最终五应用服务、生产部署或性能门槛全部通过。

## 职责与拓扑

- 默认和生产 Compose 使用 `web`、`api`、`market-runtime`、`data-worker`，通知投影和投递仍各自一个容器；阶段3B负责通知组收敛。
- data-worker 通过 `alerts.runtime --profile data` 装配供应商逐源 live/warm、逐源 transport、janitor、chart history、history network、history compute、native history、chart aggregation 和 market stream。
- `history_network` 独立创建来源适配器，执行图表准备及固定历史导入；`history_compute` 执行产物、调度、指标、显示指标和修订任务。二者分别关闭适配器/PublicationWakeup，沿用原持久任务 lease 与通知唤醒。data-worker 不装配组合 aggregate 队列。
- API 不启动 provider 持续调度。组合实时输入、聚合与告警仍由 market-runtime 持有。
- 各来源 transport 在独立监督循环推进维护；成功/失败进度来自维护操作结果，不由旁路计时器伪报。

## 验证结果

- 定向本地回归：data/runtime health、provider transport、history worker、market-stream、API 生命周期及 Compose 合同 **85 passed，29 个 Compose 子断言通过**；Ruff、`git diff --check` 通过。另含 history phase 拆分回归的 41 项定向集 **41 passed**。
- Ubuntu 本机隔离 Docker task/project：`mw-runtime-data-stage3a-20261028`。独立 PostgreSQL 14.24 volume/network，无宿主端口；合同测试容器只读挂载本 worktree。PostgreSQL 合同覆盖 runtime ownership、历史恢复/产物、market stream、组合聚合、告警。完整运行 **153 passed / 20 warnings / 338.51s**。其中首轮曾发现 phase 顺序断言回归；调整后关键复跑 54 passed，最终完整复跑全绿。
- SSE 浏览器验收：共享单 EventSource 的供应商/自建共用、cursor 重连、reset、切换 generation、取消均通过；授权图表库真实 widget 验收中供应商/自建回调、reset 后 HTTP 历史重载、切换、重连、取消均通过。使用本机已存在的图表库只读路径，没有复制或提交授权文件。
- `npm run build:ui` 通过；Compose service 配置合同 5 passed / 29 subtests。默认 Compose 渲染有 7 个服务（含 migrate）；生产模板渲染同样含 data-worker，依赖 migration 而不依赖 API healthy。
- PR108 根因修复已提交并推送 `001564f4`：SQLAlchemy 测试 URL 显式保留密码，并同步 cadence 测试的 250ms 默认合同。没有等待该提交的新 CI，按用户要求继续推进。
- Standards 和 Spec 独立复审：最新阶段3A差异均为 0 个阻塞；结论范围为代码/调用链只读复审。

## 限制与结论

- 没有在本轮运行 production/Unraid，也未合并 main、创建正式 tag 或部署生产。
- 本轮没有运行慢源积压下的联合延迟基准。已有超阈值性能结果仍记为验收偏差和后续优化，不转换为通过；不因该项阻止本阶段功能收口。
- 阶段3A数据运行组及图表 SSE 功能验收完成，可作为独立堆叠 Draft PR review。通知组三阶段收敛、阶段4有效部署/状态清理及阶段5联合验收仍未完成。

隔离合同配置：[`deploy/ubuntu/runtime-data-stage3a.contracts.yaml`](../../../../deploy/ubuntu/runtime-data-stage3a.contracts.yaml)。
