# 行情运行组收敛执行记录

## 当前状态（2026-10-28，优先于下方历史记录）

### 阶段 5 当前切片

基线 `b4bd9d70`（PR #111 合并后的 `origin/main`），worktree `/home/quant/repos/market-watch-runtime-deployment-stage5-dsh-20261028`。本切片只做验收证据收口与切换准备，不改产品代码。

- 新增 [`acceptance-matrix-index.md`](acceptance-matrix-index.md)：A01—A17b 逐项状态、证据路径与缺口。当前 6 项通过、7 项部分、1 项偏差（A08）、7 项未覆盖（A04a/A04b/A13a—A13c/A16/A17b）。
- 新增 [`switch-rollback-runbook.md`](switch-rollback-runbook.md)：切换前留档与配置核对命令（服务图 6 项、后端 Yahoo 全 true、三组依赖 migrate）、preflight 三种退出码、互斥切换顺序、绕过旧迁移的回退命令集与 `init: true` 停止要求、回退后风险核对清单。
- 覆盖索引固定归属：A16 与 A17a 属本阶段必须闭合项；A06/A09/A10/A11/A12 各补一次容器级核对；A08 保持非阻塞偏差，不放宽门槛；轨道 C/D 不并入本阶段。

阶段 5 尚未签收。真实 ntfy/A17b、A08/A09 长稳容量、真实供应商与生产盘点仍待各自授权。

### 阶段 3B / 阶段 4

阶段3B 实现在 `refactor/runtime-notifications-stage3b-20261028`，最新修复 head `bcf77cce`。PR #110 stacked 在阶段3A PR #109 上；PR #109 CI 全绿但仍为 Draft。PR #110 的 `564d326d` CI 曾因通知迁移的 SQLite ALTER 不兼容和重复加列失败；已将迁移改为批量 ALTER 且只补缺少列，本地 SQLite 迁移路径回归 **11 passed**，Ruff 通过。新 head CI 正在排队/运行，按用户指示不等待它开始阶段4。因远端 CI 尚未验证新迁移，阶段3B 目前是实现与本地验收完成、PR 门槛待复验，不记为完整收口。手机 A17b 是独立签收项，不阻塞阶段3B核心交付。

阶段4 worktree/branch：`/home/quant/repos/market-watch-runtime-deployment-stage4-20261028` / `refactor/runtime-deployment-stage4-20261028`，以 `bcf77cce` 为基线。首个切片补齐 API 的 notifications 运行组心跳，并将系统状态页改为展示 market/data/notifications 三组循环状态，移除页面上已退役的旧 worker 心跳展示；旧 API 字段暂留兼容。Draft PR #111 当前以 `main` 为 base（PR #110 已关闭且未合并）。已新增 `deploy/ubuntu/runtime_preflight.py`：宿主侧仅查询明确列出的旧 Compose project，发现旧 API/已知旧调度容器存活时拒绝切换，Docker 查询失败也失败关闭；不读取心跳作为锁，不操作容器。后端 health 定向 **14 passed**，前端 build:ui 成功，运维测试此前为 **109 passed，76 subtests passed**。Ubuntu Docker R1 真实标签/策略演练 **5 passed**，证据见 [`stage-4-preflight-acceptance.md`](stage-4-preflight-acceptance.md)。本轮五服务 Compose/preflight 定向回归 **12 passed，34 subtests passed**；默认/生产五应用服务数量、退役服务、所有生产后端 Yahoo=true、通知组仅依赖 migration 均通过。按用户授权忽略本机 swap/磁盘门槛后，Ubuntu 隔离五服务 project `mw-runtime-stage4-20261028` 已通过启动、PG14/JIT、API 停机期间后台继续运行、API 恢复和 preflight 冲突阻断验收。旧版模拟切换中，旧 API/projector可读 `az53` schema，旧 Alembic 仍不识别该 revision；使用旧版 ORM 在 `az53` 上插入、读取和更新旧字段也成功，新列由默认值保留 `kind=signal,payload={}`，临时行随后删除。首次未启用 init 的停止测试有三个 worker 在 30 秒后退出 **137 (OOMKilled=false)**；legacy fixture 增加 `init: true` 后重跑，五个容器均在 30 秒内停止，docker stop 返回成功，退出码为 **143/0 (OOMKilled=false)**。候选组随后恢复，API/web 健康，preflight 对停止的旧组返回 0。回退路径已验证旧通知表基本读写、旧 worker 停止和候选恢复，但未覆盖所有旧业务写路径；旧 Alembic 命令仍不得运行在 `az53` 数据库上，chart-history 因隔离 fixture 禁用外部供源而 degraded。具体证据和限制见 `stage-4-preflight-acceptance.md`。阶段5联合验收仍待完成。

阶段3B验收记录见 [`stage-3b-notifications-acceptance.md`](stage-3b-notifications-acceptance.md)。阶段4/5联合矩阵、真实 ntfy/A17a 与生产切换准备仍未签收。

