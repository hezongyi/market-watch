# P0 独立高周期计算与消费者一致性

2026-10-07在Ubuntu quant-server隔离Compose project `mw-issue13-p0`、PG14数据库`issue13`实际执行。基线main `0591e56`，保留本地published告警取数小修复；未改发布、聚合、覆盖或产品接口。仅启动自己的PG和一个0.75CPU/768MiB probe，PG0.75CPU/512MiB，没有供应商连接、API/provider lifespan、浏览器或通知。

十个固定合成身份，M30/W1/MN共30个目标；EURUSD/XAUUSD为NY17，其余UTC0。明确扩大原fixture历史起点，每个目标两次真实有界publish_frame覆盖完整候选集合；M30按2000bar分页读取，没有裁掉第二页。

| 阶段 | 独立目标 | 全量bar | API/CSV/MCP各自页数 |
| --- | --- | --- | --- |
| initial | 30 | 20,014 | 38 |
| revised | 30 | 20,014 | 38 |
| observation | 30 | 20,014 | 38 |
| duplicate | 30 | 20,014 | 38 |

共120个独立计算案例；真实认证ASGI图表data、CSV export、官方MCP SDK tools/call各152个请求，全部分页payload一致；告警stored_rows读取120次，与相同计算结果一致。MCP经过协议解析、Bearer、数据库授权和quota，验收进程quota设600/minute；不把ASGI调用计作TCP或MCP部署验收。CSV精确核对起止时间、OHLC、量、complete、volume_complete和revision，图表/MCP/告警另外核对observed_at。

预期来自独立high_period_oracle.py：只读归档的M15/D1输入，按明确NY17/UTC0桶边界算首open、末close、最高high、最低low、Decimal总量、complete、量完整性、最大revision与观察时间，不调用产品calendar/aggregation/read_rows/candle_dict。源M15/D1是输入，不证明M1→M15/D1生成正确；八九月无DST切换，也没有节假日覆盖改写。

修订通过真实write_bars提交：M15连续首/末成员和D1跨周/月边界日期；变化的源持久字段均与显式输入核对。SYNTH00改为未知volume，SYNTH01改为volume_complete=false；未知值不被补成零。随后同价新观察仅推进观察时间，源价格/量revision保持不变；重复同观察输入后，包含bar payload、bar行revision和可见publication边界/count/revision/initialized的全目标指纹保持一致。updated_at不在该可见指纹中，不能从幂等断言推断零写入。

| 修订实际改变的payload字段 | bar数 |
| --- | --- |
| close | 26 |
| high | 56 |
| low | 56 |
| observed_at | 56 |
| open | 36 |
| revision | 56 |
| volume | 46 |
| volume_complete | 10 |

离线审核重新计算四阶段全部预期，核对各目标equality哈希；最终PG实际20,014行高周期快照在另一个只读probe归档，并与末阶段SHA相等。审核对副本逐项破坏end/OHLC/volume/complete/volume_complete/revision/observed_at、删除bar、错误complete_count，12种均被拒绝；不改数据库来伪造负例。前面阶段的实际payload只保留执行断言与equality哈希，消费者响应也未保存完整逐份字节；原始源输入与最终实际快照完整可离线复核。

首次四阶段计算通过，但离线变化覆盖审核发现aggregate open未被输入改变；该次全部结果、最终PG快照、执行源码和scope-note保存到results/high-period-initial-no-open-change，不能算作开盘价修订回归。补首根/末根和日历边界输入后才产生当前结果，没有覆写早期成绩或修改产品。

运行：`python3 -u docs/verification/issue-13/run_high_period.py`。它要求本任务无运行服务，拒绝覆盖已有证据，finally定向停止自己的probe/PG；重跑须先明确归档旧目录。末阶段快照保存：启动自己的PG后运行同Compose probe的`capture_high_period_final.py`，该脚本只读且要求数据库SHA与完成结果相同，结束停止PG。独立审核：`python3 docs/verification/issue-13/audit_high_period.py`；报告：`python3 docs/verification/issue-13/summarize_high_period.py`。

实际PG地址Ubuntu `127.0.0.1:19613`，当前已停止，probe已移除；没有新增网页或MCP网络地址。单独PG启停命令见[README](README.md)。私有env/凭据不提交，MCP/session临时凭据在进程内创建且结束删除，原始证据没有token/hash/CSRF。

证据：[完整结果与执行源码SHA](results/high-period/result.json)、[最终实际PG快照](results/high-period/final-snapshots.json.gz)、[离线审核](results/high-period/artifact-audit.json)、[原始宿主](results/high-period/host.jsonl)、[首次范围缺口](results/high-period-initial-no-open-change/scope-note.json)、[独立计算器](high_period_oracle.py)。四阶段源输入为results/high-period/*-sources.json.gz，固定gzip mtime=0。

P0补测通过不等于核心优化验收：仍需M1生成链、DST/节假日、覆盖撤回、并发g+1、防丢/故障恢复、持续新鲜度与告警触发、迁移/回退和可比重复容量。P1–P3继续等待三层合并，Issue #13未完成。
