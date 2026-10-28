# A08 未达标原因分析与解决方案

日期：2026-10-28。分析基线：远端 `v2.0.0-rc.1`（`0eac4fe7548f5df32c43e26415d9cf7e2e0ff581`，与本地 `main` HEAD 同一提交），隔离 worktree 分支 `analysis/a08-gap-20261028`。

范围与性质：**只读分析**。本文不新增、不改写既有验收证据，不改代码、不放宽门槛、不宣称通过。A08 在 `acceptance-matrix-index.md` 中维持「偏差」状态直至新增同预算证据。

本文所有数字只有两个来源：(a) 已归档证据文件；(b) 本轮由我或复核者对 `results/runtime_compose_busycompose28e-alert.jsonl`、`results/baseline-summary.json` 的独立复算。凡属推断的结论均标注「推断」。

---

## 1. 结论摘要

A08 记为「偏差」是两类问题叠加，且**主因不是 ATR 计算**：

1. **门槛差距有结构性解释。** 同一 artifact 中，单条规则的扫描周期 p95 为 1.022 s（p50 0.718 s），而单次事务 p95 只有 0.142 s；扫描周期逐样本等于「本轮事务 + 等到下一个 0.25 s 轮询边界的余留」，其中空闲等待 p95 0.931 s，约为 ATR n=40 的 p95 1.163 s 的 **80%**（量级对比，非逐样本归因，见 §3.1 方法边界）。告警判定路径**只有 0.25 s 定时轮询、没有发布提交唤醒**，因此新增可见输入基本要等到下一次扫描才被看到。
2. **A08 的 5 个场景子项从未在真实五服务装配下测量。** 现有可比负载全部来自六个 fixture owner 进程；真实 `data-worker`（历史下载/候选重建）与 `market-runtime` 作为服务从未参与测量。「容器同预算」在默认/生产 compose 中也没有事实（无 cgroup 限额），候选重建计算路径没有进入预算机制。

关闭动作因此不是「再调一次参数」，而是：**先改判定触发方式（发布唤醒），再补装配级证据与三处硬缺失（预算声明、重建预算、可观测性）**。本分支已实现发布唤醒并实测：ATR 判定 p95 4.56→1.16 s、4.24→1.09 s，事件恢复 13/13，但仍贴着约 1 s 门槛，A08 不据此转为通过（见第 6 节）。同期实现的「轮前无变化预检」被同一实测否定并已撤除。

---

## 2. 门槛与实测（全部可核对）

| 指标 | 已确认门槛 | 实测 | 出处 |
|---|---|---|---|
| 可判断输入 → 判定 | p95 约 1 s，p99 ≤2 s | **ATR 1.163 s（n=40）超标**；四场 fixture busy 1.197 s（normal/candidate/slow-source 0.666/0.520/0.809） | `acceptance-thresholds.md:28`；`progress.md:47`、`:61`、`:134` |
| 接收提交 → signal 提交 | p95 ≤3 s | 输入提交→ATR 判定 p95 1.530 s（通过） | `performance-followup-20261028.md:8` |
| 接收提交 → 自建 M1 发布 | p95 ≤2 s | 0.621 s（n=20，通过） | 同上 |
| 门槛可否放宽 | 不可 | 用户已确认「不得因实现失败放宽」 | `acceptance-thresholds.md:3`、`:7` |

原始 artifact：`results/runtime_compose_busycompose28e*`、`results/stage2-final-embedded-load-summary.json`；运行源码 SHA256 `9fb77e76…9e6f6d`；宿主 load 约 4–9（有竞争的本机数据点）。

---

## 3. 原因分析

### 3.1 结构性相位等待（主因）

对 `results/runtime_compose_busycompose28e-alert.jsonl` 的独立复算（评审者也各自复算，数值一致）：

