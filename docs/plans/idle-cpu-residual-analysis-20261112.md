# 空闲 CPU 复查与后续优化建议（2026-11-12）

## 范围与基线

本轮修复 PR #134 的 CI 测试契约，并诊断剩余 CPU；以下业务优化尚未实施。用户随后要求停止跟踪 CI，因此不把本地通过表述为 CI 全绿。

- 仓库工作分支：`fix/idle-cost-v2-20261112`；PR head：`fix/composite-idle-20261112`。
- 已部署应用：`f301eb69`，Ubuntu 本机 Docker project `mw-dev`，4 核；地址 `https://192.168.7.232:18443`。本轮测试修复不需要重新部署。
- 实例启停入口：`/home/quant/.local/bin/mw-dev up`、`/home/quant/.local/bin/mw-dev stop`。
- 三条连接为 XAUUSD、EURUSD、GBPUSD 的组合接续来源。旧独立 EURUSD、XAUUSD、BTCUSDT 维护设置已关闭。
- 新采样前停止了本任务隔离测试 PostgreSQL；没有停止其他项目。CPU 基线期间不运行 profiler、测试或构建。
- 保留每条接受报价的 Instrument、LiveState、临时 OHLC 更新，以及所有有效告警输入、顺序、所有权和来源确认语义。

## 新实测

2026-11-12 06:34:27–06:36:27 UTC，120.097 秒；0 浏览器、0 流订阅、0 active 告警、3 connected LiveState。通过 Docker cgroup 累计 CPU 时间差计算，单位为单核百分比，全部相加后除以 4 才是四核整机百分比。

| 服务 | 单核占用 |
|---|---:|
| market-runtime | 6.444% |
| data-worker | 5.117% |
| PostgreSQL | 3.399% |
| notification-worker | 0.872% |
| ntfy（含探针） | 0.860% |
| API（含探针） | 0.372% |
| Web + TLS | 0.003% |
| **合计** | **17.066% = 0.171 核 = 四核整机 4.267%** |

同一窗口数据库增量：7,616 commits（约 63.4/s，包含只读事务，不是每秒 63 次磁盘刷写）；6 个新 CompositeMinuteInput、54 个组合周期产物、30 个通用图表聚合任务入队并消费、263 次 publication-state 更新、464 次 Preference 更新。单看“只有三条行情”不足以解释后台实际执行次数。

另一个独立 60.103 秒窗口（06:41:18–06:42:18 UTC）按 LiveMinute.quote_count 增量记录 231 条接受报价，约 3.84/s：XAUUSD 144、GBPUSD 57、EURUSD 30。这是报价速率的邻近窗口，不能当作前一 CPU 窗口的精确事件数。

## 线程和调用栈证据

先独立采 CPU，再用 py-spy 对三个 Python 服务各采 60 秒、100 Hz、仅 GIL 栈，不读取 locals。用宿主 `/proc/PID/task/TID/status` 的 NSpid 将此前 CPU 线程映射到 profiler 的角色名。下列 CPU 来自无 profiler 的基线；profile 仅用于定位，不能把采样比例直接当作全服务 CPU 比例。

| 线程 | 基线单核 CPU | 调用栈确认的工作 |
|---|---:|---|
| pricing | 3.114% | publish_event、consumers、逐报价状态和观测写入、handover_legacy、dataset/owner 查询 |
| chart_aggregation | 1.824% | 通用 aggregate_once 和 publish_once、覆盖与计划查询 |
| oanda-confirmation | 1.274% | confirmation_window、owner 锁、commit_confirmation、兼容 ingest/aggregate_touched |
| composite_aggregate | 1.199% | claim/build/commit、read_window、CurrentBuckets、状态和唤醒查询 |
| notification_projection | 0.508% | project/backfill/reconcile_channels 的空闲查询 |
| native_history | 0.450% | 每秒 claim/confirmation/空任务查询 |
| chart_history | 0.375% | 计划、导入、补量、pending_work 检查 |
| history_compute + history_network | 0.575% | 无任务轮询、准备和健康记录 |

这些行不是所有线程；数据库 CPU 也不能直接分摊给某一业务线程。

