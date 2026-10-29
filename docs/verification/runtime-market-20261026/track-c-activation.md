# Track C · A04b：一致激活、旧任务 fencing 与切换汇总消息

分支 `feat/runtime-track-c-20261028`（基线 `v2.0.0-rc.1`，与 `4f72c306` 同一 tree）。本切片实现 A04b：候选修订就绪后的**一致激活**、**旧修订/旧任务 fencing**、**失败回滚与安全暂停**、**每次切换运行至多一条按 run ID 去重的汇总 Outbox 消息**，以及**可切换来源的能力边界与双来源 fixture**。

不包含：真实备用供应商接入、真实故障切换（含影子对比与自动切回）。

## 1. 变更文件

新增：

- `backend/alerts/switch_activation.py`：激活编排（能力闸门 → run 记录 → 告警重绑 → 指标重建 → 旧修订冻结 → 激活写入 → run succeeded）与失败恢复。
- `backend/alerts/switch_notice.py`：按 run ID 去重的汇总 Outbox 消息（Notification + Outbox 同一事务写入，重试合并）。
- `backend/alerts/switch_source.py`：来源能力/兼容性校验与三个明确标注的 fixture 来源。
- `backend/tests/test_switch_activation.py`、`backend/tests/test_switch_activation_postgres.py`、`backend/tests/test_switch_source.py`。

编辑：

- `backend/alerts/composite_revisions.py`：`activate()` 保留既有对外语义（幂等、并发拒绝、readiness 门禁、账户校验）后委派给编排；`ActivationRequest` 新增可选 `switch_run_id`。
- `backend/alerts/composite_inputs.py`：新增 `frozen()` / `unfrozen()`；`apply_minutes` fan-out 不再向已冻结修订分发。
- `backend/alerts/composite_aggregates.py`：claim 不再为已冻结修订自动登记任务；`_lock` 对已冻结修订抛出 `Fenced`。
- `backend/alerts/composite_alerts.py`：新增 `bound_rules` / `pause` / `pause_bound` / `rebind_active`；`evaluate` 对已冻结修订直接返回而不写判定。
- 未改动 `composite_preparation.py`：该文件没有必须改动的缺口（准备阶段只服务未激活候选）。

## 2. 激活顺序、事务边界与涉及表

整个激活在**调用方的同一个事务**内完成（`composite_api.invoke` 的 `transaction()`），因此"候选绑定 / 告警重绑 / 指标水位 / 旧修订冻结 / 激活行"对其它读取者要么全部可见、要么全部不可见。

| # | 步骤 | 事务 | 涉及表 |
|---|------|------|--------|
| 1 | 能力闸门：候选来源 vs 当前来源（账户/环境/品种/口径/精度/确认/新鲜度） | 主事务（只读） | `market_datasets`, `market_realtime_mappings`, `instruments`, `market_history_versions` |
| 2 | run 记录：`preparing → shadow_ready → activating`；同一候选修订复用同一 run | 主事务 | `market_switch_runs` |
| 3 | 告警重绑：目标修订上的规则重置判定基线；旧修订上的规则安全暂停 | 主事务 | `chart_alerts`, `chart_alert_versions`(只读), `audit_events` |
| 4 | 指标重建：`request()` 补齐 FRAMES 任务，校验 `applied_input_revision >= 激活输入`，清理失败状态 | 主事务 | `market_composite_aggregate_tasks` |
| 5 | 旧修订冻结：`revision_frozen` + fence 证据（水位、边界、run）+ 释放任务租约 | 主事务 | `market_composite_preparations`, `market_composite_aggregate_tasks` |
| 6 | 激活写入：`CompositeActivation` + `active_revision_id` + `activated_at` | 主事务 | `market_composite_activations`, `market_composites`, `market_composite_revisions` |
| 7 | run `succeeded`（唯一解锁 30 天清理的状态） | 主事务 | `market_switch_runs` |

