# 第三候选：完整性能样本及剩余验收

2026-10-07 18:36 SGT。Ubuntu quant-server，独立project `mw-issue13-optimized-r3c`、PG 127.0.0.1:19673，PG0.75CPU/512MiB、probe0.75CPU/768MiB。冻结61b9fc2的产品与完整回归8e06535逐字节相同，173个product/migration文件已核对。完整后端1371 passed/2 skipped、真实PG相关140 passed，进程崩溃/旧应用接续通过；性能4场景×3×300秒完成并一致性审计通过。

| 场景 | 最长全体就绪等待范围 | M1可见p95范围 | 终态未服务目标 |
| --- | --- | --- | --- |
| idle | 0秒 | — | 0 |
| live | 1.396–1.441秒 | 0.524–0.640秒 | 0 / 21 / 6 |
| backfill | 6.975–7.214秒 | — | 0 / 0 / 0 |
| revision | 0.585–0.853秒 | 0.110–0.174秒 | 0 / 0 / 0 |

三次回填有效新增吞吐2712.81–2725.15 bar/s，绝对≥660.52及旧可比≥80%均满足；全体就绪最长等待≤10秒。先前599b043的回填22.6–28.9秒超限已改善，不以吞吐抵消等待。

空闲CPU约0.275–0.309%单核、SQL1.543–1.544/s，三次可见快照不变、零source/audit读；满足空闲绝对及v1.14相对降幅。小页增加活动SQL（回填约191/s），这是控制等待的代价，需保持吞吐并在API/告警并发下进一步验收，不宣称所有场景SQL下降。CPU计入注入与验证，宿主竞争记录保留，不是生产容量证明。

实时/修订各份30输入全部可见，未发布0。live-2/3窗口末尾有刚进入就绪的未服务目标；最大年龄低于10秒仅提供已知下界，不能据此完整认证尾部。原始分母与右删失记录保留，正在使用额外冻结b8f25ff、同产品源码，逐份补300秒同场景输入+最多30秒停流排空，必须所有目标完成且最大等待≤10秒；补测不能覆盖原失败或删除原证据。

消费者阶段已开始。90目标持续轮转、混合输入、独立高周期oracle、330秒同价与正常输入、120秒TCP、真实浏览器及告警≤1/2秒仍待执行/审核。完整性能套件不代表Issue #13验收完成。

证据：[一致性audit](results/optimized-r3c-baseline/measurement-audit.json)、[源码](results/optimized-r3c-baseline/source.json)、[产品等价](results/optimized-r3c/regression-source-equivalence.json)、[补测冻结](results/optimized-r3c/acceptance-source.json)、[消费者实际源码](results/optimized-r3c/consumer-executed-source.json)、[宿主竞争](results/optimized-r3c-baseline/host.jsonl)。未推送、未生产部署。