其他明确证据：

1. 通知投影的 anti-join 查询在无新通知时仍逐个检查 2,137 个已处理 notice_source。一次只读 EXPLAIN ANALYZE 返回 0 行，执行 6.755 ms、2,137 次 receipt 索引探测、5,820 个 shared buffer hits。120 秒统计中 receipts 有约 12.8 万次索引扫描。这属于反复核对历史，并不是通知发送。
2. ntfy 主进程仅约 0.058%，容器约 0.860%，差值主要来自短生命周期探针。当前探针每 30 秒启动 Python + urllib。5 次单独测量的子进程 CPU 平均 214.244 ms，折算单核约 0.714%；API 同命令结构平均 54.930 ms，约 0.183%。ntfy 的 CPU 配额会拉长墙钟耗时，不能把等待时间算成 CPU。`python -S` 复测未降低成本。
3. 8 个历史 publication correction jobs 保留，当前 requested=processed、blocked_reason=gap，当前 aggregation queue=0。`publication_schedule.discover` 有每 60 秒把已处理 generation、但仍有 correction job 的目标再次唤醒的路径。必须区分“未运行的历史纠正记录”和“持续积压”；不能通过删记录掩盖历史缺口。
4. 最近两分钟审计以 candle_revision、volume_revision、ingest/confirmation 和 heartbeat 为主，未发现 worker failed/degraded 记录。Profile 显示空闲 provider transport 仍执行连接预热及数据库资源预约；它与实际行情确认不是同一工作。

## 建议的执行顺序

每步独立修改、验证和采样，避免同时改变多个变量后无法归因。以下收益方向有证据，具体节省百分比仍需实施后验证。

### 1. 先消除无消费者的通用聚合/发布与旧任务重扫

文件：`live_pricing.py`、`market.py`、`chart_aggregation.py`、`publication_schedule.py`、相关需求判断。

- 三条组合的原始报价、确认 M1、SourceMinute、CompositeMinuteInput 继续维护；组合周期仍使用自己的聚合链。
- 对仅作为组合接续来源、没有独立图表/告警/导出等消费者的目标，停止派生通用图表高周期与发布请求。先审核各读取入口及恢复方式，不能按 `MD:` 前缀或取消历史计划直接认定为无消费者。
- 通用高周期以真实需求触发并在打开前补齐；不能把过期结果标为 ready。已有独立消费者保留维护语义。
- 对 gap-blocked correction job 按来源内容/覆盖 generation 的变化唤醒；保留记录和显式修复能力，避免 discover 对无新证据的任务反复重新发布。
- 验证：组合确认和输出不变；无通用需求时新增通用任务数应为 0；新建独立需求能补齐；历史修正确实变化后仍可重试发布。

### 2. 精简逐报价事务内的查询，保持逐条持久化

文件：`live_pricing.py`、`price_alert_inputs.py`、`display_observations.py`。

- Profile 中 consumers、一次性 handover 查询、重复身份/日历处理占有明显样本。先复用事务内已读对象、缩小查询返回列，减少重复 SQL/ORM 构造。
- handover 完成标记可在持久化成功后由当前 worker 记住，重启重新读取；只缓存已完成的正结果。
- 无有效价格告警时，避免每条报价构造和联查告警版本。优先使用在同一告警生命周期事务维护的需求信息；任何缓存都必须处理首次创建、修改、启停、过期和重连，保留现有 dataset 锁下注册与下一条观测的竞态保证。不能用未经失效控制的 TTL 跳过告警。
- 每条报价仍独立完成既有状态和临时 OHLC 写入；不合并丢弃中间报价，不把接受结果提前到 commit 前。
- 验证：接受/拒绝序列、OHLC、告警输入和跨价判断与原路径一致；首次告警注册并发、切换和重启用 PostgreSQL 验证；记录每条 SQL 数、CPU/quote、commit P95。

### 3. 让确认和后台服务按到期时间/提交事件执行

文件：`oanda_worker.py`、`live_pricing.py`、`native_history_loads.py`、`history_versions.py`、`provider_service.py`、`provider_transport.py`。