图表侧无需额外写入：未固定修订的图表读取走 `MarketComposite.active_revision_id`，与第 6 步同一事务原子切换；固定修订的图表仍读固定历史，不受冻结影响（冻结只停止实时输入与聚合扩写）。

## 3. 回滚路径

`publish()` 捕获任何阶段异常后：

1. `db.rollback()`：丢弃本次激活的全部写入（含 run 行、告警暂停、冻结、激活行），旧修订与其告警保持原状；
2. 在新事务中记录**一次** durable 失败：`MarketSwitchRun` 置 `failed`（早期失败）或 `partial`（绑定阶段之后失败），写入 `phase`=\ 失败阶段与 `error_summary`（阶段、类型、原因、已完成阶段、暂停的规则）；
3. 安全暂停：仅当"当前有效修订不存在 / 已被冻结 / 正是失败目标"时，暂停仍指向它的活跃规则（`blocked` + `chart_alert_paused` 审计），否则保持旧修订继续运行；
4. 调用 `switch_notice.record` 写去重汇总消息；
5. 重新抛出原异常，由 API 映射为 422。

失败行不是 `succeeded`，因此 `switch_runs.claim_retention` 拒绝、清理不解锁（`unlocked_runs()` 为空）。

## 4. fencing 判据与实现

判据一（输入分发）：`CompositePreparation.state.revision_frozen` 为真即视为冻结；fan-out 查询直接排除。

```python
def frozen(prep):
    """A superseded revision keeps its waterline and accepts no new input."""
    return bool(prep is not None and prep.state.get("revision_frozen"))


def unfrozen():
    """Live fan-out and aggregate claim skip frozen revisions; missing means live."""
    return CompositePreparation.state["revision_frozen"].as_boolean().is_not(True)
```

判据二（聚合 claim）：`claim()` 的任务选择与"缺任务修订自动登记"都带上 `unfrozen()`，冻结修订既不会被登记也不会被领取。

判据三（迟到提交）：`_lock()` 在比对租约令牌之前先看冻结状态，抛 `Fenced`（`TimeoutError` 子类），`aggregate_tick` 的既有 `except TimeoutError` 分支据此安静退出，不会重试、不会写任何聚合柱。

```python
class Fenced(TimeoutError):
    """A switched-away revision refuses late aggregates; nothing is written."""


def _lock(db, ownership):
    if frozen(db.get(CompositePreparation, ownership["revision_id"])):
        raise Fenced("组合修订已冻结，迟到聚合提交被拒绝")
    task = db.scalar(...)
```

判据四（判定轮次读同一修订）：`composite_alerts.evaluate` 在按 `market_identity` 取到修订后先检查冻结，命中即 `wait(..., "blocked", ...)` 返回，不产生 `CompositeJudgment`、信号或通知：

```python
if revision and frozen(db.get(CompositePreparation, revision.id)):
    # Fencing: a judgment round for a switched-away revision writes nothing.
    return wait(alert, runtime, "blocked", "该组合修订已切换并冻结，请显式改为新修订后恢复")
```

判据五（切换运行自身）：同一候选修订只有一个 run 行；`open_run` 对该行 `FOR UPDATE`，重试原地复用（`failed/partial → preparing`，`attempts+1`），因此并发的两次激活必然串行，且只产生一条汇总消息。

## 5. 去重汇总消息

- **dedupe 键**：`uuid5(NAMESPACE_URL, "market-watch/switch-notice/" + run_id)` 作为 `notifications.id`；Outbox 用同款派生 id，并由 `outbox.notification_id` 唯一约束兜底。一个 run 永远只有一条 Notification 与一条 Outbox。
- **原子性**：Notification 与 Outbox 在同一事务内用 `ON CONFLICT DO NOTHING` 插入；已存在时只更新 payload，**不动** `attempts / status / lease_until`，因此重试既不会重复推送也不会重置投递进度。
- **合并规则**：每条错误键为 `stage|scope|type`（来源不兼容时 scope 为具体能力字段，如 `basis`），重复出现只累加 `seen` 与 `last_at`；不同阶段/不同规则各占一条，最多 20 条。payload 里同时给出失败阶段、原因、受影响来源数、规则数与已暂停数、当前有效修订与状态。
- 成功激活若全部规矩都完成重绑则不推送；若有规则因目标修订暂不可服务被暂停，则在同一次成功事务内仍推送一条汇总消息（状态 `succeeded`，给出受影响/暂停计数与具体原因）。失败与部分生效同样各推送同一条逻辑消息。

