# 优化候选682818d：完整长测与失败门槛

2026-10-07。Ubuntu quant-server 独立 mw-issue13-optimized，PG14 0.75CPU/512MiB，probe 0.75CPU/768MiB；4场景×3次×300秒全部完成，原始数据一致性审计通过。PG已正常停止、exit0、OOMKilled=false。测量完整不代表性能验收通过：本候选实时/回填最长可运行等待超10秒，Issue #13未完成。

真正空闲CPU三次均值0.264%单核，对比冻结v1.14基线41.438%降低99.363%；worker SQL 1.046/s，对比67.274/s降低98.445%。三次快照不变，零source/audit读取，无publication更新，空闲门槛通过。

| 场景 | CPU均值（单核%） | SQL/s均值 | 可见p95范围 | 最长可运行等待范围 | 结果 |
| --- | --- | --- | --- | --- | --- |
| idle | 0.264% | 1.046 | — | 0.000–0.000s | 此表指标通过 |
| live | 49.572% | 496.873 | 0.318–0.344s | 11.351–11.436s | 等待超10秒 |
| backfill | 24.229% | 39.705 | — | 126.686–146.551s | 等待超10秒 |
| revision | 4.230% | 30.202 | 0.418–0.439s | 0.630–0.665s | 此表指标通过 |

历史回填吞吐三次2713.73–2717.31有效published bars/s，绝对660.52及对应v1.14至少80%门槛通过；这不抵消136.82/146.55/126.69秒等待失败。实时/修订每次30个M1输入全部可见、未发布0；实时p95约0.34秒但CPU/SQL因重复检查升高。

根因证据：live-1 XAUUSD/M30被选择4648次，旧前缀有M15源记录但不能形成完整目标桶，more仍判作可运行，重复检查不产生历史边界推进。固定fixture时钟下served_at同值排序，使连续可运行目标在同一轮长期优先，回填也呈现单目标连续页占用。修复冻结599b043增加实际历史边界推进判断与同毫秒served_at单调轮次；两项SQLite逻辑用例通过，PG/完整/新长测正串行执行。

本次源负载、配额和90目标/26290初始published bars与冻结v1.14一致；start/end/count相同，但新候选已排空初始化请求，EURUSD/XAUUSD M30 initialized true/revision2，旧基线false/revision1，不能宣称全部元数据相同。宿主其他任务和本任务0.90秒小逻辑测试竞争已记录，不称无竞争或生产测量；CPU进程口径含输入与验证，worker SQL单列。未进行新消费者、浏览器或生产部署。

证据：[12份审计](results/optimized-baseline/measurement-audit.json)、[源冻结](results/optimized-baseline/source.json)、[宿主](results/optimized-baseline/host.jsonl)、[初始化对照](results/optimized/warmup-comparison.json)。原始JSON/JSONL/SQL全部保留，失败候选不覆盖。
