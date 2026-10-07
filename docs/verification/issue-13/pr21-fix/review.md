# PR #21 合并前修复与复审

2026-10-08，固定 main/base `ec00080ff52e34e737eea6ab2bc2ec3d27b52f76`，初始 PR head `f34a218bd8416bd85042a8ad4368a6409b2e8d64`；最终产品提交 `9e51fcf`（第一轮修复 `a6ecbbb`）。PR：https://github.com/hezongyi/market-watch/pull/21 。当前完整回归及真实备份恢复退役已完成，Standards与Spec均0阻断，建议合并；未实际合并或部署。

## 发现与修复

1. **P1：回退旧应用写入后，投影完成标记使新覆盖永久漏读。** 已完成 checkpoint 原先令官方 `--verify` 返回 examined=0；真实PG旧 writer新增 `[120000,240000)`，投影仍只读 `[0,120000)`。回退入口现在对 publication/checkpoint 所有身份失效全部来源/口径检查点，保留未确认世代；显式行政核验无论是否已完成都重新扫描原始 union，准确补充及撤回证明。实际 `131bf3c` 旧应用子进程 ingestion/publisher 新增第31条分钟后，新版核验与发布保留31条完整快照及 close=12。
2. **P1：最老聚合回填独占服务。** 原真实 worker+计算经过12.003秒、229 cycles，EURUSD五任务均未服务。现在每个品种/周期持久保存服务顺序，整批回填共用一次服务年龄；失败也轮转，锁仍用 SKIP LOCKED，预算仍只处理完整桶。新增 additive `aq44` migration 保留旧 jobs，真实PG升级/降级/升级往返验证通过。
3. **P2：核验误把合法闭市当撤销证明。** 第二轮PG对照发现00:30–01:00已确认闭市、前30分钟真实M1已足以使H1完整；修复前行政核验令 True/rev1 变 False/rev2，worker再变True/rev3。修复先剔除实际完整M1及独立合法闭市，不将这些写入原始投影；源与快照 completeness/revision/payload 保持不变。源 staging 已无时也验证快照保持；真正失效的稀疏证明仍撤回并重排。

## 当前验证

- 针对第一轮修复的三个回归先在旧代码稳定失败，再在修复后通过；相关72项通过。真实PG专组24项通过，含旧 binary 写入、锁竞争及迁移往返。
- 闭市新回归先 **2 failed in 0.55s**，修复后覆盖/PG/迁移专组 **34 passed in 53.71s**。源 staging 保留及移除两条路径均验证，真实稀疏证明撤回/恢复仍通过。第二轮审查者独立PG对照也确认验证前、验证后及worker后均 True/rev1。
- 第一轮修复完整回归 **1450 passed / 2 skipped / 69 warnings / 8 subtests passed，719.41s**；该进程在 `a6ecbbb` 上开始，后续闭市修复另跑最终完整回归，不以此替代最终结果。
- 最终完整回归：**1455 passed / 2 skipped / 69 warnings / 8 subtests passed，705.39s**，源产品 `9e51fcf`，`PYTHONHASHSEED=1`；包含52项ops及真实PG合同。两项skip为可选 `pandas_market_calendars` 和test容器缺少匹配dump工具，未把skip记pass；退役另以PG容器工具实际dump/restore验证。测试import空行格式单独重跑2项通过，产品字节未变。
- 真实聚合复验采用原计算、原worker、原合作预算及真实时钟；完整输出见 `aggregation-fairness*.json`。首次复验1.0CPU worker / 0.75CPU PG：30日BTC backlog与EUR五周期0.646秒内全部服务；持续50目标、575 cycles、每目标至少11轮、末尾未服务年龄包含在最长2.826秒内，无错误/遗漏，BTC backlog仍存在。
- 冻结配额0.75CPU / 768MiB worker、0.75CPU / 512MiB PG复验：原30日大回填场景0.534秒内10目标均已服务（EUR五任务已完成、BTC仍149 jobs）；持续50目标、572 cycles、每目标至少11轮、最长3.052秒（含末尾年龄），无遗漏/计算错误。cgroup实值保存在结果中。50目标专测聚合；历史90目标证据专测发布，两个分母不混称。

## Standards

