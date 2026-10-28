# 轨道 C · A04a 周日候选 shadow 报告

日期：2026-10-28。范围：方案第 3.5/3.6 节与第 9 节 A04a——为自建组合准备"最新已发布历史版本"候选修订及其周期/指标产物，生成 shadow 差异报告并持久化到切换运行记录；**不改变任何当前有效绑定**。自动激活（A04b）、切换解锁清理（A13b/A13c）不在本文件范围。

## 1. 结论

| 项目 | 结果 |
|---|---|
| 候选基础选择 | 固定使用 `history_maintenance.latest_version` 的最新已发布、未回收历史版本；其推荐接缝必须 ≤ 本轮准备截止，否则明确报告 `candidate_beyond_cutoff`，不静默降级到旧版本 |
| 候选修订 | 由既有 `composite_revisions.create` 建立，走既有的 preparation/aggregate/artifact 机制；`activate` 从未被调用 |
| 报告持久化 | `switch_runs.record_shadow` 写入 `market_switch_runs.shadow_report`；未就绪/失败时同一 run 置 `failed`（phase=`shadow_not_ready`/`shadow_failed`），自动激活必须检查 `report.ready` |
| 幂等 | 同一 `scheduled_for`/同一 `run_id` 重跑覆盖同一行报告，不新建 run；`failed/partial` 状态先经 `switch_runs.retry` 原地重试 |
| 有效绑定 | shadow 前后对 `market_composites.active_revision_id`、`chart_alerts`、`chart_alert_versions`、`chart_publications`、`managed_realtime:*` 偏好做内容快照比对，结果写入报告 `bindings` |
| 真实 PG | 隔离容器 `mw-tc-baseline-shadow`（postgres:14-bookworm，PostgreSQL 14.24，端口 15610），用例与脚本均真实运行后删除 |

## 2. 公共 API（`backend/alerts/baseline_shadow.py`）

```python
SCHEMA = "baseline-shadow-v1"      # 报告结构版本
KIND = "baseline_shadow"           # market_switch_runs.kind
MAX_BARS = 60                      # 每周期每侧比较的柱数
MAX_SCAN_MINUTES = 32 * 1440        # 缺口扫描窗口上限（分钟）
BUDGET = 256                       # 单次 shadow 驱动的 worker tick 上限

bindings(composite_id) -> dict                     # 有效绑定的内容快照
binding_report(before, after) -> dict              # 快照差异与 critical_unchanged
candidate_plan(db, composite_id) -> dict           # 候选版本/映射/接缝；不可用时返回 {"blocked": reason}
create_candidate(composite_id, plan) -> str        # 幂等建立未激活候选修订并请求周期产物
advance(candidate_id, *, adapter=None, budget=BUDGET) -> None
                                                   # 复用既有 preparation/aggregate/indicator tick
differences(db, composite_id, candidate_id, progress) -> dict
                                                   # bars / indicators / gaps / paused_rules
shadow(composite_id, *, scheduled_for=None, run_id=None, adapter=None, budget=BUDGET) -> dict
                                                   # 编排 + 持久化；不抛出未处理异常
```

`adapter` 就是 `composite_preparation.preparation_tick` 需要的来源适配器（生产为 `HistorySources`）。不传时不发起供应商 I/O，候选的确认分钟只能来自实时确认或既有 preparation 循环——这与生产中的分工一致，脚本/测试用既有域操作预置确认分钟。

## 3. 报告字段定义

