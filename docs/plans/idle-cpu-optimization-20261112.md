# Market Watch 空闲 CPU 优化方案

状态：2026-11-12 用户已认可第1、2、4、5项及第3项去重复优化，并要求形成方案后执行。明确排除展示状态降频；按本方案完成实现、开发部署、验收和PR更新，不追踪CI。

## 1. 基线、目标与边界

- 仓库：Market Watch；开发代码 `0e2b2f33`，文档提交 `a301338670cadcd55b20156a219bd1759355ca9f`。
- 当前分支 `fix/composite-idle-20261112`；工作树 `/home/quant/repos/market-watch-composite-idle-20261112`；Draft PR #134。
- 实施工作树：`/home/quant/repos/market-watch-idle-v2-20261112`，分支`fix/idle-cost-v2-20261112`；以a3013386为应用基线。
- 目标实例：Ubuntu quant-server / Docker project `mw-dev`，4 CPU；开发地址 https://192.168.7.232:18443 。生产不在范围内。
- 原始诊断：`/home/quant/.local/share/market-watch-dev/updates/idle-process-breakdown-20261112/diagnosis.md` 及同目录 JSON；前次五分钟证据在 `updates/composite-idle-20261112`。
- 当前三条组合流运行、无浏览器、无活跃告警。五分钟容器合计折合四核8.15%；另一次120秒7.26%。这两次负载随报价和分钟边界变化，不能据此量化优化收益。
- 保留实时流、完成M1来源确认、历史修订、覆盖与休市证据、来源隔离、旧修订读取、告警输入顺序与所有权校验。保留全部历史和旧采集器关闭状态。
- 不给CPU绝对值作事先保证。每阶段实测，有收益且功能通过才保留。初版避免新增schema、消息中间件或持久缓存格式。

## 2. 健康探针：先改，低成本

### 事实

探针子进程20次基准按现有周期换算，约占单核4.64% / 四核1.16个百分点，未含全部PG服务端开销。前端5秒一次Node、ntfy15秒一次Python；PG5秒一次pg_isready+psql，后者还加载JIT provider做能力验证。API15秒一次Python。

### 决策

1. 稳定运行的前端探针5→30秒，ntfy15→30秒，API15→30秒；PG轻量存活检查5→15秒。启动阶段保留快速检查，实施时先核对当前Docker是否支持start_interval；否则由启动验收脚本执行有截止时间的快速检查。
2. 先仅调整频率并测量。按相同探针单次成本估算，子进程成本四核1.16→约0.40个百分点，减少约0.76个百分点；仅为频率换算，不是上线实测，不含去除重复JIT检查的收益。
3. PG周期探针只保留pg_isready；将实际版本/JIT深度检查放在本次启动验收。保留`ALERTS_DATABASE_EXPECTED_VERSION`和`storage.make_engine`新连接版本/JIT门禁，由迁移/应用启动实际执行，错误版本或缺少provider不能启动成功。不能只看镜像标签或沿用上次检查结果。
4. 同步更新`deploy/ubuntu/README.md`关于周期healthcheck的约定。保留固定PG版本、应用新连接门禁和验收证据；不是取消数据库基线校验。
5. 若频率优化后解释器启动仍显著，再把HTTP探针换成镜像内已有的轻量客户端；不足时在可复现镜像中加入固定实现。不在线改运行容器，不增设长期探针服务，不只用TCP连通代替HTTP就绪。
6. API /readyz继续实际验证数据库，ntfy验证HTTP健康结果，前端验证Vite服务资源可读。检查超时建议3秒、连续失败次数明确设置，并记录故障发现时间变化。

### 影响、文件与验收

- 风险F0：改变探针运行频率和故障发现时延。30秒间隔的连续失败判定会比当前慢，不能声称发现速度不变。Docker health状态本身不保证自动重启，不引入假定中的自愈。
- 文件：`deploy/ubuntu/compose.development.yaml`、`compose.development.frontend.yaml`、`deploy/ubuntu/README.md`，必要时已有启动验收脚本及镜像定义。
- 本机检查Compose展开后的healthcheck（使用安全脚本只输出healthcheck子集，禁止输出私有env）。验证启动期就绪、HTTP失败/超时、不匹配PG版本及JIT门禁。故障注入仅限隔离实例，不停止当前mw-dev的真实采集。
- 重复采样比较短命探针CPU、容器CPU、启动耗时与故障发现时延。不为纯间隔常量添加镜像实现的单元测试。

## 3. 组合聚合：最大热点，采用现有增量桶

### 事实