## 6. 绑定表清单（激活证据 `CompositeActivation.evidence.switch`）

| 绑定 | 表/字段 | 切换后 |
|------|---------|--------|
| 当前有效修订 | `market_composites.active_revision_id` | 候选修订（与激活行同事务） |
| 激活事件边界 | `market_composite_activations.event_boundary` / `input_revision` | 整分钟边界 / 激活输入水位 |
| 图表（未固定修订） | 读取路径 | 立即读新修订 |
| 图表（固定修订） | `ChartAlertVersion.market_identity.composite_revision_id` | 不变，固定历史仍可读 |
| 活跃告警（绑目标） | `chart_alerts.state/effective_at/runtime` | 清空判定状态、`effective_at=boundary`、`runtime.switch_run_id` |
| 活跃告警（绑旧修订，可重定位） | 新增 `chart_alert_versions` 行（version+1）+ 目标修订 `market_identity` | 规则跟随切换运行；旧版本行与历史证据不改写 |
| 活跃告警（目标修订暂不可服务） | `chart_alerts.status/health/runtime` | `paused/blocked` + 具体原因（缺周期产物 / 水位未覆盖） |
| 周期任务 | `market_composite_aggregate_tasks.applied_input_revision` | 全部帧 ≥ 激活输入，失败状态清零 |
| 旧修订水位 | `market_composite_preparations.state.fence` | `waterline/boundary/run_id` 固定 |
| 切换运行 | `market_switch_runs.state/phase/activation` | `succeeded` + 激活载荷 |

## 7. 来源能力边界与 fixture

`switch_source.capabilities()` 从修订的实时映射目标数据集与历史数据集读出声明能力，`compare()` 逐项判定，`validate()` 只要有一项不满足即抛 `SourceIncompatible`（附 `failures` 列表）：

| 能力 | 判据 |
|------|------|
| 账户范围 | 与当前修订一致，且等于当前 `account_scope()` |
| 环境 | 与当前修订一致 |
| 品种 | 历史数据集 `logical_symbol` 一致 |
| 价格口径 | `basis` 一致（bid/ask 不得互换） |
| 确认语义 | 双方均为 `confirmed_minutes` |
| 精度 | 候选不得比当前更粗（更细可接受） |
| 新鲜度 | 候选声明投递延迟 ≤ 15s（`REQUIRED_FRESHNESS_MS`） |

**fixture 双来源**：`switch_source.FIXTURES` 提供 `fixture-primary`、`fixture-standby`（身份独立、能力兼容，可用于验证"切换成功"），以及 `fixture-incompatible`（ask 口径、精度 3、新鲜度 60s，用于验证"切换被拒绝且旧来源不受影响"）。`fixture_switch()` 返回 `{"fixture": true, "labelled": "fixture sources; no standby provider is wired"}`。

**真实数据上的观察**：真正的 ask/更粗/未验证来源在 `create()`（必须 oanda、必须当前账户）与 `collection_identity()`（未验证 M1 口径直接拒绝）处就无法准备，因此生产路径上能力闸门是"对已存/已审核能力做复核"的第二道防线；它不是唯一防线，也不替代供应商侧的校验。

## 8. 告警重绑语义与取舍

