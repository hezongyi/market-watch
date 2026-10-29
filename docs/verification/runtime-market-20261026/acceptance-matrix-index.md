# 阶段 5：联合验收矩阵覆盖索引

日期：2026-10-28。范围：本方案第 9 节 A01—A17b 的逐项证据索引、状态与剩余关闭动作。本索引只汇总**已归档**证据，不新增测试、不重跑相同场景；一次演练覆盖多个编号时在两侧同时标注。

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
| 通过 | A01、A02、A03、A06、A07、A09、A10、A11、A12、A14、A15、A16、A17a、A17b | 14 |
| 部分 | A05 | 1 |
| 偏差 | A08 | 1 |
| 未覆盖 | A04a、A04b、A13a、A13b、A13c | 5 |

## 逐项索引

| 编号 | 状态 | 证据 | 缺口与关闭动作 |
|---|---|---|---|
| A01 默认新部署 | 通过（隔离实例） | `stage-4-preflight-acceptance.md`（`runtime-stage4.acceptance.yaml` 渲染为 postgres/migrate/api/market-runtime/data-worker/notification-worker/web，三组只依赖 migrate 成功，web 依赖 API healthy）；`stage-3b-notifications-acceptance.md`（默认与生产模板各渲染单个 `notification-worker`，无 `notify-worker`/`notification-projector`）；`tests/ops/test_database_compose.py` | 生产模板的实际进程树与隐藏常驻子进程只在隔离实例核对；正式切换清单中按 `docker compose ps` 复核一次 |
| A02 行情读取一致 | 通过（合同级） | `query-boundary-audit.md`（`chart_query.DataQuery/data_sync` 已被 HTTP、MCP、`market_stream_worker` 直接调用，`results/contracts.txt` 127 passed）；`acceptance-results.md` | 同口径在真实供应商数据上未验证（验收 fixture 均关闭真实供应商）；不新增合同，正式切换后核对 Setting 与一次真实读取 |
| A03 原生与派生差异 | 通过（合同级） | `implementation-reuse-inventory.md`（原生周期/归档与固定历史产物边界）；`stage-1-contract-boundaries.md`；`acceptance-results.md`（阶段 0 合同与 PG 套件） | 真实供应商原生周期未验证；无新增动作 |
| A04a 周日候选 shadow | 未覆盖 | 设计见 `ownership.md`、`data-retention-inventory.md`（明确"尚无周日编排"）；`baseline.md` 的 candidate 场次只证明候选准备与实时判定并发（就绪 28.20 s），不是 shadow 报告合同 | 轨道 C 独立 PR 交付；阶段 5 不实施 |
| A04b 一致激活与自动来源切换 | 未覆盖 | 现有 `composite_revisions` 激活原语见 `implementation-reuse-inventory.md`，不含自动编排 | 轨道 C；真实备用源未接入，仅能力边界与双来源 fixture |
| A05 API 完全停止 | 部分 | `stage-2-network-acceptance.md`：`stream_c`（API `/readyz` 200 后停止且 running=false，新输入经真实 stream 推进，7 条规则各触发一次）、`five_health28b`（API 保持停止、无 data-worker、7/7 crossing、六角色无 error） | "每周日基线更新不依赖 API"属轨道 C，未覆盖；关闭动作：在覆盖索引中引用轨道 C 交付后补签 |
| A06 无浏览器 | 通过（隔离实例） | stage-5-runtime-topup-acceptance.md（真实 provider 订阅 H1 计数 2→3→4；停续租后 30 s 窗口 6→6、provider_interests 归零、数据集修订冻结；同窗口 OANDA 源 ready、aggregate 8→10、判定序列推进，告警需求不随网页释放）。artifact：provider-quiet.json、snapshot-a06-*.json | 关闭 |
| A07 OANDA 两种模式 | 通过（隔离实例） | `stage-2-network-acceptance.md`：stream 模式 `stream_c`/`five_health28b`；REST batch 嵌入模式 `rest_embedded_e`（probe7，独立 project `mw-runtime-stage2-rest-20261027`）；owner/epoch/fencing 合同见 `stage-1-realtime-switch.md` 与 OANDA recovery PG 套件 | 生产部署实际选用模式属切换时的配置核对项，不是本行缺口 |
| A08 历史/指标积压及候选重建 | 偏差（非阻塞，未关闭） | a08-gap-analysis.md §6.2、§9（2026-10-29 复审更正）；归档 results/a08-ab-a1-summary.json、results/a08-ab-a2-summary.json 保留原值。A1 ATR close 可见→有效判定 p95=1.227 s、n=4；原 0.707–0.885 s 是业务时钟覆盖扫描统计，不能替代有效输入配对。 | 撤回原关闭：修复发布唤醒不等于 A08 达标。按固定门槛补最终五服务、候选重建预算、真实前台请求、data-worker 短停及 normal/busy/candidate/slow-source 同预算有效配对；旧场 PG 2 CPU 不是生产预算，亦不同于阶段 0 的 0.75 CPU。 |
| A09 慢来源 | 通过（隔离实例） | `stage-5-a09-signal-acceptance.md`（慢源 ReadTimeout 期间38采样，健康报价最大年龄584 ms；同 boot、同规则版本/运行世代，真实穿越产生各一条 signal/notification/Outbox，撤销注入后无重复）。原 `stage-5-runtime-topup-acceptance.md` 的来源/日历状态证据保留 | 信号级缺口已关闭；单条价格 intrabar 规则，不扩大为依赖源自动切换或性能 SLO |
| A10 慢通知 | 通过（隔离实例） | stage-5-runtime-topup-acceptance.md（投递目的地改永不响应 stub：投递阻塞期间投影/保留 checked_at 持续推进 28 采样；停 API+data-worker+打包后仅通知组仍领取既有 Outbox，attempts 0→1；notifications 与 outbox 严格 1:1）。artifact：projection-watch.json、snapshot-a10-*.json | 关闭 |
| A11 后台组分别重启 | 通过（隔离实例） | stage-5-runtime-topup-acceptance.md（三组各自 stop -t 30 全部 exit 0 / OOMKilled=false；boot 各自更替且其他组 boot 不变；applied 36→37→38、confirmed_end 推进、通知与 Outbox 一对一增长；三组恢复）。同任务租约接管改引 `stage-5-review-fixes.md`（原租约到期前 38 个采样 attempts=1，新 boot 到期后同 task attempts=2、accepted、仅一行 Outbox）。artifact：snapshot-a11-*.json、results/stage-5-review-fixes-20261028.json | 关闭；signal ID 集合不变仍引用阶段 2 five_recovery28a |
| A12 循环失败与健康 | 通过（隔离实例） | stage-5-runtime-topup-acceptance.md（7 规则全 paused 时 chart_alert 仍 idle、无假故障；旧 boot 迟到写入被围栏拒绝——fence-old.json 显示 stored_boot 已为新 boot、state idle、same_boot false；新实例 16 采样全 idle；关键循环抛错 → 真实 exit 1 且记录组失败） | 关闭 |
| A13a 30 天下界与引用保护 | 未覆盖 | 仅有设计：`data-retention-inventory.md`（UTC 30×24 h、未满窗不删、有效引用与 Dukascopy 不删、清理顺序与外键约束） | 轨道 C 实现 + dry-run 证据；阶段 5 不实施删除 |
| A13b 切换解锁与 dry-run | 未覆盖 | 同上；现有 `history_retention` 不等于切换成功解锁的清理 | 轨道 C |
| A13c 首次清理与恢复 | 未覆盖 | 同上；首次真删前的适用备份**实际恢复**门槛未执行 | 轨道 C；需用户安排恢复演练窗口 |
| A14 入口、能力与运维配置 | 通过（合同级） | `stage-1-realtime-switch.md`（逐品种实时开关、composite-only 可执行资格、能力发现）；`stage-3a-data-acceptance.md`（默认/生产模板含 data-worker、Compose 合同 5 passed / 29 subtests）；`stage-4-preflight-acceptance.md`（生产模板全部后端 `ALERTS_YAHOO_ENABLED=true`） | 日志轮转、pool/线程预算等运维项未在容器内逐项核对；正式切换清单核对 Setting 后关闭 |
| A15 配置切换与回退 | 通过（隔离实例） | `stage-4-preflight-acceptance.md`：preflight 合同 5 passed；fixture 冲突返回 1 并点名 `notify-worker`，停止后返回 0；真实 preflight 对 `mw-single-frontend-20261026` 返回 1 并列出 `api`、`notification-projector`；隔离 old→new→old 演练与候选恢复 | 旧镜像无法解析 `az53`，回退必须绕过旧迁移（见 `switch-rollback-runbook.md`）；旧业务写路径未全覆盖 |
| A16 运行故障主动提醒 | 通过（隔离实例） | 代码与合同：42a1eb82、e67b556f；review 修复 a49bce8a（第 3 次启动触发、按组维护抑制 boot_loop、不假恢复，真实 PG 5 合同均通过，见 `stage-5-review-fixes.md`）。真实通道：stage-5-a17a-channel-acceptance.md 第 8 节——同一活动故障 T0=166401062 → T0+901938 ms=167303000 仅两条提醒、零中间重推；last_notified_at 三次推进（166401046 → 167302980 → 168205820）不再冻结；healthy 663 s 内 system 通知新增 0 | 关闭 |
| A17a ntfy 服务端持久链路 | 通过（隔离实例，真实 ntfy.sh） | stage-5-a17a-channel-acceptance.md 第 8 节：6 条消息全部服务端接受（测试 G3nsoYqJvcS1、信号 PO9zmT4tPqSD、故障 zk1xGctTf73x、提醒 31fVwXbjo8qy、恢复 W7MzTlpGGxZA、下轮提醒 qCfIPoubT1R7）；库内 delivery_attempts accepted=6、outbox accepted=1/cancelled=5（调度方独立复读） | 关闭；手机侧点击/确认单列 A17b |
| A17b 手机端独立签收 | 通过（单设备手机签收） | 用户于 2026-10-28 在手机上实测：收到通知、点开（click 指向 LAN 地址 `http://192.168.7.232:18090`）、点「确认」；api 记录 5 次 `POST /api/notification-actions/<id>/ack 200` 且 `ack_at` 与消息一一对应（见 `stage-5-a17a-channel-acceptance.md` 第 9 节） | 已关闭；多设备、锁屏展示效果、到达率与时延不在本轮范围 |

