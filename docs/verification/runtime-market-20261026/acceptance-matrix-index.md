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
| 通过 | A01、A02、A03、A07、A14、A15 | 6 |
| 部分 | A05、A06、A09、A10、A11、A12、A17a | 7 |
| 偏差 | A08 | 1 |
| 未覆盖 | A04a、A04b、A13a、A13b、A13c、A16、A17b | 7 |

## 逐项索引

| 编号 | 状态 | 证据 | 缺口与关闭动作 |
|---|---|---|---|
| A01 默认新部署 | 通过（隔离实例） | `stage-4-preflight-acceptance.md`（`runtime-stage4.acceptance.yaml` 渲染为 postgres/migrate/api/market-runtime/data-worker/notification-worker/web，三组只依赖 migrate 成功，web 依赖 API healthy）；`stage-3b-notifications-acceptance.md`（默认与生产模板各渲染单个 `notification-worker`，无 `notify-worker`/`notification-projector`）；`tests/ops/test_database_compose.py` | 生产模板的实际进程树与隐藏常驻子进程只在隔离实例核对；正式切换清单中按 `docker compose ps` 复核一次 |
| A02 行情读取一致 | 通过（合同级） | `query-boundary-audit.md`（`chart_query.DataQuery/data_sync` 已被 HTTP、MCP、`market_stream_worker` 直接调用，`results/contracts.txt` 127 passed）；`acceptance-results.md` | 同口径在真实供应商数据上未验证（验收 fixture 均关闭真实供应商）；不新增合同，正式切换后核对 Setting 与一次真实读取 |
| A03 原生与派生差异 | 通过（合同级） | `implementation-reuse-inventory.md`（原生周期/归档与固定历史产物边界）；`stage-1-contract-boundaries.md`；`acceptance-results.md`（阶段 0 合同与 PG 套件） | 真实供应商原生周期未验证；无新增动作 |
| A04a 周日候选 shadow | 未覆盖 | 设计见 `ownership.md`、`data-retention-inventory.md`（明确"尚无周日编排"）；`baseline.md` 的 candidate 场次只证明候选准备与实时判定并发（就绪 28.20 s），不是 shadow 报告合同 | 轨道 C 独立 PR 交付；阶段 5 不实施 |
| A04b 一致激活与自动来源切换 | 未覆盖 | 现有 `composite_revisions` 激活原语见 `implementation-reuse-inventory.md`，不含自动编排 | 轨道 C；真实备用源未接入，仅能力边界与双来源 fixture |
| A05 API 完全停止 | 部分 | `stage-2-network-acceptance.md`：`stream_c`（API `/readyz` 200 后停止且 running=false，新输入经真实 stream 推进，7 条规则各触发一次）、`five_health28b`（API 保持停止、无 data-worker、7/7 crossing、六角色无 error） | "每周日基线更新不依赖 API"属轨道 C，未覆盖；关闭动作：在覆盖索引中引用轨道 C 交付后补签 |
| A06 无浏览器 | 部分 | `stage-2-network-acceptance.md`（无浏览器 interest，真实运行组推进）；`stage-3a-sse-acceptance.md` + `stage-3a-data-acceptance.md`（浏览器级取消、generation fencing、重连与 reset） | 供应商低频订阅"关闭后停止更新/租约到期停止"目前只有 `provider_service.cleanup`、`market_stream_lifecycle` 合同证据，缺容器级一次核对；关闭动作：阶段 5 补一次容器级观察 |
| A07 OANDA 两种模式 | 通过（隔离实例） | `stage-2-network-acceptance.md`：stream 模式 `stream_c`/`five_health28b`；REST batch 嵌入模式 `rest_embedded_e`（probe7，独立 project `mw-runtime-stage2-rest-20261027`）；owner/epoch/fencing 合同见 `stage-1-realtime-switch.md` 与 OANDA recovery PG 套件 | 生产部署实际选用模式属切换时的配置核对项，不是本行缺口 |
| A08 历史/指标积压及候选重建 | 偏差 | `baseline.md`（四场同预算可比负载 + candidate aggressive control 证明争用与事件正确性风险）；`performance-followup-20261028.md`（内嵌忙载 ATR 可见→判定 p95 1.197 s；六 owner Compose p95 1.163 s，n=40，目标约 1 s） | 门槛未达成，按 2026-10-28 决定保留为**非阻塞验收偏差**；关闭动作：按 `performance-followup` 的分段口径在最终源码同预算复测，结果作为偏差更新，不放宽门槛 |
| A09 慢来源 | 部分 | `baseline.md` slow-source 场（`ProviderInterest` 返回 `TimeoutError`，窗口 oracle 13/13；ATR close 小样本 0.809 s（修后）／1.769 s（旧指纹），两组不得混用） | 真实外部网络断线与恢复、容器级"单源失败其他源与判定继续"未单列；关闭动作：阶段 5 用容器级一次故障注入补证 |
| A10 慢通知 | 部分 | `stage-3b-notifications-acceptance.md`（投影/保留/投递各自循环；API 与 data 缺席时 Outbox 继续；HTTP stub 投递；`notification-runtime` 独立启动五个角色 idle） | 跨服务完整矩阵（网络等待不阻塞投影的容器级证据、停止 API/data 后已有 Outbox 持续处理）未签收；关闭动作：阶段 5 补一次 |
| A11 后台组分别重启 | 部分 | `stage-2-network-acceptance.md`（`five_recovery28a` 从 checkpoint 8.859 s 恢复、epoch 3、7 个 signal ID 不变；`stream_c` 重启 9.34 s、boot 更替）；`stage-3b-notifications-acceptance.md`（PG 中断致 profile 非零退出后干净重启、SIGTERM exit 0） | data/notification 组的容器级重启矩阵只到 profile smoke；关闭动作：阶段 5 对三组各做一次 SIGTERM/恢复核对并复用现有证据 |
| A12 循环失败与健康 | 部分 | `stage-2-network-acceptance.md`（聚合卡住 14.070 s 仅该角色 stale、异常 4.091 s 记录 failed 且容器 exit1 非 OOM、单角色失败不掩盖）；`stage-4-preflight-acceptance.md`（API 停 12 s 期间三组继续、market 心跳审计自 110 推进到 114） | "无 active 规则仍可健康"、"实例更替无旧写误报"的容器级证据未单列；关闭动作：阶段 5 补一次实例更替核对 |
| A13a 30 天下界与引用保护 | 未覆盖 | 仅有设计：`data-retention-inventory.md`（UTC 30×24 h、未满窗不删、有效引用与 Dukascopy 不删、清理顺序与外键约束） | 轨道 C 实现 + dry-run 证据；阶段 5 不实施删除 |
| A13b 切换解锁与 dry-run | 未覆盖 | 同上；现有 `history_retention` 不等于切换成功解锁的清理 | 轨道 C |
| A13c 首次清理与恢复 | 未覆盖 | 同上；首次真删前的适用备份**实际恢复**门槛未执行 | 轨道 C；需用户安排恢复演练窗口 |
| A14 入口、能力与运维配置 | 通过（合同级） | `stage-1-realtime-switch.md`（逐品种实时开关、composite-only 可执行资格、能力发现）；`stage-3a-data-acceptance.md`（默认/生产模板含 data-worker、Compose 合同 5 passed / 29 subtests）；`stage-4-preflight-acceptance.md`（生产模板全部后端 `ALERTS_YAHOO_ENABLED=true`） | 日志轮转、pool/线程预算等运维项未在容器内逐项核对；正式切换清单核对 Setting 后关闭 |
| A15 配置切换与回退 | 通过（隔离实例） | `stage-4-preflight-acceptance.md`：preflight 合同 5 passed；fixture 冲突返回 1 并点名 `notify-worker`，停止后返回 0；真实 preflight 对 `mw-single-frontend-20261026` 返回 1 并列出 `api`、`notification-projector`；隔离 old→new→old 演练与候选恢复 | 旧镜像无法解析 `az53`，回退必须绕过旧迁移（见 `switch-rollback-runbook.md`）；旧业务写路径未全覆盖 |
| A16 运行故障主动提醒 | 未覆盖 | `stage-3b-notifications-acceptance.md` 只有通知组内 health-inspection 循环、incident 持久去重与 15 分钟提醒限频 | 五服务级"预期角色缺失/过期、关键循环失败、启动反复"端到端、跨组重启去重与恢复通知未签收；**本阶段必须闭合** |
| A17a ntfy 服务端持久链路 | 部分 | `stage-3b-notifications-acceptance.md`（测试/行情/系统消息共用持久 Outbox，自动投递关闭时测试消息仍可领取；本地 90 passed/1 skipped，PG 17 passed，投递仅 HTTP stub） | 真实 ntfy 服务端与业务信号端到端、超时/鉴权/重启/确认 stub 故障矩阵未签收；**本阶段需用户提供或授权 topic 后闭合** |
| A17b 手机端独立签收 | 未覆盖 | 无真实 topic 或手机使用记录（`issue-draft.md`、`known-risks.md`、`stage-5-joint-acceptance.md` 均标注待签收） | 轨道 D 独立签收；不阻塞核心运行组交付，不得表述为已送达 |

## 阶段 5 剩余关闭清单

本阶段（阶段 5）按方案第 7 节要求关闭下列项；其余未覆盖项按轨道归属独立 PR：

1. **A16**：五服务内角色缺失/过期、关键循环失败、启动反复的端到端自报警与跨组重启去重。
2. **A17a**：真实 ntfy 服务端链路（需用户提供或授权 topic 与服务端通道；无真实通道时保持"部分"并如实标注）。
3. **A06、A09、A10、A11、A12 的标注子项**：各补一次容器级核对，复用已有 fixture 与证据，不重跑整套语义回归。
4. **A08**：按 `performance-followup-20261028.md` 的分段口径复测并更新偏差记录，不改变已确认门槛。
5. 待用户授权后：A02/A03/A14 的真实供应商与 Setting 核对，A17b 手机签收。

## 维护规则

- 新增证据写入对应阶段记录后，只更新本索引的状态与缺口列，不复制原始结论。
- 同一场景已归档的证据不重跑；只有调用链、调度所有权或恢复行为变化时才补最小证据。
- `server accepted`、stub 投递、单场 p95 不得升级为"已送达"或"长期容量通过"。
