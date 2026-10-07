# 第五候选收口核查清单

2026-10-07；候选ccb2a12。此清单只记录完成所需证据，不代表通过。实际运行状态见 `results/optimized-r5/validation-state.json`，原门槛 `acceptance-thresholds.md` 不变。

| 要求 | 权威证据入口 | 目前判定 |
| --- | --- | --- |
| v1.14.0整合、明确来源/身份、迁移头及旧链路 | `v114-integration.md`、`results/v114-baseline/source.json`、Git祖先关系 | 原整合已验证；最终候选祖先/源码仍需核查 |
| 原始对照与前后同fixture、四场景三重复300s | `results/v114-baseline/`、`results/optimized-r5-baseline/{source,state,measurement-audit}.json` | 新测未结束，不能引用r3c数字作r5通过 |
| 空闲CPU≤5%且降≥80%；SQL≤2/s且降≥90%；快照稳定零历史/审计读 | 新idle-1/2/3原始JSON/JSONL及宿主记录 | 待测 |
| 每身份实时/修订输入内容及观察标记；M1 p95≤15s/p99≤30s；缺失分母 | 新live/revision与mixed原始输入、payload、终态pending | 待测 |
| 全90就绪目标最长等待≤10秒、多轮服务，截尾未服务目标不得漏算 | baseline全ready_ages、fairness轮次、mixed及terminal-wait补测/排空 | 待测；audit独立重算服务轮次/最长年龄 |
| 回填有效吞吐≥660.52bars/s且≥可比旧版80%；等待同时通过 | 新backfill-1/2/3及冻结旧对应样本 | 待测 |
| ASGI100/200ms、evaluate200/350ms；同40非空配置×3热态，零staging读 | 新consumer-microbaseline原始120+120样本 | 待测；r4通过不作新候选认证 |
| 同价330s50准确marker、stale→ready、OHLC/量/修订不变、零signal | 新observation timeline/events/final、独立audit | 待测 |
| 正常330s310准确marker、每类payload相等及判断提交，不能合并缺失 | 新normal timeline/events/alert_commits、独立audit | 待测；r3c/r4缺失证据保留 |
| 可见→判断保守上界p95≤1s/p99≤2s、逐事件独立重建区间/分位 | same-price/normal/network raw query/commit windows及numeric-assessment | 待测；点差不替代上界 |
| TCP120实际认证请求500bar并发，500/1000ms；10输入10唯一signal | 新network result、输入/提交/可见事件及API样本 | 待测 |
| M30/W1/MN四阶段120独立oracle与chart/CSV/MCP/告警一致、重复幂等 | 新high-period源码归档、各phase及快照；audit离线重算 | 待测 |
| 完整后端回归与真实PG并发、generation、失败/锁隔离、历史/聚合推进 | r5 related178、`full-regression-result.json`/私有原日志与冻结SHA | 相关178通过；完整1389通过/2跳过，771.74s |
| 提交前/后崩溃、事务回滚、恢复及保留additive schema旧应用接续 | r5 `{publication-crash,application-rollback}.json` 与 `final-contracts/publication-postcommit.json` | 已安排主验收后串行复核；提交后SIGKILL、丢失历史通知后恢复、重复重启幂等补充探针尚未执行 |
| PG提交后通知，回滚/savepoint不通知、scan→wait竞态、通知丢失/重连兜底 | r5真实wakeup PG与pure tests；新probe wake/prepare/wait事实 | 真实相关通过；容量/空闲成本待测 |
| 覆盖补齐raw/structured等价、whole-minute与旧5s边界、并发追赶、显式verify及回退守卫 | reviewed-contracts、完整PG回归、各源码范围及最终差异 | 旧覆盖证据保留；最终适用性核查待做 |
| 实际UI原生双图、切周期/品种、save/reload、完整API生命周期；≤1.5CPU app+browser | 新browser result/screenshot/live services-runtime/internal network/host samples | 尚未启动，不把build/config当验收 |
| Ubuntu独立project/network/volume/DB/port；实际地址、启停、服务状态和保留资源 | r5 Compose/acceptance-source、Docker白名单inspect及运行交付记录 | PG19693已启动；浏览器19635/19636待真实运行 |
| 全部终态文件SHA与实际执行源码一致；无凭据/私钥/许可库提交 | evidence-manifest、audit_evidence、Git staged/committed资产检查 | 仅已归档文件审计通过，最终文件待归档 |
| 完整逐项审计、已知局限、源码合入与部署分开记录 | 最终候选报告/运行台账/本清单终态映射 | 未完成；未推送、未生产部署 |

浏览器/API离线合成不能证明供应商I/O或生产容量。硬件预算与宿主竞争原始证据保留，不能因最终本机数字通过扩称生产SLA。停止仅本任务明确服务；任务未结束不退役，删除卷前须归档且实际恢复验证。历史失败、截尾与skip不会被新成功覆盖。

最终合同补充由 `run_final_recovery_supplement.py` 等待主验收和现有恢复驱动结束、全部数值门槛通过且本project无运行服务后启动。新探针以独立只读文件挂载，产品仍为冻结ccb2a12；随后用同一冻结产品重新执行62522条白名单覆盖审计/27939条结构化记录重放。旧覆盖核心文件未变化，market源行预算/读取范围及storage迁移有变化，因此使用新真实PG结果证明最终适用性，不将旧重放直接改记r5通过。