## 阶段 5 剩余关闭清单

本 PR 的实现及联合验收切片已交付（A16、A17a 关闭；A06、A10—A12 容器级关闭；review 修复见 `stage-5-review-fixes.md`）。A09 信号级已由 `stage-5-a09-signal-acceptance.md` 补齐；下列历史缺口及独立轨道按归属处理：

1. ~~A17b 点击/确认~~：已由用户在手机实测签收（收取 + 点击 + 确认），见上表。
2. ~~A09 信号级~~：已通过独立 Ubuntu 实例补齐持续 ReadTimeout 期间的 crossing→signal→notification→Outbox，见新增证据。
3. **A05 周日基线部分**：属轨道 C，与 30 天清理一起独立 PR。
4. **A08**：恢复为非阻塞验收偏差；2026-10-28 的 busy fixture 仅作局部优化证据，不能关闭完整 A08。后续按 a08-gap-analysis.md §5、§9 补证，不放宽门槛。
5. **A02/A03/A14 真实供应商侧核对**：正式切换时按 `switch-rollback-runbook.md` 第 3 节执行。

## 维护规则

- 新增证据写入对应阶段记录后，只更新本索引的状态与缺口列，不复制原始结论。
- 同一场景已归档的证据不重跑；只有调用链、调度所有权或恢复行为变化时才补最小证据。
- `server accepted`、stub 投递、单场 p95 不得升级为"已送达"或"长期容量通过"。
