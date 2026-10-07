# Published 告警重复读取小修复

按用户允许的准备期“有实测依据的小范围修复”实施；发布调度、增量发布和覆盖存储仍等待三层合并。只改 `chart_alert_worker.stored_rows` 的取数分支：published直接读取匹配发布快照；普通managed仍使用chart_rows。原有身份/来源/日历检查、calculation_origin、标签和observed_at处理沿用。

问题：旧published路径先读staging历史并生成bar payload，随后用read_rows覆盖结果。这是丢弃计算，在M30/W1/MN还可能带入聚合和覆盖查询。修复避免此次读取；不修改告警轮询频率、事件合同、发布状态或schema。

红→绿命令（源码修复前与后各实际执行一次）：

```bash
ALERTS_DATABASE_URL=sqlite:///:memory: PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python docs/verification/issue-13/alert_read_probe.py
```

修复前退出1，断言 `BUG: published alert reads and discards staging history`；修复后退出0。probe直接调用stored_rows与三次真实evaluate，先发布120根M1、限定后60根、staging末价格修订99，验证published仍为10、观察时间不变、返回起点正确且无误发事件。读取计数是此缺陷的可重跑反馈信号，不是CPU收益估计。

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| stored_rows SQL | 6 | 5 |
| stored_rows staging读 | 1 | 0 |
| stored_rows published读 | 1 | 1 |
| evaluate三次SQL（含末状态读取） | 25 | 22 |
| evaluate三次staging读 | 3 | 0 |
| evaluate三次published读 | 3 | 3 |
| published价格/起点/观察时间与不误发 | 通过 | 通过 |

完整输出：[red](alert-read-red.txt)、[fixed](alert-read-fixed.txt)、[最初行为基线](alert-read-baseline.txt)。`--baseline`只用于旧源码保存缺陷行为；优化后默认要求零staging读，不能要求新代码继续满足旧缺陷。

现有产品回归：

```bash
ALERTS_DATABASE_URL=sqlite:///:memory: PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest backend/tests/test_chart_alert_worker.py backend/tests/test_chart_alert_calculation_contract.py -q
```

28 passed（[原始输出](alert-regression.txt)）。包含普通managed、published、平台数据集、身份变化、盘中/收盘观察、历史修订与防重、周末新鲜度、图表与告警指标相同起点的合同；不是完整产品验收或PG迁移/并发验证。

当前为本任务工作树本地修复，未部署、未推送、未修改其他工作树或现有API实例。四场景性能套件调用聚合/发布模块，不调用本次告警模块；其固定fixture和源码链路未改，长测继续。三层合入后按其最新身份/消费者入口再整合和回归，不将此小修复替代Issue #13核心改造。
