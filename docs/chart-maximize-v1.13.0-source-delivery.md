# v1.13.0 源码交付

2026-10-07。图表功能 PR [#17](https://github.com/hezongyi/market-watch/pull/17) 在 `699e6ec` 合并；运维修复 PR [#18](https://github.com/hezongyi/market-watch/pull/18) 在 `c18b219` 合并。本次发布整理仅同步版本及交付资料，不改变已审查实现。附注标签 `v1.13.0` 指向发布整理 PR 的最终 main 合并提交；使用 `git rev-parse 'v1.13.0^{commit}'` 解析。旧标签保留。

桌面多图主图空白处双击最大化／恢复复用原生实例，保留指标、画线及同步选择。操作、排除情况和历史验收环境见 [功能交付](chart-double-click-maximize.md)。PR #17 受测 head 为 `3c3b57b6f1a1d31524bc99d96ee8a92fbee244f8`。审查期间复验正常和 CPU 四倍限速各22项、合并资产 bridge 4项、补丁升级／重复安装／撤回／篡改拒绝及原同步回归通过。真实行情应用4项和用户验收属于之前 Ubuntu 隔离实例的历史证据；实例已备份、实际恢复核对并精确退役，原网址已关闭。

PR #18 最终受测 head 为 `5ba761d16c9c057340bc4c607366cc14d1588259`。PG/TLS 基础镜像以实际 image ID 和固定官方 digest 校验，拒绝任务／正式／回滚归属；未知 digest 拒绝退役，需审查后更新允许值。42项运维测试、Ruff及两个现有 Ubuntu PG 容器的只读身份验证通过，Standards／Spec 复审均无阻塞。Ubuntu 已安装的 `mw-docker` 与 `c18b219` 源码一致。

[源码清单](../deploy/releases/v1.13.0-source.json)记录实现文件 SHA256 和验证边界。无新增 schema 迁移或依赖；schema 保持 `u22_chart_alert_actions`。本次没有构建或改标生产镜像，也没有切换 Unraid 生产。部署时需另行授权，按新标签实际构建并记录镜像映射；不得将历史验收镜像当作新标签构建产物。源码回退参考 `v1.12.1`，运行实例回退按实际部署清单。