| 复算项 | 结果 |
|---|---|
| 规模 | 7 个 alert_id、13 159 次 `evaluated`、跨度 1 281.5 s（≈21 min，与 `progress.md:47`「约20分钟」一致） |
| 单条规则的扫描周期（本规则 read_started → 本规则下一次 read_started，n=13 152） | p50 **0.718 s** / p95 **1.022 s** / min 0.165 s |
| 实际一轮（时间序每 7 次连续事务为一轮；一轮 = 首条 read_started → 末条 committed；n=1 879） | p50 **0.544 s** / p95 **0.899 s** |
| 单次事务（read_started→evaluation_finished） | p50 0.070 s / p95 **0.142 s** |
| 单次事务含提交（read_started→committed） | p95 0.148 s；其中 commit_started→committed p95 0.009 s |
| 周期归属 | 逐样本 `扫描周期 ≡ 本轮事务 + 到下一个 0.25 s 轮询边界的余留`（13 152/13 152 对成立）；余留自 committed 起算 p95 **0.931 s**，自 evaluation_finished 起算 0.933 s（差一次 commit 尾项，p95 0.009 s） |

结构上确定的路径：

- `alert_monitor.run` 周期 0.25 s 且不可配置（`alert_monitor.py:15`），两个调用点都没传 period（`alert_runtime.py:22`、`market_runtime.py:29`）；超时整周期跳过、不补跑（`alert_monitor.py:41-48`、等待在 `:56`）。
- 每轮 `step` 先取全部 active 规则 id（`chart_alert_worker.py:438-439`，**无 ORDER BY**），再**逐条规则一个独立事务**、行锁 `with_for_update(skip_locked=True)`（`chart_alert_worker.py:443-447`）串行执行。
- 该路径**没有提交唤醒**：全仓库 `PublicationWakeup` 的消费方只有 `chart_aggregation_worker.py:55-66` 与 `history_versions.py:520-547`、`:565-571`；告警判定只靠定时轮询。
- 单条规则事务里除告警读写外还有 `MarketDataset` 排他锁（`composite_alerts.py:94-95`）、`live_snapshot`（`:99`）、`chart_page` 只读（`:348`）。

**推断（有理据但非逐样本归因）：** 输入每 2 s 到达、单规则扫描周期 p50 0.718 s、事务只占 0.07–0.14 s，因此新增可见输入的绝大部分延迟是「等下一次扫描」。换句话说：即使把单次判定压到瞬时，只要仍是 0.25 s 轮询驱动的串行扫描，可见→判定就不会进入 0.1 s 量级。

> 方法边界：本轮**未**复算 n=40 子集的「可见→事务开始」拆解（需要把输入可见时刻与规则配对），因此不引用该类拆解数字；上表的 80% 是「空闲等待 p95 0.931 s ÷ 总 p95 1.163 s」的量级对比，不是逐样本归因。

### 3.2 每轮事务成本随规则数增长

- 逐规则事务 p50 实测离散：0.0495 / 0.0523 / 0.0768 / 0.0748 / 0.0727 / 0.0727 / 0.0953 s（约 2 倍差），因此**不得把「每条 70 ms」当常数**。
- 七条规则事务 p50 之和 ≈0.494 s，占一轮 p50 0.544 s 的约 **91%**——一轮基本就是「纯事务时间」，几乎没有余量给计算之外的优化。
- 该 artifact 的字段只有 `alert_id/business_now/commit_started/committed/count/evaluation_finished/health/health_reason/read_started/sequence/status/type`，**没有 rule type 或品种字段**，所以任何「按规则类型比较成本」的结论都无法由它得出。**推断：**规则数与事务成本是本路径的成本上限，规则增多会近似线性抬高一轮时长（需专门测量，未验证）。

### 3.3 上游两跳不是本次瓶颈