组合聚合线程约单核5.20%。每分钟新输入触发三组合×九周期；`composite_aggregates.build`总是调用不带realtime状态的`read_window`。除了重新读取桶内M1，还会在`aggregate`里逐分钟遍历整个周/月桶计算休市、缺口和冲突，月桶数万次日历判断会反复执行。

仓库已有`composite_realtime.Bucket/CurrentBuckets`，能增量替换分钟、处理极值回撤并缓存日历证据；当前用于共享图表worker，不能直接拿包含临时观察的缓存给确认聚合使用。

### 决策

1. 确认聚合worker持有独立、有界的CurrentBuckets状态，只容纳来源已确认的分钟。复用现有Bucket算法，不与浏览器临时柱共享可变状态。
2. 首次/重启/跨桶时从PG不可变输入重建；随后从`CompositeMinuteInput`读取上次已应用修订之后、当前任务输入修订之前的变化分钟，只替换这些分钟。
3. 缓存身份包括组合修订、周期、桶边界、历史版本checksum、聚合规则、来源/日历口径。规则/来源变化、旧修订回读或live window下界变化时，按现有语义失效或移除过期目标输入。
4. 高低点不能只做max/min追加：旧极值被纠正为更低/更高时，必须支持撤回旧分钟贡献。复用现有可替换桶的机制，保留来源段、volume、覆盖、休市与冲突计数。
5. `CompositeAggregateTask`的租约和应用水位只在PG提交后推进，缓存不替代持久任务。失败后重试较旧input_revision时，不得使用较新修订的缓存结果。旧桶/修订按容量淘汰，避免27个及更多月桶无限留存。
6. 初版保留九周期持续维护，避免通过停止长周期计算改变告警就绪行为。不增加持久缓存表，不提前跳过输入事件和对应修订产物。
7. 先核对现有Bucket是否与权威read_window逐字段等价；不一致先修共享纯逻辑或缩小复用范围，不能为速度悄悄改变现有语义。

### 文件与验收

- 风险F1：核心确认聚合与告警输入。主要文件：`composite_aggregates.py`、`composite_aggregate_worker.py`、`composite_realtime.py`、`composite_inputs.py`；按需要小幅调整`composite_series.py`接口。
- 新增有意义的差分回归：相同输入的增量结果与权威全量结果逐字段一致。覆盖正常追加、旧high/low/volume纠正、缺口补齐、NY17/夏令时/周月边界、拼接点混合来源、live-window过期、旧修订回读、提交失败/租约过期和重启重建。
- PostgreSQL验证不可变输入修订、并发fencing及告警读取。性能验收另记录warm steady-state重建次数、读取M1数量、日历判断次数和线程CPU；普通追加不再每分钟全桶重建，纠正只影响其所在桶。

## 4. 逐条报价持久化：先去重复，暂不合并/丢弃价格事件

### 事实

报价线程约单核2.21%，确认线程1.42%。每条报价处理多个状态和观察表。120秒owner更新442次，另有确认维护每秒renew和守护每5秒renew。没有价格告警时，`price_alert_inputs.append`本来就不写逐条价格日志；不能把这项现有行为重复当新收益。

### 初版决策

1. 保留每条被接受报价的事务提交、实际source_time/received_at、输入sequence、断线标记、临时OHLC和真实告警证据。初版不做250毫秒采样，不用“只保留最后一个报价”降占用。
2. 发布每条报价时仍验证owner token/epoch/有效期，但只有到续约阈值才更新expires。已有有效租约可用于验证，无须每个报价都重写租约。
3. 守护线程继续按既有5秒节拍检查/续约并在失败时阻断发布；去掉确认维护循环中的重复无条件renew，但确认提交本身继续fence。实施前检查实际lease TTL必须覆盖守护节拍、已存在的事务耗时及安全余量；不擅自降低TTL。
4. 一次报价事务内复用dataset/instrument、会话判断和已读取的状态，减少相同对象查询。可先用批量加载/精简投影替代多次ORM取数；跨事务缓存必须包含身份与失效条件，初版尽量不用。
5. **用户明确要求不做展示状态降频。** Instrument.last_received/quality、LiveState以及临时OHLC继续随每条有效报价更新；不合并、延迟或删除展示状态写入。
6. 价格告警消费者判断与告警注册保持同一个dataset锁协议；只在真实写入链中精简查询。禁止用短期“没有告警”负缓存跳过首条新告警输入。
7. 确认检查按已存next_confirm_at调度，先用一次批量读识别到期数据集，再进入各自有锁事务；需保留最迟1秒的关停/故障检查、在途修订与补齐重试。作为独立后续小步，不与续约改动混在一起验收益。

