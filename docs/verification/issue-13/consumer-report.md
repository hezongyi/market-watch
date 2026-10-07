# 消费者服务时间微基线

Ubuntu独立 `mw-issue13-p0` PG14，同基线schema、源码带published告警重复读小修复。四场景套件结束后串行执行，没有供应商I/O、通知投递、浏览器或网络API服务。最终测完已停止本任务PG，退出0。

初次近期2000分钟快照的W1/MN为空，60/120告警处于warming；此结果保留为 [consumer-empty-window.json](results/consumer-empty-window.json)，不能证明非空四周期性能。审查后在同fixture显式扩大历史起点并发布M1/M30/W1/MN，重跑120次实际认证ASGI路由和120次evaluate；没有覆盖原证据或把空读算作有效高周期读取。

| 范围 | 样本数 | p50 | p95 | p99 | 最大 |
| --- | --- | --- | --- | --- | --- |
| `/api/charts/data` published（10身份×4周期×3次） | 120 | 24.49ms | 51.33ms | 104.11ms | 203.87ms |
| published告警evaluate热状态 | 120 | 24.95ms | 147.20ms | 168.44ms | 171.34ms |

120次API均返回非空发布bar，payload与同口径read_rows一致。API共480条SQL、120次published读；告警共600条SQL、120次published读；两条消费路径均未读staging或覆盖审计。告警114次ready、6次warming保留完整分母，不将warming当成策略可判断。全部无事件，价格采用常数与远离价格的阈值，因此不证明发生新输入时的触发、防重和通知延迟。

原始数据见 [consumer-microbaseline.json](results/consumer-microbaseline.json)。读取期望来自published read_rows，证明路由使用一致快照，不是独立OHLC正确性oracle。是进程内ASGI认证/路由/序列化+PG服务时间，未启动lifespan的预热/实时/告警线程，不能据此宣称网络API、线程CPU或网页/浏览器并发已经验收。

通过探针内实际session和CSRF进行认证；凭据只在内存和本任务DB，输出仅耗时、身份、周期、bar数和查询计数，不提交token。消费者结束停止自己的PG，合成卷保留复测。运行方式：按README启动PG，`docker compose ... run --rm probe python docs/verification/issue-13/consumer_probe.py`；已有输出必须先归档，结束执行stop。完整命令见[运行手册](README.md)。
