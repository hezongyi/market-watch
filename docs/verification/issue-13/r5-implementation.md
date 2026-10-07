# 第五候选：发布等待与采样成本

2026-10-07 20:00 SGT。依据两份深入专项方案实施，Issue #13仍未收口，未推送、未生产部署。原r3c/r4失败证据保留，不减少输入分母或放宽门槛。

r4完整后端1374 passed/2 skipped，相关119 passed。micro evaluate p95/p99 20.97/27.96ms通过，ASGI82.51/168.71ms通过；同价50输入全可见/判断，保守upper p95 0.9738s、p99 1.0087s通过。正常输入仍310/309/309，缺XAUUSD batch19价格修订；完成集upper p95 0.988s不能覆盖缺失。因此保留r4热态固定origin读取，不调整一秒monitor，单独处理发布容量。

## 当前实现

- 正常/同价验收采样每轮由11条SQL降为2条：十条告警必要字段批量读取，按真实instrument identity索引top1读取最新M1，保留完整payload、marker、freshness和原保守查询区间。50ms间隔不变，新增每轮实际sampler_sql计数，独立audit核查2条；不把后续marker当作原输入成功。
- 只有PublicationResult.runnable_remaining明确为true才将忙态让出20ms降为5ms。单有进展/聚合true保持20ms，idle2s、locked100ms、nextdue和失败退避保留。不采用永久M1优先，不缩小完整桶或取消历史/聚合最小进展。
- 输入持久publication请求及aggregation任务在原事务发PG通知，事务/嵌套事务内去重，回滚不发送；PG在提交后投递。通知只是检查提示，requested/processed世代仍为事实来源。SQLite继续原兜底。
- worker独立监听连接，autocommit注册LISTEN，先注册/清旧提示再检查持久队列；扫描到等待之间到达的通知保持待取。空闲/到期等待可被通知打断；5/20ms短忙态yield不会被自产通知取消。断线关闭并两秒后重连，先注册再扫描，fallback仍原等待；记录listener unavailable/reconnected，不能把fallback称正常唤醒通过。不占用应用连接池，无高频空闲SQL。
- 生产、正常/同价、TCP、mixed及性能探针使用同一PublicationWakeup入口。cycle可选observer记录发布/聚合调用耗时，另记prepare成本、requested/actual wait、wake reason、attempted/selected_target与runnable事实；调用边界不冒充精确目标选择或发布commit。

## 已有验证与限制

小型集成SQLite/pure/sampling32 passed（4.53s）；wakeup纯语义5项在其中，采样3项检查真实十identity内容与2SQL/索引计划。首次运行旧worker测试仍patch sleep而新入口wait导致挂住，定点停止测试后修正拦截入口并重跑，不隐藏初次结果。部分小测试与原r4长测有宿主竞争，不能声称原测试无竞争。

ruff、编译、diff whitespace通过。真实PG新增提交/回滚/savepoint与scan-to-wait/reconnect测试已写，尚未运行；新完整回归及容量、空闲SQL、310输入、告警/TCP/浏览器全部待新冻结运行。新增notify SQL及listener连接成本计入实际结果，不能以设计估算宣布通过。

下一候选只在Ubuntu独立project、网络、volume、数据库和端口运行，并等待原r4驱动停止。新发布路径改变，需要新12×300秒性能套件及同消费者验证，不能复用r3c吞吐/等待作为新代码通过。完整回归/性能/消费者/浏览器串行执行，预计完成时间须按启动和真实结果更新。
