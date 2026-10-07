# API 只读开销采样

采样 2026-10-06T22:39:50.680047+00:00，7个实际API主进程，三次5秒窗口；未修改配置或读取业务数据库。

| API | 进程CPU均值 | 主线程CPU均值 | 最热线程CPU均值 | 60秒access请求 / health |
| --- | --- | --- | --- | --- |
| market-watch-three-layer-api-1 | 1.9% | 0.1% | 0.5% | 133 / 22 |
| mw-range-main-20261006-api-1 | 28.7% | 0.3% | 26.1% | 16 / 13 |
| mw-chart-alerts-integration-api-1 | 29.5% | 0.1% | 27.6% | 17 / 17 |
| market-watch-data-integration-api-1 | 4.9% | 0.9% | 1.2% | 68 / 17 |
| mw-chart-alerts-acceptance-api-1 | 28.8% | 0.3% | 26.8% | 16 / 16 |
| mw-native-mcp-acceptance-api-1 | 1.3% | 0.1% | 0.5% | 17 / 17 |
| mw-range-v180-20261006-api-1 | 1.1% | 0.2% | 0.3% | 17 / 17 |

100%为一个逻辑核。请求数仅来自可见access日志，原始路径、query string和日志均不保存；SSE帧、禁用access日志的流量及日志轮转不可见。健康检查包含 `/healthz` 和 `/readyz`。原始线程数据见 [api-observation.json](api-observation.json)。

首轮曾把Docker top中的临时Python健康检查算入目标，造成两处容器重复；已改为容器State.Pid并重新采样，初轮保留为 [api-observation-initial.json](api-observation-initial.json)，不用于本表。

热点API的主线程开销很低而单个后台线程持续耗CPU，支持进一步检查后台工作；线程名和CPU本身不能区分告警、供应商预热/实时维护，不能据此确认具体根因。access样本以健康请求为主也不能证明完全没有用户活动。

源码核对：API lifespan启用provider_service（各来源预热、实时、janitor、chart_alert）以及provider_transport后台线程；chart_alert每秒调用step。published告警的stored_rows当前先执行staging chart_rows再覆盖为read_rows，是可由独立fixture验证的重复工作候选。核心共享模块的修复仍按合并等待条件执行；未附加调试器、暂停线程或停止其他任务。

下一步在本任务独立消费者fixture验证告警调用链与SQL/返回数据等价性；完整API/告警延迟和浏览器并发尚未测，不能写成验收通过。

独立逻辑fixture已执行：`ALERTS_DATABASE_URL=sqlite:///:memory: PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python docs/verification/issue-13/alert_read_probe.py`，退出0。120根M1预先发布、告警历史起点限定后60根、staging最后价格99而published仍10；返回60根published价格与观察时间正确，3次evaluate无事件。每次stored_rows仍读staging与published各1次，3次evaluate各产生3次staging/published读。原始结果见 [alert-read-baseline.txt](alert-read-baseline.txt)。这证明重复读取存在，不证明上述正在运行API的热点就是此函数，也不证明PG收益。
