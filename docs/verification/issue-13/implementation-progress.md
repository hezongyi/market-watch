# Issue #13：v1.14.0 后实施进展

2026-10-07 13:50 SGT。实现候选，尚未完成 Issue #13。

已整合 v1.14.0（ec00080），独立冻结基线 131bf3c 的 4 场景 × 3 次 × 300 秒已结束；12 个原始样本审计通过，本任务基线 PG 已正常停止。空闲平均 CPU 41.438% 单核、worker SQL 67.274/s，实时样本 p95 19.551–23.347 秒；修订 p95 24.080–24.456 秒。原始 P0 证据保留。期间 Ubuntu 其他任务及本任务逻辑回归负载由 host.jsonl 记录；这些是实际宿主条件，不当作生产指标或无竞争实验。

## 当前实现

- 持久请求/处理世代及原因，事务内触发；已完成目标等待、目标级重试、60 秒有界纳管与遗漏 bucket job 恢复。Instrument 先锁、状态后锁；被锁身份通过 SKIP LOCKED 跳过，避免拖住其他品种。
- 明确区分快照变化、任务消费、仍可运行及等待。worker 每次一个目标，忙时等待 0.02 秒、空闲 2 秒；不将检查当进展。新输入立即就绪，来源观察时间不控制任务到期时间。
- 按发布尾部、历史未复制页和精确修订窗口读取，计数增量维护；M30/W1/MN 依日历读取完整源成员，同时将源页预算控制在约 2000 行。
- 新观察时间进入脏桶和持久调度；同价 M1 以 observed 聚合任务刷新匹配的高周期。任务优先级 price > volume > observed，元信息传播使用来源成员的观察时间，拒绝配对不同价格及重复价格/量修订。
- an41 请求状态、ao42 覆盖投影均为 additive 迁移。覆盖原始表与审计保留；whole-minute 安全边界及旧 received_at 五秒余量不变。分批 checkpoint、运行时双写、最终锁内区间核对、错误记录隔离、完成后切换与证据移除 rebuild。
- publication_admin 提供覆盖分页和回退前旧 bucket jobs 分页补建。应用回退保留新表与原始证据，不能同时运行两个版本的发布拥有者；schema downgrade 遇到 pending generation 拒绝执行。

## 已有验证

- 相关回归 95 passed；增加及修正触发/预算后相关回归 80 passed（51.80 秒）。这些覆盖 SQLite 快速逻辑与真实 PG 修订、成交量、迁移及并发。
- PG 世代/锁/回滚及覆盖合同 8 passed；实际 am40 → head → 被拒绝的 pending downgrade → am40 → head 1 passed。
- 同价 H1 传播及延迟 worker 不制造新鲜度用例先红后绿；遗漏请求恢复先红后绿。
- 保存的正式覆盖白名单快照在 Ubuntu 隔离 schema 重放：62,522 audit / 27,939 structured；两个身份各 92 页，约 8.9 秒。与此前独立兼容 union 完全一致，完成后 audit 查询为 0。最终一次验证页最大约 1.8 秒，属于迁移成本，不是普通发布成本；大于现有证明规模时仍需测量此锁内全量核对的时间与内存。
- 第一轮边开发边跑的全量：1316 passed / 10 failed / 10 skipped，806.99 秒。旧 migration HEAD、源预算缩小后的分页次数假设、硬编码 .venv 路径及不完整 fixture 已修正；修正相关回归通过。最终全量必须在冻结候选上重新执行，不能用混合源码结果代替。
- backend 与新增迁移 ruff 已通过；不涉及前端代码变更。

## 仍未完成的关卡

冻结候选完整后端回归、优化后 12 次 PG 长测及与冻结基线对比、10 身份 90 周期公平性、同价观察到告警、独立高周期 oracle/消费者对照、真实 API/浏览器并发、实际旧二进制回退接续、运行交付台账与最终证据审计。最终性能门槛保留 acceptance-thresholds.md，不因结果放宽。未推送、未生产部署。

## 当前实际环境与命令

Ubuntu quant-server Docker project `mw-issue13-optimized`，独立网络 `mw-issue13-optimized_default`、volume `mw-issue13-optimized_pgdata`、PG14 数据库/用户 `issue13`；PG 本机监听 `127.0.0.1:19633`。当前是数据库验证实例，尚未提供新网页/API 地址。私有 env 为 `/tmp/market-watch-issue13-optimized.env`（0600），不进仓库。

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized.env -p mw-issue13-optimized -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized.compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized.env -p mw-issue13-optimized -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized.compose.yaml stop postgres'
```

性能测量与浏览器、真实告警等重型验收串行，避免同库重置及互相争抢。只停止明确本任务实例；不在 unraid 建开发/验收环境。
