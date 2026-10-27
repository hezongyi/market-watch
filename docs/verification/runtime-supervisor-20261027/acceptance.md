# 阶段 1A：最小循环监督器

基于阶段 0 已确认的 `v1.29.1` 后继链。只新增生命周期原语和行为测试；没有接入生产 service profile、改 worker owner、持久心跳 schema 或迁移调度。该边界符合阶段 1A 不新增常驻服务及“先验证 interface，再迁移顶层循环”的要求。

实现 `alerts.runtime_supervisor`：

- `run_steps` 为有界简单循环提供可中断等待；仅完成一轮后回调进度，正常空闲也算一次有效检查，禁止零等待忙轮询。步骤异常向组监督器传播，由监督器触发组停止。
- `Loop` 保留复杂现有 `run(stop)` 接口。`run_group` 统一启动、SIGINT/SIGTERM 转 stop、非预期返回/未处理异常传播、同组停止与 join。超时未退出会抛失败并列出未退出 role，不杀 Python 线程，也不假称安全关闭。
- 进度/状态回调故障只记日志，不覆盖业务循环结果；业务内部可恢复错误、节奏、租约及健康水位仍由原循环自己管理，不在 supervisor 叠加 retry/backoff。

Ubuntu `quant-server` 使用固定基线镜像 `sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743`，只读挂载独立 worktree，网络禁用，1 CPU/768 MiB；未创建服务、端口或可写数据库。`test_runtime_profiles.py` 覆盖简单空闲检查和及时 stop、复杂 run(stop) 资源关闭、实际 `alert_monitor.run` 适配、组级异常停止 sibling、非预期返回、预先停止不启动循环、零等待拒绝、信号 handler 生命周期及真实子进程非零退出。

最小回归：

```bash
docker run --rm --network none --cpus=1 --memory=768m \
  -e PYTHONPATH=/candidate/backend -e PYTHONDONTWRITEBYTECODE=1 \
  -v /home/quant/repos/market-watch-runtime-1a-20261027:/candidate:ro \
  -w /candidate sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743 \
  sh -c 'pytest -q backend/tests/test_runtime_profiles.py backend/tests/test_alert_monitor_cadence.py backend/tests/test_oanda_worker_lifecycle.py && ruff check --no-cache backend/alerts/runtime_supervisor.py backend/tests/test_runtime_profiles.py'
```

结果：25 passed，ruff 通过。pytest 有一条 cache 写入 warning，因为 worktree 是只读挂载；测试不依赖该 cache。初轮测试曾因测试自身的 wait 次序耗满 30 秒，已改为外部定时 stop 并复验，最终 suite 约 1.2 秒。

限制：尚未把 Preference/Heartbeat 接到每个 supervisor 角色，也未迁移任何真实顶层循环；这是后续阶段按 owner 边界逐项适配工作。未测试系统级 SIGTERM 发给真实 Docker 容器，但 handler 设置与恢复及子进程失败退出已覆盖。阶段 0 PR #100 尚待 Backend CI 完成；本 PR 应以该阶段分支为 base，按顺序审查。没有合并 main 或生产操作。