1. **显式切换运行重绑，隐式指针变化绝不重绑**。`rebind_active` 只在 `activate()` 的事务内运行：可重定位的规则由 `identity()`（与 `bind()` 共用同一构造）生成目标修订身份，写入一条新的不可变 `ChartAlertVersion`（`alert.version+1`），配置只把 `composite_revision_id` 指向目标修订，条件/几何/次数/冷却/通知选择原样保留；旧版本行与历史证据一字不改。直接修改 `MarketComposite.active_revision_id` 的隐式路径不经过该函数，`test_active_chart_revision_switch_never_retargets_running_rule` 因此仍成立。
2. **可重定位判据（fail-closed，先看服务形状）**：`relocatable(previous, target, config, bound)` 依次检查
   (i) 服务日历一致（`previous.rules.aggregation_calendar` 与 `target.rules.aggregation_calendar`，ny17→utc0 即不兼容）；
   (ii) 拼接规则一致（`aggregation`/`selection`/`tail_revisions`）；
   (iii) 规则接缝策略与其固定身份一致（`bound.seam_policy`）；
   (iv) 能力闸门结论通过（`switch_source.check` 的 report）；
   (v) 价格口径与精度一致（`switch_source.capabilities` 的 `basis`/`precision`）；
   (vi) 目标修订该周期产物已发布（`HistoryArtifact`）；
   (vii) 该周期聚合水位 ≥ 激活输入。
   任一项不满足即不可重定位 → 暂停，`health_reason` 写明具体一项（例如「目标修订服务日历 utc0，与规则绑定的 ny17 不兼容」）。只有同日历、同口径、仅历史版本/接缝前移的常规基线切换才重绑。指标预热仍走规则原本的 `chart_results` 懒加载路径：未就绪时 `evaluate` 返回 warming，不产生伪信号，因此不阻塞重绑。
   **与 shadow 结论取并集**：`switch_activation.shadow_pauses()` 读取该组合该候选修订的 Sunday shadow run（`baseline_shadow.KIND`、`target_revision_id`）里 `paused_rules` 中 `will_pause=true` 的规则，把 shadow 给出的具体原因传进 `rebind_active(shadow=...)`。这些规则一律不重绑、直接暂停，`health_reason` 用 shadow 的原因（`migration=paused_shadow_rule`，汇总消息 `type=rule_paused_by_shadow`）；shadow 未标记的规则仍走上面 (i)—(vii)。floor 变化、ATR 暖机不足、指标缺值等几何不可重定位因此在激活侧生效，而不是只停留在 shadow 报告里。
3. **不可重定位才暂停**：`status=paused / health=blocked`，`health_reason` 给出具体缺口（日历/口径/周期产物/水位），并在汇总消息里计入受影响规则数与暂停数。日历或口径变化的切换因此不会把规则挪到另一种桶边界上。
4. 暂停时沿用既有 held-rule 需求机制（`runtime.demand_hold = "stale_input"`），因为 `market_usage.composite_targets` / `realtime_switch` 只识别该值；`health_reason` 与 `runtime.switch_reason` 记录真实原因。若后续允许改 `market_usage`，应新增独立的 hold 值替换该复用。
   **冻结修订不再维持自身采集需求**：`market_usage.composite_targets` 的 held 分支读到规则绑定的修订已冻结（`composite_inputs.frozen`）时跳过它——来源切换后 target 不同，旧修订的那条采集需求被丢弃；共享来源仍服务其它有效消费者。唯一保留的情形是「运行修订需要的正是同一个 target」，此时两条需求本就是同一条（`test_frozen_held_pause_drops_its_own_target_after_a_source_switch` / `test_held_pause_on_a_running_revision_keeps_its_target`）。保留该情形是因为既有 `test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity` 的唯一需求来源就是这条 held 规则，而它切换后的运行修订在该 fixture 里未启用实时；若改为「一律跳过」，需同时修改该测试的期望。
5. 判定基线：重绑后 `alert.state` 清空、`effective_at=boundary`、`control_revision+1`、`runtime.switch_run_id/switch_boundary` 记录本次运行，并写 `Audit(kind=chart_alert_rebound, run_id, 旧/新修订, from/to version)`。切换前最后一次收盘在阈值下方、切换后第一根在上方时不会产生穿越（`test_relocation_never_replays_a_pre_switch_crossing`）。