阶段5本轮联合核对补记见 [`stage-5-joint-acceptance.md`](stage-5-joint-acceptance.md)：当前 head 下 stage3A PostgreSQL 全集 **153 passed**，stage3B 通知 PostgreSQL 合同 **17 passed**，五服务 synthetic crossing/API-offline/restart、Chromium SSE、阶段4隔离旧版读写与回退分别通过。复跑修正了 stage3A 测试跨分钟导致的时钟不确定性；仅修改测试时钟及合同 wrapper，没有生产代码变化。阶段5仍为分层证据联合核对，不冒称真实供应商、实际部署浏览器和手机通知的单次端到端；A17a/A17b、provider-disabled 下的供源状态和生产部署仍未验收。ATR门槛偏差依用户决定作为独立性能后续，不阻塞本轮核心交付；旧 Alembic 不得运行在 `az53` schema 上。

### 本轮最终证据与下一步

目标仍为五个应用服务，告警留在 market-runtime。**当前只完成 market 迁移切片；data/notification 旧服务仍在，全部五服务装配尚未完成。** 性能超阈值记录为非阻塞验收偏差，独立事项见 `performance-followup-20261028.md`，不再以第六服务实验阻塞开发。

本轮已修复错误恢复事务的旧boot覆盖，以及OANDA确认/旧实时采集/聚合的假恢复。确认角色读取独立持久incident，按identity与epoch限定；报价成功、其他品种成功、退避无工作不会清错。最终主机定向 **72 passed / 19.91秒**；任务PG14.24/JIT off回归 **129 passed / 221.91秒**；Compose/供源/API相关 **43 passed、27 subtests / 15.32秒**。首次PG新增合同因空schema未seed默认品种而失败，已修夹具并保留失败日志；未放宽业务断言。两轴独立review当前未关闭发现均为0，见 `stage-2-review-20261028.md`。

最终源码指纹 `9c77d4dee4c1d3e7082d818d83de084a6ab3b9c37196d4a30d6fd3f91394da6a` 的容器检查 `five_health28b`：API保持停止、无data-worker，market内嵌告警经真实synthetic OANDA socket完成7/7 crossing，所有角色error为空且有有效checked_at；场景26.57秒包含等待分钟，不是SLO。market退出0；fixture supplier因默认停止宽限退出137（非OOM），不作为应用优雅退出证明。源码只读挂载于probe7依赖镜像，未声称该镜像包含最终源码。

此前 `five_recovery28a` 的同内嵌拓扑恢复合同：checkpoint后8.859秒恢复、epoch升至3、7个signal ID不变；聚合卡住14.070秒仅其角色stale，聚合抛错4.091秒记录failed且真实容器exit1/非OOM。该轮早于最终角色健康修复，其恢复/故障证据不追认为最终源码性能数据。

应用验收容器均已停止，任务PG保留健康及历史schema；任务未退役、未删除数据。下一开发切片为阶段3A data profile，通知组与完整五服务/浏览器/回退联合验收继续依阶段推进；不等待阶段2远端CI才开始独立开发。

### 本轮之前的实施与实验记录

阶段 0、1、1A 已经由 PR #106 进入 `main`（`bb02c6e3`，候选 tag `v1.29.2-rc.1`）。阶段 2 在 `refactor/runtime-market-stage2-20261027` 形成独立审查切片，当前实现和本阶段列出的功能合同已完成，PR CI及合并按远端状态另计；阶段 3A SSE 独立切片已提交并创建 Draft PR #107（HEAD `8e7b09e0`），远端CI四项检查均通过，PR仍为Draft。data-worker迁移、阶段3B、4、5与轨道C/D未完成；不因候选tag或独立SSE PR而视为全案交付。

当前已装配 market 与条件化独立 alert profile、boot fencing、告警所需轻量指标与 ATR 依赖推进，并移除 API 持有的 monitor。四场同版同预算合成负载已结束并归档（normal `74c50860`、busy `209bd115`、candidate `33953fc6`、slow-source `c198228e`），每场 EMA 59/59、13/13 事件，所有输入/规则配对完整，无漏报/重复/窗口外事件。它们的源码指纹为 `075de8308f20a003b5c613a26f91aca6b144d1eebc19816abfc92f431b13df8a`，早于本轮所有权/指标职责修复，不能代表最终源码或完整五/六服务验收。摘要为 `results/stage2-comparable-load-prefinal-summary.json`；慢源 ATR 可见→判定 p95 1.769s，部分投影观测 p95 超过2s，尚不能宣布全部 SLO 通过。