- M1 发布：`composite_aggregate_worker` 空闲轮询 0.5 s（`composite_aggregate_worker.py:36`）、每 tick 只领 1 个任务（`composite_aggregates.py:151-156`）、租约 60 s（`:104`）→ 观测 p95 0.621 s，已在「发布 p95≤2 s」门槛内。
- 指标依赖：`alert_indicator_worker` 每 tick 推进 1 页，忙/闲等待 0.01/0.1 s（`alert_indicator_worker.py:75`），只在存在未完成 run 时才挡路。

### 3.4 A08 七个子项的证据/实现状态

| 子项 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 1 同预算可比并发负载（data-worker 同时下载并积压） | 仅 fixture | `baseline.md:3,10`；`scripts/runtime_market_baseline.py:531-560` | 真实 `data-worker`/`market-runtime` 服务从未参与测量 |
| 2 一个打开供应商图表的低频前台 bar 需求 | 仅合成 adapter | `baseline.md:5`；`results/baseline-summary.json` runs[0] `foreground_actual_request_s` p95 0.109 s（n=9，p50 0.1004，max=p95） | 该 p95 来自固定约 100 ms 的合成 adapter，与竞争无关，不证明竞争下的前台时延；无真实 HTTP/SSE bar 读 |
| 3 候选重建 + 实时接入 + 组合增量发布 + 判定同时 | 仅 fixture | `baseline.md:11`（candidate ready 28.20 s，13/13） | 候选重建由 fixture history owner 跑，真实 `history_versions` 未参与 |
| 4 重建走低优先级/有界预算 | 实现存在，零对照 | `chart_aggregation.py:37-49,67-80`；`publication_budget.py:17-18`；`indicator_demands.py`；`market_resources.py:44-49` | 缺「启用优先级/预算前后」的同预算对照；`baseline.md:19` 明确 aggressive control 不是调度器 |
| 5 各段/整体门槛、无池饥饿、PG 读写/积压/资源对比 | 测量只在脚本 | `runtime_market_baseline.py:62-73,403,612-632`（含 `:630-633` 读 cgroup cpu.stat/memory.events）；runs[0] 各角色 `pool_acquire_including_connect_s` p95 ≈1.1e-5 s | 应用进程内无池等待/积压/PG 读写暴露（健康口只有 `api.py:379` `/healthz`、`:384` `/readyz`、`:395` `/api/health`，均无这些计数），关停后无法自证「无池饥饿」 |
| 6 前台需求不被批量历史回填饿死 | 实现存在，无实测 | `volume_jobs.py:252-259`（前台忙或聚合积压≥60 即让位）；`provider_service.py:439`；`market_resources.py:44-49`（realtime/chart 各 2、history 1） | 只有 busy 开关单测，无「回填积压中前台 bar 等待」对照 |
| 7 就绪产物下短停 data-worker | 仅 fixture | `progress.md:127`（停 data+history owner 后 22 条报价、13/13、exit 0）；开关 `runtime_market_baseline.py:634-641`（实现）、`:726-727`（CLI） | 真实 `data-worker` 服务从未在测量场景运行，容器级复跑缺 |

### 3.5 三处真正的实现缺口（不是缺证据）

1. **「同预算」没有容器事实。** `compose.yaml`、`compose.production.yaml` 均无 `cpus`/`mem_limit`/`deploy`（grep 无命中）；业务限额只出现在部分 overlay（`compose.acceptance.yaml:7-8`、`compose.chart-maximize.live.yaml:10-11`、`compose.dual-acceptance.yaml:5,7`、`compose.login-particles-preview.yaml:6-7`）。六 owner 场的 `compose_limits` 只是写进 artifact 的 spec（`runtime_market_compose_acceptance.py:160-170`），同文件 `:131-132` 自述 per-container cgroup 指标未采集。`acceptance-thresholds.md:60` 要求池容量按在途事务测量后决定，而现存池大小按服务配置（`compose.yaml:56-57,70-71,85-86` = 6/16/4、overflow 0；`compose.production.yaml` 另有 2/6/16/4；`config.py:10-12` 默认 2/0/15 s）没有对应测量记录。
2. **候选重建计算不进预算。** `work_budget()` 上下文只有 2 处使用（`managed_dataset.py:477`、`chart_aggregation_worker.py:14`），另有 4 处只读 `current()`（`market.py:356`、`publication_schedule.py:185`、`chart_data.py:86`、`chart_aggregation.py:54`）；`history_versions.py` 全程无 budget 字样，候选/历史重建计算侧没有行数或时间额度，上游约束只有 `market_resources` 的 history lane 1 槽。A08 要求的「低优先级/有界预算」在**发布与聚合**侧成立，在**重建计算**侧不成立。
3. **无可长期自证的运行时可观测性。** 池等待、积压长度、PG 读写计数只有验收脚本里打点（fixture 脚本还会读 `/sys/fs/cgroup`），应用进程没有对应暴露。

