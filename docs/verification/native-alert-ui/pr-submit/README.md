# 原生告警 UI：PR 提交复验

本页为首次提交 PR 时的历史证据。PR 审查后的修复与最终 v1.19.0 Docker 验收见 [修复与合并复核](../review-fixes/README.md)。

2026-10-11。实现提交 `1741c9c` 基于 v1.18.0。PR 目标 main 已推进至 v1.19.0，提交 `6a928ce035739faa7c8b501f6a42165d30253cd7`；提交 PR 前在本分支合并该 main，以保留现行商品状态、日历、历史价格精度及范围恢复行为。

唯一文本冲突位于 `advanced-host/bridge.js` 的 pagehide 清理函数。解决后同时销毁告警 UI/bridge、紧凑报价面板、报价与时区订阅，以及原有图表适配器。后台、数据库迁移、版本文件、生产 Compose、data-center 与 native-navigation 直接采用 main，没有为告警改写这些功能。

合并后的源码检查：

- `npm run build` 通过（tsc、Vite、原生数据中心内容）；[日志](web-build.log)。
- 告警 domain/API/service/geometry、基础 SSE、日历与报价契约：78 passed；[日志](backend-tests.log)。
- 告警 bridge/UI RPC、行情流、工具栏生命周期、新版报价展示/失败与原生范围恢复：15 项通过；[日志](js-tests.log)。
- 完整 AdvancedWorkspace、当前 bridge 和真实许可库：4 组通过，0 页面异常和意外 API 路径；[结果](workspace-integration.json)。
- JavaScript 语法、`git diff --check`、私密材料排除检查通过。

实际源码摘要见 [source-hashes.json](source-hashes.json)。上述浏览器集成采用 Ubuntu 本机 Chromium、真实许可库和进程内模拟 API，没有部署新实例。

保留的 Ubuntu Docker 验收实例仍运行 v1.18.0，实现地址、密码和启停方法沿用 [v1.18.0 验收记录](../v118/README.md)。完整 v1.18 Docker 回归、备份恢复与数据持久性证据也在该目录；本次 PR 提交没有重建该实例，没有发布生产。