2026-10-28 独立 alert 六 owner Compose 忙载复测：project `mw-runtime-stage2-compose-perf-20261028`，独立 PG14.24/JIT off；market-runtime、alert、provider、notification、projection、history 分别为独立容器，应用服务预算合计1.5 CPU/1536MiB，PG为0.75 CPU/768MiB。合成输入601笔、间隔2秒、约20分钟，20个确认M1、7条规则；全部17个预期Signal/Notification/Outbox存在，规则输入配对无遗漏。接收提交→M1发布观测 p95 0.621秒(n=20)，ATR行情可见→判定 p95 **1.163秒(n=40)**，超过约1秒门槛；输入提交→ATR判定 p95 1.530秒。价格写入p95 0.107秒。阶段延迟、owner日志与原始快照为 `results/runtime_compose_busycompose28e*`。运行源码SHA256 `9fb77e76fe1b27f9c4bcdc3a5b281725565c2fa46ee05e60db1847c7939e6f6d`；宿主load约4–9，需视为有竞争的本机数据点。

本轮投递保持关闭，故没有 ntfy/stub accepted 时延；owner 退出时 Compose 默认 10 秒停止宽限导致六个 owner 以137退出，最终 CPU/SQL metrics 行未落盘，内存峰值从 Compose 统计可见但未做时间序列归档。该限制不影响已观测到的超标结论，但不能据此定位到单一 SQL/函数，也不能签收投递或资源余量。用户决定不为本次收口继续独立告警优化轮次；优化作为后续独立事项，原始结果不变。五服务收口继续完成 API 离线、owner 重启与其余部署拓扑矩阵，阶段2仍未签收。

独立 Standards/Spec 复审发现的启动抢锁前覆盖 boot、停止超时提前解锁、指标内部失败上报成功、大范围指标初始化进入实时组四项问题已实施修复。新增合同在原代码明确失败；当前主机 runtime/health/profile/race **32 passed**，完整 PG 回归最新为 **114 passed，178.09秒**，见 `results/stage2-postgres-final.txt`（此前108项记录保留）。指标错误包含租约过期/接管无法写 run.error 的分支，实时组按依赖保留本地错误至实际完成或需求移除，不以下一次空闲循环当作恢复。实时指标领取仅允许已有初始化 checkpoint 后最多八根、已发布水位内的 composite 增量；初始化/长修复由 data-worker 完成。

完整 PG 首轮发现原联合夹具先跳业务时钟60秒、后发布源观察的竞争；仅在夹具内串行化人工跳时钟与完整判定 step，不改变业务新鲜度语义。下一轮因任务 PG 的 tmpfs 累积发生 OOM，cgroup `oom_kill=1`、数据目录约867MiB，造成服务恢复与级联连接错误。数据和失败证据均保留，功能回归时该任务 PG 内存上限调整为1536MiB（原768MiB）；此预算不能冒充原性能对照预算。相关证据为 `results/stage2-fixture-clock-race.txt`、`results/stage2-postgres-tmpfs-oom.txt`、各 review/indicator red/green 日志。没有停止其他任务。

真实容器网络 `stream_c` 已通过：无浏览器、API `/readyz` 200 后完全停止，新输入经真实 OANDA stream 解析/发布、组合增量、EMA/ATR 与判定，七条规则各触发一次；market+alert 重启后9.34秒恢复，epoch及boot更新，信号身份不变。关键聚合循环抛错，进程非零退出；卡住时14.16秒仅该角色 stale，其他循环继续。基础产物预置且未运行 data-worker，因此只证明已准备链路的依赖边界。详见 `stage-2-network-acceptance.md`，rest_batch和嵌入判定模式仍待执行。

真实网络曾暴露 pricing writer 与 judgment 的40P01死锁；修复后完整浏览器查询又复现 history/target 顺序和确认锁升级两类死锁。统一父数据集→LiveState顺序，图表按ID排序共享锁，确认在修改LiveState前取得最终排他锁。六条真实PG竞态合同已绿，双轴独立复审已关闭这些发现；主机相关回归110项、完整PG114项通过。全部红绿日志保留。

标准 `mw-docker` BuildKit 候选 `market-watch-api:runtime-market-stage2-20261027-probe4` 构建成功，digest `sha256:c5588a285edebb23be2bb2b8656e3ef1922d13ea549c2cad5e7341873fd92587`，标为acceptance/dirty。本机node/python保存的是部分多架构索引；使用已完整导出的amd64 manifest、任务专属引用和经标准工具验证的OCI缓存，未改共享基础tag、未绕过TLS、未替换已安装工具。非正式发布候选。

缩短指标空闲检查和网页投影空闲轮询，并修正嵌入模式fixture沿用旧750ms cadence的问题。ATR的 `atr_offset` 只等到通过校验的持久游标覆盖实际前置参考柱，不等待无关pending尾部；版本、输入修订、接缝、来源确认水位及迟到确认保护保留。新增真实PG合同证明pending尾部可用ATR参考立即判定、尾部后续完成不重复信号；晚确认既有合同未放宽。独立Standards/Spec复审无阻塞发现；ATR/固定指标定向回归87 passed。最终同预算四场（1.5CPU/1536MiB应用、0.75CPU/768MiB PG）均13/13信号、零未处理输入/规则配对，normal/busy/candidate/slow-source ATR可判断→判定p95分别为0.666/1.197/0.520/0.809秒。busy超过已确认约1秒门槛，阶段2仍未签收；独立alert预案尚需同预算比较。

