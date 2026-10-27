# 阶段 0：测量校正与证据边界

早期试跑留在仓库外私有目录 `/home/quant/.local/share/market-watch-runtime-20261026/pilots/`，保留原文件，不将其计为通过。正式报告只引用当前 results 中完成且核对过的 artifact。

1. 业务时钟曾每两秒推进一分钟，制造超过 15 秒的报价断层。已改为墙钟速率、两秒报价、实际分钟边界确认 M1；不能用加速行情结果推断真实时延。
2. 复用 test helper 的默认 observed_at 晚于本 fixture 时钟，ATR 会一直等待未来确认。seed 只将该测试适配器的确认时间改为实际最后柱末端。补齐 forming/display observation、九周期准备及规则就绪后才测量。
3. worker 的非零退出必须使采样失败；最终状态在 stop/join 成功后读取，避免尾部提交在 JSONL 中存在而 final 快照缺失。分别记录最后输入、全部 worker 停止时间；收尾排空的事件仍进入最终完整性分母，延迟照常计时，不隐去尾部耗时。
4. 第一轮墙钟 candidate 的 92 次准备观察全部为 `invalid_payload`。独立读取原始 JSONL 的断言已复现失败：`AssertionError: candidate preparation is blocked by invalid payload`。来源格式核对发现 probe HistoryAdapter 使用 Dukascopy 的 quantity/source_quantity，OANDA 要求 price_count/quotes。修正为使用既有 `source_registry.capabilities` 并返回整数计数量；同一适配器检查输出 `dukascopy quantity source_quantity 2 PASS`、`oanda price_count quotes 2 PASS`。完整 candidate 必须另证实历史、九周期及非空 EMA warmup 实际完成，不能仅以进程正常结束代替。
5. 报告以每条规则、每个预定交叉窗口独立核对事件，避免一条规则或后段多发抵消另一条/前段漏发。`tests/ops/test_runtime_market_report.py` 的分母回归已通过。close/ATR 以相同确认序列匹配，允许计算跨后续报价采样轮；盘中报价若被后续覆盖且没有处理，则保留未处理分母，不能凭最终 ready 消除。
6. 快方案曾只产生 12/13 个预期信号；缺失前存在一次 stale。原探针在数据库更新报价/heartbeat 后才推进共享测试时钟，制造最长一个采样周期的未来输入窗口。对原 schema 只读检查证实 `now=received_at−1` 时 `owned=False`，`now=received_at` 时 `owned=True`；原先附带要求 sample_ready=True 的探测断言未满足，故只以实际 owned 观察和年龄边界作为证据，不声称所有可用性条件都已满足。改为主进程与判定进程从同一个 monotonic origin 独立计算连续业务时钟；源时间仍取实际发出输入时刻，读取不倒回上一采样时间。没有放宽生产 future 输入保护。旧五场结果留在 sampled-clock-race 私有子目录，正式同负载重测；该轮漏信号不能直接归因于重建性能。

Compose 自测发现短语法挂载会被 CI 的 fixture 变量解释为未声明命名卷，且初版 PG 探活只检查在线。已改显式 bind，沿用仓库 PG14.24/JIT 可用探活与应用 expected-version140024。运维检查拆分：本机执行 Docker Compose 等不需要应用依赖的 97 项（68 subtests），缺少本机应用依赖的 DatasetTests 三项在固定基线镜像执行并通过；后续 CI 在安装锁定依赖的 runner 跑完整 tests/ops。不能将最初环境依赖失败隐藏为产品通过，也不为验收改变宿主 Python 全局环境。

输入事务提交后的观察时间还包含一次修订回读，故真实 commit 位于 `[issued, committed observer]` 区间内。报告保留该区间，匹配 sequence 时允许判断发生在 commit observer 之前；内部延迟主表使用 issued 起算的保守上界，另保留从 commit observer 起算的下界值（可能略负，表示观察滞后）。M1 发布也用 issued 起算上界；不把观测误差钳成零或当成漏处理。新增“首判早于提交观察点仍保留”的回归；三项报告回归均通过。正式当前 normal 原始日志只读扫描未发现早于提交观察点的有效首判，但报告必须覆盖这一可能竞争，不依赖本轮恰未触发。

连续时钟试跑的按窗口 oracle 又发现一规则在中段多触发一次、提前完成，末段缺失；按类别总数会漏掉这个问题。根因是并发使用 `test_composite_alerts.forming`：先调用 live 提交默认 1.11，再另事务提交 1.119，读者可能在同一 source_time 看见两种价格。`backend/tests/test_runtime_market_baseline.py` 以独立 Session 在每次 commit 后观察真实状态，旧 helper 明确 red（读到 `('1.11', None)` 再读 `('1.119','1.119')`），新 sample_quote 单事务更新 QuoteEvent、owner freshness、LiveState 与既有 display_observations.accept，green 为 1 passed。该修改只模拟真实来源的一次完整输入，不更改判定逻辑或 age 门槛。已停止当时 task-owned probe（exit137，不计通过），保留 two-phase-source-helper 证据；PG 与其他项目未停止。后续所有正式场景使用同一修正后的 sampler 重测。

事件延迟关联 input → SignalRow → NoticeEvent / Notification → MockTransport 接受，不输出确认令牌或通知正文。投影时刻是提交后的观察点，不是精确 SQL commit；同机 monotonic 可以相减，fixture 业务时间与 monotonic 不可混减。pool acquire 包含建连成本，SQL reads/writes 是语句分类，WITH 归 read 不等同磁盘 I/O；PG 全库计数另外记录，且本任务应用和回归库不同。

这些改动只修正测量工具，不修改 v1.29.1 的生产算法、任务装配、schema 或资源配置。没有真实供源/ntfy 网络请求，没有访问生产。
