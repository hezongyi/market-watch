# 独立待办：RRS原生稀疏历史

最新状态：用户随后明确要求“把rrs 的问题修复”。独立修复分支fix/rrs-sparse-history-20261026已恢复被整合覆盖的3处运行代码，原5项及162项相关回归通过，候选Docker真实日线复算通过；已按授权更新mwa API。用户要求直接收口：修复与部署完成，OANDA连接失败导致真实图表验收未完成，未记为通过。见 [独立修复报告](../../rrs-sparse-fix-20261026/README.md)。

以下保留接入交付时的原始问题及复现边界；接入交付本身不以该独立修复为前提。

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
