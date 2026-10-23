# MCP 固定历史版本指标接通

需求：复用现有已发布历史版本和图表计算，使 `indicators_calculate` 同时返回该版本 K 线、
指标值及依据。组合指标沿用 PR #94；不新增通用流水线、固定工作流或复算快照。

分类 F0：兼容的 MCP 输入/输出扩展，复用现有任务和存储；无数据库迁移、算法或持久格式变更。
最小检查为定向协议/共享图表回归、CI、自审和 Ubuntu R1。

分支 `feat/mcp-history-indicators-20261023`；worktree
`/home/quant/repos/market-watch-mcp-history-indicators-20261023`。
此补丁依赖 `feat/mcp-composite-indicators-20261023`，以该分支作为 Draft PR 基线。

- [x] 显式 history 输入和 UUID/MWH 规范化，拒绝冲突参数。
- [x] 共用固定版本读取/计算、进度、null 及依据；不回退最新版本。
- [x] 版本不可用或周期未发布时明确失败，不创建行情需求或供应商请求。
- [x] 输出 schema 和调用说明。
- [x] 定向协议与共享读取回归：首轮 71 项通过；最终定向 30 项通过，见 results.md。
- [x] 使用说明、R1 脚本及本人自审。
- [ ] Ubuntu R1 真实 HTTP MCP 冷启动/部分完成/完成。
- [ ] 最终 CI 和 Draft PR。

不涉及 main 合并、生产发布或永久数据删除。
