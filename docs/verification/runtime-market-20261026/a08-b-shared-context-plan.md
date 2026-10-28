# A08-B：同一组合多规则共用读取（结构性优化任务书）

状态：待实施。基线：`perf/a08-shared-context-20261028`（从 `analysis/a08-gap-20261028` 的 `921399ce` 分出）。上游分析见 `a08-gap-analysis.md`。

## 1. 目的（为什么做）

已实测（同 host、同夹具、隔离 PG）：

| 事实 | 数值/证据 |
|---|---|
| 每次规则评估的 SQL | ~47 条（应用自身计数：46 510 条 / 986 次评估） |
| 一轮 = 7 条规则 | ~330 条 SQL + **7 次 `market_datasets … FOR UPDATE`** |
| 单次评估成本 | compute p50 70–106 ms、p95 155–280 ms；提交仅 3–5 ms；池获取 p95 1.8e-5 s（无池饥饿） |
| PG 预算对照 | 0.75 CPU：全规则 p95 1.00–1.27 s；2 CPU：0.75–0.98 s → 说明 PG CPU 是共同瓶颈 |
| 慢语句画像 | 50 ms 以上共 41 条，**全部是同一条** `SELECT market_datasets … FOR UPDATE` |

`db.get` 已被会话 identity map 去重，所以「逐条削减语句」只有个位数收益；量级收益只能来自**少开一次会话、少读一遍同一份组合状态**。

## 2. 两种候选形态

### B1 合并事务（收益最大，风险最高）
`chart_alert_worker.step()` 内把 active 规则按 `composite_revision_id` 分组，每组一个事务：一次数据集排他锁、一次 `live_snapshot`、一次 `chart_page`，组内逐条判定，**整组一起提交**。

### B2 共享上下文（收益中，风险中）
每轮一次**只读**事务解析共享上下文（revision / mapping / target / datasets / instrument / prep / applied 水位 / live_snapshot 摘要），每条规则仍是自己的写事务，写事务内只做廉价复核；复核不一致则退回现有完整路径。

## 3. 必须保持的不变量（决定能不能做）

1. **锁序与时钟**（`composite_alerts.py:280-289`）：先取 `MarketDataset` 排他锁（按 id 排序），**再**取生产时钟；等待锁期间发生的来源提交不得被当作未来输入。B1 天然满足；B2 必须在写事务内复核水位，否则回退到完整路径。
2. **失败隔离**：现在每条规则独立事务，一条失败只写它自己的 `health=error`（A12/A16 依赖）。B1 合并提交会放大失败，需要「组内单条失败 → 该条降级为独立事务重试」的补偿，不得让一条规则拖垮同组其它规则。
3. **并发所有权**：每事务 `assert_current(db)` 的 boot fence 与 `skip_locked` 语义必须保留；B1 把锁持有时间拉长，必须实测与来源写入的冲突窗口。
4. **观测口径**：`on_evaluated` 一条观测必须对应一次真实判定（`scripts/runtime_market_baseline.py` 与报告脚本依赖它算「可判断输入→判定」）。

## 4. 验收

- 合同/回归：`test_alert_monitor_cadence.py`、`test_alert_monitor_wakeup.py`、`test_chart_alert_worker.py`、`test_composite_alerts.py`、`test_composite_aggregates.py`、`test_chart_alert_postgres.py`、`test_composite_alerts_postgres.py`（真实隔离 PG）。
- 新增必测：per-rule 失败隔离、锁序/时钟、组内一条 blocked/warming 不影响其它条、事件分母不变（13/13，missing=0）、`skip_locked` 行为。
- 性能：同夹具 `--scenario busy --samples 61 --interval 2 --profile-runtime`，**两个预算口径都测**（PG 0.75 CPU 与 2 CPU），记录 pair p50/p95（每规则）、事务成本、SQL 总数、一轮时长、池等待、PG 读写。
- 判据：0.75 CPU 口径下全规则 p95 <1 s 且事件 13/13；SQL/轮显著下降（目标 ~330 → 60–80）。

## 5. 不做的事

不改业务阈值/新鲜度/租约口径；不改 schema；不为降读数取消正确性检查；不把合并事务当成「顺便省掉 assert_current」。

## 6. 回退

基线为 `checkpoint/a08-wakeup-20261028`（`921399ce`）；B 未达标时该分支可整体丢弃，不影响 A 的收口结论。
## 7. 实施与实测（2026-10-28）

实现形态：B1（按 `composite_revision_id` 分组，一组一个事务、一次数据集排他锁、一次锁后时钟、一次共享上下文；组内逐条 `db.begin_nested()` savepoint 判定；组读取/提交失败降级为逐条事务）。共享读取抽为 `composite_alerts.shared_context()`，因此 B2 变体可直接复用它。

交错 A/B（同一隔离 PG 2 CPU、同夹具、同预算，A/B/A/B 顺序，宿主 load 4.3–4.6 的干净窗口）：

| 场 | 评估数 | pair p50 / p95 | 事务 p50 / p95 | SQL/评估 | M1 发布 p95 | 事件 |
|---|---|---|---|---|---|---|
| A1（仅唤醒） | 1220 | 0.403 / 0.809 | 0.071 / 0.141 | 46.0 | 0.613 (n=2) | 13/13 |
| B1（分组共享） | 1741 | 0.465 / **0.652** | 0.037 / **0.081** | **28.9** | 0.724 (n=2) | 13/13 |
| A2 | 1414 | 0.360 / 0.780 | 0.059 / 0.125 | 45.4 | 0.493 (n=2) | 13/13 |
| B2 | 1941 | 0.483 / **0.707** | 0.033 / **0.073** | **28.6** | 0.618 (n=2) | 13/13 |

每规则 p95：A 0.71–0.89 s（ATR 0.862/0.756），B 0.64–0.75 s（ATR 0.658/0.643）——B 的分布明显更紧。

结论：

1. 结构目标达成：SQL/评估 −38%、事务成本 p95 −48%，每条规则 p95 全部压到 0.75 s 以内且离散度收敛。
2. **未达「5–7 倍」预期**：共享读取只占每次评估约 17 条语句，剩余 28 条是规则级（`chart_page`、指标、ATR、evidence），要再降必须动规则级查询，不是本次范围。
3. 代价方向已验证但证据弱：组事务把两个 `MarketDataset` 排他锁持有到整组提交，M1 发布 p95 由 0.49–0.61 s 升到 0.62–0.72 s（n=2）。**未判定为回归**，但不能据此宣称无影响；需要长场（≥300 样本）或专门的锁持有时间探针复核后才能合并。
4. 回退：本分支未达标即整体丢弃，A 的收口结论只依赖 `analysis/a08-gap-20261028`。
