# v1.14.0 整合与核心改造入口

2026-10-07用户要求在已完成三层行情的v1.14.0上继续Issue #13。已fetch核对：tag和origin/main同为`ec00080ff52e34e737eea6ab2bc2ec3d27b52f76`（PR #20），三层合并条件成立。整合提交`131bf3caf2fa170638c7136d1c29f33c59654975`无冲突，保留本任务published告警小修复；未推送、未部署。

## 实际合同核对

| 范围 | 当前入口/身份 | 实施约束 |
| --- | --- | --- |
| 旧managed及显式旧兼容数据集 | `managed_dataset.publish_once/publish_frame`，`Instrument.id`；显式数据集为独立`MD:`身份 | 发布进度不得按显示代码合并；源、口径、日历在实际注册身份中隔离 |
| 三层固定历史 | `history_artifacts`，不可变`HistoryVersion`及规则身份 | 不将普通实时维护套入固定历史，不修改固定回放父版本 |
| 三层组合 | `composite_aggregates`，固定`CompositeRevision`与不可变输入事件 | 保留独立claim/lease/input_revision提交；旧managed基线不充当组合性能验收 |
| 日历 | `calendar_for(inst)`、显式日历身份及来源证据 | NY17仅为相位；未知覆盖/成功空响应不提升为来源确认或闭市证明 |
| 迁移 | 唯一主线头`am40_chart_revision_demand` | 新加法迁移从该头接续；不复用三层编号，升级/回退用Ubuntu隔离PG验证 |
| 告警 | published读取小修复仍在；三层固定输入另有独立入口 | 验证图表/CSV/MCP/告警各实际入口，不按一条旧链路推断全部正确性 |

读取了`CONTEXT.md`及ADR 0001/0002。七个旧发布相关模块仍保留原机制：每轮全量纳管、全目标轮转、尾部/历史窗口读取、覆盖审计合并、全量complete_count。新结构并未自动修复旧空闲发布。

整合后的SQLite内存探针实际退出1：九轮publication_claims=9；完整可见快照相同，两队列均0；SQL121、行情读19、覆盖读18、count1、发布UPDATE1。运行命令沿用README中的`idle_probe.py`，通过Ubuntu只读源码probe执行，原始脱敏输出将另行归档。

## 冻结整合基线环境

Ubuntu quant-server，本机Docker project `mw-issue13-v114`，网络`mw-issue13-v114_default`，卷`mw-issue13-v114_pgdata`，PG14数据库`issue13`。只在测量时开放`127.0.0.1:19623`；没有API/网页或真实供应商IO。PG0.75CPU/512MiB，probe0.75CPU/768MiB。原`mw-issue13-p0`库和所有既有证据保留。

冻结源码为独立detached工作树`/home/quant/repos/market-watch-issue13-v114-baseline`的整合提交131bf3c，只读挂载；依赖用现有不可变镜像`sha256:8ddc9b93c3a767a845353c8ce6072f2b72a899a2db9f6167a00d866bb39c1e12`，pytest/yfinance/dukascopy_python/alembic/psycopg实际导入通过。未安装共享venv、未更改他人镜像。私有env在`/tmp/market-watch-issue13-v114.env`，0600，不提交。

运行：`python3 -u docs/verification/issue-13/run_v114_baseline.py`。结果独立保存到`results/v114-baseline/`，拒绝覆盖/自动重跑，失败私有日志先审查。四场景各300秒×三次，scenario-first安排在第一轮就观察全部场景；同原fixture/事件序列、源和发布快照重置。宿主观测随原始样本保存，竞争污染须披露；核心改造后按同一口径比较，不放宽冻结门槛。

手动启停（脚本正常/异常结束自动停止自身PG）：

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-v114.env -p mw-issue13-v114 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/v114.compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-v114.env -p mw-issue13-v114 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/v114.compose.yaml stop postgres'
```

此文记录整合入口和运行范围，**不声明四场景已结束或性能已通过**。进程终态、每份实际300秒artifact与原始事件分母是完成依据；之后进入P1–P3，完整正确性/覆盖迁移与回退/P4仍为最终关卡。