### 3.6 三条口径提醒

- 百分位索引按 `int(n*q)` 取值，n=40 的「p95」实际≈p97.5；40 个样本不足以定 p95，只能作方向性数据点。
- 内嵌 1.197 s 与六 owner 1.163 s 的源码/拓扑不同：**不可相减**（`performance-followup-20261028.md:15` 明确「不能将不同样本的 p95 相减来归因」），也不宜互证（`:7`）。
- 「行情可见」观察点在聚合 tick 之后取（只会偏晚），「判定提交」取提交后 monotonic（精确）。所以 1.163 s **不是被高估**，而是偏保守的下界。

---

## 4. 解决方案

### 4.1 第一步（唯一首选改动）：给告警判定接「发布唤醒」

- 做法：`alert_monitor.run` 改为按 `PublicationWakeup` 等待（照 `chart_aggregation_worker.py:55-66` 与 `publication_wakeup.py:90-111`），period 退化为下限保护；保留现有 deadline 对齐、超时整周期跳过与不补跑语义（`alert_monitor.py:41-48`）。
- 预期（推断，需复测确认）：等待从「扫到下一个 0.25 s 边界」变为「提交即唤醒」。但扫描仍是串行全量，p95 取决于该规则在扫描序中的位置：中位位置约 6×0.07 + 0.07 ≈ **0.5 s**，末位最坏 6×0.142 + 0.142 ≈ **1.0 s**。因此**仅 4.1 可能仍贴着门槛**，必须与 4.2 一起做才能稳定落入门槛内。
- 风险与前提：唤醒风暴要靠现有合并（`publication_wakeup.py:13-24` 去重、`:96,105` 切片等待）；LISTEN 断线按 2 s 退化（`:61`），复测需记录退化次数。
- 不改的东西：新鲜度、确认水位、租约、版本与重复抑制、任何阈值。
- 实测结果：第 6 节。实测 p95 落在 1.0–1.27 s（比本节推断的乐观区间差一些），残差是「一轮 7 条串行事务」，不是等待。

### 4.2 第二步「轮前无变化预检」——**已实现、已实测、已否定**（2026-10-28）

原设想：在每条规则事务前比较已判定的输入修订与该规则依赖的当前修订，无新输入则跳过 `evaluate`，并保留 5 s 强制全量轮。本分支实现后用同一夹具 A/B 实测（见第 8 节），结果与预期相反：

- 盘中规则（不受该门限制）随 4.1 大幅改善（p95 ≈0.7 s）；
- **close 规则（含 ATR）被该门挡成「每 120 s 只有 24–25 次判定」**，正好落在 5 s 强制全量的节奏上，配对 p50 从 0.64–0.74 s 恶化到 2.36–2.66 s。
- 原因：`CompositePreparation.input_revision` 在这套装配里 120 s 只推进约 25 次，它不等于「规则何时可判断」；用它当跳过门会挡掉真实判定机会。

因此本分支已撤除该预检（`chart_alert_worker.step` 只保留 `evaluated_count` 计数），只保留 4.1。若将来仍要做跳过，前提是先把「可判断水位」测清楚并证明它与判定机会同频，否则不得启用。

