# ChartAlert 与指标维护

当前源码的后台告警实现只有 ChartAlert。旧 `domain.Rule/State/advance`、旧 `WatchInput`、SMA-cross 插件及演练执行入口已经退出；历史记录与 ORM 保留，不应按旧接口新增功能。

## 代码边界

- `chart_alert_domain.py`：条件、观测和纯判定；`chart_alert_service.py`：`AlertConfig`、版本、生命周期和事件/通知事务。
- `chart_alert_application.py`：HTTP/MCP 共用的来源绑定、关联验证、用例组织、序列化和查询；两个 Adapter 分别转换协议错误，不互相调用。
- `chart_alert_worker.py` 与 `composite_alerts.py`：读取已支持来源的输入并推进同一规则。`alert_monitor.py` 由 API 生命周期持有；API 停机期间判定暂停。
- `chart_indicators.py`：指标目录、参数校验及 `register(name, metadata, calculator)`；`indicator_state.py` 等保留递归计算起点和检查点。通用行情读取在 `chart_query.py`，供 HTTP/MCP/worker 共享。

## 修改规则与指标

先固定具体业务需求与既有数值，再修改对应模块。不要在纯判定函数中下载行情、发送通知或读取系统时钟；数据身份、价格精度、算法版本和恢复语义需保持可核验。新算法版本不得悄悄改写既有规则的计算含义。

配置修改走原生表单或 [ChartAlert MCP](native-mcp-usage.md)：创建提供稳定 `request_id`，编辑检查 `version`，生命周期检查 `version`、`control_revision` 和 `request_id`。MCP 写入另有 `idempotency_key`；条件、来源、固定历史和画线关联仍由服务端校验。

验证至少覆盖等号/上下穿、开始前不通知、临时/完成柱、重复观察、版本冲突、暂停恢复、次数与事件/Outbox 原子性。涉及行情时增加相同身份下 HTTP/MCP/worker 与图表读数的回归；涉及持久状态时使用独立 Ubuntu PostgreSQL 验证恢复和兼容性。测试位置为 `backend/tests/test_chart_alert_*`、`test_composite_alerts*` 和对应指标测试。

网页不执行用户任意 Python 源码。当前候选的范围、验证和回退见 [完成审计](verification/single-frontend-20261026/completion-audit.md)。
