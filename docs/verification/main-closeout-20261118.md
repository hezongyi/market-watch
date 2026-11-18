# 最新开发成果收口到 main

用户授权：将截至 `182be9f9` 的连续开发成果完整合入 main，不发布生产、不打 tag、不清理分支或数据。

## 范围与完整性

- PR #145，源分支 `feat/mobile-notification-polish-20261117`，起始 main `2c6cc212`。
- main 与共同祖先 `ba10541f` 的 tree 相同；原源分支包含23个待合提交。PR #144 已合入该源分支，尚未进入 main。
- 原源分支与已通过完整 CI 的 `ed269841` tree 相同：`0fff04102f8ea79cab13cb98e7d1b87ff7248773`。GitHub 试合并得到相同 tree，无代码覆盖或冲突。
- main 严格分支保护要求先更新源分支，追加 `c04448df`，保留全部历史，tree 不变。
- 风险 F1 沿用已有功能分类；schema、通知与后台链路的独立审查、迁移恢复及 Ubuntu mw-dev R1 证据见各专项文档与 `mobile-pending-20261117/README.md`。本收口不新增业务行为，不重复部署或迁移。

## 总范围 CI 修复

PR #145 首次对 main 运行 Ruff 时，上游文件进入检查范围，暴露39项 I001/F401/F811/E702；本地同范围命令已复现。

仅整理导入、删除未使用的 settings/pytest 导入、拆开两处同一行的数据库操作。pytest复用的fixture与测试函数使用显式同名重导出，保留发现机制和全部17个复用测试，不按未使用导入删除。

对全部8个修改文件，移除导入节点后比较 Python AST，结果完全一致；相对共同祖先修改的56个Python文件全部通过Ruff，`git diff --check`通过。最终完整回归以PR最新HEAD的CI为准。

由于本机磁盘已满，修复checkout位于Ubuntu本机 `/dev/shm/mw-main-closeout-20261118`；未清理其他任务、永久数据或备份。最终提交推送到远端保存；不在本机重复启动全量测试。现有开发实例镜像、数据、配置和APK保持原样。

## 合并验收

使用merge commit保留历史。合并前核实PR的固定head、最新main、必需检查和测试合并tree；合并后验证原最新HEAD及本次修复HEAD均为main祖先，main tree等于最终源分支tree。若main在检查期间有新代码变更，重新更新并验证，不能沿用旧tree证据。最终结果另记录在PR正文中。