### 与既有测试的关系（未改任何既有测试）

`backend/tests/test_composite_revisions.py::test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity` 的场景是 ny17→utc0 派生（换 history_version、mapping、接缝）后显式激活：日历变化会移动日界与桶边界，规则几何与判定基线无法等比平移，因此按第 2 条 (i) 判定为**不可重定位 → 显式暂停**，规则版本身份保持不变，该测试**原样通过**。其"旧修订仍可按 revision_id 读出 ny17 页面"与"规则身份不被悄悄改写"两条意图同时成立。只有同日历同口径的常规基线切换才重绑（`test_forward_history_version_rebinds_without_pausing`）。

## 8b. 汇总消息的再投递

- 一个 run 始终只有 1 条 `Notification` + 1 条 `Outbox`（id 由 run id 派生，`notification_id` 唯一约束兜底）。
- 合并时若**引入新的错误键**（不是重复计数）且该 run 的 Outbox 已投递完成（`accepted` / `blocked`），把**同一行**重新置为 `pending`（`next_at=now`、保留 `attempts`、清空 `lease_until`），让合并后的逻辑消息再投递一次；重复错误只累加 `seen/last_at`，不触发再投递；已 `pending/sending` 时不重复排队；`cancelled` 是显式退役，不复活。返回体带 `new_errors` 与 `requeued`。
- 插入判断按「行是否存在」而不是 `rowcount`：`INSERT … ON CONFLICT DO NOTHING` 的 rowcount 在 PostgreSQL 驱动下不可靠（实测把冲突后的二次写入误判为新建），否则重试合并后永不重排。

## 9. 未交付 / 被 Boundary 阻挡

- **未交付**：真实备用供应商接入、真实故障切换（影子对比、自动切回、按源限流）、切换的调度入口（A04a 侧 `switch_runs.start` 的排程与影子报告生成）。fixture 只证明能力边界与失败安全。
- **被 Boundary 阻挡**：`storage.py` 不能改，因此没有新增列/索引，冻结与 fence 证据落在 `CompositePreparations.state` JSON 与 `MarketSwitchRun.activation/error_summary` JSON 内；`market_usage.py` 不能改，held-rule 复用见第 8.2 条；`notification_center.py / notification_runtime.py` 不能改，系统消息去重由 `switch_notice` 自建（未改动既有 `_queue_system_notice` 的限频语义）；`cli.py / data_runtime.py / market_runtime.py / composite_api.py` 未改动。
- 需要新增列或迁移的场景（例如把冻结状态升为一级列、把 hold 原因独立成字段）**未实施**，按 brief 要求停下报告。

## 10. 验证

环境：Ubuntu 本机，Python `/home/quant/repos/market-watch/.venv/bin/python`（共享 venv，editable 指向主仓库，必须带 `PYTHONPATH=backend`）。

