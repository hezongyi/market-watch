# 第二候选599b043：完整长测与未通过门槛

2026-10-07 17:06 SGT。Ubuntu quant-server 本机独立 Compose project `mw-issue13-optimized-r2`，PG 127.0.0.1:19643，PG14 0.75CPU/512MiB，probe 0.75CPU/768MiB。12×300秒全部完成，一致性audit通过，PG正常停止且无OOM。相关回归88 passed，完整后端1356 passed / 2 skipped / 65 warnings（778.23秒）。这些结果属于599b043，不验证后续r3产品。

| 场景 | CPU均值（单核%） | worker SQL/s均值 | M1可见p95范围 | 最长可运行等待范围 |
| --- | --- | --- | --- | --- |
| idle | 0.263 | 1.046 | — | 0秒 |
| live | 4.768 | 47.117 | 0.324–0.350秒 | 1.389–1.917秒 |
| backfill | 24.415 | 41.412 | — | 22.603–28.924秒 |
| revision | 4.142 | 30.287 | 0.263–0.427秒 | 0.585–0.663秒 |

与第一候选相比，实时忙转已消除，CPU约49.6%降至4.77%、SQL约497/s降至47.1/s；实时/修订每份30个输入全部可见，未发布0。回填吞吐2711.15–2723.28有效bar/s通过绝对660.52及旧可比80%门槛，但三次公平等待均超过10秒，**第二候选不通过整体验收**。旧等待计量尚遗漏终态未服务目标，不能将已有低值用来排除该边界。

三次空闲零source/audit读取、无可见变化，空闲CPU≤5%且对v1.14降≥80%、SQL≤2/s且降≥90%门槛通过。warmup仍为90目标、26,290bar；metadata差异与第一候选报告一致，不称全部相等。

宿主其他任务及本任务小型SQLite验证竞争已在host证据记录。测量CPU含输入与验证，worker SQL另列；不是生产容量测试，也不验证provider成功I/O、告警、网页或外部通知。本候选消费者未启动，原数据完整保留。

证据：[12样本一致性审计](results/optimized-r2-baseline/measurement-audit.json)、[完整结果汇总](results/optimized-r2-baseline/candidate-summary.json)、[冻结源码](results/optimized-r2-baseline/source.json)、[PG停止状态](results/optimized-r2-baseline/postgres-stopped.json)、[宿主](results/optimized-r2-baseline/host.jsonl)。

第三候选实现/边界见 [r3-implementation.md](r3-implementation.md)。第三候选使用独立project `mw-issue13-optimized-r3`、端口19653，已开始真实PG相关回归，随后串行全量、性能、消费者/浏览器；尚未通过。未推送、未部署生产，Issue #13未完成。
