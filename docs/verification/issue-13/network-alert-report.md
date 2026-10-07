# P0 TCP API 与发布告警并发基线

Ubuntu quant-server，独立Compose project `mw-issue13-p0`、PG14 `issue13`；本地`d362766`告警小修复，主线基线`0591e56`。真实Uvicorn、认证路由、序列化、PG、发布循环与每秒真实chart_alert_worker.step并发；120秒测量，十个新分钟。三层核心改造仍等待合并。

运行中实际地址`127.0.0.1:19614`，Ubuntu宿主已检查protected API返回401；120次认证数据请求由同容器TCP客户端发出。探针结束已移除服务，PG由runner停止，地址不保持在线。进程CPU 52.15%（单核），宿主采样忙碌率61.01%；CPU含API、客户端、发布、告警与可见性观察，不直接与纯worker对照。

| 范围 | 样本 | nearest-rank p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| TCP published API：10身份×M1/M30/W1/MN×3 | 120 | 68.97ms | 450.18ms | 524.08ms |
| published M1被观察到→告警step提交被观察到 | 10 | 609.16ms | 1657.03ms | 1657.03ms |

API均返回非空bar（≤500），未检查所有正在变化payload的全量独立正确性。十身份均有价格由阈值下方向上穿越的新完成分钟，十个signal已创建（consume同事务创建本地notification，本次未独立记录通知计数）；至测量结束各count和signal_count仍为1，允许2次触发所以重复会被检测。未启动外部通知投递。

| 身份 | 提交→观察到发布 | 观察到发布→观察到判断 | 判断延迟估计上界 | signal/count |
| --- | --- | --- | --- | --- |
| EURUSD | 31.259s | 1.657s | 1.717s | 1/1 |
| XAUUSD | 18.987s | 0.644s | 0.702s | 1/1 |
| BTCUSDT | 21.425s | 0.661s | 0.719s | 1/1 |
| SYNTH00 | 27.958s | 1.515s | 1.927s | 1/1 |
| SYNTH01 | 28.466s | 0.671s | 0.733s | 1/1 |
| SYNTH02 | 28.932s | 0.089s | 0.431s | 1/1 |
| SYNTH03 | 29.527s | 0.609s | 0.669s | 1/1 |
| SYNTH04 | 30.094s | 0.011s | 0.410s | 1/1 |
| SYNTH05 | 30.215s | 0.471s | 0.532s | 1/1 |
| SYNTH06 | 31.160s | 0.008s | 0.494s | 1/1 |

可见性每50ms查询，判断时间来自step结束后读到count，均为提交后观测时刻。估计上界加入查询起点和50ms轮询间隔，但线程调度/前一轮查询耗时可能增加误差，不是精确提交到提交时延；十样本nearest-rank p95/p99等于最大值。保留全部输入分母，没有隐藏未可见或未判断项。

输入前统一写入/聚合/发布模块按值导入的now_ms；fixture epoch加实际monotonic经过时间，不按事件数推进。实际源received_at和observed_at已保存并断言不晚于消费者时钟，完成分钟已经结束且五秒余量已经过。告警基准和新输入为同一时钟。早期补充mixed的内部received_at wall clock限制不沿用于本探针。

已正确归因的告警查询计数：`{"alert_published_reads": 920, "alert_sql": 5706}`，零staging/审计读。当前API计数仅覆盖AnyIO认证依赖线程（120 SQL），异步路由数据读在Uvicorn线程被归入verification，故本次不能单独证明API零staging/审计或总SQL。先前ASGI微基线另有准确scope证据。后续脚本已修正线程归因，原结果保留不重写；执行版脚本按已知改动逆向还原保存，非运行前捕获哈希，见source-provenance.json；publisher仍有这些读写，告警零读取不代表整体空闲优化达标。

本探针关闭API lifespan：没有provider prewarm、供应商采集、native MCP transport、完整网页/浏览器。它只补实际TCP消费与十个M1触发的短并发窗口，不证明全应用常驻CPU、浏览器预算、持续正常输入SLA、同价盘中新鲜度或高周期触发/防重。网络候选门槛可在此合成范围对照，但完整应用验收仍未完成。

运行：`python3 docs/verification/issue-13/run_network_alert.py`，已有证据拒绝覆盖。PG启动/停止与凭据管理见[README](README.md)，只操作本任务project。原始：[result.json](results/network-alert/result.json)、[宿主采样](results/network-alert-host.jsonl)、[主机地址检查](results/network-alert-host-access.txt)。完整线程逐轮时长、原始API样本、可见payload、源时间与cgroup限流均保留。
