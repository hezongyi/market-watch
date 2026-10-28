# 轨道 C：实时 30 天下界清理清单（A13a/A13b/A13c 机制部分）

分支 `feat/runtime-track-c-20261028`，基线 `0eac4fe7`（与 `4f72c306` tree 一致）。
本文件只描述已实现的机制；周日调度、激活与重启后的循环接线由其它任务负责，本分支不接线。

## 1. 业务合同（实现依据）

- 下界 = 当前 UTC 时间 − 30×24 小时；候选判定按行自身所属分钟的 `start`，**严格早于下界才算候选**，等于下界不删。不使用交易日、不用最后一条行情倒推。
- 只有持久化的 `state=succeeded` 切换运行解锁清理；`failed` / `partial` / `preparing` / `shadow_ready` / `activating` / 无运行一律不解锁。`claim_retention` 已强制，`retention_window._pass` 与 `tick` 仍在 tick 层再校验一次并输出 `switch_run_<state>` 跳过原因。
- dry-run 只报告：候选行数、字节估算、被保护引用明细与按类别计数；不删除任何行，也不受恢复门槛限制，更不会隐式升级为删除。
- 真实删除按切换运行 ID 幂等、有界（单批候选上限 + 单事务行数上限 + 时间预算）、按真实外键顺序、可安全中断续跑。

## 2. 清理对象与删除顺序

删除单元是一个 `(source_id, start)` 源分钟：其本地最新修订（`market_source_minutes.revision_id` 指向）以及不再被任何头指针引用的历史价格修订（`market_source_minute_revisions`，orphan）。

| 顺序 | 表 | 删除条件 |
|---|---|---|
| 1 | `market_composite_minute_inputs` | `source_revision_id` 属于本批可删修订，且 `revision_id` 属于本批判定可删的允许清单（未受保护） |
| 2 | `market_composite_minutes` | 同第 1 步（同一允许清单与 `source_revision_id` 过滤） |
| 3 | `market_composite_input_events` | 所属 `revision_id` 在本批失去全部输入引用（同一事务内按删除后的状态判定） |
| 4 | `market_source_minutes` | 头指针指向本批可删修订 |
| 5 | `market_source_minute_revisions` | 本批可删修订本身 |

顺序按真实外键核对，与方案草图有两处差异，必须按本表执行：

1. `market_source_minutes.revision_id` 外键指向 `market_source_minute_revisions.id`，因此**头指针明细行（第 4 步）必须先于修订（第 5 步）**删除；方案草图写成“先修订后明细”会直接违反外键。
2. `market_composite_input_events` 被 `market_composite_minute_inputs.event_id` 引用，只能在输入行删除之后清理，且必须按“删除后是否仍有输入引用”判定，不能整修订清空。

`market_source_minute_revisions` 只有三处外键引用（已核对 `storage.py:131`、`415`、`424`），因此上述 5 张表即完整闭包；删除完成后不会留下悬空引用。

## 3. 保护规则（fail-closed，宁可少删）

候选源修订若被任一“受保护”的组合修订的行引用，则该候选整体跳过，并计入跳过原因计数；同一批里其它可删候选继续删。

| 原因码 | 含义 | 依据 |
|---|---|---|
| `active_composite_revision` | 该修订是 `market_composites.active_revision_id` | 当前生效数据 |
| `active_alert_old_revision` | 有 `status=active` 的 ChartAlert，其当前版本的 `market_identity.composite_revision_id` 仍指向旧修订 | 激活不一致；删除继续但该批整体跳过并计数 |
| `alert_bound_revision` | 非 archived 的告警（暂停/到期等）仍绑定该修订 | 恢复告警需要输入 |
| `incomplete_preparation` | 该修订无 `market_composite_preparations` 行，或 `status != queried`、或有 `error` | 准备水位未就绪 |
| `pending_task` | 该修订存在 `CompositeAggregateTask.applied_input_revision < preparation.input_revision` | 聚合任务未追平 |
| `leased_task` | `CompositePreparation.lease_until` 或 `CompositeAggregateTask.lease_until` 未过期 | 行正被租约使用 |

未满 30 天的行不是候选（`start >= lower_bound`），因此也不进入保护统计。

## 4. 明确排除项与理由（永不在本清理范围内）

| 表族 | 排除理由 |
|---|---|
| `market_history_versions` / `_chunks` / `_artifact*` / `_frame_runs` / `_read_attempts` / `_reclamations` / `market_dataset_reclamations` | Dukascopy 等固定历史与既有回收路径；来源不是实时分钟，保留策略由 history_retention 单独负责 |
| `provider_datasets` / `provider_bars` / `market_provider_*` / `market_source_blobs` / `market_source_fetches` | 供应商缓存与采集账本，与实时分钟无关，另有 provider 清理路径 |
| `chart_alerts` / `chart_alert_actions` / `chart_alert_versions` / `signals` / `composite_watch_*` / `composite_judgments` / `market_composite_activations` / `market_composite_revision_changes` | 告警判定证据与激活证据，不可重建，且模型层声明不可变 |
| `notifications` / `outbox` / `delivery_attempts` / `audit` / `notice_*` | 通知、投递与审计链路；删除会破坏证据与重投语义 |
| `market_realtime_mappings` / `market_composites` / `market_composite_revisions` / `market_composite_preparations` / `market_composite_aggregate_tasks` / `market_composite_aggregate_bars` / `market_composite_read_attempts` | 身份、规则与任务状态；本清理只读不删（仅当其分钟/输入行引用候选修订时才删第 1–3 步的行，且受第 3 节保护约束） |
| `fixed_indicator_*` / `display_*` / `observed_minutes` / `live_state` / `live_minutes` / `market_bars` / `quotes` / `watch*` / `market_demand` / `provider_interest` | 属于其它保留/回收路径，本次不改动语义 |
| `preferences` / `market_switch_runs` | 运行状态与门槛标记，只写不删 |

