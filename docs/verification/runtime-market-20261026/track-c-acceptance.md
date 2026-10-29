# Track C 验收：A04a shadow / A04b 一致激活 / A05 周日基线 / A13a-b-c 30 天清理

2026-10-29 复核修订：见 [PR #115 修复与验收](pr115-review-fixes.md)。下文历史证据保留原提交与时钟；新 30 天可用性及精确来源清理以修订报告为准。

验收执行任务（未改动 `backend/` 任何代码、迁移、其它任务 compose 或文档）。实际运行主机是**本机 Ubuntu Docker**（无远端实例、无 SSH 转发）。

## 1. 实例与环境

| 项 | 值 |
|---|---|
| 源码 | 分支 `feat/runtime-track-c-20261028`。首轮 G0–G6 在 `5f8e2c543a9fefac3b668bb0664a687815175e68` 上跑完；随后的 G5 产品入口重做在 `0716c4fce914cf6087e704940fdc2f52633b6021`（`fix: scope the shadow binding snapshot to this composite`）上执行，G1/G3 复验与反向证明也在该 HEAD 上 |
| worktree | `/home/quant/repos/market-watch-runtime-track-c-20261028` |
| Compose project | `mw-track-c-20261028`（labels `market-watch.task/project=mw-track-c-20261028`, `market-watch.purpose=acceptance`） |
| overlay | `deploy/ubuntu/runtime-track-c.acceptance.yaml`（新增，固定 digest 依赖镜像 + 只读挂载本工作树；未构建新镜像） |
| network | `mw-track-c-20261028`（bridge，标签同 project） |
| volume | `mw-track-c-20261028-postgres`（标签同 project，保留）、`mw-track-c-20261028-artifacts`（备份产物，标签同 project，保留） |
| 运行中 HEAD | `0716c4fce914cf6087e704940fdc2f52633b6021`（G5 产品入口重做 + G1/G3 复验 + 反向证明） |
| 端口 | `127.0.0.1:15612` → postgres:5432，`127.0.0.1:18091` → api:8000（web 未启用） |
| 后端镜像 | `market-watch-api:v1.29.1-rc.2` = `sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743` |
| PostgreSQL | `postgres:14.24-bookworm` = `sha256:a389ed49344afc8f4444efd4eb512965df07aaa6ed84b239b54a23246e9fe347`（`server_version_num=140024`，`ALERTS_DATABASE_EXPECTED_VERSION=140024` 生效） |
| 数据库 | `track_c_acceptance` / 角色 `track_c`（本任务专用） |
| 服务 | postgres、migrate（一次性）、api、market-runtime、data-worker、notification-worker，以及 `backup`（`profiles: [maintenance]`，与 `compose.production.yaml` 的 backup 服务同形：同一 digest 应用镜像 + `ALERTS_POSTGRES_BIN_DIR=`指向 pg_dump/pg_restore 所在目录） |

```bash
# 启动
cd /home/quant/repos/market-watch-runtime-track-c-20261028
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml up -d postgres
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml run --rm --no-deps -T migrate
# 造数据（G0 之后、G1 之前，一次）
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml run --rm --no-deps -T \
  data-worker python /candidate/scripts/track_c_acceptance_seed.py --stage fixtures
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml up -d \
  api market-runtime data-worker notification-worker

# 停止（本次实际执行，末尾已执行）
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml stop -t 30
```

数据库起点：`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` → `alembic upgrade head`（head = `ba54_market_switch_runs`）→ `track_c_acceptance_seed.py --stage fixtures`。seed 在 `preferences` 写入 `track_c_acceptance:state`（含 `seeded_at=1793199087828`、验收时钟 `clock=1793199060000`、各 composite/revision/version/alert id），重复执行会直接返回该状态而不重复建图。重置方式：同一个 DROP/upgrade/seed 三步。

G0 资源与归属（`results/track-c/g0-resources.txt`）：本机无其它运行中的 Compose project（其余均为 exited 的别任务容器）；启动前可用内存约 9.3 GiB、`/` 剩余 9.9 GiB（磁盘已用 93%，非本任务造成，本任务 volume 仅 544 MB）；`docker compose config` 展开为 6 个默认服务 + maintenance profile 的 `backup`，network/volume/容器标签全部属于本 project；端口 15612/18091 不在既有占用列表内。

**backup 服务的工具来源（与 `deploy/Dockerfile.backup` 同款做法，只是不构建镜像）**：生产镜像在 `FROM \${APP_IMAGE}` 之后 `COPY --from=postgres` 两个二进制到 `/usr/local/bin` 并装 `libpq5 libreadline8 liblz4-1 libzstd1`。本任务未构建镜像，改为从**固定 digest 的 PostgreSQL 镜像**里取出同样的 `pg_dump`/`pg_restore`（`cp -L`，14.24）以及该应用镜像缺少的 4 个共享库（`libpq.so.5`、`libldap-2.5.so.0`、`liblber-2.5.so.0`、`libsasl2.so.2`），放到任务私有目录 `/home/quant/tc-scratch/tc-backup-bin`，只读挂载到 backup 容器 `/opt/pgbin`，并设 `ALERTS_POSTGRES_BIN_DIR=/opt/pgbin/bin`、`LD_LIBRARY_PATH=/opt/pgbin/libs`。在容器内以 uid 1000 验证：`pg_dump (PostgreSQL) 14.24 (Debian 14.24-1.pgdg12+2)`。备份目录是任务私有命名卷 `/artifacts/backups`。

## 2. 造数据（真实形状，全部走应用代码路径）

脚本：`scripts/track_c_acceptance_seed.py`（`--stage fixtures|utc-candidate|version3|version4|isolate|judge|counts|state`），走 `register_dataset → create_version → import_page → artifact_tick → save_mapping → first_use → composite_preparation.claim/commit → composite_aggregates.aggregate_tick → chart_alert_service.create → chart_alert_worker.evaluate`。

* 组合 A：EURUSD（Dukascopy 历史 + OANDA 实时映射，ny17），固定历史 3 天，接缝在 40.7 天前，活分钟从接缝覆盖到 `clock`：前段 15 分钟网格、最后 2 天逐分钟（让判定柱有完整覆盖），共 6 700+ 源分钟；其中约 10 天超出 30 天窗口（清理候选），约 30 天在窗口内（必须保留）。
* 组合 A 的告警：绑当前修订、`cross_up` + 水平线几何（`points=[{time,index:0,price:1.1030}]`）、`max_triggers=3`，用固定验收时钟逐分钟驱动 `evaluate` 产生 7 条 `market_composite_judgments`（`triggered` 1 条 + 对应 1 条 signal 与 1 条 signal 通知）。
* 组合 A 的候选：再发布一个同数据集、同口径同日历、仅历史前移的已发布版本（end 20 天前），由 shadow 的 `candidate_plan` 自动选中。
* 组合 B：USD/CAD（Dukascopy 历史 + OANDA 实时映射，ny17），同样 40 天活分钟与一条绑当前修订的告警；另用 `aggregation_policy.change_aggregation` 由同一父版本派生 utc0 数据集与版本（`agg-utc0-*`），作为「日历不同」的显式候选。
* seed 之后：`source_minutes_old=2066`、`source_minutes_recent=11134`、`bars=1249`、`history_artifacts=27`（`results/track-c/g0-seed-record.json`）。

## 3. 门槛结论

**每条证据跑在哪个 HEAD 上（旧证据保留，未删除）**

| 门槛 | 首轮 | 修复后复验 | 复核修复后重跑（本批） |
|---|---|---|---|
| G1 shadow | `5f8e2c54`（`g1-shadow.json`） | `0716c4fc`（`g1b-*`/`g1c-*`/`g1d-*`） | `9c5a0801`（`g1e-*`/`g1f-*`） |
| G2 激活 | `5f8e2c54`（`g2-*`） | — | `9c5a0801`（`g2b-*`/`g2c-*`） |
| G3 周日基线 | `5f8e2c54`（`g3-*`） | `0716c4fc`（`g3b-*`） | `9c5a0801`（`g3c-*`） |
| G4 dry-run | `5f8e2c54`（`g4-dry-run.json`） | — | `9c5a0801`（`g4b-*`/`g4c-*`） |
| G5 清理 | `5f8e2c54`（`g5-*`） | `0716c4fc`（`g5b-*`） | `9c5a0801`（`g5c-*`/`g5d-*`）；孤儿候选专项复验 `93bbdec6`（`g5e-*`） |
| G6 失败安全 | `5f8e2c54`（`g6-*`） | — | `9c5a0801`（`g6b-*`/`g6c-*`） |

`9c5a0801` = `9c5a08015b68868ab92c68bb5b15ae86eda16f67`（`fix: close the review findings on activation, notice and cleanup`）；`93bbdec6` = `93bbdec6d43195a01e9fd9de26e10067067b76c3`（含 `ace64f64 fix: delete unreferenced minutes instead of stalling the cleanup pass`，只用于 G5 孤儿候选的定点复验）。本批重跑都在**同一个既有隔离实例**（project `mw-track-c-20261028`、同一 DB/volume）上完成：`data-worker` 自 `17:33:28` 起一次性运行至收尾（`RestartCount=0`，见 `g8b-worker-lifecycle.txt`），`api` 全程 `exited 0`，`market-runtime` 保持 `exited` 未被触碰。

### G1 · A04a shadow —— 通过

* artifact：`results/track-c/g1-shadow.json`
* 候选版本 ≠ 当前版本：candidate revision `066483b8…` ≠ active `483db6a3…`；candidate history version `0f53dff4…`（end 20 天前）≠ active `76e1d73c…`（end 40 天前），同一数据集（仅历史前移）。
* `active_revision_id`/告警/告警版本/发布记录前后逐列不变：`bindings.tables.{alerts,alert_versions,publications,realtime_preferences}.unchanged=true`，`active_revision_id.before == after`，`critical_unchanged=true`。
* run 记录：`baseline_shadow` 状态 `shadow_ready`，phase `shadow`，`scheduled_for=1792890000000`（本周日 01:00 UTC 窗口）。

**修复后复验（不停 data-worker，HEAD `0716c4fc`）** —— artifact：`results/track-c/g1b-shadow-rerun.json`、`g1d-shadow-unrelated-write.json`、`g1d-restore-unrelated.json`、`g1b-worker-baseline.txt`、`g1b-worker-lifecycle.txt`

* 运行方式：`data-worker` 全程不停（`StartedAt=2026-10-28T15:27:38.814140646Z` 恒定、`RestartCount=0`、自身日志 14:59:56Z→15:42:29Z 连续，四个检查点见 `g1b-worker-lifecycle.txt`）；`api` 保持 `exited 0`，`market-runtime` 保持 `exited`（未触碰）。shadow 用 `next_weekly` 显式开新窗口（脚本内 `fresh_slot`：跳过已有 run 的窗口）。
* 结果：run `543b5cae-729a-48a8-babd-ef5573b6721b` `shadow_ready`；`status=ready`、`ready=true`、`reasons=[]`、`critical_unchanged=true`。`bindings.scope` 存在且只含本组合范围：`instruments=[MC:7e3cad2f…:EURUSD, MD:99f162c8…:EURUSD, MD:d00bccca…:EURUSD]`、`alert_ids=[45bfd944…]`、`realtime_keys=[3 条]`；快照 1 条告警 / 3 条告警版本 / 1 条发布行 / 2 条实时偏好。修复前导致失败的 `BTCUSDT` 发布行不再入快照。
* 前向证明（无关品种写入不再导致失败）：shadow 运行期间由同进程线程改写**不在 scope 内**的 `BTCUSDT M1` 发布行（`revision 2145→2146`、`updated_at+1000`，见 `g1d-shadow-unrelated-write.json` 的 `tamper_outcome`），run `cd12f062-6809-4afc-8200-8c9565887eb0` 仍 `shadow_ready`、`critical_unchanged=true`；随后 `restore-unrelated` 写回原值（`2145|131|1793200916888`）。
* 反向证明（scope 内改动仍必须失败）：见下面独立小节。

**反向证明：范围收敛没有削弱保护** —— artifact：`results/track-c/g1c-shadow-tampered.json`、`g1c-shadow-tampered-report.json`、`g1c-restore-scope-after-proof.json`

* 做法：shadow 运行期间（同进程线程 100ms 轮询，检测到本次窗口的 run 行后立即执行）改动**本组合自己**的两行：告警 `45bfd944…` 的当前 `chart_alert_versions.effective_at`（+1）与 `MD:99f162c8…:EURUSD` 的 `chart_publications.complete_count/updated_at`（+1/+1000）。原值先写入 `preferences.track_c_acceptance:tamper`，运行后由 `restore-scope` 逐列写回并删除该键。
* 结果：run `33567e42-ef29-40bf-ace4-b455bf703df9` **`state=failed`、`phase=shadow_failed`**，`error_summary.reasons=[{"code":"binding_changed","detail":"有效绑定在 shadow 运行期间发生变化"}]`；`bindings.critical_unchanged=false`，其中 `alert_versions.unchanged=false`、`publications.unchanged=false`，`alerts`/`realtime_preferences` 仍为 `true`。
* 恢复：`restore-scope` 写回后复核 `chart_publications=(complete_count 1, revision 4, updated_at 1793201334643)`、`chart_alert_versions.effective_at=1793199960000`、`preferences` 无临时键残留；随后一次干净 shadow（run `f7fa959d-a160-437b-af0d-adf3d7cd6322`）重新 `shadow_ready` / `critical_unchanged=true`。
* 报告内容：`bars`（9 个周期，history/target 段均 `compared`；M1 target 段 60 根全同、`changed=0`，history 段 `missing=60` 因为候选历史起点更晚）、`indicators`（无指标规则 → 空，两端 `has_value=false`）、`gaps`（`observed_minutes=4675`，`missing_minutes=[]`，`uncovered=[history]`）、`paused_rules`（1 条规则，`will_pause=false`）、`preparation`（`ready=true`，`input_revision=5`，`periods_ready=true`）。

**HEAD `9c5a0801` 重跑（data-worker 不停）** —— artifact：`results/track-c/g1e-shadow-rerun.json`、`g1f-shadow-willpause.json`、`g8b-version7.json`、`g8b-version8late.json`

* `g1e`：run `c561e8ad…` `shadow_ready`、`status=ready`、`critical_unchanged=true`，`bindings.scope` = 3 instrument / 2 `alert_ids`（新加了一条「计算起点晚于候选历史」规则）。行为与旧 HEAD 一致。
* `g1f`：切换到带**更晚固定历史起点**的已发布版本（`a5785d7e…`，start=clock−30d）后重跑，run `0e0cf334…` 仍 `shadow_ready/ready`、`critical_unchanged=true`，且 `paused_rules` 现在给出真实判定：规则 `45bfd944…` `will_pause=false`；规则 `a77a804c…` `will_pause=true`，`reasons=[{code:"geometry_not_relocatable", detail:"候选固定历史起点晚于规则计算起点"}]`。该候选即 G2 重跑的输入。

### G2 · A04b 一致激活 —— 通过

artifact：`results/track-c/g2-activation.json`、`g2-fencing.json`、`g2-pause.json`

1. 一致激活（组合 A，由 market-runtime 的 `switch_activation` 循环执行）：run `822ab313…` 持久化 `state=succeeded`、`phase=activated`、`attempts=0`；`active_revision_id` 切换到 `066483b8…`；`CompositeActivation.event_boundary=1793199540000`、`input_revision=8`。
2. 可重定位规则重绑为新版本行：告警 `45bfd944…` `version 1→2`，新版本行 `market_identity.composite_revision_id` 指向新修订，`evidence.alerts.rebound=[{id, revision_id, version:2, previous_revision_id:旧}]`；旧版本行（version 1）内容与绑定修订保持不变，条件/几何/`seam_policy` 原样保留；告警 `state={}`、`effective_at=boundary`、`control_revision=2`、`runtime.switch_run_id/switch_boundary` 写入，`health=warming`（"组合修订切换后建立新判定基准"）。
3. 指标基线重建：`evidence.metrics={input_revision:8, frames:[9 个周期], boundary, run_id, policy:watermarks_consolidated_at_event_boundary}`，全部周期任务 `applied_input_revision>=8`。
4. 旧修订冻结：`preparations[483db6a3].frozen=true`，`fence={waterline:15, boundary, run_id}`；迟到 `apply_minutes`（`late_minute=1793199360000`）结果 `applied_to_old=[]`（只写进了新修订，`input_revision 8→9`），`aggregate_claim_after_freeze=null`、`aggregate_tick_after_freeze=false`、`waterline_unchanged=true`、`CompositeAggregateBar` 前后同为 46970 行。
5. 切换前数据不回放、无重复告警：激活前后 `judgments 7→7`、`notifications 4→4`、`outbox 3→3`；激活后第一次判定（G3 中）结果为 `initial_baseline`，没有把切换前的穿越重放成新事件。
6. 成功后 `unlocked_runs` 出现该 run（`822ab313…`，`unlocked=true`）。
7. 不可重定位（日历不同）分支（组合 B）：utc0 候选 `a0be0d03…`（`change_aggregation` 派生数据集 `f94f7045…`，版本 `2e28b0cf…`）激活 run `5024863b…` `succeeded/activated`，`active_revision_id` 切到候选；规则**未重绑**（仍是 `version 1`，绑旧修订 `05694f9d…`），状态 `paused/blocked`，`health_reason="组合修订切换后该规则暂不可迁移：目标修订服务日历 utc0，与规则绑定的 ny17 不兼容"`，并在同一次成功事务内写出 1 条汇总 system 消息（payload `topic=switch_run`, `run_id=5024863b…`, `stage=alerts`）。

**HEAD `9c5a0801` 重跑（本批修复重点）** —— artifact：`results/track-c/g2b-activation-rerun.json`、`g2c-targets-*.json`、`g2c-report-stimulus.json`、`g2c-report-restored.json`、`g8b-pause-rule.json`、`g2d-calendar-pause-rerun.json`

* 成功切换：run `8ad02acb-5850-4f79-a57c-947a83328da0` `state=succeeded`、`phase=activated`、`attempts=0`；`active_revision_id` 从 `4271c8d0…` 切到 `c8c7dd51…`；`event_boundary=1793209020000`、`input_revision=5`。
* 可重定位规则重绑：`45bfd944…` `version 3→4`，新版本行绑到 `c8c7dd51…`，`evidence.alerts.rebound=[{id, revision_id, version:4, previous_revision_id:4271c8d0…}]`，`migration="relocated_to_activated_revision"`。
* **被 shadow 标记 will_pause 的规则被暂停且原因来自 shadow**：`a77a804c…` `migration="paused_shadow_rule"`、`reason="候选固定历史起点晚于规则计算起点"`，规则 `status=paused`、`health=blocked`、`health_reason="组合修订切换后该规则暂不可迁移：候选固定历史起点晚于规则计算起点"`，版本仍为 1（未被挪到新修订）。这正是 `shadow_pauses()` 读取持久化 shadow 报告 `paused_rules` 后交给 `rebind_active(shadow=…)` 的结果（`relocatable()` 本身对该规则是放行的，说明 shadow 判定优先）。
* 通知：该 run 仅 1 条 system 通知（`0c955380…`），error key = `alerts|a77a804c…|rule_paused_by_shadow`，`counts={sources:1, rules:2, paused:1}`，Outbox 1 行 `pending`。
* **激活前的 shadow 判定门禁**（本批修复 2）：`activation-snapshot` 在构造刺激（把一份 `shadow_ready` run 的报告临时改成 `not_ready`，`g2c-report-stimulus.json`）前，该窗口的原因分类是 `window_superseded`；刺激后变成 **`shadow_not_ready`**（`g2c-targets-not-ready.json`），且该 target 的 `revision_activation` run 数仍为 **0**（未消耗唯一一次激活机会）；恢复报告后回到 `window_superseded`（`g2c-targets-after-restore.json`，`g2c-report-restored.json`）。
* 日历不同的暂停分支：本批未改动 `relocatable()` 的日历比较，本 HEAD 上**未重跑**——组合 B 的 ny17 反向候选在本实例里无法完成准备（data-worker 的真实供应商历史循环持续抢走该 prep 行并写 `unavailable`，见 `g2d-calendar-pause-rerun.json` 与 `g8b-worker-lifecycle.txt` 里 data-worker 全程在跑）。旧证据 `g2-pause.json`（HEAD `5f8e2c54`，utc0 候选 → 规则 `paused`，原因「目标修订服务日历 utc0，与规则绑定的 ny17 不兼容」）保留未删；本 HEAD 的等效暂停语义由上面 `paused_shadow_rule` 走同一 `pause()` 落库路径。

### G3 · A05 周日基线不依赖 API —— 通过

artifact：`results/track-c/g3-feed.json`、`g3-shadow.json`、`g3-activate.json`

* `api` 容器停止：`status=exited exit=0`（停止时刻 `2026-10-28T15:03:54Z`），shadow 与激活期间再次确认 `api status=exited exit=0`。
* 输入→组合聚合→判定检查点继续推进：写入 240 条新源分钟（`window=[1793199420000,1793213820000]`，`apply_minutes` 产生新输入），`preparation.input_revision 9→10`、`confirmed_end` 前移，9 个周期任务在 4 秒内 `applied_input_revision 9→10`（data-worker 循环推进），判定检查点 `judgments 7→8`（新基准，无穿越重放）。
* API 停止期间的 shadow：run `dedac8e8…` `shadow_ready`、`ready=true`、`reasons=[]`；激活：`activation_cycle` `status=activated`，`active_revision_id` 切到 `4271c8d0…`（run `85d9ea55…` `succeeded/activated`）。
* 之后恢复 api：`api Up (healthy)`（`G4` 前）。

**修复后复验（api 仍停机、不停 data-worker，HEAD `0716c4fc`）** —— artifact：`results/track-c/g3b-shadow-rerun.json`、`g3b-version-frames.json`、`g3-shadow-first-attempt.txt`（修复前失败证据，保留）

* 做法：使用最新已发布历史版本（`5eef2e1b…`，end 4 天前，`--stage frames` 补齐 9 个周期产物）作为候选，用 `next_weekly` 显式开新窗口跑 shadow；期间 `api` 保持 `exited 0`、`data-worker` 保持运行（同一 `StartedAt`、`RestartCount=0`）。
* 结果：run `b2ff067e-e032-4316-931c-b850e836e9cd` `shadow_ready`，`status=ready`、`ready=true`、`reasons=[]`、`critical_unchanged=true`；`bindings.scope` 同样只含 3 个本组合 instrument / 1 个 alert_id；候选 `e808c0a1…` 准备 `ready（input_revision=2，periods_ready=true）`。即 API 停机 + data-worker 正常发布并行时，周日候选仍能就绪。
* 修复前的失败证据保留：`g3-shadow-first-attempt.txt`（`binding_changed`，`publications.rows=12`、`unchanged=false`，原因是 BTCUSDT 等无关品种的发布写）。

**HEAD `9c5a0801` 重跑（api 仍停机、data-worker 不停）** —— artifact：`results/track-c/g3c-version9.json`、`g3c-shadow-apidown.json`、`g3c-activate-apidown.json`

* `api` 在整个重跑前后都是 `exited 0`；`data-worker` 同一 `StartedAt=2026-10-28T17:33:28.863083502Z`、`RestartCount=0`。
* shadow：run `a72ed23c…` `shadow_ready`、`ready=true`、`reasons=[]`、`critical_unchanged=true`（候选来自新发布版本 `a1c0e810…`）。
* 激活：`activation_cycle` 选中该窗口并 `activated`，`active_revision_id` → `e3af4bf5…`；期间无 api。行为与旧 HEAD 一致。

### G4 · A13a/A13b dry-run —— 通过（零删除）

artifact：`results/track-c/g4-dry-run.json`

* 30 天下界：`lower_bound=1790608190341`（= now − 720 h），候选严格早于下界。
* 候选：`source_minutes=2104`、`source_revisions=2104`、`composite_minutes=1034`、`composite_inputs=1034`、`composite_input_events=3`；估算 `bytes=471824`、`rows=6279`。
* 保护明细与跳过原因：`protected.revisions=1070`，`by_reason={active_composite_revision: 1022, alert_bound_revision: 1034}`，`detail` 前 50 条给出具体 `source_id/start/revision_id/reasons`（例：`reasons=["alert_bound_revision"]` 属于被暂停规则仍绑定的旧修订）。
* 零删除：前后逐表行数差全为 0（`zero_deletion=true`），`skipped=[]`（该 run 已解锁、dry-run 批次可认领）。
* 单列断言：`source_minutes_inside_window=13438`（未满 30 天数据）前后不变；`history_chunks=9`、`history_artifacts=54` 前后不变。

**HEAD `9c5a0801` 重跑（dry-run 与 CLI 开关）** —— artifact：`results/track-c/g4b-dry-run.json`、`g4b-cli-default-dryrun.json`、`g4b-cli-dry-run-removed.txt`、`g4b-cli-status.json`、`g4c-cli-default-dryrun.json`

* 脚本 dry-run（run `8ad02acb…`）：`dry_run=true`、`rows=2440`、`bytes=84612`、候选 `{source_minutes:1210, source_revisions:1210, composite_minutes:10, composite_inputs:10, events:0}`、保护 `1080`（`active_composite_revision`/`alert_bound_revision`）、逐表 delta 全 0（`zero_deletion=true`）、字段集与旧 HEAD 相同。
* CLI 默认即 dry-run：`python -m alerts.cli retention` 不带任何开关输出 `dry_run=true` 的报告（`g4c-cli-default-dryrun.json`）。
* `--dry-run` 已不存在：`python -m alerts.cli retention --dry-run` → `cli.py: error: unrecognized arguments: --dry-run`，退出码 **2**，usage 里只剩 `[--execute]`（`g4b-cli-dry-run-removed.txt`）。
* `--execute` 才删除：见下面 G5 的 `--execute` 实际删除证据（`g5d-cli-execute-resume.json`，`dry_run=false`，删 192 行）。

### G5 · A13c 备份真实恢复 + 首次真实删除 + 幂等/续跑 —— 通过（恢复演练已改用产品入口重做）

**G5a 恢复演练（产品入口，重做版）** — artifact：`results/track-c/g5b-backup-cli.json`、`g5b-restore-check-cli.json`、`g5b-restore-drill-marker.json`、`g5b-retention-status.json`、`g5b-temporary-databases.txt`、`g5b-backup-files.txt`、`g5b-after-restart.json`（`g5b-backup-cli-first-run.json` 为卷重建前的一次同款运行，保留）

1. 备份：容器内 `python -m alerts.backup --directory /artifacts/backups`（backup 服务，`ALERTS_POSTGRES_BIN_DIR=/opt/pgbin/bin`）→ `/artifacts/backups/alerts-20261028T152036231475Z.dump`，**7 043 323 字节**，`sha256=e1d55632acd6748bb410f42c5c851b3fd4dadcc25a02879d31a836f7cb8e33d6`，同目录写出 `format=1/backend=postgresql/bytes/counts` 的 manifest（`.dump.json`）。
2. 恢复校验：容器内 `python -m alerts.backup --restore-check <dump>` → `{"verified": true, "backend": "postgresql", "tables": 103}`；`restore_check` 自己 `CREATE DATABASE "alerts_restore_<uuid>" TEMPLATE template0`、`pg_restore --exit-on-error`、用 `sql_counts` 比对后 `DROP DATABASE`。临时库名从 PostgreSQL 日志取到：**`alerts_restore_646afa65edf1484cb40d47e3bb16f672`**（15:20:39 建 / 15:20:44 删），事后 `select count(*) from pg_database where datname like 'alerts_restore%'` = **0**（无遗留）。
3. 门禁标记（同一产品入口）：容器内 `python -m alerts.cli retention --restore-drill /artifacts/backups` → `retention_window.restore_drill` 自行再做一次备份 + 真实恢复 + 写标记：artifact `retention-restore-eddde0c35c914965a0125cbcaead8c5a.dump`（7 043 391 字节，`sha256=26e07eb9d19c2986f94344475fda0adc3414745ac2142f78b8fd48428d4dd03a`）、`tables=103`、`verified_at=1793200863185`、schema `{tables:104, digest:5eeb6d13…, alembic:ba54_market_switch_runs}`；对应临时库 `alerts_restore_fe035aaab7f540d68f4d938c0c0fa113`（15:20:54 建 / 15:21:03 删）。
4. 状态入口：`python -m alerts.cli retention --status` 返回同一标记 + `deletion_order`（5 张活分钟表）+ `window_hours=720`。
5. 门槛持久：重启 data-worker 后 `g5-status` 读回同一标记（同 sha256/verified_at），期间 `retention_cycle(mode=dry_run)` 仍只标批次、行数未变；随后再次停止 data-worker（exit 0）。

**G5b 首次真实删除 / 中断 / 续跑 / 幂等（沿用首轮结果）** — artifact：`results/track-c/g5-execute-1.json`、`g5-interrupted.json`、`g5-execute-2.json`、`g5-execute-3-idempotent.json`、`g5-after-restart.json`

6. 首次真实删除（`ALERTS_RETENTION_MODE=execute`，run `822ab313…`）：第 1 次 pass 删除 200 行（`source_minutes 50, source_minute_revisions 50, composite_minutes 50, composite_minute_inputs 50`），逐表 delta 与报告一致；`@old` 列 delta 与总 delta 相同（删除全部落在 30 天窗口外）。
7. 人为中断：`docker kill --signal=SIGKILL` 中断正在执行的 pass（容器 `exit 137`，`oom=false`），持久批次 `state=running`、`attempts=12`、`stats.rows=900`（每表 225，含中断前第 1 次的 50）；库内实际 `source_minutes@old` 从 2104 降到 1879 = 225，**与累计 stats 完全一致，无重复计数**。
8. 续跑：同一 run 再执行 → 删除 809 行/表 + 3 条 `composite_input_events`（`rows=3239`），批次 `state=completed`、累计 `stats.rows=4139`（每表 1034、events 3）；库内实际 `source_minutes@old` 2104→1070 = 1034，**累计 stats 与实际删除逐表相等（不重复、不跳删）**；剩余 1070 条全部是受保护修订（B 侧）的旧分钟（重做演练后同一列为 1072，因为 30 天下界随墙钟前移了 2 分钟）。
9. 幂等：同一 run 第 3 次执行 → `rows=0`、`idempotent=true`、`batch.state=completed`、逐表 delta 全 0。
10. 未满 30 天与历史表：三次 pass 的 `source_minutes_inside_window` 恒为 13438；`history_chunks=9`、`history_artifacts=54` 恒定；`bars` 5659→5661→5662 的 +3 行是 data-worker 发布循环写入的 BTCUSDT H1 新行（与清理无关，见偏差 9）。

**对照：首轮的手工演练（历史记录，未删除）** — artifact：`g5-backup-counts.json`、`g5-restore-counts.json`、`g5-restore-verification.json`、`g5-marker.json`、`g5-drill-commands.sh`。首轮因为不知道/没使用产品备份入口（`deploy/Dockerfile.backup` + `ALERTS_POSTGRES_BIN_DIR`），改用 PostgreSQL 容器内的 `pg_dump/pg_restore` 手工完成：dump `/home/quant/tc-scratch/track-c.dump`（6 558 905 字节，`sha256=cce6bb5f…`）、临时库 `track_c_restore_1793200123`、103 表计数完全一致（`differences={}`）、标记经 `retention_window.save_restore_drill` 写入。结论与产品入口一致，但它绕过了产品入口，因此以 G5a 为准。

**HEAD `9c5a0801` 重跑（块提交后立即被杀 + 续跑 + 幂等）** —— artifact：`results/track-c/g5c-victim-minutes.json`、`g5c-drop-orphans.json`、`g5d-counts-before.json`、`g5d-chunk-commit-then-die.json`、`g5d-counts-after-kill.json`、`g5d-status-after-kill.json`、`g5d-cli-execute-resume.json`、`g5d-counts-after-resume.json`、`g5d-idempotent-rerun.json`、`g5d-counts-after-idempotent.json`

可删除数据的构造：清理只会删除「有组合行随它一起离开」的源分钟，因此先用 `victim-old-minutes` 建了一个**不受保护**的修订（request_id `acceptance-victim-revision-2`，seam=clock−34d，prep `queried`、9 个周期 `applied==input`），让 33 天前的旧分钟由它引用；原先只插入的 60 条「无引用」孤儿分钟用 `drop-orphans` 撤掉（`g5c-drop-orphans.json`，删 60 条）——它们在计划里是 `deletable` 但 `touched` 为空，`_delete` 不会删，反而会让 pass 在 `passed==0` 处停住（见 §6 新观察）。

* 块提交后立即被杀：`chunk-commit-then-die --chunk 1500` 在**删除的同一个事务**里写 `retention.stats`，随后 `os._exit(0)`（不 release、不 claim）。删除 464 源分钟 + 464 源修订 + 464 组合分钟 + 464 组合输入 + 2 事件 = **rows 1858**；`durable_stats_after_commit` 已经是这 5 项完整计数，批次 `state=running`（从未 release）。
* stats 与实际删除量相等：同一时刻库内 delta = `{source_minutes:464, source_minute_revisions:464, composite_minutes:464, composite_minute_inputs:464, composite_input_events:2}`，**与 stats 逐键相等**（旧 HEAD 上这一场景会少计，因为计数只在 release 时写）。
* 续跑（`python -m alerts.cli retention --execute --run-id <run>`）：删除 46 源分钟 + 54 源修订 + 46 组合分钟 + 46 组合输入 = **rows 192**，其批次 `stats` 与该批实际 delta 逐键相等；两个批次合计 `1858 + 192 = 2050` = 整个序列的库内实际删除总量。
* 同 run 再跑（脚本 `g5-execute`）：`rows=0`、逐表 delta 全 0（无重复计数、无跳删）。
* 未满 30 天数据与历史表：本批未触发这两张断言的变化（`source_minutes` 总量只按删除量下降；清理报告的 `deleted` 仍只有 5 张活分钟表）。

**孤儿候选定点复验（HEAD `93bbdec6`）** —— artifact：`results/track-c/g5e-head.json`、`g5e-orphan-minutes.json`、`g5e-counts-before.json`、`g5e-dry-run.json`、`g5e-counts-after-dry-run.json`、`g5e-counts-before-execute.json`、`g5e-execute-orphans.json`、`g5e-counts-after-execute.json`、`g5e-status-after-execute.json`、`g5e-idempotent-rerun.json`、`g5e-counts-after-rerun.json`

复验动机（保留的历史证据）：`9c5a0801` 上暴露过一个缺陷——无引用的孤儿源分钟在 dry-run 里被算作 `deletable`，但 `_delete` 因为「没有组合侧引用（`touched` 为空）」提前返回 0，随后 `_pass` 又因「有 deletable 但本节零删除」直接 `break`，整趟清理卡在那里。当时的现场保存在 **`g5c-drop-orphans.json`**（为绕开该缺陷而手工删除 60 条孤儿）与 `g5c-cli-execute*.json`（0 删除 + `interrupted`），均未删除。HEAD `93bbdec6`（含 `ace64f64 fix: delete unreferenced minutes instead of stalling the cleanup pass`）改为：只要存在可删候选就继续，组合侧第 1–2 步在没有 `touched` 时整体跳过；终止条件改为「确实没有任何候选」才算完成，「本块零删除且没有新的跳过分类」才算停滞；并且每批先给孤儿留 1/4 额度。

* 场景：沿用同一实例与同一 succeeded 运行 `822ab313…`，重新用 `seed-orphans --minutes 120 --days-back 33` 造出 120 条**无任何组合引用**的 33 天前源分钟（`g5e-orphan-minutes.json`），与 1082 条受保护旧分钟混在一起。
* dry-run（`g5e-dry-run.json`）：`dry_run=true`、`rows=2412`、候选 `{source_minutes:1204, source_revisions:1204, composite_minutes:2, composite_inputs:2, events:0}`、**`deletable_revisions=122`**、`protected=1082`（`by_reason={active_composite_revision:1034, alert_bound_revision:1046, incomplete_preparation:1046}`）、`skipped=[]`；`counts` 前后逐表**零变化**（`zero_deletion=true`）。
* 执行（`g5e-execute-orphans.json`）：`deleted={source_minutes:122, source_minute_revisions:122, composite_minutes:2, composite_inputs:2, events:0}` = **rows 248**；`deletable_revisions(122)` 与 `deleted.market_source_minute_revisions(122)` **口径一致**；`batch.state=completed`（不再卡住）、`remaining={source_minutes:1082, source_revisions:0}`（受保护的旧分钟原样保留）、`skipped=[]`。
* 对账：库内实际变化 `{source_minutes:−122, source_minute_revisions:−122, composite_minutes:−2, composite_inputs:−2, events:0}` 与 `deleted` **逐表相等**（`deleted == delta` → True）。
* 幂等：同一 run 再执行（`g5e-idempotent-rerun.json`）→ `rows=0`、`idempotent=true`、批次仍 `completed`、逐表 delta 全 0（`g5e-counts-after-rerun.json` 与执行后完全一致）。
* 本次会话只起 `postgres`（`data-worker` 保持 `exited`，避免它的 `retention_cycle(dry_run)` 与本次复验抢同一批次的认领）；证据里 `g5e-head.json` 记录 HEAD `93bbdec6d43195a01e9fd9de26e10067067b76c3`。

### G6 · 失败安全 —— 通过

artifact：`results/track-c/g6-shadow.json`、`g6-activate.json`

* 触发：候选 `7b1a45b8…`（新历史版本 `f09b0945…`）shadow 到 `shadow_ready` 后，在 dry 环境里由驱动脚本把 `switch_activation.consolidate_metrics` 替换为抛错实现（注入，见偏差 7），连续激活 3 次，3 次均 `ValueError("验收注入：指标水位重建失败")`。
* run：`ae9720ac…` `state=partial`、`phase=metrics`、`attempts=2`、`error_summary={stage:metrics, completed_stages:["alerts"], paused_alerts:[]}`（3 次尝试 = 首次建行 + 2 次原地重试，与 `attempts=2` 一致）。
* 去重消息：按 run id 过滤 `notifications=1`（`ddd0d8f4…`, `attempts=2`, `state=partial`）、`outbox=1`（`518dfb3d…`），多次重试后仍各 1 条。
* `unlocked_runs` 不含该 run（只含 3 个 succeeded 运行）。
* retention 拒绝清理：`retention_window.dry_run(ae9720ac…)` → `skipped=[{reason:"switch_run_partial", detail:"只有持久化的 succeeded 切换运行解锁清理"}]`，`rows=0`。

**HEAD `9c5a0801` 重跑（新错误键重排 Outbox）** —— artifact：`results/track-c/g6b-version10.json`、`g6b-shadow.json`、`g6b-shadow-ready.json`、`g6c-step1-metrics.json`、`g6c-deliver.json`、`g6c-step2-duplicate.json`、`g6c-outbox-after-duplicate.json`、`g6c-step3-new-error.json`、`g6c-outbox-final.json`、`g6c-retention-refusal.json`、`g6c-status-final.json`

* 候选：新发布版本 `1db5ea30…` → shadow run `de89814c…` `shadow_ready/ready=true`。注意：版本刚发布时，data-worker 的发布循环会写本组合范围内的 `chart_publications`，此窗口内的 shadow 会按设计判 `binding_changed` 失败（`g6b-shadow.json` 记录了两次这样的失败），等发布沉降后再跑即通过（`g6b-shadow-ready.json`）。
* 同一 run（`5cf1f9b2…`）三次失败：
  1. stage `metrics` → run `partial/phase=metrics`；1 条 system 通知（`7e88bb2e…`）+ 1 行 Outbox（`e12eaf20…`）`status=pending`；`errors=[["metrics","ValueError",1]]`。
  2. 模拟投递成功（本实例投递关闭，`deliver-outbox` 把该行置 `accepted`，`g6c-deliver.json`）后，重复同一错误 → run 仍 `partial`、`errors=[["metrics","ValueError",2]]`（seen+1）、`payload_attempts=1`，**Outbox 仍是 `accepted`（未重排）**。
  3. 引入**新错误键**（stage `fence`）→ `errors=[["metrics","ValueError",2],["fence","ValueError",1]]`、`payload_attempts=2`，**同一行 Outbox 回到 `pending`（重排一次）**，`outbox_rows` 始终为 **1**，Notification 始终为 **1**。
* `unlocked_runs` 不含该 `partial` run；`retention --execute --run-id 5cf1f9b2…` 被拒：`skipped=[{reason:"switch_run_partial", ...}]`、`rows=0`、`dry_run=false`。

## 4. 容器退出状态

| 容器 | 结束状态 |
|---|---|
| mw-track-c-20261028-postgres-1 | exited 0 |
| mw-track-c-20261028-migrate-1 | exited 0 |
| mw-track-c-20261028-api-1 | exited 0（G3 中被主动停止过 1 次，exit 0） |
| mw-track-c-20261028-market-runtime-1 | exited 0（G6 前主动停止） |
| mw-track-c-20261028-data-worker-1 | 首轮多次停/启均 exit 0；复验会话里自 `15:27:38` 起一次性运行至收尾（`RestartCount=0`），收尾 `stop -t 30` 后 exited 0 |
| mw-track-c-20261028-notification-worker-1 | exited 0 |
| mw-track-c-20261028-backup-1 | 仅 `created`/`exited 0`（maintenance profile 的一次性入口，G5a 用 `run --rm` 执行） |
| tc-interrupt（G5 中断实验的一次性容器） | exit 137（SIGKILL，`oom=false`） |

## 5. 残余资源与停止状态

* 全部容器已停止：第一次 `docker compose stop -t 30` 在 `2026-10-28T15:14:07Z`，G5a 产品入口重做时再次起停（`2026-10-28T15:19:57Z` 起 postgres → `15:21` 后停 data-worker → 收尾再 `stop -t 30`）。未 `down -v`、未删 volume、未 prune、未动其它 project。
* 保留：network `mw-track-c-20261028`、volume `mw-track-c-20261028-postgres`（544 MB）、volume `mw-track-c-20261028-artifacts`（13.7 MB，含两份产品路径 dump + manifest）、镜像 `sha256:995534fb…` 与 `sha256:a389ed49…`（共用依赖镜像，未删）。
* 备份件保留在仓库外：`/home/quant/tc-scratch/track-c.dump`（首轮手工演练，6 558 905 B，sha256 `cce6bb5f…`）；产品路径的两份 dump 在任务命名卷 `mw-track-c-20261028-artifacts:/artifacts/backups`（`e1d55632…` 7 043 323 B、`26e07eb9…` 7 043 391 B），两者都未放入仓库。
* `pg_dump/pg_restore` 的暂存目录 `/home/quant/tc-scratch/tc-backup-bin`（bin 2 个 + libs 4 个）保留，供重跑 G5a 使用。
* `9c5a0801` 重跑会话（`17:33:28` 起 data-worker 一次性运行，`18:0x` 收尾）：同一 network/volume 复用，未新建实例；`stop -t 30` 后全部容器 `exited 0`（见 §4）。
* 复验会话（HEAD `0716c4fc`）新增证据：`g1b-worker-baseline.txt`、`g1b-worker-lifecycle.txt`（data-worker `StartedAt`/`RestartCount`/日志连续性与 4 个检查点）、`g1c-out-of-scope-writes.txt`（scope 外 BTCUSDT 发布行快照）。
* 起停命令：见 §1；G5a 与复验命令见 §7。

## 6. 偏差、未覆盖与建议（如实）

1. **服务以宿主 uid 运行**：worktree 是 `0700/0600`（uid 1000），镜像内 `app` 用户是 10001，无法遍历只读挂载；overlay 里给后端服务加了 `user: "1000:1000"`。不是代码问题，但属于与阶段 4 overlay 的差异。
2. **关闭 market-runtime 的判定轮询**（`ALERTS_MARKET_RUNTIME_CHART_ALERT_ENABLED=false`）：本实例没有任何供应商可达，真实判定轮次第一轮就会把种子告警判成 `stale/paused`。判定证据改为 seed 期内用 `chart_alert_worker.evaluate`（固定验收时钟 + 通过 storage 模型写入的 `LiveState/PricingOwner` 与实时开关）产生；因此"历史判定/信号"是真的应用判定路径产物，但驱动者是脚本而非容器循环。
3. **组合 B 用 USD/CAD**：`composite_matching.product_rule` 只对 EUR_USD / USD_CAD / XAU_USD 有同产品规则，GBP_USD 无法建立可审核映射。B 的实时开关在建完告警后被显式关闭，避免 data-worker 的周日循环对没有可用候选基线的 B 反复空转。
4. **日历不同候选是显式创建**：`candidate_plan` 只从组合自己的数据集挑最新已发布版本，拿不到 `change_aggregation` 派生到另一个数据集的 utc0 版本；因此 G2 暂停分支用 `composite_revisions.create` 显式建候选（与 `test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity` 同一路径）。
5. **G1 的"将暂停规则"为空**：候选与当前修订同日历同口径，报告确有 `paused_rules` 段但 `will_pause=false`；真正的暂停证据在 G2 的组合 B（日历不同）。
6. **备份/恢复：已用产品备份入口完成（更正前一版结论）**。前一版报告写成"后端镜像缺 pg_dump/pg_restore，因此走 maintenance 方式"——那只对不带备份工具的 api 镜像成立；产品路径是存在的：`deploy/Dockerfile.backup` 以应用镜像为基、从 PostgreSQL 镜像 `COPY` 两个二进制到 `/usr/local/bin`，`compose.production.yaml` 的 `backup` 服务再设 `ALERTS_POSTGRES_BIN_DIR=/usr/local/bin`。本次验收**未构建 `Dockerfile.backup`**（不在 Boundary 内，也不需要），而是在自己的 overlay 里加一个同形的 `backup` 服务：同一 digest 应用镜像 + 从固定 digest PostgreSQL 镜像取出的同版本 `pg_dump/pg_restore` 与 4 个缺失共享库（任务私有目录只读挂载到 `/opt/pgbin`）+ `ALERTS_POSTGRES_BIN_DIR=/opt/pgbin/bin` + `profiles: [maintenance]`。随后用**产品代码入口**跑完整个门禁：`python -m alerts.backup --directory /artifacts/backups`（备份 + manifest）、`python -m alerts.backup --restore-check <dump>`（真实恢复到临时库 + `sql_counts` 比对）、`python -m alerts.cli retention --restore-drill /artifacts/backups`（`retention_window.restore_drill` 自己再做一次备份+恢复并写标记）、`python -m alerts.cli retention --status`（读回标记）。结果见 G5a，均通过。首轮的 PostgreSQL 容器手工方式保留为对照（G5 末段），没有删除历史记录。遗留建议（非阻塞）：把"备份工具从哪儿来"写进验收文档模板，避免再次绕过产品入口；若要在验收里直接用 `Dockerfile.backup`，需要允许构建该镜像。
7. **G6 的失败是脚本层注入**（替换 `switch_activation.consolidate_metrics`），未改仓库代码。原因：真实数据上 `create()/collection_identity` 已挡住 ask/更粗/未验证来源，能力闸门失败会发生在 `open_run` 之前（无法产生 run 行）；而 readiness 与 `consolidate_metrics` 共用同一水位判据，无法只让后者失败。注入点之后的一切（回滚、`partial`、去重通知、retention 拒绝、`unlocked_runs` 排除）都是真实代码路径。为了不让 market-runtime 的真实循环把这枚候选激活成功，G6 前停止了 market-runtime。
8. **shadow 绑定范围（已修复并复验）**：首轮 G3 shadow 曾被 `binding_changed` 判失败——data-worker 的发布循环每周期都在写 `chart_publications`（BTCUSDT 等），而旧实现把整表当作 critical 绑定；当时只能让 shadow 窗口内停掉 data-worker（失败证据见 `g3-shadow-first-attempt.txt`，未删除）。HEAD `0716c4fc` 把快照收敛到 `scope`（本组合 instrument ∪ 固定历史数据集 instrument ∪ 实时映射目标 instrument、本组合告警的全部版本行、这些 instrument 的发布行、对应 `managed_realtime:*` 偏好），比较仍是逐列内容 + sha256。**复验结论**：不停 data-worker、不动 market-runtime 的前提下，(a) 干净 shadow 通过（`g1b-shadow-rerun.json`、`g3b-shadow-rerun.json`、`g1c-shadow-restored.json`）；(b) 运行期间改写 scope 外的 `BTCUSDT` 发布行仍通过（`g1d-shadow-unrelated-write.json`）；(c) 运行期间改写 scope 内的一行告警版本 + 一行发布仍失败于 `binding_changed`（`g1c-shadow-tampered.json`，run `33567e42…`）。修复后不再需要停 data-worker。
9. **历史表计数不是全程恒定**：30 天清理只作用于 `DELETION_ORDER` 的五张活分钟表（报告里的 `deleted` 只有这五个键）；session 期间 `candles/history_chunks/history_artifacts` 的增长来自其它 worker（BTCUSDT 发布 + 后续版本发布），清理前后紧邻快照（G4/G5）显示 `history_chunks=9`、`history_artifacts=54` 不变，`bars` +3 为 BTCUSDT H1 新行。
10. **gap 扫描的 `expected_minutes=0`**：种子目标品种没有 `calendar_profile`（未声明休市），`_closed()` 对每分钟都返回 false，所以"预期分钟"为 0、"缺失分钟"为空；这是数据形状的局限，不是判定被放宽。
11. **批次 `completed` 不等于窗口清空**：执行批次在跳过全部受保护候选后以 `completed` 结束，同时 `remaining.source_minutes=1070`（B 侧受保护旧分钟）。若之后解除保护，需要新的 succeeded run 才能再清；这符合"只有 succeeded 运行解锁、且受保护修订永不删除"的设计，但值得在运维文档里写明。
12. **未覆盖**：真实备用供应商与真实故障切换（Track C 明确不交付）；web 服务未启用；未做并发激活压测（只有 `test_switch_activation_postgres` 层面的 4 线程并发结论）；未对 SQLite 路径重复以上门槛。
13. **清理只会删除「有组合行随它离开」的源分钟**（`_delete` 在 `touched` 为空时直接返回 0）。本次构造数据时先用无引用的「孤儿」源分钟试过：dry-run 把它们计为 `deletable`，但执行时 `deleted` 全 0，并且 `_pass` 会因为「有 deletable 但 passed==0」而 `break`，整趟清理停在那里。最终改为由一个不受保护修订持有这些旧分钟（`victim-old-minutes`）才得到可删除集合。建议：`_plan` 对 `references=={}` 的候选直接判为 blocked（带 `unreferenced_source_minute` 原因），或在 `_delete` 里允许删除无引用的源分钟/修订，避免这种"计划可删、执行不删、还提前结束"的状态。
14. **新发布历史版本后的短窗口会让本组合 shadow 判 `binding_changed`**：publish 之后 data-worker 的发布循环会在数分钟内改写本组合范围内的 `chart_publications`（例如 `MD:99f1…:EURUSD` 六个周期），此时启动的 shadow 会按设计失败（`g6b-shadow.json`）。这不是回归（范围内改动必须失败），但运维上应把「发布新历史版本」和「周日 shadow」错开，或在发布完成后再开窗。
15. **`9c5a0801` 上未重跑的两项**：(a) 日历不同的暂停分支——组合 B 的反向候选在本实例无法完成准备（data-worker 的真实供应商循环持有该 prep 行并写 `unavailable`，`g2d-calendar-pause-rerun.json`），本批也未改动 `relocatable()` 的日历比较，旧证据保留；(b) 备份/恢复演练沿用了 `0716c4fc` 的产品入口结果（本批未触及 `backup`/`retention_window` 的恢复门禁，只改了每块计数的持久化位置）。

## 7. 复现要点

```bash
# G1（api/data-worker 未启动时执行，避免供应商桥接与发布写）
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml run --rm --no-deps -T \
  data-worker python /candidate/scripts/track_c_acceptance_run.py g1-shadow
# G2（起 api/market-runtime 后由周日激活循环完成，再取证据）
... run --rm --no-deps -T data-worker python /candidate/scripts/track_c_acceptance_run.py g2-activation
... g2-fencing / g2-pause（g2-pause 会先派生 utc0 数据集、准备并更新 utc0 候选）
# G3（停 api，data-worker 用于推进聚合）
... g3-feed ; ... g3-shadow ; ... g3-activate
# G4/G5/G6
... g4-dry-run --run-id <succeeded run>
# G5a 产品备份入口（maintenance profile；ALERTS_POSTGRES_BIN_DIR 已在 overlay 内）
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml \
  --profile maintenance run --rm --no-deps -T backup                      # 备份 + manifest
docker compose ... --profile maintenance run --rm --no-deps -T backup \
  python -m alerts.backup --restore-check /artifacts/backups/<name>.dump   # 真实恢复 + 计数比对
docker compose ... --profile maintenance run --rm --no-deps -T backup \
  python -m alerts.cli retention --restore-drill /artifacts/backups        # 再演练一次并写标记
docker compose ... --profile maintenance run --rm --no-deps -T backup \
  python -m alerts.cli retention --status                                  # 读回标记
# G5 首轮对照（PostgreSQL 容器手工方式，保留）
bash results/track-c/g5-drill-commands.sh
... g5-execute --run-id <run> --limit 200 --chunk 50      # 首次真实删除（execute 模式）
... g5-execute --run-id <run> --limit 5000 --chunk 50     # 中断实验/续跑
... g5-execute --run-id <run> --limit 5000 --chunk 50      # 幂等零删除
... g6-shadow ; ... g6-activate --attempts 3
... final
# 修复后复验（HEAD 0716c4fc，data-worker 不停）
... g1-shadow                        # fresh_slot + next_weekly，干净 shadow 通过
... g1-shadow-unrelated-run --days 0  # 运行期间写 scope 外的 BTCUSDT 发布行 → 仍通过
... restore-unrelated
... g3-shadow --days 0               # api 停机 + data-worker 运行，新窗口 shadow 就绪
... g1-shadow-tampered-run --days 0  # 运行期间写 scope 内的告警版本+发布行 → 必须 failed/binding_changed
... restore-scope ; ... g1-shadow    # 恢复后再跑一次干净 shadow
... run-report --run-id <failed run> # 归档失败报告

# 复核修复后重跑（HEAD 9c5a0801，容器内需 -e MW_TC_HEAD=$(git rev-parse HEAD)）
... add-pause-rule                       # 造一条 shadow 会判 will_pause 的规则（calculation_origin = 绑定版本起点）
python /candidate/scripts/track_c_acceptance_seed.py --stage forward --days 3 --start-days 30 --key v8late
... g1-shadow                            # G1：shadow 报告给出 will_pause=true
... activate-candidate --run-id <shadow> # G2：成功切换 + 重绑 + paused_shadow_rule
... activation-snapshot / report-stimulus --run-id <run> / activation-snapshot / restore-report
... g3-shadow --days 0 ; ... g3-activate # G3：api 停机下的周日基线
... g4-dry-run --run-id <run>            # G4：零删除
python -m alerts.cli retention           # CLI 默认即 dry-run
python -m alerts.cli retention --dry-run # 应报 unrecognized arguments
... victim-old-minutes ; ... chunk-commit-then-die --run-id <run> --chunk 1500
python -m alerts.cli retention --execute --run-id <run> --limit 5000 --chunk 500 --budget-ms 120000
... g5-execute --run-id <run>            # 幂等零删除
... g6-sequence --stages metrics --run-id <shadow> ; ... deliver-outbox --run-id <activation run>
... g6-sequence --stages metrics ; ... outbox --run-id <activation run>
... g6-sequence --stages fence   ; ... outbox --run-id <activation run>
```
