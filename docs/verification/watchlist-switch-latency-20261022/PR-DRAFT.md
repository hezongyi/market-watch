# fix(chart): reduce watchlist first-screen blocking with bounded admission

Base: `integration/mwa-20261022` at `983b402`。产品候选 `defdcf9`；这是本地草案，尚未推送或创建远端 PR。以该集成基线审查，避免将此前集成工作误算为本次独立修复。

自选切换时，指标释放／续租、报价和预取可能占满普通四槽；平台历史结果还会等待句柄清理，而固定价格的默认指标预热会等待全局容量锁。本次集中请求用途、准入与公平规则，限制后台在途，优先活动图首屏；成功历史结果先交付，再在有界生命周期内清理。生命周期额度反馈给同一 bridge 队列，避免尚未发出的旧焦点请求在第二层 FIFO 阻塞新活动图。

默认预热使用非阻塞的原事务锁准入，锁忙则跳过可选预热；前台指标需求及 strict／observed、展示快照、容量、取消围栏、缓存和新鲜度合同保持。无 schema、持久格式或 API 数据口径变更。风险 F1，因涉及指标容量准入的重要后台链路，采用独立 PG 并发与兼容检查及双轴审查。

验证：106 项定向 Python／PostgreSQL 检查，50 条 CI 前端 runtime 命令，6 条新建 Chromium 浏览器回归，TypeScript／Vite build、Ruff 与 diff check 均通过。新增回归均能在修复前复现；Standards／Spec 跟进审查没有剩余阻断项。API／Web／Chart 已从同一干净提交构建，固定制品及完整证据见 [RESULTS.md](RESULTS.md)。

剩余：候选尚未更新长期 mwa，Ubuntu R1 原五图业务与端到端性能验收未完成，GitHub CI 未运行。后台占用收紧可能延后可选预取；不能把本地检查视为整体性能零退化。准备好固定候选和回退后，按长期实例明确更新规则继续验收；本任务不包含合并或生产发布。