## 5. 公共 API（`backend/alerts/retention_window.py`）

```python
WINDOW_HOURS = 30 * 24            # WINDOW_MS = 30×24×3600×1000
DEFAULT_LIMIT = 20000             # 单批候选分钟上限
DEFAULT_CHUNK = 1000              # 单事务行数上限
DEFAULT_BUDGET_MS = 20000         # 单次调用时间预算
DELETION_ORDER = (5 张表，见第 2 节)
RESTORE_KEY = "retention:restore_drill"

lower_bound(now=None) -> int                      # UTC 下界（毫秒）
dry_run(run_id=None, *, limit, chunk, budget_ms, now) -> dict
execute(run_id=None, *, limit, chunk, budget_ms, now) -> dict
tick(*, dry_run=True, limit, chunk, budget_ms, now) -> dict
restore_drill(directory) -> dict                 # 真实 backup + restore_check，写入标记
restore_marker() -> dict | None
save_restore_drill(record) -> dict               # 仅记录已完成的恢复校验（CLI/测试用）
schema_signature(connection=None) -> dict        # {tables, digest, alembic}
```

报告键：`run` / `dry_run` / `lower_bound` / `window_hours` / `now` / `limit` / `chunk` / `budget_ms` / `candidates`（5 类行数）/ `rows` / `bytes`（估算）/ `payload_bytes` / `protected`（`revisions`、`by_reason`、`detail`、`detail_truncated`）/ `deleted`（本次调用逐表删除数）/ `batch`（`id`、`state`、`dry_run`、`attempts`、`stats` 累计）/ `remaining` / `skipped`。

## 6. 批次、幂等与续跑

- 批次身份来自 `switch_runs.claim_retention(run_id, dry_run=...)`：同 run 同模式复用同一 `batch_id`，`interrupted` 再 claim 会 `attempts+1` 续跑。
- 单次 `execute` 处理不超过 `limit` 个候选分钟，按 `chunk` 分段提交。**每个分段的删除行数与累计 stats 在同一个事务内写回 `market_switch_runs.retention.stats`**，提交成功后才 `release_retention(outcome="interrupted")` + `claim_retention` 标记为可续跑；因此进程在“提交后、release 前”被杀也不会漏计，续跑的累计值恒等于数据库实际删除量（既不重复计数也不跳删）。
- 批次进入 `completed` 后同 ID 重跑不再删除：返回 `skipped=[{reason: "batch_completed"}]`、`idempotent: true`，累计计数取 `batch.stats`。
- dry-run 与真实批次按 `dry_run` 标志区分，交替调用会重置另一模式的批次（不会重复删除，只是重新规划）。

## 7. 首次真实删除的恢复门槛

- `alerts.cli retention --restore-drill DIR` 会真实执行一次 `backup.backup()`（写入 `DIR/retention-restore-<uuid>.<db|dump>` 与 manifest）与 `backup.restore_check()`（SQLite 校验 / PostgreSQL 真实恢复到随机新库并比对全表计数），成功后才写入 `preferences` 的 `retention:restore_drill` 标记：`{artifact, sha256, verified_at, tables, backend, bytes, schema}`。
- `execute` 在标记缺失时以 `restore_drill_missing` 拒绝删除，在 `schema != schema_signature()`（表集合摘要或 alembic 版本变化）时以 `restore_drill_schema_mismatch` 拒绝删除，均不触碰任何行。
- dry-run 不受门槛限制，可随时运行。

## 8. 本次未实现（另有任务负责）

- 周日调度与调度器 / `data_runtime` 循环接线（本模块只提供可重复调用的 `tick` / `execute`，不改任何 worker）。
- 激活（A13b 的激活触发）与 `switch_runs` 状态机扩展。
- 生产环境的真实删除授权与备份产物目录选择。

## 9. 被 Boundary 拦住、建议后续评估的索引

当前实现全部走既有列与索引，未新增迁移。以下访问路径在真实规模下会退化为顺序扫描，建议由后续迁移任务评估：

1. `market_source_minutes.start`：候选选择按 `start < lower` 做 keyset 分页，主键是 `(source_id, start)`，无 `start` 前缀索引。
2. `market_source_minutes.revision_id`：orphan 修订判定用 `NOT EXISTS (... where revision_id = r.id)`，该列无索引。
3. `market_composite_minutes.source_revision_id`：删除与计数按该列过滤，当前只有 `(revision_id, start)` 主键。
4. `market_composite_minute_inputs.source_revision_id`：同上，当前只有 `(revision_id, start, input_revision)` 主键与 `event_id` 索引。

以上缺失只影响扫描成本，不影响正确性；本任务按 boundary 未新增列或索引。

## 10. 验证

- sqlite 合同（`backend/tests/test_retention_window.py`）：下界边界、解锁、dry-run 零删除、外键顺序、按 run ID 幂等重跑、中断续跑不重复计数、**“分段提交后立刻被杀、从未 release”后续跑累计 stats 仍等于实际删除量**、混合批次只删安全行、活跃告警绑定整批跳过、恢复门槛缺失/过期拒绝、真实 backup+restore_check 演练。
- PostgreSQL 合同（`backend/tests/test_retention_window_postgres.py`）：同一组共享合同在真实 PostgreSQL（`TEST_POSTGRES_URL`）上重跑，覆盖真实外键与行锁语义。
