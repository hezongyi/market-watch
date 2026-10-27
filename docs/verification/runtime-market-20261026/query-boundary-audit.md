# 阶段 0：共享查询边界复核

基线 `78697159`。本次只核对调用链，不重做前置查询提取。原始定位见 `results/query-boundary-audit.txt`。

`chart_query.DataQuery/data_sync` 已被 HTTP 图表适配、MCP 及 `market_stream_worker` 直接调用；`query_errors.QueryError` 已提供协议无关错误身份。没有需要另建的 `market_query.py`。`mcp/adapter.py` 属于协议边界，其 HTTPException 使用与应用层依赖需要分别判断，不能仅凭关键词搜索认定全部违规。

仍有一处实际边界缺口：`series_access.export_page` 在共享读取实现内导入 FastAPI HTTPException，并在超过 2000 根或 32 页时抛 413。阶段 1 应复用 QueryError 表达同一状态/文案，由 HTTP/MCP 适配层映射。保留 pending 返回以提交异步指标请求，不能顺便改成异常导致任务回滚。现有 `test_series_access.py::test_fixed_export_rejects_actual_row_overflow_without_import_jobs` 是 HTTP 413 回归依据；补直接调用的协议无关错误检查即可，不新增第二套分页实现。

告警边界与共享读取分开核验：AlertConfig 及 worker 仍有 provider/managed 分支，`test_chart_alert_worker.py::test_provider_demands_survive_absent_browser_and_protect_dataset` 明确保留了旧需求行为。阶段 1 需要统一写入/执行边界与兼容读取，不能引用旧 Watch 410 就宣称所有旧告警已退役。阶段 0 没有修改这些行为。

复用语义回归见 `results/contracts.txt`（127 passed）；涉及真实 PG 的十个核心套件见 `results/postgres-contracts.txt`（150 passed、1 skipped）。后者 skip 是缺少挂载的 v1.14.0 旧采集源码的专项兼容测试，不作为新 profile、当前 owner、手机投递或容量证据。具体阶段 1 的变更仍需本阶段对应回归及独立 PR。