| 字段 | 含义 |
|---|---|
| `schema` | 固定 `baseline-shadow-v1`，便于 A04b 与后续审计识别结构 |
| `started_at` / `finished_at` | 本次 shadow 的起止毫秒时间 |
| `composite_id` | 被评估的自建组合 |
| `status` / `ready` | `ready`（候选已就绪且绑定未动）、`not_ready`（候选/数据/版本条件不满足）、`failed`（运行期异常或关键绑定变化） |
| `reasons[]` | `{code, detail}` 列表；`ready` 时为空，见第 4 节原因码 |
| `error` | 仅 `failed` 且由异常导致时出现：`{type, detail}` |
| `run` | 本次持久化的切换运行：`id/kind/state/attempts/scheduled_for` |
| `history_version` | `latest_available_version_id`、`candidate_version_id`、`active_version_id`、`same_version` |
| `revision` | `active_revision_id`/`active_seam`、`candidate_revision_id`/`candidate_seam`、`history_version_id`、`mapping_id`、`request_id` |
| `preparation` | 既有 `readiness()` 原样快照（`status`、`input_revision`、`periods_ready`、`indicators[]`、`query_error`、`coverage`）加 `aggregates[]`（`composite_aggregates.report` 的逐周期状态） |
| `bars.overlap` | 比较窗口：`history_end`（两侧接缝最小值）、`target_start`（接缝最大值）、`target_end`（两侧 `confirmed_end` 最小值） |
| `bars.frames[]` | 每个 `FRAMES` 周期一项：`history`（接缝前固定历史）与 `target`（接缝后已确认目标分钟） |
| `bars.frames[].status` | `compared` / `empty`（无可比较窗口）/ `unavailable`（该侧产物未发布或聚合未到固定输入，附 `reason`） |
| `same` / `changed` / `added` / `missing` | 相同柱数、OHLC 有差异柱数、仅候选有的柱数、仅当前修订有的柱数 |
| `max_price_delta` | 同一柱 OHLC 的最大绝对价格差（按两侧原有价格直接比较，不做平移） |
| `indicators[]` | 每个"已配置指标"（候选修订捕获的 warmup 清单）：`timeframe`、`indicator`、`candidate`/`current` 的 `status/has_value/cursor/start/end/values`，以及 `difference`（`comparable` 与逐键 `candidate/current/delta`） |
| `gaps.scanned` | 缺口扫描窗口与 `expected_minutes`（按交易日历判定的应有分钟）/ `observed_minutes`（候选确认分钟） |
| `gaps.missing_minutes[]` | 连续缺失段 `{start, end, minutes}`（仅统计日历判定为交易时段且候选未确认的分钟；日历无法证明交易分钟的窗口 `expected_minutes` 为 0，如实反映而不猜测） |
| `gaps.uncovered[]` | 未覆盖区间 `{segment, start, end, reason}`：候选固定历史起点晚于当前修订，或 `confirmed_end` 到准备截止之间尚无线索确认 |
| `paused_rules[]` | 每个受影响有效告警：`alert_id`、`name`、`alert_version`、`bound_revision_id`、`will_pause`、`reasons[]`（几何无法重定位/指标缺失/来源不兼容/绑定修订缺失，逐条给理由） |
| `bindings.tables` | `alerts`/`alert_versions`/`publications`/`realtime_preferences` 的 `rows`、`digest`、`unchanged` |
| `bindings.active_revision_id` | `{before, after, unchanged}` |
| `bindings.critical_unchanged` | `active_revision_id` + `chart_alert_versions` + `chart_publications` 全部未变；为 `false` 时报告强制 `failed` |

## 4. 原因码

| code | 含义 |
|---|---|
| `active_revision_missing` | 组合没有当前有效修订 |
| `no_history_version` | 没有已发布且未回收的历史版本 |
| `no_candidate_base` | 最新已发布版本缺少推荐接缝或已审核实时映射 |
| `candidate_beyond_cutoff` | 最新版本推荐接缝晚于本轮准备截止（不静默降级旧版本） |
| `preparation_error` | 候选准备记录了来源错误（`CompositePreparation.error`） |
| `preparation_confirming_m1` / `preparation_publishing_periods` / `preparation_initializing_indicators` | 候选仍停留在对应准备阶段 |
| `periods_not_published` | 候选周期固定产物未齐备 |
| `aggregates_behind` | 某周期聚合未达到候选固定输入 |
| `indicator_pending` | 已配置指标在候选上尚未完成 |
| `bound_revision_missing` | 告警绑定的组合修订不存在（规则将暂停） |
| `source_incompatible` | 告警绑定固定历史不可读，或其实时目标与候选映射不同（规则将暂停） |
| `indicator_missing` | 告警配置的指标在候选上没有已完成值（规则将暂停） |
| `geometry_not_relocatable` | 候选聚合日历与绑定修订不同、候选历史起点晚于规则计算起点，或接缝前历史不足以重建 ATR 参考柱（规则将暂停） |
| `run_not_shadowable` | 目标运行已进入 `activating/succeeded`，拒绝覆盖其报告 |
| `binding_changed` | 关键绑定在运行期间变化（强制 `failed`） |
| `shadow_failed` | 运行期未预期异常，已记录在报告中而非抛出 |