技能要求的独立规范审查未发现阻断规范违规或有实际影响的baseline smell。已核对Ubuntu隔离、带task/project用途的mw-docker构建、additive migration、凭据与资源归属；原52项ops回归在完整suite内执行。最终文档补充已独立核查：aq44、回退失效与重新核验步骤、当前/历史边界正确；历史852条除操作说明hash外未更改；当前340文件源码清单已刷新并全部匹配。

## Spec

第一轮两个P1及第二轮P2均已独立复现并回归修复。审查者独立SQLite17项，以及独立PG轮转、官方回退→真实旧ingestion→新核验/发布和闭市对照通过。最终产品 `9e51fcf` 规格复审 **0阻断**；审查者最后独立SQLite三组 **20 passed in 3.68s**（含源保留/移除闭市两case），独立PG两P1合同与闭市对照均通过。没有把主审完整回归或历史报告当作其独立执行结果。

## 实际环境与启停

运行主机为 Ubuntu `quant-server` 的本机Docker，task/project **mw-pr21-fix**；数据库地址 **127.0.0.1:19722**，独立数据库、network及`mw-pr21-fix_pgdata`，无网页实例或生产部署。镜像 `market-watch-pr21-fix:tests` 经 `mw-docker build --task mw-pr21-fix --project mw-pr21-fix --purpose acceptance` 与专用 `market-watch-ubuntu` BuildKit 构建。镜像只复用现有依赖，当前源码只读挂载 `/workspace`，实际源码以 `source-manifest.json` 核实，镜像label的旧commit不代表测试源码。旧版本只读挂载 `/oldsource`。

私有compose/env仅位于本机 `/tmp/mw-pr21-fix-private/`，凭据不提交。验收时启动/停止方式如下；退役后不能直接宣称地址仍在线，需要新task重建独立环境并按需恢复归档。

```bash
sg docker -c 'docker compose --env-file /tmp/mw-pr21-fix-private/review.env -p mw-pr21-fix -f /tmp/mw-pr21-fix-private/compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/mw-pr21-fix-private/review.env -p mw-pr21-fix -f /tmp/mw-pr21-fix-private/compose.yaml stop postgres'
sg docker -c 'docker compose --env-file /tmp/mw-pr21-fix-private/review.env -p mw-pr21-fix -f /tmp/mw-pr21-fix-private/compose.yaml run --rm --no-deps -e PYTHONHASHSEED=1 probe python -m pytest -q -p no:cacheprovider backend/tests tests/ops/test_docker_lifecycle.py'
# 实际公平复验使用仅修改probe quota的私有override
sg docker -c 'docker compose --env-file /tmp/mw-pr21-fix-private/review.env -p mw-pr21-fix -f /tmp/mw-pr21-fix-private/compose.yaml -f /tmp/mw-pr21-fix-private/fairness.compose.yaml run --rm --no-deps probe python docs/verification/issue-13/pr21-fix/aggregation_fairness_probe.py'
mw-docker retire --task mw-pr21-fix --project mw-pr21-fix
mw-docker retire --task mw-pr21-fix --project mw-pr21-fix --apply
```

本次资源退役已完成：`mw-docker retire`精确预览后执行`--apply`，两个数据库均真实dump/restore验证；测试schema已finally清理，退役时两库无业务表（不声称恢复了测试业务fixture）。本任务1容器/1卷/1网络及独有测试镜像删除，project剩余资源为0；其他17容器的ID/镜像/名称/状态不变。当前19722地址已离线。私有归档 `/home/quant/.local/share/market-watch-docker/archives/mw-pr21-fix-20261007T220345-1bc312aa`，公开摘要见 `retirement.json`，不提交含凭据归档。

## 证据边界

历史852证据的raw文件和哈希保留；主manifest仅修订当前release-pr操作文档的hash并记录旧值，不重新签署历史运行源码或原始结果。本目录新增结果有独立manifest。`bcaefcf` 的175文件字节相等、79数值gate及UI/长消费者/三重复吞吐仅证明历史候选；本次未完整重跑这些长场景，也不把当前产品称为r6字节相同。当前补测聚焦确证的阻断、实际聚合公平、旧进程接续、闭市语义与全回归。没有证明生产容量、供应商I/O、通知送达或新的生产SLA。没有实际合并PR、创建release或部署unraid。
