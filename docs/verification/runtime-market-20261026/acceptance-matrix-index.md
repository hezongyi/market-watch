# 阶段 5：联合验收矩阵覆盖索引

2026-10-29 复核修订：见 [PR #115 修复与验收](pr115-review-fixes.md)。下文历史证据保留原提交与时钟；新 30 天可用性及精确来源清理以修订报告为准。

日期：2026-10-28。范围：本方案第 9 节 A01—A17b 的逐项证据索引、状态与剩余关闭动作。本索引只汇总**已归档**证据，不新增测试、不重跑相同场景；一次演练覆盖多个编号时在两侧同时标注。2026-10-28 由轨道 C 回填 A04a、A04b、A05 基线段、A13a—A13c 的状态与证据引用（入口见「轨道 C 证据入口」）；阶段 5 原有证据与结论未改动。

状态口径：

| 状态 | 含义 |
|---|---|
| 通过（合同级） | 有回归/合同证据证明该行为，证据路径可核对；未在容器级重跑 |
| 通过（隔离实例） | 在 Ubuntu 本机隔离任务实例中以真实容器验证 |
| 部分 | 已覆盖列出子项，仍有明确未覆盖子项（见"缺口"列） |
| 偏差 | 行为正确但未达已确认门槛，按既决事项保留为验收偏差，不转通过 |
| 未覆盖 | 无实现或无证据，需由标注的阶段/轨道交付 |

引用规则：证据文件在 `docs/verification/runtime-market-20261026/` 下，原始 artifact 在 `results/` 或任务主机 artifact 目录；`ntfy` HTTP stub 与 `server accepted` 不得表述为手机送达。

## 汇总

| 状态 | 编号 | 数量 |
|---|---|---:|
| 通过 | A01、A02、A03、A04a、A05、A06、A07、A09、A10、A11、A12、A13a、A13b、A13c、A14、A15、A16、A17a、A17b | 19 |
| 部分 | A04b | 1 |
| 偏差 | A08 | 1 |
| 未覆盖 | 无 | 0 |

## 逐项索引

| 编号 | 状态 | 证据 | 缺口与关闭动作 |
|---|---|---|---|
| A01 默认新部署 | 通过（隔离实例） | `stage-4-preflight-acceptance.md`（`runtime-stage4.acceptance.yaml` 渲染为 postgres/migrate/api/market-runtime/data-worker/notification-worker/web，三组只依赖 migrate 成功，web 依赖 API healthy）；`stage-3b-notifications-acceptance.md`（默认与生产模板各渲染单个 `notification-worker`，无 `notify-worker`/`notification-projector`）；`tests/ops/test_database_compose.py` | 生产模板的实际进程树与隐藏常驻子进程只在隔离实例核对；正式切换清单中按 `docker compose ps` 复核一次 |
| A02 行情读取一致 | 通过（合同级） | `query-boundary-audit.md`（`chart_query.DataQuery/data_sync` 已被 HTTP、MCP、`market_stream_worker` 直接调用，`results/contracts.txt` 127 passed）；`acceptance-results.md` | 同口径在真实供应商数据上未验证（验收 fixture 均关闭真实供应商）；不新增合同，正式切换后核对 Setting 与一次真实读取 |
| A03 原生与派生差异 | 通过（合同级） | `implementation-reuse-inventory.md`（原生周期/归档与固定历史产物边界）；`stage-1-contract-boundaries.md`；`acceptance-results.md`（阶段 0 合同与 PG 套件） | 真实供应商原生周期未验证；无新增动作 |
| A04a 周日候选 shadow | 通过（隔离实例） | 设计见 `ownership.md`、`data-retention-inventory.md`；`baseline.md` 的 candidate 场次只证明候选准备与实时判定并发（就绪 28.20 s），不是 shadow 报告合同。2026-10-28 轨道 C 回填：`track-c-acceptance.md` §G1（隔离实例 `mw-track-c-20261028`：run `543b5cae…` `shadow_ready`、`critical_unchanged=true`，`bindings.scope` 只含本组合 instrument/告警/实时偏好；前向证明改写 scope 外 `BTCUSDT` 发布行仍通过，反向证明 scope 内改动 run `33567e42…` 仍 `shadow_failed` + `binding_changed`）；报告字段与原因码见 `track-c-shadow-report.md`；artifact `results/track-c/g1b-shadow-rerun.json`、`results/track-c/g1c-shadow-tampered.json`、`results/track-c/g1c-shadow-restored.json`、`results/track-c/g1d-shadow-unrelated-write.json`、`results/track-c/g1b-worker-lifecycle.txt`；合同 `backend/tests/test_baseline_shadow.py`（11 passed）与 `backend/tests/test_baseline_shadow_postgres.py`（12 passed，PG 14.24） | 候选与当前修订同日历同口径，`paused_rules.will_pause=false`（真暂停证据在 A04b 的组合 B，偏差 5）；`gaps.expected_minutes=0` 是 fixture 无 `calendar_profile` 的数据形状局限（偏差 10）；真实供应商候选续传与真实缺口段未验证 |
| A04b 一致激活与自动来源切换 | 部分 | 现有 `composite_revisions` 激活原语见 `implementation-reuse-inventory.md`，不含自动编排。2026-10-28 轨道 C 回填（一致激活一侧）：`track-c-activation.md`（激活顺序、事务边界、回滚、fencing 判据、去重汇总消息、重绑语义）；`track-c-acceptance.md` §G2（run `822ab313…` `succeeded/activated`、告警 `version 1→2` 重绑且旧版本行逐列不变、`preparations[483db6a3].frozen=true` 后迟到 `apply_minutes` 只入新修订、`judgments/notifications/outbox` 7/4/3 前后不变、日历不同分支 utc0 规则 `paused/blocked` 并在同事务写 1 条汇总 system 消息）；artifact `results/track-c/g2-activation.json`、`results/track-c/g2-fencing.json`、`results/track-c/g2-pause.json`；合同 `backend/tests/test_switch_activation.py`（12 passed，含来源能力）、`backend/tests/test_switch_activation_postgres.py`（11 passed，含 4 线程并发激活只产生 1 条激活记录）、`backend/tests/test_switch_source.py` | **自动来源切换未交付**：真实备用供应商未接入，只交付映射/能力合同与双来源 fixture（`track-c-activation.md` §7），该子项无真实证据，不能标通过；切换前穿越不回放只在合同层验证，未做容器级真实穿越；并发激活未压测（仅 PG 合同 4 线程） |
| A05 API 完全停止 | 通过（隔离实例） | `stage-2-network-acceptance.md`：`stream_c`（API `/readyz` 200 后停止且 running=false，新输入经真实 stream 推进，7 条规则各触发一次）、`five_health28b`（API 保持停止、无 data-worker、7/7 crossing、六角色无 error）。「每周日基线更新不依赖 API」2026-10-28 由轨道 C 补签：`track-c-acceptance.md` §G3（`api` `exited 0` 期间 shadow `dedac8e8…` 与复验 `b2ff067e…` 均 `shadow_ready`，激活 `status=activated`；写入 240 条新源分钟后 `input_revision 9→10`、9 个周期任务 4 s 内推进、判定 `7→8` 为新基准无穿越重放；复验在 `data-worker` 不停、`RestartCount=0` 下完成）；artifact `results/track-c/g3-feed.json`、`results/track-c/g3-shadow.json`、`results/track-c/g3-activate.json`、`results/track-c/g3b-shadow-rerun.json`、`results/track-c/g3b-version-frames.json` | 关闭。注：Track C 实例无供应商可达，验收期关闭 market-runtime 判定轮询、判定由脚本用固定验收时钟驱动（偏差 2）；生产供应商可达条件下的周日窗口仍按 `switch-rollback-runbook.md` 第 3 节核对（与 A02/A14 同批） |
| A06 无浏览器 | 通过（隔离实例） | stage-5-runtime-topup-acceptance.md（真实 provider 订阅 H1 计数 2→3→4；停续租后 30 s 窗口 6→6、provider_interests 归零、数据集修订冻结；同窗口 OANDA 源 ready、aggregate 8→10、判定序列推进，告警需求不随网页释放）。artifact：provider-quiet.json、snapshot-a06-*.json | 关闭 |
| A07 OANDA 两种模式 | 通过（隔离实例） | `stage-2-network-acceptance.md`：stream 模式 `stream_c`/`five_health28b`；REST batch 嵌入模式 `rest_embedded_e`（probe7，独立 project `mw-runtime-stage2-rest-20261027`）；owner/epoch/fencing 合同见 `stage-1-realtime-switch.md` 与 OANDA recovery PG 套件 | 生产部署实际选用模式属切换时的配置核对项，不是本行缺口 |
| A08 历史/指标积压及候选重建 | 偏差 | `baseline.md`（四场同预算可比负载 + candidate aggressive control 证明争用与事件正确性风险）；`performance-followup-20261028.md`（内嵌忙载 ATR 可见→判定 p95 1.197 s；六 owner Compose p95 1.163 s，n=40，目标约 1 s） | 门槛未达成，按 2026-10-28 决定保留为**非阻塞验收偏差**；关闭动作：按 `performance-followup` 的分段口径在最终源码同预算复测，结果作为偏差更新，不放宽门槛 |
| A09 慢来源 | 通过（隔离实例） | `stage-5-a09-signal-acceptance.md`（慢源 ReadTimeout 期间38采样，健康报价最大年龄584 ms；同 boot、同规则版本/运行世代，真实穿越产生各一条 signal/notification/Outbox，撤销注入后无重复）。原 `stage-5-runtime-topup-acceptance.md` 的来源/日历状态证据保留 | 信号级缺口已关闭；单条价格 intrabar 规则，不扩大为依赖源自动切换或性能 SLO |
| A10 慢通知 | 通过（隔离实例） | stage-5-runtime-topup-acceptance.md（投递目的地改永不响应 stub：投递阻塞期间投影/保留 checked_at 持续推进 28 采样；停 API+data-worker+打包后仅通知组仍领取既有 Outbox，attempts 0→1；notifications 与 outbox 严格 1:1）。artifact：projection-watch.json、snapshot-a10-*.json | 关闭 |
| A11 后台组分别重启 | 通过（隔离实例） | stage-5-runtime-topup-acceptance.md（三组各自 stop -t 30 全部 exit 0 / OOMKilled=false；boot 各自更替且其他组 boot 不变；applied 36→37→38、confirmed_end 推进、通知与 Outbox 一对一增长；三组恢复）。同任务租约接管改引 `stage-5-review-fixes.md`（原租约到期前 38 个采样 attempts=1，新 boot 到期后同 task attempts=2、accepted、仅一行 Outbox）。artifact：snapshot-a11-*.json、results/stage-5-review-fixes-20261028.json | 关闭；signal ID 集合不变仍引用阶段 2 five_recovery28a |
| A12 循环失败与健康 | 通过（隔离实例） | stage-5-runtime-topup-acceptance.md（7 规则全 paused 时 chart_alert 仍 idle、无假故障；旧 boot 迟到写入被围栏拒绝——fence-old.json 显示 stored_boot 已为新 boot、state idle、same_boot false；新实例 16 采样全 idle；关键循环抛错 → 真实 exit 1 且记录组失败） | 关闭 |
| A13a 30 天下界与引用保护 | 通过（隔离实例） | `data-retention-inventory.md`（UTC 720 h、未满窗不删、有效引用与 Dukascopy 不删、`DELETION_ORDER` 五张活分钟表、批次幂等与续跑）。2026-10-28 轨道 C 回填：`track-c-acceptance.md` §G4（`lower_bound=1790608190341`=now−720 h、候选 `source_minutes=2104`/`composite_minutes=1034`、受保护 `revisions=1070` 且 `by_reason={active_composite_revision:1022, alert_bound_revision:1034}`、`zero_deletion=true`、窗口内 13438 行与 `history_chunks=9`/`history_artifacts=54` 前后不变）；artifact `results/track-c/g4-dry-run.json`；合同 `backend/tests/test_retention_window.py` 与 `backend/tests/test_retention_window_postgres.py` | dry-run 为单次采样；30 天下界随墙钟前移（重做演练时同一列 1070→1072）只改变候选集合，不构成删除错误；生产数据量下的扫描成本未测（`track-c-retention-inventory.md` §9 的索引建议被 boundary 挡住） |
| A13b 切换解锁与 dry-run | 通过（隔离实例） | 同上；现有 `history_retention` 不等于切换成功解锁的清理。2026-10-28 轨道 C 回填：§G4 该 succeeded run 已解锁，故 `skipped=[]`、dry-run 批次可认领且零删除；§G6 失败安全（run `ae9720ac…` `state=partial`/`phase=metrics` → `retention_window.dry_run` 返回 `skipped=[{reason:switch_run_partial}]`、`rows=0`、`unlocked_runs` 不含该 run）；artifact `results/track-c/g4-dry-run.json`、`results/track-c/g6-shadow.json`、`results/track-c/g6-activate.json` | 关闭。解锁判据只接受持久化 `succeeded` 运行；生产首个 succeeded 运行的真实解锁属正式切换时的核对项 |
| A13c 首次清理与恢复 | 通过（隔离实例） | 同上；首次真删前的适用备份**实际恢复**门槛已有产品入口证据：`track-c-acceptance.md` §G5a（`python -m alerts.backup` dump 7 043 323 B、`--restore-check` `verified=true`/`tables=103` 且临时库无遗留；`alerts.cli retention --restore-drill` 自建备份+真实恢复并写标记；`--status` 读回同一标记）+ §G5b（`execute` 模式首次真删 200 行、SIGKILL 中断 `attempts=12` 累计与实际删除逐表一致不重复、续跑后 `stats.rows=4139` 与实际删除相等、第 3 次 `rows=0`/`idempotent=true`）；artifact `results/track-c/g5b-backup-cli.json`、`results/track-c/g5b-restore-check-cli.json`、`results/track-c/g5b-restore-drill-marker.json`、`results/track-c/g5b-retention-status.json`、`results/track-c/g5-execute-1.json`、`results/track-c/g5-interrupted.json`、`results/track-c/g5-execute-2.json`、`results/track-c/g5-execute-3-idempotent.json` | 首次真实删除**只在隔离任务实例执行**（Compose project `mw-track-c-20261028`），生产未授权、未执行；批次 `completed` 不等于窗口清空——剩余候选（`results/track-c/g5-execute-2.json` 的 `remaining.source_minutes=1070`，全为受保护修订旧分钟）需下一次 `succeeded` 切换运行才能继续清（偏差 11）；未对 SQLite 路径重复以上门槛 |
| A14 入口、能力与运维配置 | 通过（合同级） | `stage-1-realtime-switch.md`（逐品种实时开关、composite-only 可执行资格、能力发现）；`stage-3a-data-acceptance.md`（默认/生产模板含 data-worker、Compose 合同 5 passed / 29 subtests）；`stage-4-preflight-acceptance.md`（生产模板全部后端 `ALERTS_YAHOO_ENABLED=true`） | 日志轮转、pool/线程预算等运维项未在容器内逐项核对；正式切换清单核对 Setting 后关闭 |
| A15 配置切换与回退 | 通过（隔离实例） | `stage-4-preflight-acceptance.md`：preflight 合同 5 passed；fixture 冲突返回 1 并点名 `notify-worker`，停止后返回 0；真实 preflight 对 `mw-single-frontend-20261026` 返回 1 并列出 `api`、`notification-projector`；隔离 old→new→old 演练与候选恢复 | 旧镜像无法解析 `az53`，回退必须绕过旧迁移（见 `switch-rollback-runbook.md`）；旧业务写路径未全覆盖 |
| A16 运行故障主动提醒 | 通过（隔离实例） | 代码与合同：42a1eb82、e67b556f；review 修复 a49bce8a（第 3 次启动触发、按组维护抑制 boot_loop、不假恢复，真实 PG 5 合同均通过，见 `stage-5-review-fixes.md`）。真实通道：stage-5-a17a-channel-acceptance.md 第 8 节——同一活动故障 T0=166401062 → T0+901938 ms=167303000 仅两条提醒、零中间重推；last_notified_at 三次推进（166401046 → 167302980 → 168205820）不再冻结；healthy 663 s 内 system 通知新增 0 | 关闭 |
| A17a ntfy 服务端持久链路 | 通过（隔离实例，真实 ntfy.sh） | stage-5-a17a-channel-acceptance.md 第 8 节：6 条消息全部服务端接受（测试 G3nsoYqJvcS1、信号 PO9zmT4tPqSD、故障 zk1xGctTf73x、提醒 31fVwXbjo8qy、恢复 W7MzTlpGGxZA、下轮提醒 qCfIPoubT1R7）；库内 delivery_attempts accepted=6、outbox accepted=1/cancelled=5（调度方独立复读） | 关闭；手机侧点击/确认单列 A17b |
| A17b 手机端独立签收 | 通过（单设备手机签收） | 用户于 2026-10-28 在手机上实测：收到通知、点开（click 指向 LAN 地址 `http://192.168.7.232:18090`）、点「确认」；api 记录 5 次 `POST /api/notification-actions/<id>/ack 200` 且 `ack_at` 与消息一一对应（见 `stage-5-a17a-channel-acceptance.md` 第 9 节） | 已关闭；多设备、锁屏展示效果、到达率与时延不在本轮范围 |

## 阶段 5 剩余关闭清单

本 PR 的实现及联合验收切片已交付（A16、A17a 关闭；A06、A10—A12 容器级关闭；review 修复见 `stage-5-review-fixes.md`）。A09 信号级已由 `stage-5-a09-signal-acceptance.md` 补齐；下列历史缺口及独立轨道按归属处理：

1. ~~A17b 点击/确认~~：已由用户在手机实测签收（收取 + 点击 + 确认），见上表。
2. ~~A09 信号级~~：已通过独立 Ubuntu 实例补齐持续 ReadTimeout 期间的 crossing→signal→notification→Outbox，见新增证据。
3. ~~A05 周日基线部分~~：已由轨道 C 的 `track-c-acceptance.md` §G3 补签（`api` `exited 0` 期间 shadow 就绪 + 激活成功 + 聚合/判定推进），见上表 A05。
4. **A08**：按 `performance-followup-20261028.md` 的分段口径独立复测，结果作为偏差更新，不放宽已确认门槛。
5. **A02/A03/A14 真实供应商侧核对**：正式切换时按 `switch-rollback-runbook.md` 第 3 节执行。
6. **轨道 C 回填（2026-10-28）**：A04a、A13a、A13b、A13c 转通过（隔离实例），A05 的周日基线段补签；A04b 一致激活侧已通过但**自动来源切换未交付**，保留为部分。证据入口见下节；真实备用供应商接入与生产首次删除仍不在已交付范围。

## 轨道 C 证据入口

轨道 C（独立 PR）交付 A04a / A04b / A05 基线段 / A13a—A13c 的实现与隔离实例验收。入口如下，只指路径，不复制原始数据：

| 类别 | 路径 | 内容 |
|---|---|---|
| 验收报告 | `track-c-acceptance.md` | G0—G6 逐门槛证据与 §6 偏差清单；首轮 `5f8e2c54…`，G5 产品入口重做与 G1/G3 复验在 `0716c4fc…` |
| 原始 artifact | `results/track-c/`（54 件 + `results/track-c/SHA256SUMS`） | `g1b`/`g1c`/`g1d` 前向与反向证明、`g3b` API 停机复验、`results/track-c/g4-dry-run.json`、`g5b-*` 产品备份入口、`g5-execute-*` 与 `results/track-c/g5-interrupted.json` 首次真删/中断/续跑/幂等、`g6-*` 失败安全 |
| 设计与字段说明 | `track-c-shadow-report.md`、`track-c-retention-inventory.md`、`track-c-activation.md` | shadow 报告字段与原因码、30 天清理合同与保护规则、激活顺序/fencing/重绑语义与来源能力边界 |
| 代码合同 | `backend/tests/test_switch_runs.py`、`backend/tests/test_switch_schedule.py`、`backend/tests/test_baseline_shadow.py`、`backend/tests/test_baseline_shadow_postgres.py`、`backend/tests/test_switch_activation.py`、`backend/tests/test_switch_activation_postgres.py`、`backend/tests/test_switch_source.py`、`backend/tests/test_retention_window.py`、`backend/tests/test_retention_window_postgres.py`、`backend/tests/test_runtime_loops.py` | 周日调度、shadow 合同、一致激活/回滚/fencing/来源能力、清理下界/解锁/幂等 |

边界与运维事实（不得据此抬高状态）：

1. 真实备用供应商未接入、真实自动故障切换未交付；Track C 只交付映射/能力合同与双来源 fixture，因此 A04b 为**部分**，不因激活门槛通过而整体转通过。
2. 首次真实删除只在隔离任务实例（Compose project `mw-track-c-20261028`）执行；生产未授权、未执行。
3. 验收偏差照实引用 `track-c-acceptance.md` §6，本索引不转述为通过：服务以宿主 uid 1000 运行（偏差 1）、验收期关闭 market-runtime 判定轮询并由脚本驱动判定（偏差 2）、组合 B 选 USD/CAD 的原因（偏差 3）、G6 的失败是脚本层注入（偏差 7）、备份/恢复已改用产品入口（偏差 6，更正前一版结论）。
4. 运维事实：一个清理批次 `completed` 不等于窗口清空；剩余候选（`results/track-c/g5-execute-2.json` 的 `remaining.source_minutes=1070`）需要下一次 `succeeded` 切换运行才能继续清（偏差 11）。
5. 实例为 `127.0.0.1:15612`（PG）与 `127.0.0.1:18091`（api），web 未启用，全程无真实供应商读取（偏差 12）；SQLite 路径未重复以上门槛。

## 维护规则

- 新增证据写入对应阶段记录后，只更新本索引的状态与缺口列，不复制原始结论。
- 同一场景已归档的证据不重跑；只有调用链、调度所有权或恢复行为变化时才补最小证据。
- `server accepted`、stub 投递、单场 p95 不得升级为"已送达"或"长期容量通过"。