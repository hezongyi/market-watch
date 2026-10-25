# 开发分支整理（2026-10-25）

后续主开发入口统一为：

- 分支：`market-watch-integration-20261024`
- 工作树：`/home/quant/repos/market-watch-integration-20261024`
- 本次快进：`8dd4faf2b5db2a46829d65b9873882b1f09fabc2` → `1c8a8ac818693aa3bcc1df28a62456a50f37cd20`
- 产品提交：`feat: integrate FXCM history, history modes and mobile charts`

快进纳入已部署的 FXCM、历史维护模式和手机图表集成提交，随后仅补本整理记录。验收实例运行源码仍对应 `1c8a8ac8` 的产品内容；本记录没有触发构建或部署。FXCM 首次冷加载延迟按用户决定后续处理。

## 分支归档与保留

| 原分支 | 当前分支 | 处理结果 |
| --- | --- | --- |
| `integration/fxcm-mwa-20261025` | `archive/fxcm-mwa-20261025` | 已提交的交付快照；工作树保留且干净 |
| `feat/fxcm-platform-managed-20261024` | `archive/fxcm-platform-managed-20261024` | 原 FXCM 开发现场；112 项未提交状态原样保留 |

这里的归档仅改变本地分支名，不代表原工作树的未提交文件都已纳入整合提交。两个工作树目录不变；旧 FXCM 目录仍有独立实例的只读配置挂载，因此保留原路径。

以下分支保留原名称与现场，未自动合并或废弃：

| 分支 | 保留原因 / 整理时状态 |
| --- | --- |
| `feat/managed-history-modes-20261024` | 88 项未提交状态，包含尚未完全整合的 UI 与研究内容 |
| `integration/history-modes-mwa-20261024` | 92 项未提交状态，包含暂存及未暂存修改、后续 A 股/复权计划 |
| `docs/history-maintenance-modes-20261024` | 1 项未跟踪计划文件 |
| `docs/mobile-web-capabilities-20261024` | 3 项未跟踪分析文件 |
| `docs/mobile-ui-plan-20261025` | 独有计划提交 `ddbb1810`，工作树干净 |
| `prototype/mobile-ui-preview-20261025` | 独有预览提交 `e30f8a9a`，工作树干净 |

`main` 保持 `59ed3a3f3fc727da76d13149934d999ebee04218`；既有 `archive/android-mobile-20261024`、`archive/mt4-integration-20261024` 不变。本轮保留全部 12 个本地分支和 10 个工作树，没有减少数量。

## 备份与验证

私有证据目录：`/home/quant/repos/archives/market-watch-development-branches-20261025`。

- `branches-before.bundle` 保存整理前 Git 引用与历史；已实际恢复 heads/tags 至 `restore.git`，逐项核对引用并通过 `git fsck --full --no-reflogs`。
- `archive-verification.json` 记录 bundle SHA256 与恢复验证结果。
- `worktrees-before.json` / `worktrees-after.json` 记录文件摘要、HEAD、完整 Git 状态、暂存及未暂存补丁摘要。除主开发工作树预期的快进外，其余工作树逐项一致，未提交文件继续保存在原目录。
- `runtime-before.json` / `runtime-after.json` 核对全部 Docker 容器 ID、镜像、启动时间及状态，一致。
- `result.json` 记录整理验证通过；没有删除工作树、备份、分支、数据或 Docker 资源，没有推送或合并 main。

本次属于 P0 本地分支与文档整理。已完成引用、实际恢复、工作树保留、快进及运行身份核对；产品文件沿用既有验证结果，详见 [交付提交记录](../../verification/fxcm/mwa-native-periods-20261025/consolidation.md)。本次未新增产品改动，无需重复构建或业务测试；未创建 PR 或运行远程 CI。
