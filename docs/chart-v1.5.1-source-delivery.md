# v1.5.1 图表能力与 MT4 桥接文档交付

v1.5.1 是文档修订版，将五篇研究文档合为一次本地提交，同时同步 Python、web
及锁文件根包版本。固定功能基线为 `v1.5.0`：
`37cf4048ca10f3206963c1aec67f49b38140f5a8`。

- [警报模块](advanced-charts-v31-alert-module-research.md)：原生占位与项目预警接入。
- [回放模块](advanced-charts-v31-replay-module-research.md)：原生缺口与现有演练适配。
- [策略、Pine 和交易](advanced-charts-v31-strategy-pine-trading-research.md)：公开接口和执行边界。
- [后续接入能力](advanced-charts-v31-future-integration-capability-research.md)：已接功能、候选优先级及数据依赖。
- [Windows MT4 桥接](mt4-live-trading-bridge-research.md)：同局域网 DWX Connect 路线及交易状态恢复。

研究仅静态核查，不表示已接入警报、原生回放、Pine 或 MT4 实盘。引用已按当前
实际 loader 和 v1.5.0 源码整理，旧 bundle 只作注明的交叉参考。

运行源码、测试、依赖与数据库 schema 保持基线；schema 仍为 `p17_volume`，
没有新增迁移。本次版本元数据变化不会自动升级已有运行环境。

本次验证包括文档本地链接及行号范围、四处版本一致性、依赖与锁文件等价、
所有原有受 Git 管理文件的变更范围、前端生产构建及 Python wheel 构建。
wheel 中运行模块与基线逐字节相同，核对结果见
[发布核对](verification/research-release-v1.5.1/audit.json)。前端构建保留既有
大文件提示；没有重新执行功能、浏览器、通知或真实交易验收。
[v1.5.0 验证记录](chart-v1.5.0-source-delivery.md)继续保留其原有来源和范围。

`fix/docs-v1.5.1` 只有一次发布提交，本地 `main` 快进到同一提交，附注标签
`v1.5.1` 指向该提交。源码清单见
[v1.5.1-source.json](../deploy/releases/v1.5.1-source.json)。本次未推送远端，
未构建或改标容器，也未切换本机实例或部署生产。既有镜像保持原发布清单来源。
源码回退基线为 `v1.5.0`；本次没有运行环境变更，无需运行回退。
