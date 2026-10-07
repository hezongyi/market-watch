# P0 持续同价观察与盘中告警新鲜度

Ubuntu quant-server独立project `mw-issue13-p0`、PG14数据库`issue13`；main行情基线0591e56与本地published告警取数小修复，产品发布/聚合/覆盖逻辑未改。一个0.75CPU/768MiB探针，PG0.75CPU/512MiB。真实aggregate_once/publish_once、每次step结束后等1秒的真实告警循环、200ms目标间隔的PG状态观察并发；没有provider/API lifespan、网络服务、浏览器或通知投递。

实测330.00秒、1187份逐轮状态、859次发布轮转、244次告警step。十个身份均是合成输入，NY17和UTC0在本时段正常开市；不称为十真实供应商SLA。每个身份使用同一最新完成M1，只刷新观察时间，没有增加新分钟。

源和消费者时钟统一为fixture epoch加实际monotonic经过时间，写入前无事件数跳变或未来观察。10/55/100秒各批十输入后暂停，超过120秒观察年龄；235/280秒恢复两批。每次真实write_bars断言零价格/量变化集合、源price/volume revision不变，发布的非observed_at payload逐次采样保持原值。

| 范围 | 全部输入 | 完成 | nearest-rank p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- |
| 提交返回→准确观察到该published标记 | 50 | 50 | 16.902s | 36.234s | 40.406s |
| 准确观察到published→准确观察到告警sequence | 50 | 50 | 0.680s | 1.840s | 2.400s |

缺少准确published标记0、缺少准确告警sequence 0，没有把更新的标记替代成旧输入的成功；统计只对完成样本求分位数且保留全部分母。每个身份末次source观察、published observed_at和告警sequence均相同；十个告警最终ready/active、count及独立signal_count均为0。该条件没有跨阈值，零signal不证明复杂触发/通知防重。

候选门槛对照：本样本M1同价观察提交→可见p95/p99=36.234/40.406秒，超过冻结15/30秒；可见→告警判断的观测p95/p99=1.840/2.400秒，超过1/2秒。采样有时序不确定性，不能精确认证提交到提交SLA；功能生命周期通过不代表延迟门槛通过，不以本结果调整目标。

| 身份 | 首次stale | 当时观察年龄 | 恢复ready | 最终最新标记 |
| --- | --- | --- | --- | --- |
| BTCUSDT | 221.370s | 121.307s | 249.239s | 一致 |
| EURUSD | 221.370s | 121.369s | 252.974s | 一致 |
| SYNTH00 | 221.370s | 121.290s | 256.539s | 一致 |
| SYNTH01 | 221.370s | 121.275s | 258.938s | 一致 |
| SYNTH02 | 221.370s | 121.258s | 261.545s | 一致 |
| SYNTH03 | 221.370s | 121.239s | 264.210s | 一致 |
| SYNTH04 | 221.370s | 121.224s | 266.521s | 一致 |
| SYNTH05 | 221.370s | 121.202s | 237.536s | 一致 |
| SYNTH06 | 221.370s | 121.183s | 240.093s | 一致 |
| XAUUSD | 221.370s | 121.328s | 243.928s | 一致 |

进程CPU（含输入/发布/告警/观察）均值41.45%单核；cgroup限流/内存和宿主竞争保留在原始文件。告警路径零staging/审计读取，publisher仍有这些读取；这不是空闲worker CPU或SQL优化验收，不能与纯worker基线直接比较。

采样是同一read-committed事务中顺序读取published和告警，事件提交也记录begin/return窗口。线程调度、池等待、采样查询耗时与告警事务提交后观察增加不确定性；观察到判断先于观察到发布的差值有0份，不把它解释为违反因果，也不改成零来美化分位数。这些是采样估计，不能当严格提交到提交SLA或估计上界。

新鲜度审核逐份检查全部timeline、50个准确marker、十条stale→ready、源修订/固定payload、末次marker与signal分母，并核对执行源码SHA。停输入后120秒以上正常进入stale，恢复同价观察通过真实发布后重新ready；不以手工改告警health或直接consume代替调用链。

执行：`python3 -u docs/verification/issue-13/run_observation_alert.py`；离线审核：`python3 docs/verification/issue-13/audit_observation_alert.py`；报告：`python3 docs/verification/issue-13/summarize_observation_alert.py`。已有证据拒绝覆盖，重跑必须先明确归档；runner仅在本任务无运行服务时reset自己的fixture，结束或异常定向停止自己的probe和PG。

实际PG地址Ubuntu `127.0.0.1:19613`，当前已停止exit0/OOM=false，probe已移除，没有新增网页/API/MCP地址。PG单独启停与私有env见[README](README.md)。原始：[结果/执行源码SHA](results/observation-alert/result.json)、[全部状态timeline](results/observation-alert/timeline.jsonl)、[离线审核](results/observation-alert/artifact-audit.json)、[宿主](results/observation-alert/host.jsonl)、[停止状态](results/observation-alert/postgres-stopped.json)。

冻结门槛不因本结果调整；此330秒单样本补观察新鲜度，不证明成功供应商I/O、新分钟/高周期触发、完整网页容量、三重复可比基线、并发世代/故障恢复、迁移/回退或核心性能达标。P1–P3仍等待三层合并，Issue #13未完成。