## 5. 有效绑定不变性的断言方式

`bindings()` 对四类行集合做**内容快照**（不是只比计数）：按主键排序后逐列取值，`digest` 取 `sha256(json(sort_keys))`；`shadow()` 在建立/推进候选前后各取一次，比较并要求关键集合完全相等。

```python
def _snapshot(db, model):
    order = [getattr(model, column.name) for column in model.__table__.primary_key.columns]
    columns = [column.name for column in model.__table__.columns]
    return [{name: getattr(row, name) for name in columns}
            for row in db.scalars(select(model).order_by(*order))]

def binding_report(before, after):
    tables = {name: {"rows": len(after[name]), "digest": _digest(after[name]),
                     "unchanged": before[name] == after[name]}
              for name in ("alerts", "alert_versions", "publications", "realtime_preferences")}
    active = {"before": before["active_revision_id"], "after": after["active_revision_id"]}
    active["unchanged"] = active["before"] == active["after"]
    critical = active["unchanged"] and all(tables[name]["unchanged"] for name in CRITICAL)
    return {"tables": tables, "active_revision_id": active, "critical_unchanged": critical}
```

契约测试用同一快照做 `before == after` 断言，并额外断言 `MarketComposite.active_revision_id` 未变、候选修订 `activated_at is None`、`managed_realtime:*` 偏好条数不变（确保没有把候选误当运行修订而未改动 Preference）。`chart_alerts` 的运行时字段在真实常驻进程中可能被无关循环更新，因此只有 `active_revision_id`、`chart_alert_versions`、`chart_publications` 参与 `critical_unchanged` 强制失败判定；`alerts` 表仍如实记录差异。

## 6. 一次真实运行（隔离 PostgreSQL 14.24）

命令（容器 `mw-tc-baseline-shadow`，端口 15610，PostgreSQL 14.24；脚本自建并默认删除 `shadow_<uuid>` schema）：

```bash
TEST_POSTGRES_URL=postgresql+psycopg://shadow:shadow@127.0.0.1:15610/shadow \
  .venv/bin/python scripts/track_c_shadow.py --report /tmp/shadow-report.json
```

报告片段（id 已截断，数字为真实输出）：

```json
{
  "schema": "baseline-shadow-v1",
  "status": "ready",
  "ready": true,
  "reasons": [],
  "run": {"id": "d9f3b89a…", "kind": "baseline_shadow", "state": "shadow_ready",
          "attempts": 0, "scheduled_for": 200000000},
  "history_version": {"latest_available_version_id": "ccf60774…",
                      "candidate_version_id": "ccf60774…",
                      "active_version_id": "3ecb0cf6…", "same_version": false},
  "revision": {"active_revision_id": "a640bd95…", "active_seam": 165600000,
               "candidate_revision_id": "2f49997d…", "candidate_seam": 165600000,
               "history_version_id": "ccf60774…", "mapping_id": "bfc195a5…",
               "request_id": "shadow:67889378…"},
  "bars": {"overlap": {"history_end": 165600000, "target_start": 165600000,
                       "target_end": 165900000},
           "frames": [
             {"timeframe": "M1",
              "history": {"status": "compared", "same": 2, "changed": 0, "added": 0,
                          "missing": 0, "max_price_delta": 0.0},
              "target": {"status": "compared", "same": 0, "changed": 5, "added": 0,
                         "missing": 0, "max_price_delta": 0.21}},
             {"timeframe": "D1",
              "history": {"status": "compared", "same": 1, "changed": 0, "added": 0, "missing": 0},
              "target": {"status": "compared", "same": 0, "changed": 1, "added": 0,
                         "missing": 0, "max_price_delta": 0.21}}]},
  "indicators": [{"timeframe": "M1", "indicator": "SMA",
                  "candidate": {"status": "complete", "has_value": true,
                                "start": 165840000, "end": 165900000,
                                "values": {"value": 1.3}},
                  "current": {"status": "complete", "has_value": true,
                              "start": 166140000, "end": 166200000,
                              "values": {"value": 1.11}},
                  "difference": {"comparable": true,
                                 "values": {"value": {"candidate": 1.3,
                                                      "current": 1.11, "delta": 0.19}}}}],
  "gaps": {"scanned": {"start": 165600000, "end": 165900000,
                       "expected_minutes": 0, "observed_minutes": 5},
           "missing_minutes": [],
           "uncovered": [{"segment": "target", "start": 165900000, "end": 199980000,
                          "reason": "准备截止前尚无来源确认分钟"}]},
  "paused_rules": [{"alert_id": "fe413731…", "will_pause": false, "reasons": []},
                   {"alert_id": "e0a45b19…", "will_pause": true,
                    "reasons": [{"code": "indicator_missing",
                                 "detail": "M1/EMA 在候选修订上没有已完成值"}]}],
  "bindings": {"tables": {"alerts": {"rows": 2, "unchanged": true},
                          "alert_versions": {"rows": 2, "unchanged": true},
                          "publications": {"rows": 1, "unchanged": true},
                          "realtime_preferences": {"rows": 1, "unchanged": true}},
               "active_revision_id": {"unchanged": true},
               "critical_unchanged": true}
}
```