### 后续候选，不纳入首批

只有前三阶段收益不足且测量证明每报价事务仍为热点，才评估有界小批量事务：批内必须按顺序保存全部告警输入、跨分钟切分并保留极值，明确最大提交延迟、崩溃未提交窗口、首条告警注册竞态和所有权交接。不能当成无风险的写入合并；需要单独评审后再决定。

### 文件与验收

- 风险F1。`live_pricing.py`、`oanda_worker.py`、`display_observations.py`、`price_alert_inputs.py`；必要时`composite_quotes.py`和使用Instrument新鲜度的读取者。
- 验证瞬间穿越后回落不会漏告警、同价新时间戳仍刷新新鲜度、跨分钟高低点、重复/乱序、注册首条告警竞态、断线/重连、过期旧owner在新owner启动后无法提交、数据库故障、恢复确认。
- 独立记录owner更新/秒、quote事务/秒、状态更新/秒与报价→提交/告警延迟。报价数量随市场变化，比较每条有效报价的成本，不能只比较总写入数。

## 5. 原第3点：空后台扫描与健康写入

1. 区分真正空队列、未来到期、活跃/工作中、错误重试四类。真正空的历史/平台/图表队列先采用5秒兜底+事务提交通知；有明确next_at时遵守更早的deadline，活跃工作和错误退避保持现有节奏。
2. 审计全部生产者：建/恢复历史任务、补齐、volume任务、订阅/预取策略、创建/修改/恢复告警与告警结算。必须在事务提交时通知；回滚无唤醒，重连先监听再扫队列，丢通知5秒内发现。
3. 当前告警执行monitor听publication，告警配置写入发ALERT_CHANNEL。延长无告警等待之前，必须让monitor同时监听publication与ALERT_CHANNEL。优先同一PG连接LISTEN多个channel，避免为每种信号另建连接，也避免新通知无关唤醒全部平台线程。
4. 只有无active且无expired待结算等真实待办时，告警monitor才可5秒兜底。任何活跃/阻塞告警及未完成结算继续原0.25秒节奏；新建告警提交后立即唤醒。不能仅凭active计数为零延后结算。
5. 关键pricing、告警及ownership健康保持现有5秒报告；低频后台稳定成功/idle记录可30秒报告，错误与恢复立即写。只有状态真实变化才即时报告，避免每个busy/idle瞬态绕过节流。
6. 同步逐角色stale阈值：30秒报告至少90秒超时，原本更长的期限不缩短。不能用独立计时线程替业务循环报“健康”；健康必须来自真实业务循环进展。挂起发现时间变长是明确取舍，核心采集/告警不采用这项取舍。
7. 当前约38角色、两分钟preferences更新877次；健康写入是主要候选，尚无逐key写入次数证据。实施时先分组测量再确认收益，不能把877次全部当作可删写入。

风险F1。主要文件：`chart_history_worker.py`、`native_history_loads.py`、`market_stream_worker.py`、`provider_service.py`、`alert_monitor.py`、`chart_alert_service.py`、`publication_wakeup.py`、`runtime_health.py`、各runtime角色deadline。验证commit/rollback/lost notify、未来任务不变慢、活跃告警0.25秒节奏、过期结算不饿死、idle误报及故障/恢复即时性。

## 6. 原第4点：开发模式

- 当前API statreload父进程约单核1.06%，实际API子进程约0.125%；Vite常驻Node/esbuild合计约0.40%。这些是开发便利性开销，与业务CPU分开记录。
- 用户已认可切换日常使用/验收配置：API关闭--reload；前端使用当前候选已构建静态产物。保留原开发入口和配置用于显式切回源码热重载。
- 静态产物必须由当前候选构建，保留现有原生图表资源装配、同源路由、登录、SSE/MCP代理与回退清单，不能随意复用旧web镜像。
- 不新增自动模式切换器，也不把“关开发模式”的节省计为业务算法优化收益。
- 本次开发部署采用日常使用模式。风险F0，UI/登录/五图及SSE smoke足够，不另做低价值单元测试。

## 7. 实施顺序、命令与验收

用户已授权按以下步骤执行：

