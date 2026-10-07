# Issue #13 合并前准备收口

核对时间：2026-10-07 09:17（Asia/Singapore）。合并前可独立完成的必要准备已收口；**Issue #13 未完成，P0 的整合主线复测也未完成**。P1–P3 按用户确定的顺序等待三层行情合并，不继续追加可选旧基线实验。

## 已完成与交付边界

| 关卡 | 已保存证据 | 尚未满足的部分 |
| --- | --- | --- |
| P0 基线与门槛 | 四场景×三次×300秒PG原始样本、固定fixture、实例台账、版本矩阵、冻结数值门槛 | 三层合并后实际身份/日历/schema/旧入口核对，以及相同负载的可比较重复基线 |
| 覆盖准备 | 合成差集/查询计划、正式覆盖只读快照与有效区间差集 | EURUSD/XAUUSD仍缺264,964/266,161分钟结构化证明；补齐、并发追赶、下游等价、切换与回退未演练 |
| 回归准备 | 完整idle快照、十身份mixed、TCP/告警、网页双图、外部锁、高周期独立oracle、持续同价新鲜度 | 新调度的完整触发矩阵、并发世代、计数/崩溃恢复、DST/节假日、覆盖撤回、持续供应商I/O及完整容量未验证 |
| 有实测依据的小修复 | published告警去除重复staging读，先红后绿；28个告警回归通过 | 仅本地提交，未推送、未部署；不代表API CPU或核心性能目标达成 |
| P1 结果语义与调度 | 方案和失败基线已准备 | 核心实现、持久状态迁移、公平等待及性能关卡未实施 |
| P2 变化触发与增量发布 | 输入/观察/修订与消费者的旧链路证据已准备 | 按桶增量、完整触发、防丢并发世代与故障恢复未实施 |
| P3 覆盖优化 | 已证实不能直接停读审计兼容路径 | 规范化存储、补齐工具、检查点、切换/回退未实施 |
| P4 运行管理与集成 | Ubuntu隔离环境、配额、启停/归属、真实网页短测已有证据 | 整合主线、完整正确性矩阵、可比性能、迁移/回退与最终交付未验收 |

当前性能仍有明确红灯：持续同价输入提交→可见p95/p99为36.234/40.406秒，目标15/30秒；可见→告警判断观测为1.840/2.400秒，目标1/2秒。功能链路通过不能写作性能通过；门槛保持冻结。

## 既有回归环境问题及复核

同一组五个既有文件在宿主共用venv得到82 passed、3 failed、1 warning（11.88秒、exit1）。三项失败均在API lifespan退出时由`close_clients → provider_yahoo`导入缺失的`yfinance`引起。宿主原始输出未另存文件，此处依据此前工具结果记录，**不把摘要伪装成原始日志**。

改用已有固定Ubuntu隔离probe镜像，只读挂载本工作树实际源码，`--no-deps`且显式SQLite内存库；没有启动PG、修改共享venv或修改产品代码。相同五文件实测 **85 passed、0 failed、2 warnings，15.20秒、exit0**。警告仅为只读挂载不能写pytest cache；Compose还提示已有停止的网页服务，未清理这些资源。

原始输出：[probe.log](results/premerge-regression/probe.log)。命令、固定image ID、源码commit/哈希、宿主失败记录和运行范围：[metadata.json](results/premerge-regression/metadata.json)。该回归不证明PG并发、迁移、真实供应商可用性或整个测试集通过。

复跑命令（日志另行归档，不覆盖当前证据）：

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml run --rm --no-deps --name mw-issue13-p0-regression -e ALERTS_DATABASE_URL=sqlite:///:memory: probe python -m pytest backend/tests/test_domain.py backend/tests/test_calendar_profile.py backend/tests/test_chart_aggregation.py backend/tests/test_managed_dataset.py backend/tests/test_volume.py -q'
```

## 合并条件与环境状态

本轮fetch后main仍为`9670dae4ffa9d7917dfaf8c4331f1fad9830d56b`，开放PR为`[]`；三层工作树只读核对为`92b3475ec518d435c95a071087a2a1846f0859e1`、干净，尚未合并。未整合main、占用新迁移编号、推送或开PR。

Ubuntu本任务PG/API/web/chart-origin均停止、exit0、OOM=false，publisher停止、exit143、OOM=false；临时regression probe已移除，合成数据卷保留供整合复测。当前没有在线验收地址。实际运行过的地址、启动/停止方式和配额见[README](README.md)。没有创建unraid测试实例、影响其他任务资源或生产部署。

下一必要动作是三层合并后整合当时最新main，核对实际接口与迁移头，归档旧输出后复测相同fixture，再实施P1–P3并完成P4。合并前准备本轮收口；整体收口日期依赖合并时间及复测发现，当前不承诺无实测依据的日期。
