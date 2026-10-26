# 独立待办：RRS原生稀疏历史

状态：已记录，待独立任务安排；本轮接入交付不以修复此问题为前提。用户认可单独处理，不表示本轮授权改动RRS实现。

## 可复现问题

H1/H4/D1的正常缺失时段被加入gap_before，反复重置RRS的252窗口预热。另两项显式gap_before或incomplete输入用例也失败，因为前置的正常观测尚未正确积累。以现有5个行为断言为红例，不删除、不放宽。

改动前基线ba5407b218c0d5ffb5b946cb83bba4af67f3965e在同一环境和独立任务PG上同样失败。目录夹具修正后的原失败节点及新增4项回归为19通过、5失败；尚无干净全量结果。

证据：[最新失败节点](../failed-nodes-catalog-followup.log)、[基线对照](../known-failures-baseline.log)、[检查历史](../backend-final-checks.json)。相关源码为backend/alerts/chart_calculation_history.py和backend/tests/test_provider_squeeze_history.py；这里只定位，不断言已完成修复设计。

## 独立任务复现命令

在本工作树根目录执行，沿用已有只读venv：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch-history-modes-integration-20261024/.venv/bin/python -m pytest -q backend/tests/test_provider_squeeze_history.py
```

后续修复应使正常缺失时段按有效观测连续计算，显式无效输入仍按合同重置；保留数值与绘图oracle，验证分页和相邻指标，再运行必要全量检查。独立实施前读取届时AGENTS.md和实际基线，不操作其他任务或长期实例数据。
