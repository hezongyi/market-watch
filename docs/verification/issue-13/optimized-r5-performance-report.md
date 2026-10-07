# r5完整性能验收及消费者接续

2026-10-07 21:20 SGT。冻结产品ccb2a12，Ubuntu quant-server本机Docker，独立project `mw-issue13-optimized-r5`、PG127.0.0.1:19693。PG0.75CPU/512MiB，probe0.75CPU/768MiB；175个实际backend/root migrations文件与主工作树逐字节一致。v1.14.0祖先关系、真实PG相关178项、完整后端1389项通过/2跳过均已核对。未推送、未生产部署，Issue #13尚未收口。

四场景各300秒、三重复已全部完成，原始JSON/JSONL、SQL及host记录归档到 `results/optimized-r5-baseline/`。独立audit重算最长全体就绪年龄、CPU、事件延迟分位和有效新增吞吐，12份一致性通过；原始末尾未服务目标全部为0，terminal-wait无需补测。完整数值脚本仍等待全部消费者结果，不以本报告代替最终逐项审计。

| 场景 | 三轮结果 | 判定范围 |
| --- | --- | --- |
| 空闲 | CPU均值1.161%、较v1.14下降97.20%；SQL1.543/s、下降97.71% | ≤5%/降≥80%、≤2/s/降≥90%通过；三轮快照稳定，历史/审计读取、publication更新均0 |
| 实时 | 三轮各28准确输入、十身份新分钟与观察，84/84发布；p95 0.418–0.436s、p99 0.431–0.482s | M1 15/30s通过；最长就绪等待0.969–1.237s，无未发布或末尾截尾目标 |
| 回填 | 2717.99–2726.05有效新增bars/s；各对应旧版吞吐比1.87–1.96倍 | 绝对≥660.52及相对≥80%通过；最长就绪等待5.633–5.751s，终态ready为空 |
| 修订 | 三轮各29准确输入、87/87发布；p95 0.128–0.162s、p99 0.165–0.168s | M1 15/30s通过；最长就绪等待0.476–0.571s，无未发布或末尾截尾目标 |

消费者已串行接续。90目标持续轮转首次最长4.417s，持续最长5.413s，每目标至少7轮，缺失0。micro120实际ASGI与120evaluate样本：ASGI p95/p99 48.67/135.91ms，evaluate16.34/29.26ms，均通过各自门槛；告警零staging/audit读取。该微测不等于可见到判断的1/2秒认证，330秒同价与310正常输入、120秒TCP、实际浏览器及最终恢复/覆盖/组合故障仍未完成。

21:25 SGT：300秒实时与两身份大回填混合已完成，20/20准确输入发布，M1 p95/p99 0.480/0.564s、最长就绪等待1.189s，结束时未发布输入与ready目标均空；当前高周期独立oracle进行中，其他待验范围不变。

限制：CPU包含worker、输入及验证；同fixture/配额顺序对照有宿主竞争，host原始观测保留，不是同时受控A/B，也不是生产或供应商SLA。活动回填SQL约192/s，小批次控制等待有查询成本，不能宣称全部场景SQL下降。r5新增监听空闲CPU高于r3c，但原冻结绝对/相对门槛未放宽。UI尚未运行，不把已构建镜像或计划地址称在线交付。

证据：`results/optimized-r5-baseline/measurement-audit.json`、`source.json`、`host.jsonl`，`results/optimized-r5/idle-assessment.json`、`product-source-manifest.json`、`environment-performance.json`、`fairness/result.json`及`consumer-microbaseline.json`。全部最终要求与待验映射见 [收口清单](r5-closeout-checklist.md)。任务服务仅由驱动按明确归属启停，数据卷保留。