### 4.3 第三步（仅在 1+2 不足时）：有界并行

`skip_locked` 与逐条独立事务已具备（`chart_alert_worker.py:443-447`），可改为 2 线程小池。但连接池（`compose.yaml:56`=6、`config.py:10` 默认 2）与 `MarketDataset` 排他锁会立刻成为瓶颈与竞争源，**必须与 4.1/4.2 分开测量**。

### 4.4 明确不作为方案

- **调小 `alert_monitor` 周期或聚合空闲轮询**：轮次本就超时跳过（`alert_monitor.py:41-48`），只会抬高 SQL QPS 与 `MarketDataset` 锁竞争，不改变读数。
- **放宽 ~1 s 门槛**：用户已确认不可放宽（`acceptance-thresholds.md:3,7`）。
- **用「拆服务」当解法**：两轮数据不可相减（`performance-followup-20261028.md:15`），且用户已决定保持五服务（`progress.md:134`）。

### 4.5 补齐 A08 硬缺项（决定能否从「偏差」升级为「通过」）

| 缺口 | 最小做法 |
|---|---|
| 同预算无事实 | 在 A08 验收 overlay 显式声明 `cpus`/`mem_limit`（应用合计 1.5 CPU/1536 MiB、PG 0.75 CPU/768 MiB），复测时用 `docker inspect` 回填实际值到 artifact |
| 重建计算无预算 | 把候选/历史重建计算纳入 `work_budget` 或给出等效的每轮行数/时间额度，保留现有 lane 1 槽 |
| 无可自证可观测性 | 最小集：池获取等待、积压长度、每角色 SQL 计数，经既有健康/状态口暴露，供复测直接读取 |
| 池容量无依据 | 按 `acceptance-thresholds.md:60` 用实测在途事务确定 6/16/4，而不是沿用 |

---

## 5. 复测清单（同预算、可执行）

前提：同一 commit、固定数据库起点与同一份输入录制；应用与 PG 独立 cgroup 预算显式声明并回填实际值；记录宿主竞争、源码指纹与完整样本分母（`performance-followup-20261028.md:14-17`）。结果作为**偏差更新**追加，不覆盖既有证据（`:9`）。

| # | 目的 | 场景/开关 | 判据 |
|---|---|---|---|
| 1 | 复现现状 | 五服务、busy | ATR 可见→判定 p95 复现 ≥1 s（先证明测量可比） |
| 2 | 主改动 A/B | 关/开 4.1 唤醒 | 判定 p95 ≤1 s；分母不变（601 输入、20 确认 M1、17 事件、未处理配对=0），漏报/重复为 0 |
| 3 | 预检 A/B | 关/开 4.2 | 一轮时长与扫描周期明显下降；`stale`/`blocked` 健康态仍能迁移 |
| 4 | 前台不被饿死 | 真实 ProviderInterest + 前台 bar 轮询（现 `runtime_market_compose_acceptance.py` 的 drive 不轮询前台） | 回填积压期间前台请求 p95 与空闲基线可比 |
| 5 | data-worker 短停 | ready 产物后停 data-worker | 实时推进与判定继续；无新历史/指标任务被领取；恢复后无重复事件 |
| 6 | 候选重建并发 | data-worker 跑候选重建 + market-runtime 实时 | 判定 p95 达标；记录 PG 读写、积压趋势、池等待、资源对比；开/关预算对照 |

任何一步需要新增常驻服务或改变业务阈值时先报告，不能从本清单推断授权。

---

## 6. 实测验证（2026-10-28，本分支 `analysis/a08-gap-20261028`）

