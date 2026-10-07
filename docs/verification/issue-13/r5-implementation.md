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

20:02 SGT实际运行：冻结ccb2a12，源码 `/home/quant/repos/market-watch-issue13-r5-acceptance`，driver `/tmp/mw-issue13-r5-driver.py`、PID1126319。Ubuntu独立project `mw-issue13-optimized-r5`、PG127.0.0.1:19693、Compose `optimized-r5.compose.yaml`，PG0.75CPU/512MiB、probe0.75CPU/768MiB；状态 `results/optimized-r5/validation-state.json`。完整验证预计22:00–22:30 SGT，以实测通过为前提。浏览器https://192.168.7.232:19635及chart :19636尚未启动，不能当作在线交付。

启动/停止（在主工作树执行；测量中由driver独占管理，勿手工停止）：

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized-r5.env -p mw-issue13-optimized-r5 -f docs/verification/issue-13/optimized-r5.compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized-r5.env -p mw-issue13-optimized-r5 -f docs/verification/issue-13/optimized-r5.compose.yaml stop postgres'
```

私有env/TLS/login不进仓库。停止保留本任务volume和失败证据，不删除其他实例、不全局清理、不在unraid开发验收。

20:04 SGT：冻结第五候选相关回归178 passed/20 warnings（109.10秒、exit0），包含真实PG事务提交/回滚/savepoint通知及扫描后提交、等待/重连用例。完整后端回归已开始，其后12次性能/消费者/浏览器尚未执行，不当作已通过。结果见 `results/optimized-r5/related-regression-result.json`。

20:17 SGT：第五候选完整后端1389 passed/2 skipped/65 warnings（771.74秒、exit0），结果 `results/optimized-r5/full-regression-result.json`，175个实际产品及root migrations文件的冻结源码见 `product-source-manifest.json`。驱动已于20:16:18 SGT进入新12×300秒性能套件，终态未产生，不将启动称通过。最终收口核查表见 [r5-closeout-checklist.md](r5-closeout-checklist.md)，性能/消费者/浏览器/最终恢复适用性仍未完成。