说明：该次运行的数据来自脚本用既有域操作在**独立 schema** 内建立的合成 fixture（历史版本、实时映射、确认分钟、两条告警），不是生产数据，也不是对真实供应商的读取。因此 `expected_minutes` 为 0（fixture 的 synthetic 时间轴无法按交易日历证明交易分钟），`gaps.missing_minutes` 为空是如实结果；缺失分钟段的计算由契约测试单独覆盖（见第 7 节）。切换运行记录本身是真实 PG 行：`market_switch_runs(kind=baseline_shadow, state=shadow_ready, target_revision_id=<候选>)`，报告从该行读回一致。

## 7. 测试证据

```bash
cd /home/quant/repos/market-watch-runtime-track-c-20261028
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests/test_baseline_shadow.py -q
# 8 passed

TEST_POSTGRES_URL=postgresql+psycopg://shadow:shadow@127.0.0.1:15610/shadow \
  PYTHONPATH=backend .venv/bin/python -m pytest backend/tests/test_baseline_shadow_postgres.py -q
# 9 passed（PostgreSQL 14.24，真实运行）
```

sqlite 合同覆盖：报告字段完整性、绑定不变快照断言、未就绪分类、版本超截止、运行期异常入档、重跑幂等（同 run 覆盖、failed→retry 原地恢复、`attempts` 递增）、将暂停规则计算（指标缺失）、重写历史价格的差异与最大价差、缺口清单（缺失分钟段 + 未覆盖区间）。PG 侧复用同一批合同并额外验证 `market_switch_runs` 的报告 JSON 往返与两个索引（`ix_market_switch_run_unlock`、`ix_market_switch_run_dedupe`）存在。

相关回归：`test_composite_revisions/test_composite_aggregates/test_composite_chart/test_composite_preparation/test_composite_definitions` 与新增用例一起 37 passed。

## 8. 边界说明（未自行扩改）

- `backend/alerts/cli.py`：未改。若要把 shadow 接进现有 CLI，需要另开任务（brief 明确该文件属其他任务）。
- `switch_runs.record_shadow` 会把 `preparing` 推进到 `shadow_ready`；本实现据此在未就绪/失败时追加 `set_state(..., "failed", phase="shadow_not_ready"|"shadow_failed")`，避免"报告已写=可激活"的误读。若希望新增一个"只写报告不推进状态"的原语，需要改 `switch_runs.py`（属其他任务）。
- 候选准备的真实供应商续传依赖 `composite_preparation.preparation_tick(adapter)`；本实现的 `adapter` 由调用方注入，未新增常驻循环、队列或锁。
- 未新增 alembic 迁移：`market_switch_runs` 已由其他任务的迁移提供。
