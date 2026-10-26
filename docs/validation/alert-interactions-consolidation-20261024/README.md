# 告警交互分支整理收口

用户确认人工验收通过，并认可分支/worktree 整理建议后授权执行。分类 P0：归并既有验收通过提交、迁移私有探针路径和整理源码工作区；本轮没有新增业务修改或部署。

后续源码入口为 `/home/quant/repos/market-watch-integration-20261024`，分支 `market-watch-integration-20261024`。从 `71e13ae3` 快进到 `17b51d1b0ebe8e6e76b15fcf792cb031bb569276`，完整纳入本轮六个提交，归并后树与原开发分支完全一致。原 `feat/alert-ui-interactions-20261024` 分支及同任务 worktree 已移除；没有合并 main 或推送。

## 归档和实际恢复

私有归档目录：`/home/quant/repos/.archives/market-watch/alert-interactions-consolidation-20261024`。

- `branches.bundle` 保留完整分支历史；独立 bare 仓库恢复分支 tip 并通过 `git fsck --full --no-reflogs`。
- 完整工作树归档包含 ignored 许可库、构建产物和 node_modules 符号链接，不跟随链接删除集成工作区依赖。
- 实际解包后核对 9,663 个文件及 1 个符号链接的 SHA256、权限及链接目标，重建 Git 索引并核对原 status/staged/unstaged 状态；删除前再次验证源码与归档一致。
- tar 大小 202,993,190 字节，SHA256 `331ff7d127580c93e0a14e1263b00bbce833d4145af789f1aba4ff841a168418`。
- 原探针、registry、Git 元数据、manifest、恢复及删除记录均私有保留；恢复命令见归档目录 `README.md`。归档含许可及私有材料，不提交仓库。

## 后续探针与检查

两套私有 `.mwa-alert-axis-menu-20261024` / `.mwa-alert-interactions-20261024` 目录内共四个浏览器探针已改用集成工作区，原件已备份。语法检查和依赖解析通过。旧 native-interactions 探针保留历史的直接创建预期，不能作为当前加号菜单行为验收入口。

当前菜单探针 `/home/quant/repos/.mwa-alert-axis-menu-20261024/image-axis-menu.browser.cjs` 已在迁移后运行通过：点击加号只开菜单、Escape 关闭不创建、选择告警后只创建一次且使用捕获价格、不弹编辑器，pageerror 0。使用固定镜像资源、许可图表和模拟 API，无真实数据库写入。结果：`/home/quant/repos/.reports/market-watch/20261024-alert-interactions-consolidation/image-axis-menu/result.json`。

本轮检查为恢复完整性、快进树一致性、脚本语法/路径、上述局部浏览器回归及运行现场审计；没有重新构建产品或重复全量测试。

## 实例与其他任务

Ubuntu `quant-server` 长期验收入口：`https://192.168.7.232:18280/advanced-charts/mw75-real`。15 个服务运行，API/PG healthy。已有 22 个容器的 ID、镜像、启动时间、状态、健康及重启计数保持；保护浏览器身份和配置审计通过。网关原始摘要差异经验证仅来自 Docker 挂载列表顺序，有效配置没有变化。

整理期间其他任务新增 `mw-history-modes-pg-20261024-pg-1`，FXCM 工作区出现并发未提交修改；均未触碰，不宣称整个工作目录干净。其他原有 worktree HEAD 和分支 tip 保持。本轮没有执行 Docker 变更或清理，也没有删除数据库、卷、镜像、证据及回退材料。

实际产品仍为 Chart `a641f019`、Web `19cc026a`、API `b4e1326a`、workers `8b7ee3ee`；整理文档提交不是部署源码身份。完整记录见私有 `preservation-check.json` 和 acceptance registry。

统一启停入口保持：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。当前 Chart 操作/只读审计入口保持：`python3 /home/quant/repos/.mwa-alert-axis-menu-20261024/operate.py start|status|stop|audit`。本轮已执行 audit 通过。
