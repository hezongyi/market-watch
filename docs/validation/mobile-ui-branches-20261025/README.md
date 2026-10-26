# 移动端计划与原型分支整理（2026-10-25）

用户认可“保留资料，归档后清理两个分支及 worktree”，并明确要求执行。本次 P0，仅整理历史文档与本地 Git 工作区，不修改产品源码。

## 保留内容

- 原计划 `docs/mobile-ui-plan-20261025` / `ddbb1810af375a0db2d278ba5c801f7e00a0df57`：1 个独有 Markdown 文件，收录到 [历史任务书](../../mobile-ui-agent-plan-v1.29.0-rc.1-20261025.md)，顶部补充当前状态与旧指令边界。
- 原型 `prototype/mobile-ui-preview-20261025` / `e30f8a9af87bc6d9b49b89e61d2a924c9b11fa2d`：21 个独有文档、截图及静态原型文件，完整保存在可恢复的本地 Git 归档中。
- [已发布静态原型](https://pages.kookvv.com:8443/sites/market-watch-mobile-ui-preview-20261025/?variant=A&mode=single) 保留；本次没有调用网页库发布、删除或回滚。

当前产品基线 `ba5407b2` / `v1.29.0-rc.3` 已包含移动端实现，不能将旧计划的“尚未实施”理解为当前产品状态，也不能宣称原计划全部完成。后续从当前集成分支开任务，不直接执行旧的 rc.1 启动指令。

## 归档与验证

本机归档：`/home/quant/repos/.archives/market-watch/mobile-ui-branches-20261025`。

- `branches.bundle` 保存两个分支及完整可达历史，已执行 bundle verify。
- 已从 bundle 实际创建 `restore.git`，核对两个分支 HEAD/完整树 ID，并通过 `git fsck --full --no-reflogs`。
- 从恢复仓库提取并逐字节核对 22 个独有文件；文件 SHA256 见 `file-manifest.json`，恢复文件见 `recovered-files/`。
- `before.json`、`verification.json`、归档 `README.md` 保存分支身份、bundle 摘要和恢复命令；`cleanup.json` 保存清理后的核对结果。
- 清理前两个工作区均无未提交、未跟踪和忽略文件，未发现对应 Docker 挂载或进程工作目录依赖。

## 清理范围

仅删除以下两个本地分支及关联 worktree：

- `docs/mobile-ui-plan-20261025`：`/home/quant/repos/market-watch-mobile-ui-plan-20261025`
- `prototype/mobile-ui-preview-20261025`：`/home/quant/repos/market-watch-mobile-ui-preview-20261025`

原型实现不作为业务代码合入。其余分支、工作区、实例、数据库和生产资源保持；既有候选标签仍指向原提交。本次不推送、合并 main、打新标签或触发部署。

验证采用归档恢复、树/文件核对和 Markdown diff 自审；无产品变更，不新增业务测试或构建。
