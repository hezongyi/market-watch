# v1.10.0 原生 MCP 源码交付

2026-10-06。原生 HTTP MCP、能力注册、agent 身份与已保存画线读取属于兼容新增功能，使用次版本 1.10.0。通过 [PR #10](https://github.com/hezongyi/market-watch/pull/10) 保留实施和修复提交；用户已授权合并及推送附注标签。最终 main 合并提交由 `git rev-parse 'v1.10.0^{commit}'` 解析，标签只创建一次，不覆盖旧版本。

最终受测功能提交为 `8792b99713e25b58a71d56e3056fafe31ed2439d`。发布准备只调整 Python/web/锁文件根包版本及 CHANGELOG、README、版本维护和交付记录；运行代码、依赖锁定和迁移与该受测提交保持逐字节一致。完整后端回归为 497 passed、38 skipped，实际 Ubuntu Docker/PostgreSQL 14、HTTPS 官方 SDK、真实网页画线保存、实际 Codex 0.160.0、真实 Binance 数据及项目启停持久性均通过；原始证据见 [验收记录](verification/native-mcp/acceptance.md)。版本一致性、发布输入等价和包构建另见 [发布核对](verification/native-mcp/release-audit.json)。

本次是源码发布；已有验收 API 镜像仍为 1.9.0 包元数据，不声称由 v1.10.0 标签重新构建。Ubuntu 独立 `mw-native-mcp-acceptance` 实例、镜像 ID 和资源归属保持 [环境记录](verification/native-mcp/environment.json) 的实际来源，连接与启停方式见 [使用文档](native-mcp-usage.md)。没有重新构建容器、切换实例或部署生产。

新增 `s20_agent_capabilities` 是 `r19_native_history_loads` 后的增量迁移，增加 agent 凭据和幂等记录；官方 `mcp==2.3.0` 和固定传递依赖为本期功能变更。MCP 默认关闭，需显式启用并签发独立凭据；精确指标由后台计算，不在对话中凭心算替代。旧原生图表文档需在新客户端重新保存才有可信绘图投影。合成 EURUSD/绘图夹具与实际 Binance 来源明确分开，不把合成样本当实时行情或跨周期聚合验收。

源码清单见 [v1.10.0-source.json](../deploy/releases/v1.10.0-source.json)。源码回退基线 v1.9.0；回退标签不会改变现有实例。未来生产部署需另行授权，按标签固定构建并先验证备份、迁移与目标实例；不得仅因源码回退便删除 agent 凭据、幂等或审计数据。无计划 CRUD、形态扫描和交易工具，未执行实盘操作。