REST-Batch+嵌入alert容器功能验收已通过probe7完成。独立project/schema `mw-runtime-stage2-rest-20261027` / `runtime_network_rest_embedded_e` 中，market-runtime使用REST candle sample；7条close-only规则覆盖普通价格、ATR和EMA。初始seed sample过期后按既有语义暂停，实时告警需求保活使OANDA owner可恢复；在owner/candle新鲜后用正式lifecycle restart，再移除临时fixture demand lease。七条规则回到ready，crossing后各有一个Signal、Notification和Outbox；36.18秒场景耗时包含等待分钟收盘，不是单次判定SLO。schema与主要阶段artifact已归档；早期a/b/c/d失败现场保留。启动时fixture supplier尚未监听导致三次catalog连接失败，后续owner重试成功；这不改变crossing验收结果，但启动时间不作为稳态SLO。

REST复测发现并修复 stale 自动暂停后 demand 被清空导致来源无法自愈的闭环：ChartAlert在stale暂停时记录 `runtime.demand_hold=stale_input`，仅该系统暂停且未过期的composite修订继续保留实时输入；用户执行显式pause/drawing删除时清除保活标记，restart清空运行状态。realtime eligibility迁移初值也识别该短期保活状态。SQLite定向合同1 passed，PG market-usage合同8 passed，组合/告警PG相关回归合计36 passed；Ruff与diff check通过。它不承诺失联规则自动触发或补发，恢复后仍需显式restart。

早期“必须新增持久 pending observations 队列”的结论撤回：初次瞬时交叉夹具缺少显式 intrabar、旧 EMA 基线与连续观察时间，不能证明该结论。修正后的测试在只关闭 `fixed_indicators.alert_append` 时已复现 `warming` 且零事件，证据 `results/stage2-transient-ema-ablation-red.txt`；启用短后缀路径时通过。当前实现从同一固定输入修订的可复用 checkpoint 只读计算最多八根增量，然后预览当前真实报价；不发布指标块、不伪造已完成任务，不新增报价归档或从 OHLC 极值推断路径。阶段初始化、长追赶和不可复用修复继续由持久 worker 负责；修订校正/epoch/观察中断仍重建基线。边界测试与完整阶段验收继续推进，以下历史条目不作为当前签收结论。

## 历史执行记录

2026-10-27：开始阶段 0。基线 `v1.29.1 / 78697159067e1c1bc6c38be8ca8218cd12c29179`，origin/main 同提交；正式 tag 是 annotated tag，比较 peeled commit，不把 tag object SHA 当作代码不一致。

已阅读 AGENTS.md、完整方案及第 12 节、前置完成审计。新 worktree/branch 独立；未复用/删除 release 工作树的私有文件。单前端、旧 Watch 退役、共享查询提取只复核。

风险 F1（重要后台链路与恢复）；阶段 0 新增材料/测量脚本不迁移调度、不改业务表模型。后续适用 PG/R2、Standards/Spec review；各阶段独立 PR，合并前停止报告。

本机前置资源：Ubuntu Docker default；已有 mw-issue75-v2-20261018、mw-single-frontend-20261026 两项目，保留。MemAvailable 6.2 GiB、磁盘可用 26 GiB，swap 几乎用满；不能把争用环境当空闲机容量。阶段 0 只新增 PG（0.75 CPU/768 MiB）和按需 probe（1.5 CPU/1536 MiB），独立 project/network/volume/凭据，无宿主端口，无外部网络；不部署第三个完整网页验收栈。后续五/六服务联合实例预算须重新核实。

基线镜像复用已在本机的正式构建：`sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743`，OCI commit 为本基线且 dirty=false；只读使用，不修改正式 tag。任务代码只读挂载，凭据在 checkout 外。

命令（保留数据，不执行 down -v）：

```bash
cd /home/quant/repos/market-watch-runtime-20261026
docker compose --env-file /home/quant/.local/share/market-watch-runtime-20261026/compose.env \
  -p mw-runtime-20261026 -f deploy/ubuntu/runtime-market.baseline.yaml up -d postgres
docker compose --env-file /home/quant/.local/share/market-watch-runtime-20261026/compose.env \
  -p mw-runtime-20261026 -f deploy/ubuntu/runtime-market.baseline.yaml run --rm probe
docker compose --env-file /home/quant/.local/share/market-watch-runtime-20261026/compose.env \
  -p mw-runtime-20261026 -f deploy/ubuntu/runtime-market.baseline.yaml stop
```

用户已于2026-10-27明确接受建议业务门槛，确认记录见 acceptance-thresholds.md。阶段0门槛检查点与基线 CI 已通过 PR #100，阶段0完成。阶段1A 已由 PR #101 验证通过。当前 PR #102 是阶段1边界切片，最终 SHA `2e85bfc5` 的 Backend（3094 passed、3 skipped）、Web、Compose、分类检查全通过；该 PR 通过不代表阶段1的实时开关资格语义或后续阶段完成。不涉及合并 main、正式发布、生产操作、真实 ntfy 投递或永久删除。

