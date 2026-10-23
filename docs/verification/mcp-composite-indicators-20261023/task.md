# MCP 组合指标实施任务

分类：F0。扩展兼容的读取接口；不增加 schema、持久格式、数值算法或后台调度。

方案基线：main 6f74951；实施已 rebase 至 main ffc8149（PR #93）。
保留新增 observed_display_v1 网页策略，MCP 默认继续 strict_confirmed_v1。
独立分支 feat/mcp-composite-indicators-20261023；Draft PR #94。

验收：定向协议/共享读取测试、PostgreSQL 并发与既有固定指标回归、完整 CI、自审、Ubuntu R1。

- [x] 独立 worktree 和范围盘点。
- [x] 指标输入校验和可发现输出 schema。
- [x] 单次固定修订/输入选择、非活动修订元数据。
- [x] 组合冷启动、部分进度、null、重试、质量字段透传。
- [x] 使用说明、自审、源码完整 CI（2846 passed；PG 兼容检查及 Web/Compose 通过）、Draft PR。
- [x] PostgreSQL 一致性与网页回归（Ubuntu 独立测试数据库 70 passed）。
- [x] 任务专用 R1 配置、fixture、验证脚本；用户改选既有 mw-acceptance 后完成真实数据/HTTP R1，未启动备用合成实例。
- [x] 真实协议和数据保留证据、PG 日志、运行版本/源码哈希归档与 A1–A12 完成审计。
- [ ] 最终证据提交的 PR CI（源码与此前完整绿色提交相同）。

不承诺跨调用复算；不涉及合并或生产发布。
