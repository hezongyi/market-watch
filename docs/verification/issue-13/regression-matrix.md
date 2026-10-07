# v1.14.0 后回归验收矩阵

2026-10-07 23:14 SGT 后续：PR #21已提交；退役工具52项ops测试通过，10个本任务项目20个数据库749业务表实际恢复校验后，22容器/10卷/13网络全部退役；其他17容器ID/镜像/状态未变，共享镜像保留。应用175产品/迁移字节仍与r6一致。详见 [资源退役](resource-retirement.md)，未合并主线、未生产部署。

2026-10-07 22:27 SGT 终态：r6 `bcaefcf` 全后端 1389 passed/2 skipped、全部消费者与恢复/回退/覆盖通过，79 数值关卡全通过、missing 空；同价50/50/50与正常310/310/310，告警保守 p95 0.723/0.805秒。产品已整合 `63bad46`，175 产品及迁移文件与冻结源字节相等。Ubuntu 本任务全部服务已停止，保留证据卷；自动退役工具拒绝识别 digest 固定的 PG 镜像，未执行删除，作为基础设施后续记录。未推送、未生产部署。最终要求映射见 [r6收口记录](r6-closeout.md)，以下为历史检查点。

2026-10-07 22:05 SGT 最新：r6 `bcaefcf` 完整后端 1389 passed/2 skipped，自己的数据库初始快照核对、90 目标多轮公平服务、120+120 微测、20/20 混合输入及 120 项高周期 oracle 通过；同价/正常输入/TCP/浏览器/最终恢复仍未完成。r5 发布性能证据明确继承，monitor 消费者重新运行；r5 两项告警 p95 失败原始证据保留。见 [r6 验收报告](optimized-r6-performance-report.md)。以下为历史检查点，不能替代 r6 终态。

2026-10-07 20:40 SGT最新：最终产品冻结ccb2a12，175个backend/实际root migrations文件与当前工作树逐字节一致，v1.14.0 ec00080祖先关系成立。r5相关真实PG178 passed（109.10s）、完整后端1389 passed/2 skipped（771.74s）已通过。首轮idle/live/backfill/revision均结束：idle CPU1.145%、SQL1.544/s；live28输入全可见、p95/p99 0.424/0.431s、最长ready0.969s；backfill2725.72 bars/s、最长ready5.633s、终态ready为空；revision29输入全可见、p95/p99 0.128/0.168s、最长ready0.544s。只证明第一重复，第二轮正在运行；310正常输入、告警/TCP、oracle、浏览器、实际恢复及覆盖最终重放仍未完成，Issue #13不宣布通过。

| r5新增合同 | 当前权威证据 | 判定 |
| --- | --- | --- |
| 全局服务序号在固定/回拨时钟及不同历史服务次数下保持轮转 | frozen scheduler SQLite/真实PG合同，相关178与完整1389 | 回归通过；持续90目标容量尚待实际消费者及组合故障探针 |
| 失败只延后其目标，健康队列使用5ms忙态yield | scheduler失败合同及cadence，相关/完整回归 | 回归通过；同窗90目标/回填/外部锁/重试待最终45秒probe |
| PG通知提交/回滚/savepoint，扫描到等待竞态与重连 | `test_publication_wakeup_postgres.py`、pure wakeup/cadence；相关178 | 真实PG回归通过；完整长测成本及最终丢失通知进程恢复未结束 |
| 监控每轮采样2SQL，完整身份/marker/payload保留 | sampling集成32项中的3项；观察/正常timeline独立audit | 逻辑与索引计划通过；330s最终完整分母及延迟待测 |
| 最终固定origin读取、前驱/缺口/修订及1秒monitor | 完整回归，后续micro/330s/TCP同生产入口 | 回归通过；不得将r4微测/同价成绩记作r5认证 |
| Ubuntu实际隔离、运行源码、CPU/内存限制与只读挂载 | `results/optimized-r5/environment-performance.json`、product-source-manifest、Compose | 真实性能阶段环境已记录；浏览器及最终停止状态待记录 |

最终状态矩阵与必需原始证据映射见 [r5收口清单](r5-closeout-checklist.md)。以下保留历史r3及更早阶段事实，不作为r5通过证据。

2026-10-07 18:41 SGT。Issue #13 未完成。r3最终产品220b328、完整回归8e06535、性能61b9fc2、补测/消费者b8f25ff的173个backend及迁移文件逐字节一致。真实PG相关140 passed、完整后端1371 passed / 2 skipped / 65 warnings（778.54秒）；进程SIGKILL事务回滚/新进程接续与旧131bf3c应用against additive schema后新版本接续通过。12×300秒性能测量与独立审计完成，回填最长等待6.975–7.214秒、吞吐2712.81–2725.15 bars/s；空闲与M1数字门槛通过。实时窗口末尾右删失补测进行中（live-2排空、最长等待1.622秒；live-3待完成），消费者/告警/浏览器尚未全部运行，不宣布完整验收。详见 [r3实现](r3-implementation.md) 和 [第三候选性能报告](optimized-r3-performance-report.md)。

