# data-worker CPU 修复验收

## 候选与范围

- 固定基线：`68df842ee99bdc7781def3aa62f57e48234711ba`，2026-11-11 再次核对远端 main 未变化。
- 分支：`fix/data-worker-cpu-20261111`；[Draft PR #129](https://github.com/hezongyi/market-watch/pull/129)。
- F1：持久聚合/发布后台链路，以及加法索引迁移。需求见 [issue.md](issue.md)。
- 已修复代码与验证副本；尚未部署 mw-dev、合并、打正式 tag 或操作 Unraid。

## 实现

1. 同品种、同周期的相交/相邻 observed 范围有界合并，保留原始等待年龄与失败退避；worker 能逐步处理旧格式任务和分片余量。
2. 已完成且与 M1 内容匹配的聚合柱只推进实际来源 `observed_at`，不读覆盖历史、不改价格/成交量修订。M1 标量页只读取和计费一次，fallback 复用；缺失、不完整或不匹配的柱按完整路径修复。相交内容修订尚未完成时保留观察任务等待。
3. 无变化任务不唤醒干净发布；移除 observed barrier 后，只唤醒相交且仍有 dirty 工作的发布，保留失败退避。M30/W1/MN 派生快照保持新鲜度。
4. 现有 dataset 状态增加覆盖 checkpoint 的 `complete`、`phase`、`maintenance_required`；保留未维护时的兼容读取，不在 worker tick 自动全量核验。
5. `bd57_notice_source_poll_index` 从 `bc56_price_alert_inputs` 增加 `audit_events(id) WHERE kind='notice_source'` 索引。查询与 receipt 语义不变，仍可发现晚提交的低 ID。回退只删索引，不删审计/通知事实。

## 已完成验证

- [169 项定向回归](tests-169.log)全部通过、无跳过，包括真实 PostgreSQL 14.24 的聚合/发布并发、死锁、历史交错、通知、迁移往返、成交量与真实 v1.14.0 writer 兼容。
- [后续补充](tests-extra.log)：W1/MN 自动 `publish_once` 调度 2 passed；worker 持锁与新写入交错、分片余量和公开新鲜度 1 passed。测试使用事件同步，断言写入等待 Instrument 锁并最终保留范围。
- [迁移兼容补验](tests-migrations.log)：15 passed、无跳过。更新旧测试写死的 schema head（先复现 7 failed），验证六条 SQLite 历史升级路径、PostgreSQL 发布迁移、原有告警记录及 rc1 evaluator 在新 head 上的回退保护；事实保留断言不变。
- Ruff 与 `git diff --check` 通过。
- CI 另外复现了 main 既有的 `saved-layout-startup.browser.cjs` 时序失败：保存失败通知已接收、尚未投影，详情确认 GET 未被 mock。夹具按空投影状态返回 404，保留所有布局/草稿/冲突断言；本任务源码 `npm run build:ui` 成功，该浏览器测试连续 5 次通过。无产品 Web 代码变更。
- Standards 独立复审：无阻塞项/需报告异味；上轮 M1 双读预算问题已关闭。
- Spec 独立复审：上轮 fallback 丢请求、预算双读、冗余唤醒三项关闭，无新代码阻塞。提出的自动调度和 writer/worker 交错证据边界已补测，并在 `97a0c526` 复审确认关闭。
- 最终提交的 CI 结果在 PR 展示；旧提交的绿灯不能替代最终候选检查。

## 正式覆盖维护演练

[coverage-rehearsal.json](coverage-rehearsal.json) 保存统一快照归档 SHA-256、维护前后事实哈希、完成柱数和正常入口基准。

仅从 mw-dev 只读导出覆盖/聚合/发布相关 14 表，实际恢复至本任务 `cpu_rehearsal`，未复制其他项目百万行 provider 历史表。归档在私有目录保留，不提交私有业务快照。逐品种使用正式 CLI：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-private/cpu-20261111/compose.env \
  -p mw-cpu-20261111 -f docs/verification/data-worker-cpu-20261111/compose.yaml \
  run --rm --no-deps maintenance python -m alerts.publication_admin coverage \
  --instrument '<instrument_id>' --limit 500 --until-complete --verify
```

6 个 checkpoint 从 `verify/false` 变为 `complete/true`。M1、原始覆盖、provider 审计 SHA-256 均不变；source complete 4,702、published complete 3,664 均不变，本次没有撤回完成柱。测试另验证失去证明时正常撤回与重算。

同一恢复库正常 `stored_coverage()` 三次中位耗时：EURUSD 371.522 → 1.870 ms，XAUUSD 460.529 → 1.777 ms；不是绕过 checkpoint 直接查询投影的结果。JSON 中 `timings.legacy` 是既有基准函数名，维护后实际已由正常入口读取投影。

## Ubuntu R1

- 实际主机：Ubuntu `quant-server`。
- Project/network：`mw-cpu-20261111` / `mw-cpu-20261111_acceptance`。
- PG：`127.0.0.1:25471`，独立库 `cpu_acceptance`（测试）和 `cpu_rehearsal`（恢复演练）；PG 14.24 固定 digest，1 CPU / 1 GiB 上限。
- API：<http://127.0.0.1:28471/healthz>、<http://127.0.0.1:28471/readyz>。仅主机 loopback 可访问，无公网/局域网发布。
- 复用已有依赖镜像、只读挂载本任务代码；没有构建新候选/生产镜像。API lifespan 不启动行情采集或通知投递，不宣称这是完整服务性能验收。
- PG 使用独立 named tmpfs volume，上限 512 MiB；完全停机卸载后不保证数据保留。已实际恢复验证的私有 dump 在主机磁盘保存。

从仓库根目录启动（私有 env 已在本机准备）：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-private/cpu-20261111/compose.env \
  -p mw-cpu-20261111 -f docs/verification/data-worker-cpu-20261111/compose.yaml \
  --profile smoke up -d --no-build --wait
```

重新运行 HTTP 与查询计划验收：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-private/cpu-20261111/compose.env \
  -p mw-cpu-20261111 -f docs/verification/data-worker-cpu-20261111/compose.yaml \
  exec -T api python - < docs/verification/data-worker-cpu-20261111/smoke.py
```

[smoke.json](smoke.json)：health/ready 通过；未登录 API 返回 401；临时认证会话读取 coverage complete，无 maintenance_required；公开发布读取 5 根完成 M1。临时会话已移除。

同一恢复库捕获实际通知投影 SQL，在回滚事务内模拟全部通知已处理、对比删除/重建部分索引：无关审计过滤 172,374 → 0 行，共享命中 52,021 → 7,900，单次 72.366 → 7.873 ms。模拟 receipt 与 DDL 全部回滚。该值只说明此查询减少工作量，不代表数据库全部 CPU 已解决。

停止本任务服务（不删 volume/归档）：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-private/cpu-20261111/compose.env \
  -p mw-cpu-20261111 -f docs/verification/data-worker-cpu-20261111/compose.yaml \
  --profile smoke stop
```

## 尚待完成

1. mw-dev 源实例覆盖维护尚未执行。演练成功不等于现场已修复；该实例挂载其他任务的 dirty worktree，不直接覆盖或部署代码。按方案与工作树拥有者协调时段后逐品种正式核验，保留备份和前后证据。
2. 整套项目 1–5% CPU 尚未验证。当前主机约剩 680 MiB，另有验收项目运行；AGENTS.md 要求完整性能测试由用户协调错峰。待窗口明确后，以同一业务负载分别运行基线、仅维护、完整候选各至少 10 分钟，记录所有项目容器 CPU 秒/4 核分母、队列年龄/收敛、输入至发布延迟和告警新鲜度。不能用 SQL 或单 worker 提速代替此目标。
3. 合并、正式 tag 和生产部署需要本任务明确授权；PR #128 / v2.0.4 的历史授权不延伸至 PR #129。

回退代码可返回基线；索引可 `alembic downgrade bc56_price_alert_inputs`。覆盖投影使用既有 `prepare-rollback` 契约，不能在运行时直接翻 complete 或清任务；生产操作另按发布清单执行。