合同回归 127 passed；十个任务 PG 套件 150 passed、1 skipped（需要 v1.14.0 源码挂载的旧进程专项，不计通过）。运维检查 97 passed、68 subtests，三个应用依赖项在基线镜像另跑 3 passed；事件分母两项回归包含于运维检查。新脚本 ruff 通过。schema head `ay52_history_modes`。试跑校正与失效证据见 `probe-corrections.md`；正式采样采用连续业务时钟、61×2秒/场，包含四场及同资源快重建对照，测量期间不并跑性能/PG套件。

正式五场采样均已结束。normal、busy、candidate(1s)、slow-source 各13个事件且按窗口 oracle 通过；aggressive candidate(0.05s) 只有12个，末段盘中窗口缺失。前四场仍各有1–2个未处理输入/规则对，完整分母已保留。candidate(1s) 28.20s 就绪。报告、原始 JSONL 压缩副本和只读实例盘点均已生成；candidate 更快但事件缺失，不能作为可接受预算。environment.json 记录其他 Docker 项目同时运行、host load约6–9。业务门槛已接受，阶段1可推进；阶段2仍须按固定门槛验收。

2026-10-27：阶段 1 实时开关切片在独立 worktree `/home/quant/repos/market-watch-runtime-switch-20261027`、分支 `refactor/managed-realtime-switch-20261027` 推进。实现基于阶段 1 边界 Draft PR #102 当前代码 `210083f6`；持久配置复用 Preference，不改 schema。详情及 PG 隔离环境见 `stage-1-realtime-switch.md`。兼容初值为一次性持久快照，显式 off 优先；方案 §3.6 要求有效实时映射和活跃消费者同时存在，旧 `Instrument.enabled` / `ChartHistoryPlan.realtime_enabled` 单独存在不能使纯历史品种迁移开启。资格检查覆盖开关、来源新鲜度、接缝准备、规则周期发布及聚合水位。曾发现并修正 resident OANDA 无条件采集、未准备状态进入告警资格，以及历史 join 错误默认打开。

最终阶段门槛复验：SQLite/隔离 PostgreSQL 跨模块合同 **270 passed**；Compose policy 测试 **4 passed、26 subtests passed**；ruff 与 `git diff --check` 通过。独立 Standards/Spec 复审针对迁移默认、未注册旧品种兼容、managed OANDA lease 和旧 collector 边界完成，无阻塞 findings。PR #103 上一轮 CI 的后端失败定位为 Compose 测试夹具将 `MW_SWITCH_REPO` 解析为 named volume；测试 helper 已修正，本地 Compose policy 测试通过。该修正随后经 PR #106 合入，旧 Draft PR #102/#103 均已关闭；不要据此段落推断当前 PR 状态。

2026-10-27：PR #106 已合入 `main`，merge commit `bb02c6e36c8da013d802bfc95c3651620b264545`，候选 tag `v1.29.2-rc.1` 指向该提交。阶段 1 边界、逐品种实时开关及阶段 1A 监督器代码已在主线；阶段 2–5 尚未完成。阶段 2 实施 worktree 为 `/home/quant/repos/market-watch-runtime-stage2-20261027`，分支 `refactor/runtime-market-stage2-20261027`，起点为上述 merge commit。

阶段 2 当前切片新增固定 market-runtime profile，装配 pricing、realtime、composite_aggregate、chart_alert 四个逻辑循环；实时导入、pricing 和聚合循环接入共享 stop，API 不再由 `provider_service.start()` 启动 ChartAlert monitor。生产 Compose 以 `market-runtime` 替换独立 pricing/realtime/composite-aggregate 服务，并只依赖 migration 完成。专项回归 **60 passed**，Compose 生产服务合同通过，ruff 与 `git diff --check` 通过。阶段 2 仍在实施：尚缺 API 完全停止下的新输入/聚合/判定联合验证、可比并发负载与候选重建争用验收、资源预算核对及完整阶段 PR；本地单测通过不替代这些门槛。没有连接真实行情、生产数据库、ntfy 或生产部署。

2026-10-27 阶段 2 续验：按 review 增加每次 ChartAlert 判定事务的 runtime boot 校验与持锁 fencing；旧 owner 的 monitor 在新 boot 接管后立即退出，新的 claim 会等待已开始的判定事务提交。新增 SQLite fencing 合同及 PostgreSQL 并发 claim 合同。`test_runtime_health.py` + `test_runtime_profiles.py` **16 passed**；隔离 PostgreSQL 阶段合同 **81 passed**；Ruff、Compose contracts 配置解析、`git diff --check` 通过。先前忙碌与候选重建进程已正常结束，但它们是阶段 0 旧 fixture，不构成阶段 2 或 A08 证据。阶段 2 仍未签收：需完成 API 完全停止的新输入→聚合→判定联合链路（A05/A06）、真实 runtime profile 的正常/忙碌/候选重建/慢源可比测量与资源余量（A08/A09）、data-worker 短停依赖边界、owner 重启恢复计时及 A11/A12 证据；阶段 0 sample30 EMA 未处理配对也仍须定位并复测。当前变更尚未提交或开 Draft PR。