1. 从a3013386新建独立worktree/分支，名称如`fix/idle-cost-v2-20261112`。先读取AGENTS.md，确认当前mw-dev没有其他会话部署变更；只读盘点Docker项目、端口、磁盘与内存。保存当前镜像/源码挂载/启动器/配置和healthcheck子集；不打印env和凭据。
2. 实施探针频率/职责调整→完成R1启动/健康失败验证→单独测CPU。完成验证后切换已授权的mw-dev。
3. 实施组合增量聚合→SQLite差分回归→隔离PG兼容/租约/告警验证→F1独立Standards/Spec review。重点是完整结果等价和稳态不全桶重建。
4. 实施空队列通知/健康节流→提交/回滚、丢通知、未来到期/结算回归→独立PG→增量review。随后测量，避免一次同时改四个变量。
5. 实施报价续约去重与事务内去重复查询；保持展示状态逐条更新；确认到期调度单独小步。每个小步测量并验证价格告警与fencing。
6. 全部通过后，以`mw-docker build`/`compose-build`显式标注task、project及候选用途。隔离PG复用本任务volume，不重置/删除其他任务；镜像/配置无schema回退可用。开发部署后检查mw-dev up/status、readyz、角色、六供源、MCP/SSE/ntfy、三组合确认进展和旧采集器不活动。
7. 每阶段先短测定位，最后完成两次至少5分钟的稳态采样：0浏览器/告警+3流，以及一个隔离测试告警活跃场景。不要向真实通知渠道发测试消息。性能采样器、构建和测试PG不与基线CPU样本同跑。记录有效报价数、确认数、分钟边界、各容器/线程CPU、数据库事务/写入、P95报价提交和告警延迟、内存、连接数、冷启动耗时。
8. 对比同类负载，确认有效报价没有丢失、确认水位不落后、旧极值修订正确、告警延迟不恶化、CPU确有下降后再更新PR。按用户既有要求不查询/追踪CI；不合并、不打正式tag、不部署生产。

可复用测试命令（在实施的新worktree执行）：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest -q backend/tests/test_composite_realtime.py backend/tests/test_composite_aggregates.py backend/tests/test_composite_aggregate_wakeup.py
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest -q backend/tests/test_price_alert_inputs.py backend/tests/test_price_alert_execution.py backend/tests/test_price_alert_reliability.py backend/tests/test_runtime_health.py backend/tests/test_publication_wakeup.py backend/tests/test_idle_worker_costs.py
```

PG验收按AGENTS创建/复用专属project、network、volume、私有env和未占用loopback端口；先从现有任务验收材料确认启动方式，不在本计划虚构新脚本。使用该任务test.env进入PG测试上下文后：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest -q backend/tests/test_composite_aggregates_postgres.py backend/tests/test_price_alert_reliability_postgres.py backend/tests/test_publication_wakeup_postgres.py backend/tests/test_idle_wakeup_postgres.py
```

以上是现有回归入口；实施时先为新行为补充前述真实差分/竞态测试，再运行。纯间隔配置不添加镜像实现的测试。

完成条件：各阶段实现/证据可单独审查；两次最终CPU样本和功能验收通过；F1复审无未解决问题；PR已按授权更新。若增量结果与权威结果不一致、出现漏告警、错误新鲜度、跨owner写入或无可靠CPU收益，保留原实现与证据，定位后再继续。不得以CPU下降掩盖处理量减少或后台积压。

## 8. 实施记录（持续补充）

- 探针配置单独部署，启动与容器健康通过；120秒样本包含冷启动和积压追赶，不能作为稳定收益证据。
- 确认聚合接入worker独占的有界`CurrentBuckets`；多桶追赶保留权威全量路径，单桶后续修订增量替换。无schema或持久格式修改。
- 报价只在租约剩余不超过TTL一半时续约；5秒guardian继续续约/fence，删除每秒维护线程的重复续约。逐条Instrument、LiveState及临时OHLC更新保留。
- 成功空闲history与market-stream等待5秒；history未来任务保持1秒，market-stream错误仍1秒，活跃任务原节拍。告警monitor用同一连接监听publication和alert demand，真正无active/待结算才5秒。
- 普通data/notification后台健康成功写入30秒、超时至少90秒；pricing、market角色与ownership维持原策略。错误/恢复及boot fencing保留。
- native-history兼有来源确认职责，尚未证明全部确认任务具有独立唤醒提示，因此保留1秒确认检查，避免把真实确认延后；只应用健康写入去重复。确认到期批量调度及小批报价事务仍作为后续候选，不在本批引入。
- 两轴独立review已完成：Standards无发现；Spec发现market-stream错误退避被误延长，已修复并复核关闭。原测试对暂停/到期告警要求所有订阅为空，与独立启用组合冲突；基线复现后修正预期，组合流继续运行。
- 后续代码将一起构建部署。最终测量只报告组合收益，不据此给单项优化分摊收益。
