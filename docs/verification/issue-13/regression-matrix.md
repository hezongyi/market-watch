# v1.14.0 后回归验收矩阵

2026-10-07 16:53 SGT。Issue #13 未完成。r2产品冻结599b043完整后端已1356 passed / 2 skipped / 65 warnings（778.23秒），12次长测仍运行；两次回填公平22.794/28.924秒失败，实时两次1.403/1.917秒。新r3产品冻结b2cb5d2已实现两个专项方案，相关SQLite87项、恢复/调度25项及补充合同33项通过（各范围有重叠），PG/全量/性能/消费者尚未运行，详见 [r3实现](r3-implementation.md)。

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

完整回归仅证明实际已执行测试范围。第一候选12×300秒已完成并保留失败数值；r2在独立project/网络/卷/数据库/port19643长测。r3驱动等待r2结束并停止PG后，使用独立project与port19653串行验证；冻结门槛不变。全部开发/验收在Ubuntu本机，未推送、未生产部署。

历史合并前证据及局限保留在原报告：[合并前收口](premerge-closeout.md)、[PG基线](pg-baseline-report.md)、[高周期oracle](high-period-report.md)、[真实网页P0](browser-report.md)、[持续观察P0](observation-alert-report.md)。这些不能替代优化后候选验收。