阶段 2 再续验：阶段 0 normal 报告定位到 sample30 的 EMA 规则在新 composite input revision 可见后连续 4 轮 `warming`，当时 rule 的固定指标 run 仍 pending，sample31 才恢复 ready；其余规则同窗 ready。方案要求的“判定所需轻量指标推进”此前确实缺少 market-runtime owner。新增 `alert_indicator_worker`：只扫描 active ChartAlert 持久化 runtime 引用的未完成指标 run，每轮最多推进一个既有 fixed-indicator page，沿用现有 lease/优先级/checkpoint/capacity；历史通用准备仍由 data-worker 负责。market-runtime profile 增加 `alert_indicator` 角色，连接池按 5 个 loop + 1 个 ownership connection 设为 6，并在其业务读取前执行 boot fencing。新增 PG EMA 联合合同：规则先完成旧基线；新确认分钟进入固定输入与 M1 聚合后，告警同一轮显示 warming 且 count 不变；指标 loop 完成新修订 EMA 后，原输入可供判定并唯一产生预期 signal。该合同不使用 API/外部供源。复验结果：阶段 2 SQLite/运行组 **67 passed**；隔离 PostgreSQL contracts **82 passed**；Ruff、Compose contracts config 解析、`git diff --check` 通过。

后续 fencing 复核又发现指标 worker 的 claim/build/commit 事务若仅依赖通用指标 lease，旧 boot 仍可能完成持有 lease 的页。已在 fixed-indicator claim 与 commit/error bookkeeping 事务增加 runtime boot fence（纯读 build 阶段不长期锁健康行），新增 PG 合同证明旧 boot 已 claim 指标页后，新 boot 接管会阻止旧 boot 提交页。定向 PG 合同 **2 passed**，并复验 API-independent EMA 链路通过；关键 SQLite runtime/health/profile/race **26 passed**，Ruff 与 diff check 通过。常驻 profile process smoke 曾写出五个 loop/ownership 角色健康状态并按 SIGTERM 记录 stopped，但 bootstrap 默认品种使 realtime loop 发起两次 Binance 连接尝试后即停止；这次 smoke 不能作为无外网/行情链路验收，也不计入 A05/A08。测试专属容器已停止并移除，阶段合同 PG 保留。

补充完成安全的无外网常驻 profile smoke：使用本任务 internal-only Docker network 与独立 `profile_smoke_20261027` schema，先 bootstrap 并将全部品种实时开关显式关闭，OANDA stream 与 delivery 关闭，然后运行当前代码挂载的锁定应用依赖镜像。持续观察六个逻辑角色同一 boot：pricing=`disabled`，realtime/composite_aggregate/alert_indicator/chart_alert/market_ownership=`idle`；realtime 周期约 0.01–0.04s，无外部连接日志。SIGTERM 后六个角色均记录 `stopped`，容器退出并移除，临时 schema 已删除。该证据覆盖常驻 profile 装配、空闲健康及退出，不覆盖有输入时的跨角色并发负载。

阶段 2 仍未签收：尚缺当前 runtime profile 下正常/忙碌/候选重建/慢源的可比 R2 负载和固定 SLO/资源预算证据；本次 PG 联合合同驱动的是真实聚合、指标、判定 worker step，不等同于五服务常驻进程和外部 stream 输入。A06 无浏览器及供应商临时租约停止、data-worker 短停依赖边界、A11 owner 重启恢复计时、A12 全 profile 循环失败/卡住实测亦未齐。阶段 0 EMA 配对由新 loop 覆盖了同类 pending revision 合同，但尚未对原 61×2 秒同负载 fixture 以阶段 2 profile 重跑，因此原报告不改写为通过。当前改动未提交或开 Draft PR。

阶段 2 修正 ChartAlert monitor 周期：阶段 0 R2 normal 的唯一 EMA 未处理对与 revision warmup 结束和 monitor 下一轮间隔有关；将 monitor 固定周期由 750ms 调整为 250ms。最终代码下以独立告警 profile 重跑同一 normal 61×2 秒 fixture，artifact `results/runtime_baseline_normal_ad515eff.json`，owner 日志为同前缀 `.jsonl.gz`。EMA 配对 **59/59**，端到端输入→判定 p95 **0.72s**；其他三类规则配对齐全，13 个预期事件无漏报/重复/窗口外信号，所有 owner 退出码 0。定向 SQLite/runtime 测试 **28 passed**，改动相关 Ruff 通过；完整 PostgreSQL 阶段合同（84 passed）在本 cadence 改动前已通过，瞬时交叉复现专门合同尚待修复后新增。