- SQLite 合同测试（本切片）：
  - `PYTHONPATH=backend .venv/bin/python -m pytest backend/tests/test_switch_activation.py backend/tests/test_switch_source.py -q` → **18 passed**（14 条激活合同 + 4 条来源能力）。新增的三组：shadow 结论并集（`test_shadow_verdict_pauses_rules_the_candidate_cannot_move`：shadow 标记的规则被暂停且原因来自 shadow、未标记的同口径规则正常重绑）；汇总消息再投递（`test_merged_new_error_requeues_the_same_outbox_row`：重复错误只累加 seen、已投递后新错误把同一行重排一次且 attempts 保留、再次新错误在 pending 状态不重复排队、Notification/Outbox 恒为 1）；held 需求（`test_held_pause_on_a_running_revision_keeps_its_target` / `test_frozen_held_pause_drops_its_own_target_after_a_source_switch`）。
  - 本切片相关套件合并运行（`test_switch_activation.py test_switch_source.py test_composite_revisions.py test_composite_alerts.py test_composite_aggregates.py test_market_usage.py test_switch_runs.py test_switch_schedule.py test_runtime_loops.py`）→ **96 passed**。
  - 迁移语义专项：`-k 'binds_one_state'`（重绑：新版本行指向目标修订、旧版本逐字段不变、state 清空、effective_at=boundary、`chart_alert_rebound` 审计）1 passed；`-k 'forward_history_version'`（同日历同口径、仅历史版本前移 → 重绑且不暂停、不发消息）1 passed；`-k 'calendar_change'`（ny17→utc0 → 暂停且原因写明 utc0/ny17、运行仍 succeeded、汇总消息 paused/rules 计数为 1）1 passed；`-k 'relocation_never'`（切换前最后一根在阈下、切换后第一根在阈上也不产生伪穿越，随后真实穿越只发一次）1 passed；`-k 'relocatable_requires or cannot_serve'`（判据单测 + 暂停后运行仍 succeeded 且计数正确）2 passed。
  - 验收要求的五套件合并运行（`test_switch_activation.py test_switch_source.py test_composite_revisions.py test_composite_alerts.py test_composite_aggregates.py`）→ **46 passed**；其中 `test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity` 单独运行 **1 passed**（文件未改动）。
  - 既有隐式指针不变量 `test_composite_alerts.py -k 'never_retargets_running_rule or fixed_binding'` → **2 passed**。
  - 相邻回归（含 `test_market_usage.py`）全部通过；`test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity` 仍原样通过（见第 8.4 条对 held 分支的收窄）。
- 真实 PostgreSQL（本机 Docker，容器 `mw-tc-activation`，镜像 `postgres:14-bookworm`，端口 `15611`，每个测试独立 schema，跑完 `docker rm -f` 清理）：
  - `TEST_POSTGRES_URL=... CHART_ALERT_TEST_DATABASE_URL=... PYTHONPATH=backend .venv/bin/python -m pytest backend/tests/test_switch_activation_postgres.py backend/tests/test_composite_alerts_postgres.py backend/tests/test_composite_revisions_postgres.py -q` → **41 passed**（本切片 PG 15 条合同 = 14 条 SQLite 合同搬 PG + 并发激活/迟到写入；其余为 composite 告警与修订的既有 PG 门控）。其中 `switch_notice` 的 `rowcount` 不可靠问题正是这轮 PG 实测发现的 —— 4 线程并发激活同一候选修订只产生 1 条 `CompositeActivation`、1 条 `MarketSwitchRun`、0 条通知；切换后旧修订的迟到 `apply_minutes` 与迟到聚合 `commit` 均被拒绝，聚合柱数量不变。
  - 同一次 PG 运行中 `test_composite_revisions_postgres.py` 一并通过（7 passed），确认既有"同请求重试幂等 / 并发激活单条"语义未回退。
- 全量 backend 套件（不带 `TEST_POSTGRES_URL`）：**2496 passed, 10 failed, 746 skipped, 105 errors**。失败与本切片无关，均为既有噪声：
  - 105 errors 及 MCP 相关失败：共享 venv 缺少 `mcp` 模块、PG fixture 无连接串；
  - `test_chart_alert_migration.py`（2 项）：另一并行任务新增的 `migrations/versions/ba54_market_switch_runs.py` 使 alembic head 从 `az53_notification_outbox_types` 变成 `ba54_market_switch_runs`，测试期望值未同步；
  - `test_chart_alert_geometry.py`（1 项）：跨用例 `dependency_overrides` 污染，单独运行、与本切片测试同跑均通过；
  - 其余 `transport_observation / series_search* / imports / chart_export / native_mcp` 与本切片无关。
- `ruff check` 全部改动文件通过；`git diff --check` 干净；`git status --short` 只出现本切片文件（`storage.py` / `switch_runs.py` / `test_switch_runs*.py` / `migrations/versions/ba54_*.py` / `test_alerts_mcp_migration.py` 属另一并行任务，本切片未改动）。
