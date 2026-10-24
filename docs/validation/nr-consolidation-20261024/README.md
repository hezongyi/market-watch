# NR4/NR7 分支链路整理与归档

状态：完成。用户认可盘点建议后授权执行，记录于 2026-10-24T17:11:47.533450+00:00。分类 P0：补入已有验收文档与浏览器测试修正，并整理重复源码工作树；没有业务代码、schema 或运行部署变更。

## 唯一后续源码入口

- 分支：`market-watch-integration-20261024`
- 工作树：`/home/quant/repos/market-watch-integration-20261024`
- 本轮归并提交：`f9df29c93271d8fef6a1f83322ea80c3b20bf20b`，将提醒 UI 独有提交 `1e66040e` 合入；其三份文档及浏览器截图交互修正完整保留。
- NR 正式实现 `8b7ee3ee`、绘图归属 `8dc8a24e`、重启丢图 `b1a479a7`、加载闪动 `c68fd817`、最终记录 `2b3c8da9` 均已是主集成祖先。没有重复合并旧工作区的实现。
- 与整理前 `d91ed479` 相比，`advanced-host/`、`backend/alerts/`、`web/src/` 业务源码完全一致。

## 已归档并清理

| 原分支 | 原提交 | 原工作区 | 结果 |
| --- | --- | --- | --- |
| `feat/nr4-nr7-breakouts-20261024` | `59ed3a3f` | 27 个未暂存文件、42 个未跟踪文件 | 已归档并移除 |
| `integration/nr4-nr7-mwa-20261024` | `3e674dd7` | 33 个暂存文件、12 个未跟踪文件 | 已归档并移除 |
| `integration/nr4-nr7-mwa-v2-20261024` | `59f07cdd` | 33 个暂存文件，其中 5 个另有未暂存修改；35 个未跟踪文件 | 已归档并移除 |
| `integration/nr4-nr7-mwa-v3-20261024` | `2b3c8da9` | 干净 | 已归档并移除 |
| `fix/preference-draft-banner-20261024` | `54b66bb3` | 干净 | 已归档并移除 |
| `feat/alert-ui-reference-20261024` | `1e66040e` | 干净；独有提交已补入 | 已归档并移除 |

六个同任务名 worktree 均已移除。前三套未提交工作通过完整文件归档和 staged/unstaged binary patch 保留；不能仅依靠已合并的分支 tip 判断可直接删除。

私有归档：`/home/quant/repos/.archives/market-watch/nr-consolidation-20261024`。六个 tar 共 1180391714 字节。实际解包后逐项核对 **56468 个文件和 29 个符号链接**，含文件权限及 ignored 材料；重建 Git 暂存树，并核对 status、staged、unstaged 差异与原件一致。完整历史 bundle 已独立恢复并执行对象完整性校验。逐归档 SHA256、tip 和校验结果见 [summary.json](summary.json)。

恢复方法详见私有归档目录的 `README.md`。其中 `branch-tips.json`、逐文件 manifest、原始 gitdir、原始差异与 `cleanup-result.json` 一并保留。归档可能含私有配置和许可资源，目录权限 0700，不提交归档内容。

## 保留的其他任务与运行现场

保留 `feat/managed-history-modes-20261024`、`integration/history-modes-mwa-20261024`、`docs/history-maintenance-modes-20261024` 和 FXCM 任务。特别是 history-modes 集成分支虽然承载首次 NR 提交，但其 87 个新暂存文件属于另一项任务，没有被清理或重置。

五个其他 worktree 的 HEAD、status、staged 和 unstaged 差异摘要整理前后均一致。Ubuntu 全部 22 个既有容器的 ID、镜像、启动时间、状态、健康、重启计数及有效配置摘要均保持。

长期验收 `mw-issue75-v2-20261018`、保护浏览器、所有数据库卷、原始 `.reports`、`.mwa`、镜像及回退配置保留。已停止的 NR 专项 PostgreSQL 容器和数据卷也未删除。

当前实际组件版本仍以 acceptance registry 为准：API `b4e1326a`、workers `8b7ee3ee`、Chart `bacbcd7d`、Web `970a2550`。没有将归并提交冒充运行镜像的源码身份。

## 检查与后续入口

- 归并无冲突，新增差异 whitespace 检查及浏览器脚本语法检查通过。
- preference banner、request queue、NR display/restart 四个回归入口通过；chart-alerts bridge **9 项测试通过**。
- 许可原生提醒 UI 浏览器回归通过，覆盖 **16 组价格坐标**、多图、模式、编辑、日志、归档、窄屏及 200% 字号；pageerror **0**。使用合成 feed/API，无真实数据库写入。结果位于 `/home/quant/repos/.reports/market-watch/20261024-nr-consolidation/alert-reference-native/result.json`。
- NR 新业务探针：`node /home/quant/repos/.mwa-nr-consolidation-20261024/browser.cjs`。改用主集成源码、独立报告目录和保留的原私有凭据；本轮验证语法，未重新执行整套 NR 运行验收。
- 历史脚本保留作证据；引用已退役 worktree 的脚本需先恢复目录。后续运行使用上述新探针。
- 长期验收启停不变：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。

未运行全量后台、Web 重建或远端 CI；本轮业务源码没有变化。未推送、创建 PR、合并 main、打 tag 或操作 Unraid。