早期瞬时交叉排查（已纠正）：当时据一份不完整夹具提出持久 pending observations/重放方案；该夹具没有显式 intrabar、旧基线及合理的连续观察时间，不能用来证明盘中漏报或队列必要性。当前有效复现、短后缀修复与剩余验收见本文顶部“当前状态”。保留该更正以免后续实施者按失效结论扩大存储设计。

阶段 2 profile 负载复测：报告器修正为只汇总 artifact 中真实进程的 metrics；profile runtime fixture 的 pool 调为 6，并通过任务专属 `runtime_stage2` 数据库安全门。结果在 `/tmp/runtime-market-stage2-profile-validated/`，所有数据源和实际投递仍关闭，通知只到本地 stub。normal、busy、candidate(1s)、slow-source 四场各 61×2 秒，所有 owner 退出码 0；13 个预期事件窗口均命中、无重复/窗口外事件，notice 与 stub acceptance 完整。但每场均有一个 sample30 EMA provisional 输入/规则对没有 ready judgment（58/59 个 EMA 输入对），不能从 p95 数值样本中隐去。normal 的盘中价格 evaluation p95 1.14s；busy 为 0.84s；candidate 为 1.27s，EMA 1.11s、ATR 输入到 signal p95 4.76s、候选 26.09s ready；slow-source 健康规则盘中价格 p95 1.10s、EMA 1.24s，供应商前台请求 p95 约 3.00s。candidate(2s history cadence) 的 ATR 端到端 p95 3.08s、candidate 38.19s ready；candidate(4s) ATR 4.85s、ready 60.03s。以上 candidate 结果未达到固定 SLO；cadence 控制也未解决遗漏 EMA 配对。runtime pool acquire p95 约 13–15 微秒、无 OOM；隔离 PG 0.75 CPU/768 MiB，采样中 RSS 最高约 754 MiB，宿主 load 约 4–5，资源争用无法完全排除。阶段 0 R1 数据不能替代完整五/六服务 R2；这些结果是当前阶段的风险定位证据，不是通过签收。报告和摘要保留于临时目录，尚未归档进仓库。

按 §2 已授权条件启动独立告警 profile A/B。固定 `alert` profile 以独立 PostgreSQL advisory lock 和 boot-fenced `chart_alert` 心跳运行；market profile 可显式关闭自身 ChartAlert 循环，避免双 owner；生产 Compose 仅在 `independent-alert` profile 下加入第六服务，market 开关默认保持 true。独立 candidate 复测（artifact `runtime_baseline_candidate_596a9cae.json`）：相同 61×2 秒 fixture，13/13 事件、无重复/窗口外事件、0 未处理 input/rule pair；价格 p95 0.76s、EMA p95 1.07s、ATR input→signal p95 2.59s、candidate 23.48s ready；相比五服务 candidate(1s) 的价格 p95 1.27s、EMA 1.11s、ATR p95 4.76s、26.09s ready，端到端 ATR 降低且回到已确认 3 秒门槛内。资源为 runtime CPU 7.35s / 171 MiB RSS、alert CPU 34.18s / 154 MiB RSS；仍需在真实独立 Compose 进程拓扑及完整 API-offline/重启验收中复现，不能单凭 fixture 判整个阶段通过。新增 PG 互斥合同、独立 profile dispatch/market 关闭装配和 Compose 合同测试；provider lease 到期不再轮询也加回归。下一步按该预案验证六服务独立告警、API 离线新输入、data-worker 短停依赖、owner 重启与循环失败。阶段 2 PR 尚未创建。

2026-10-27 阶段 2 短停尾部排查：读取既有 `runtime_baseline_normal_30cf6e95.json` 后发现 sample60 的两个 ATR 规则最终仍为 warming，原因是它们的固定 ATR 指标运行停留在旧 input revision。短停探针最后输入后只等约 4 秒，新增 `--drain-seconds` 以显式计量 owner drain，并在隔离 PG 以 45 秒重测。初次重测仍未就绪，定位到 `composite_alerts.atr_offset()` 在 `chart_results()` 返回后未把 ATR 固定指标 run 状态写入 active Alert runtime，故 `alert_indicator_worker` 只能推进普通 operand 指标，不能推进 ATR 偏移依赖。现已将 ATR run 进度持久化为 `runtime.offset_indicators`，并纳入 market alert-indicator loop 的 bounded pending 扫描；回归覆盖 ATR pending run 被扫描。SQLite runtime 定向 **11 passed**；阶段合同 PostgreSQL 套件 **84 passed**；Ruff 与 `git diff --check` 通过。修复后的 45 秒重测 artifact `runtime_baseline_normal_b84548f7.json` 显示 ATR revision 3 run 已从 pending 推进到 complete，13 个事件/通知均存在且无重复；但停止 history/provider 后探针不再产生新报价，约 15 秒后来源按既有 freshness 规则过期并使两条规则暂停，因此该试验只证明 ATR 指标任务推进，不证明 data-worker 短停时端到端告警持续性。下一步修正短停演练：停止历史/指标准备 owner，持续送入新的 runtime 报价及有效心跳，并以预先就绪的历史基础产物启动；验收输入、聚合、ATR 指标与判定均推进且完整配对无遗漏。