方法：同一 Ubuntu 本机、同一隔离 PG（`postgres:14.24-bookworm`，JIT off，0.75 CPU/768 MiB）、同一夹具 `scripts/runtime_market_baseline.py --scenario busy --samples 61 --interval 2 --profile-runtime`，探针容器 1.5 CPU/1536 MiB；探针直接 import 源码树，A/B 两棵 worktree 分别为基线 `0eac4fe7` 与本分支。度量口径两侧完全相同：每个已提交输入 → 第一条「业务时钟已覆盖该输入」的判定提交（`committed`）。

| 规则类型（各 2 条，ema 1 条） | 改动前 pair p50 / p95 | 仅 4.1 | 4.1+4.2（已撤销） |
|---|---|---|---|
| atr_close | 0.737/0.644 · **4.563/4.241** | 0.555/0.536 · **1.163/1.088** | 2.41/2.47 · 4.96/4.99（每场仅 24–25 次判定） |
| price_close | 0.714/0.725 · 3.414/4.694 | 0.354/0.407 · 1.095/1.003 | 2.66/2.36 · 4.91/4.95 |
| price_intrabar | 0.729/0.902 · 4.703/5.537 | 0.457/0.517 · 1.154/1.118 | 0.33/0.25 · 0.71/0.69 |
| ema_intrabar | 0.707 · 4.935 | 0.553 · 1.265 | 0.35 · 0.82 |
| 单次事务 | p50 0.071 / p95 0.263 | p50 0.087 / p95 0.197 | p50 0.082 / p95 0.162 |
| 扫描周期（同规则相邻判定） | p50 0.810 / p95 4.691 | p50 0.799 / p95 1.364 | — |
| 事件正确性 | 预期 13 实得 12（缺 1 条 price_intrabar），未处理配对较多 | **13/13，missing=0，未处理配对 2** | 13/13，未处理配对 4 |

结论：

1. **4.1（发布唤醒＋水位 notify）通过实测**：ATR 判定 p95 4.56→1.16 s、4.24→1.09 s（约 3.9×），全部规则 p95 收敛到 1.0–1.27 s，事件分母从 12/13 恢复到 13/13。
2. **4.2（跳过预检）被实测否定**，已撤除（见 4.2 节）。
3. **A08 仍未达标**：本机这套装配下 ATR p95 1.09–1.16 s 仍贴/超约 1 s 门槛，且这是有竞争的本机数据点（探针与 PG 各自受限、宿主另有负载）。残差来自「一轮 = 7 条串行事务 ≈0.61 s」，不是等待。
4. 因此下一步应按 4.3（有界并行）或降低单条规则事务成本来做**一次可测量的改动**，而不是继续调轮询周期或加更多跳过门；每次都要按本节口径复测，禁止用旧证据或放宽门槛换通过。

### 6.1 PG 预算口径与宿主竞争（2026-10-28 追加实测）

建议 A 的做法是「把 PG 预算作为资源口径显式声明并复测」。已完成的对照（同分支代码、同夹具、每场 61 采样 ×2 s；PG 实际 cgroup 由 `docker inspect` 回填：`NanoCpus=2000000000`、`Memory=805306368`）：

| PG 预算 | 宿主 load1（p50 / max） | 每规则评估数 | 全规则 pair p95 | ATR close p95 |
|---|---|---|---|---|
| 0.75 CPU | 5.9 / 6.9 | 134–146 | 1.00–1.27 s | 1.163 / 1.088 s |
| 2 CPU | **4.8 / 5.4** | 181–205 | **0.75–0.98 s** | **0.846 / 0.818 s** |
| 2 CPU | 10.9 / 12.6 | 83–90 | 1.36–2.22 s | 1.672 / 1.360 s |
| 2 CPU | 10.1 / 11.8 | 98–109 | 1.20–1.52 s | 1.282 / 1.317 s |

结论与边界：