- confirmation_window 现在先锁 owner 再判 next_confirm_at。将多个数据集的到期发现合成一次轻查询，非到期不逐一开事务取锁；真正提交仍重新执行所有权/epoch/有效期检查。5 秒 guardian 和错误处理保持原语义。
- 历史、平台源和导入无任务时等待提交事件，最近重试/定时任务到期前再扫描；保留低频兜底重扫防漏通知，启动时先读持久任务。
- 无需求时不维持多供应商 HTTP 热连接；按最近真实交互需求短期预热。单独验证首次打开图表时延，不能只比较空闲 CPU。
- 验证：到期确认及时执行；丢失 wakeup、未来重试、故障恢复、首次任务和停止均正常；空闲 SQL/事务数下降。

### 4. 通知用可靠待处理集合替代每两秒全历史核对

文件：`notification_center.py`、`notification_center_worker.py`、通知来源写入及迁移文件（如需）。

- 不使用简单的全局最大 Audit.id 游标：并发事务可能按相反顺序提交，跳过迟提交事件。
- 优先在来源提交事务登记待投影身份，投影成功后事务性确认；可重放修复扫描低频执行。Browser intake、回填、通道状态补偿各自保留语义。
- 单独分类为 F1；如需持久表，先做兼容迁移和旧来源补登记，保留 receipt 幂等。
- 验证：反序提交、重复提交、投影中断、回放/保留期、实际通知和恢复事件；空闲主查询的扫描量不再随历史总数增长。

### 5. 用轻量 HTTP 探针减少进程启动成本

文件：`deploy/ubuntu/compose.development.yaml`、镜像内探针入口/`Dockerfile.ntfy`（按最终方案）。

- 优先替换 Python + urllib 探针为成本实测更低的 HTTP 客户端，仍请求原健康接口、检查状态并设置超时。不能用 `true`、PID 存在或 TCP 端口代替服务健康。
- 保留 PostgreSQL 真实版本/JIT 启动门禁；周期探针已使用 pg_isready。仅调整间隔的收益有限，且影响发现故障时间。
- 验证健康/HTTP 失败/超时三个退出码，记录探针 CPU；候选镜像只通过 `mw-docker` 构建。

## 单核 3% 的判断及收口标准

单核 3%=0.03 核=四核整机 0.75%。作为这类个人实例的优化目标合理；当前还有已定位的重复工作，不能把 17.1% 解释为必要成本。不过当前报价线程本身已约 3.1%，因此只调探针或睡眠间隔不足以让全部服务达到目标。3.84 报价/s、逐条持久化、数据库和其他服务都需要计入；尚没有证据承诺最终能到 3%。

下一轮应在每步功能通过后采集三段至少 5 分钟的完整容器 CPU、相同窗口 quote_count、分钟确认数、SQL/事务数和每条报价成本；覆盖至少一个确认分钟边界。保持三个实时来源连接且没有图表/告警消费者，并单独执行有活动告警与打开图表的功能场景。目标改善必须同时满足数据/告警正确性及可接受的交互时延；不以降采样、停接续源或漏写换取 CPU 数字。

## 本轮 CI 修复与证据位置

`ba21e7bd` 已推送至 PR #134。失败来自 ops 测试仍要求开发实例的周期 PostgreSQL healthcheck 执行版本/JIT 深检查。测试现在明确验证开发实例的轻探针，并补充 migrate/app 的版本环境与启动依赖门禁；其他验收配置保留原要求。本地 `tests/ops` 111 passed、93 subtests passed，数据库版本/JIT 门禁相关 13 passed，Ruff 通过。该修复属于 P0 测试契约修正，未修改应用、schema 或部署配置。按用户最新要求，未继续等待或查询 CI 最终状态。

原始 CPU、DB 前后计数、线程映射、只读 EXPLAIN、quote_count 和三份 speedscope 文件保存在 Ubuntu 私有诊断目录 `/home/quant/.local/share/market-watch-dev/updates/idle-v3-analysis-20261112/`，不含 py-spy locals，不提交实例凭据。临时 profiler 容器 `--rm` 已正常退出。