短停复测已按上述边界修正：data/provider 与 history fixture owners 在 sample55 干净退出，runtime 与独立 alert owners 保持运行；其后持续提交 **22 条** synthetic 实时报价/心跳，覆盖 45 秒 drain。artifact `runtime_baseline_normal_cc1b3392.json` 显示 13 个预期 signal/notice/outbox 均有且无重复，实时规则最终 ready，输入 revision 3 均已处理至 3，两条 ATR 依赖 run 均 complete；六个进程退出码均为 0。此项补足“数据准备 owner 短停而已有实时链继续推进”的受控 fixture 证据，但输入通过同一进程内的 fixture writer 直接入库，不是完整 OANDA pricing stream/五六服务 Compose，因此 A07 和 Compose R2 仍待验收。

真实 profile PG 联合合同升级：`test_api_independent_input_aggregate_and_alert_runtime_chain` 不再逐个手动调用 worker step，而是在隔离 PostgreSQL schema 上并发启动真实 `market_runtime.run()` 与 `alert_runtime.run()`，market profile 关闭内嵌判定，通过实际 alert profile 判定；确认初始 ready 后写入新确认 M1/报价，无 API lifespan，等待聚合、固定 EMA 指标和告警 loop 自行推进，最终检查水位追平且只有一个 SignalRow。前两轮失败暴露了测试自身的问题并修正：独立 runtime engine 需要按两个 profile 建池；fixture 业务时钟必须在输入前推进，不能先制造已过期来源。最终单项 **1 passed**。该项仍是进程内线程形式的 PG 联合合同，不等于容器级真实报价输入。

容器级阶段 2 profile smoke 新增 `deploy/ubuntu/runtime-market-stage2.runtime.yaml`：隔离 project/network，使用本地已锁定依赖镜像 `sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743`，把当前 worktree 只读挂入容器；delivery、OANDA、Yahoo 关闭，bootstrap 后四个默认品种均显式关闭实时开关。market + independent-alert 两容器启动后，六个角色分别持续写入同一 market boot 的 `idle/disabled` 心跳；无行情连接日志，realtime cycle 约 40–120ms。SIGTERM 正常停止；重新启动后六角色 boot ID 均已更新并在约 10 秒内回到 idle（≤60 秒门槛），旧 boot 心跳未覆盖新实例。未启动 API 容器，两个运行组直接依赖隔离 PG。结束时两个运行容器已停止，PG 保留。该 smoke 不含有效新输入、所以只覆盖 profile 装配/空闲/退出/恢复，不计 A05 有输入或 R2 负载通过。

容器候选构建尝试按仓库要求使用 `mw-docker build`，本地基础 OCI image 导出两次缺少 layer blob；`--base-source registry` 受 Docker Hub 未知 CA 拒绝。没有绕过标签工具构建新镜像；容器验收复用了本地锁定镜像并只读挂载候选代码。阶段 2 仍缺完整容器级新输入→聚合→指标→判定、candidate/慢源/积压的六服务可比 R2、data-worker 停机容器级依赖边界、pricing owner 实际重启恢复以及关键循环故障/卡住容器验收；不能以本次空闲 smoke 或 PG 联合合同签收阶段。
2026-10-28 收口决定：本次保持方案定义的五个应用服务（web、api、market-runtime、data-worker、notification-worker），ChartAlert 与实时采集/聚合留在 market-runtime，不部署独立告警第六服务。已确认的约1秒判定门槛不变；目前 ATR 可见→判断 p95 1.163s（n=40）记录为超标/验收偏差，不宣称通过。用户确认该性能优化独立跟踪，不阻塞本次其余正确性、恢复、通知和部署收口；未完成的其他合同继续验收，不能由此决定推定通过。性能复测须追加新证据，不覆盖本轮原始结果。

本次服务拓扑已落实到正式 Compose：移除 `chart-alert-runtime` 独立服务和 `independent-alert` profile，market-runtime 默认装配 ChartAlert；独立 alert profile/Compose fixture 仅保留在阶段验收工具中，不属于正式五服务部署。

五服务真实网络功能验收：新建隔离 project `mw-runtime-stage2-five-stream-20261028`，显式启用 market 内嵌告警，未启动独立 alert 容器；API 停止后通过 synthetic OANDA stream fixture 输入 crossing，7/7 规则均产生唯一预期 signal，检查耗时57.02秒，角色心跳/owner及规则状态均 ready。首次就绪轮因启动竞态先连接 supplier 失败并令 seed 输入过期，证据保留为 `five-service-network-ready-failure-20261028.json`；执行合同要求的显式 restart 后规则恢复 ready，再完成 crossing。本项不作为时延SLO或生产供源验收。数据见 `stage-2-network-acceptance.md` 和 `results/five-service-network-*-20261028.json`。运行容器已停止，独立 PG 容器保留且健康，未删除 volume。