下表保留15:15 SGT阶段的合同证据，表中“待执行”对应当时状态，不把其他候选结果归为r3通过。最新状态以本段、r3报告及各候选validation-state为准。

| 合同 / 场景 | 实际证据 | 当前状态 |
| --- | --- | --- |
| 真正无输入空闲等待、不重算、不写可见快照 | scheduler SQLite/PG、冻结长测 idle-1/2 | CPU约0.26%、SQL1.046/s、零source/audit读，可见稳定；第三次尚未结束 |
| 新分钟及同价观察刷新 | scheduler 触发、H1同价传播、延迟来源stamp、live-1 M1 | 实时M1 p95 0.344s；完整330秒告警及混合消费者新候选仍待执行 |
| 多页尾部追赶、无后续输入 | SQLite与真实PG2430分钟恢复用例 | e529bb1回归通过；599b043未全量验证 |
| 历史页推进、计数/幂等、价格/量修订、unknown量 | managed_dataset、volume、PG managed/composite revisions | e529bb1完整回归通过；backfill-1吞吐2713.73 bars/s但公平等待136.82s失败 |
| 无完整旧目标桶必须等待源输入 | 新SQLite回归、r2冻结 | 两项快速逻辑通过；PG/全量/新性能待执行 |
| 固定观察时钟持续runnable公平轮转 | 新SQLite18目标两轮不重复、r2冻结 | 快速逻辑通过；当前旧候选长测实时/回填公平等待超门槛，不能计验收通过 |
| g+1、品种锁、SKIP LOCKED、事务失败回滚重试 | publication_scheduler_postgres独立事务/线程 | e529bb1回归通过；实际进程kill/restart不由这些事务测试直接证明 |
| 聚合焦点连续输入不饿死历史、SQL单候选 | chart_aggregation SQLite与真实PG | e529bb1通过，固定queue年龄十秒优先；持续90目标/mixed新验收待执行 |
| DST、NY17/UTC0桶界、闭市与unknown | 完整回归中的domain/calendar/history_plan/volume/managed tests | e529bb1通过，pandas_market_calendars可选模块一项skip明确保留；新高周期消费者oracle待执行 |
| 覆盖whole-minute、原received_at五秒余量、异常隔离 | coverage_projection SQLite/PG合同 | e529bb1通过，source/basis不猜测、异常quarantine、raw保留 |
| 并发迟到UUID、双写、兼容读回退 | PG覆盖合同、保存正式白名单raw重放 | 682818d真实PG重放62522audit/27939structured与独立union等价，完成后audit读0 |
| 覆盖分页普通tick禁止全量验证 | SQLite/PG SQL预算回归 | e529bb1通过；显式maintenance --verify才全量核对，真实examined计数，兼容读保留 |
| 显式撤销proof撤回完整性/计数、恢复proof排队重算 | SQLite及真实PG稀疏H1撤销/幂等/恢复 | e529bb1通过；M1来源保留，作用区间审计，published/source同事务撤回 |
| schema升级/回退守卫 | 真实am40→head→pending拒绝downgrade→am40→head | e529bb1完整回归通过 |
| 旧应用回退接续 | 真131bf3c publisher进程→新候选再接续、保留additive schema | 682818d复核通过，独立schema，不同时启动两个版本拥有者 |
| 图表/CSV/MCP/告警消费者一致、告警防重与新鲜度 | 已保留P0报告；优化版scripts冻结 | 新候选高周期oracle、ASGI/TCP、330秒观察、10唯一trigger验收待执行 |
| 实际网页、原生双图、save/reload、完整API lifespan | owned镜像已build、隔离TLS/login/网络Compose已校验 | 优化版尚未运行；不得把build/config当部署或验收 |

完整回归仅证明实际已执行测试范围。第一候选与r2均已完成12×300秒并保留公平等待失败数值；对应PG已停止。最终r3c使用独立project/网络/卷/数据库/port19673串行验证，前序r3/r3b失败证据保留。冻结门槛不变。全部开发/验收在Ubuntu本机，未推送、未生产部署。

历史合并前证据及局限保留在原报告：[合并前收口](premerge-closeout.md)、[PG基线](pg-baseline-report.md)、[高周期oracle](high-period-report.md)、[真实网页P0](browser-report.md)、[持续观察P0](observation-alert-report.md)。这些不能替代优化后候选验收。