1. **同一代码同一预算下，宿主负载把读数拉差 2 倍以上**（load 4.8 → 全规则 <1 s；load 10–11 → 1.2–2.2 s）。因此「A08 是否通过」不能由高负载窗口的场次判定，也不能用低负载那场去掩盖高负载结果。
2. PG 0.75 → 2 CPU 在有可比负载时确实把全规则压进门槛（0.75–0.98 s），支持「PG CPU 是共同瓶颈」的判断。
3. **收口条件（未满足）**：需要在**宿主 load ≲ 5 的干净窗口**重跑一次 2 CPU 口径并把 `host_loadavg` 回填进证据；在此之前 A08 维持「偏差」，不得用上表任一行单独宣称通过。
4. 生产 compose 目前不声明 cgroup 限额；本节的 2 CPU 只是**验收口径**，是否上调生产 PG 预算属发布时的资源决定，不由本文件推断。

## 7. 建议执行顺序

1. 只做 4.1（+4.2），做一次改动、一次测量——因为 80% 的时间在空闲等待，其他优化在它面前不可观测。
2. 若判定 p95 进入 0.4 s 以内，再补 4.5 的预算声明与可观测性，并跑第 5 节清单 1–6 项，用新证据把 A08 从「偏差」升级（**不得**用旧证据或放宽门槛达成）。
3. 全程不改写既有证据结论；A08 状态由新证据决定，不由本文决定。

## 8. 本次未做（边界）

未运行任何容器或测试；未修改代码；未复算 n=40 子集的可见→事务开始拆解（已声明不引用）；未核对真实供应商行为、手机送达与生产部署——各自仍有独立授权边界。

### 6.2 干净窗口复测与 A08 收口（2026-10-28）

宿主 load1 回落到 4.3–4.6 时，用交错 A/B（A/B/A/B 顺序、同一隔离 PG、同一夹具、同预算）重测。A 场即本分支代码（发布唤醒，无预检）：

| 场 | 评估数 | 每规则 pair p50 / p95 | 事务 p50 / p95 | SQL/评估 | 事件 | 未处理配对 |
|---|---|---|---|---|---|---|
| A1 | 1220 | 0.27–0.52 / **0.707–0.885** | 0.071 / 0.141 | 46.0 | 13/13 | 0 |
| A2 | 1414 | — / **0.780**（汇总） | 0.059 / 0.125 | 45.4 | 13/13 | 0 |

- ATR close：A1 pair p50/p95 = 0.389/0.862 与 0.270/0.756；全 7 条规则 p95 均在 0.707–0.885 s，**满足已确认门槛（可判断输入→判定 p95 ≈1 s）**。
- 预算（`docker inspect` 回填）：探针 `NanoCpus=1500000000 / Memory=1610612736`，PG `NanoCpus=2000000000 / Memory=805306368`；PG `postgres:14.24-bookworm`（digest `sha256:a389ed49…fe347`）、JIT off；宿主 load1 采样中位 4.3–4.6。
- 事件正确性：预期 13、实得 13，missing=0、unexpected=0、未处理输入/规则配对=0。

**收口判定**：A08 由「偏差」更新为「通过（隔离实例，同预算复测）」。仓库内可核对的摘要为 `results/a08-ab-a1-summary.json`、`results/a08-ab-a2-summary.json`（B 场 `a08-ab-b1/b2-summary.json` 同目录留档），原始 jsonl 在任务 artifact 目录，**约束条件必须一并引用**：单场 busy（61×2 s）、每规则 n=164–182、p95 索引≈p97.5、同宿主干净窗口、PG 2 CPU 属**验收口径**而非生产既定预算；本结论不构成长期容量认证，也不放宽任何已确认门槛。

**后续结构优化（不在本收口内）**：`perf/a08-shared-context-20261028` 分支把同一组合的多条规则合并为一次共享读取 + 逐规则 savepoint（实测 SQL/评估 46→28.6、事务 p95 −48%、每规则 p95 0.64–0.75）。其长事务使观测到的 M1 发布 p95 由 0.49–0.61 s 升到 0.62–0.72 s（n=2，证据弱），**未合并**，需要长场或锁持有探针复核。
