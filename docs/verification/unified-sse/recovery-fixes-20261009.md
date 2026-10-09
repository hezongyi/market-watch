# 恢复修复的开发证据

环境：Ubuntu worktree，Python `.venv`、Node VM bridge 回调；数据库测试使用隔离的内存 SQLite。未运行 PostgreSQL、Docker 实例、真实许可图表浏览器或供应商验收。

## 失败复现与修复

- `pytest .../test_market_stream_worker.py -k managed_preparation`：修复前失败，部分 publication 预期 `status`，实际为 `reset`。原因是仅按非空尾部判断首屏就绪。复用 dataset status 的几何和指标预热条件；publication complete_count 进入 worker 变化凭据。
- `node tests/advanced-market-stream.cjs`：修复前分别出现空页接受状态 undefined、恢复多注册一次（6 ≠ 5）、拒收历史仍 `history_accepted=true`、窗口过滤后的空回调仍被视为已加载。原因是空页直接忽略、恢复与历史接受分别重注册，以及首读状态在原生接受之前/未按接受窗口登记。空首屏保留准备订阅，历史恢复隔离旧世代，完成后统一重注册，凭据只记录已接受柱。
- 同一 Node 入口验证尾部从 60000 撤回到 30000 后，新注册 cursor 为 30000。reset 清除旧 first/last 和 HTTP 临时缓存，防止恢复新历史时复用旧尾部。
- `pytest .../test_market_stream_worker.py -k canceled_inflight`：修复前取消后迟到计算留下 MarketDemand；首次修复后，再次订阅因内存续期节流而未恢复需求。提交复核有效消费者并释放本任务需求；续期节流现在先核实需求存在且有效，需求 ID 复用同一函数。已有独立预警需求保留测试通过。
- 后端恢复契约新增：空首屏准备后通知历史恢复，任意长断线超出完整保留窗口时 reset，各条回放结果不使用任务未来快照。三条契约加入 PostgreSQL gates，但尚未运行 PostgreSQL。

## 当前通过结果与重跑命令

在 worktree 根目录：

```bash
PYTHONPATH=backend .venv/bin/pytest -q --tb=short \
  backend/tests/test_composite_realtime.py backend/tests/test_composite_chart.py \
  backend/tests/test_composite_series.py backend/tests/test_composite_quotes.py \
  backend/tests/test_composite_aggregates.py backend/tests/test_fixed_series_revisions.py \
  backend/tests/test_market_stream.py backend/tests/test_market_stream_worker.py \
  backend/tests/test_market_stream_api.py backend/tests/test_market_stream_postgres.py
PYTHONPATH=backend .venv/bin/pytest -q --tb=short \
  backend/tests/test_provider_service.py backend/tests/test_market_data.py \
  backend/tests/test_managed_dataset.py backend/tests/test_fixed_indicators.py
```

结果：116 passed、11 skipped；既有回归 105 passed。输出保存于 `unit-tests.txt`、`regression-tests.txt`。跳过项不算通过。

在 `web` 目录分别运行 `node tests/advanced-market-stream.cjs`、`node tests/advanced-fixed-series.cjs`、`node tests/advanced-provider-subscriptions.cjs`，全部通过；`npm run build` 通过，仍有既有 chunk size 提示。修改模块 Ruff、bridge JS syntax 与 git diff check 通过。

Ubuntu Docker socket 仍拒绝 quant，`sudo -n true` 要求密码。本任务未构建/部署容器，预留端口不是验收访问地址，P95 ≤ 3 秒目标及负载预算未测量。待本机 Docker 权限配置后继续 README 所列隔离验收。
