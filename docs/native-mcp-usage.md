# 原生 MCP 使用与开发

实现分支 `feat/native-mcp`，基线 `3c18f60`。模块使用官方 Python SDK `mcp==2.3.0` 的公开 low-level Server handlers；SDK 负责 JSON-RPC 和 Streamable HTTP，能力注册表负责业务 schema、权限和调度。P1 和 P2 已实现；Docker HTTPS 与实际 Codex 分析验收尚待运行，不能据本文宣称实例已部署。

## 接入

默认 `ALERTS_MCP_ENABLED=false`，不开启 MCP 路由。启用后，`/mcp` 和 `/mcp/` 均支持 Streamable HTTP；同一 FastAPI lifespan 启停协议管理器，客户端连接不启动行情 worker。使用无状态 HTTP 调用。网页 Nginx 已配置 `/mcp` 转发；正式网络入口须使用可信 HTTPS，Host/Origin allowlist 必须包含实际域名。

首期采用受控 opaque Bearer 凭据，数据库只存 SHA-256 摘要、agent 身份、scope、到期及撤销时间，不提供 OAuth 授权发现。所有 MCP 方法均验证凭据，发现目录按 scope 过滤，调用及事务内写入再次授权。scope 限制适用于当前单管理员共享工作台；没有多租户或券商账户授权功能。

本机 Codex CLI `0.160.0` 的 `mcp add --help` 和配置读取已确认下列配置字段，实际工具调用仍待验收。官方 OpenAI 文档 `https://developers.openai.com/codex/mcp` 及 `.md` 本次仍返回 HTTP 403。

```toml
[mcp_servers.market_watch]
url = "https://YOUR_HOST/mcp"
bearer_token_env_var = "MW_MCP_TOKEN"
tool_timeout_sec = 30
startup_timeout_sec = 30
```

凭据放在运行 Codex 的进程环境，不放 TOML。也可运行 `codex mcp add market_watch --url https://YOUR_HOST/mcp --bearer-token-env-var MW_MCP_TOKEN`。本次未修改用户全局 Codex 配置。

## 凭据管理

在指定实例的数据库环境内运行：

```bash
python -m alerts.mcp.credentials issue --agent codex-reader \
  --scope market:read --scope analysis:read --scope charts:read --scope alerts:read \
  --hours 24 --output /tmp/codex-reader.token
python -m alerts.mcp.credentials list
python -m alerts.mcp.credentials revoke --hash HASH_FROM_LIST
```

`issue` 以独占创建、0600 权限写一次 token 文件，不输出明文。重复路径拒绝覆盖。只读凭据不能调用告警写入；写入须单独给予 `alerts:write`。数据库迁移为 `s20_agent_capabilities`，增加 `agent_credentials`、`agent_operations`。幂等记录保留首个成功操作的结果，同 agent、同工具、同 key 的不同规范化意图返回 `IDEMPOTENCY_CONFLICT`；同 key 跨凭据仍属于同一 agent 的操作。客户端超时后应使用原 key 重试。

## 能力和数据合同

| Scope | 工具 |
| --- | --- |
| `market:read` | `market_list_instruments`、`market_get_quote`、`market_get_bars`、`system_get_status` |
| `analysis:read` | `indicators_list` |
| `analysis:read` + `market:read` | `indicators_calculate` |
| `alerts:read` | `alerts_list`、`alerts_get_signals` |
| `charts:read` | `charts_list_workspaces`、`charts_get_drawings` |
| `alerts:write` | `alerts_create`、`alerts_cancel`、`notifications_ack` |

- 行情输入使用基础品种 ID，`series_kind` 明确选择 `managed` 或 `provider`。先发现品种；不能把来源 ID 当成券商可交易映射。管理系列的品种发现沿用网页启用品种目录，平台系列沿用网页市场目录。
- 价格、OHLC 是十进制字符串，时间为毫秒。报价保留网页的 bid/last trade/M1 close 标签；OANDA/Binance 平台报价首期取有限 M1 数据并明确标为 `M1 close`。Yahoo 使用网页共用的市场报价快照，并返回延迟字段。来源不可用返回错误。
- `market_open`（已知时）与 `is_stale` 分开表达休市和陈旧。报价年龄不等于交易可用性。平台报价未获得休市状态时不推断市场正在交易。
- K 线默认 300，最多 2000；批量指标 1–12。`before` 是排他的毫秒游标；`next_before` 可继续分页。所有 bars 与 indicators 来自 `chart_api.query_chart/data_sync`；网页仍使用同一入口。指标保留完整历史前缀、预热、缺口重置和 null 语义。
- 返回页面保留原有 coverage、cache revision、history revalidation、原始历史起点等字段。管理系列使用 `history_revision`，平台系列使用 `cache_revision`；未知起点不伪造。`gaps`、`incomplete_count` 和 `coverage_scope=returned_page` 仅描述当前页面，不承诺完整历史覆盖。原生图表时间坐标和 K 线 UTC 起止时间可能因 D/W/M 标签不同。
- 管理系列指标历史超过 200000 根时拒绝计算，避免截短历史后产生不同数值。Provider 保持项目既有缓存填充、超时和取消策略；不创建持久历史维护订阅。长期历史任务继续使用网页现有维护流程，未自动暴露给 agent。
- 默认单请求体 64 KiB、每凭据每分钟 60 次协议请求（包括发现/初始化）、最多 4 个业务调用并行、最多 8 个待处理调用、20 秒调用等待预算。数据库配额跨进程；计算并行额度按 API 进程。同步工作未退出时占用业务 slot，客户端断连设置取消标记。当前部署使用一个 API 进程。
- 告警及通知使用网页现有一次性模型与规则；不把并行开发的新告警模型当成已集成。signals 只包含网页共用视图的最新 500 条。审计保存 agent、请求 ID、能力名、资源和结果，不保存原始凭据或完整请求正文。
- 无计划 CRUD、计划表、形态扫描引擎或交易工具。Agent 根据 OHLC、可选指标和画线在对话中分析，区分事实、计算、推断，并征询用户意见。

## 已保存画线

原生图表库公开 `getAllShapes()/getShapeById().getPoints()` 在保存时生成 `state._mwDrawingProjection`，包含图表索引、symbol、resolution、对象 ID、稳定类型 ID、时间/价格锚点。投影和 vendor state 一起保存并沿用工作区 revision；保存期间图表编辑变化会拒绝该次快照并提示重试。加载时剥离投影扩展，不传给 vendor。不解析私有 vendor sources，不返回 options、正文或任意 vendor 文档。

首期白名单：`horizontal_line`、`trend_line`、`ray`、`rectangle`、`fib_retracement`、`text`、`parallel_channel`、`long_position`、`short_position`。实际验收目前覆盖水平线、趋势线和矩形；未知对象返回 `supported=false` 及空 anchors，不能宣称已解释它。价格坐标必须有限；原生水平线允许 price-only 锚点。原生时间标为 `native_chart_time_ms`，旧版 lightweight 工作区标为 `utc_ms`。

旧原生工作区没有投影时返回 `UNSUPPORTED_CAPABILITY`，需通过更新后的页面重新保存；未保存改动不可见。缺失工作区返回 `WORKSPACE_NOT_FOUND`。工作区列表不包含文档正文。

## 增加能力

在 `capabilities/actions.build_registry()` 的显式装配清单加入一个 `Capability`：名称、说明、Pydantic 输入/输出模型、不可变 scope 集合、read/write 效果和业务 handler。同步 read handler 接收 `(context, input)`；async read handler 同样接收显式上下文；同步 write handler 接收 `(context, input, db)`，使用 dispatcher 提供的事务，不自行 commit。

注册表检查重复名称、模型、权限与效果一致性、写入的幂等键。启动时冻结；新文件需要显式导入并发布重启。SDK Adapter 自动生成 schema、发现和调用，不需改 MCP server。写入输出校验、业务动作、幂等记录和成功审计处于同一事务。

算法扩展沿用 `chart_indicators.register()`，通用指标工具自动发现。重复算法 ID 拒绝注册；需要稳定 ID/版本、参数、输出和历史要求。测试已通过真实 SDK 协议验证新增动作发现，并验证新增指标发现/计算。

## Ubuntu Docker 验收运行步骤（待执行）

工作目录 `/home/quant/repos/market-watch-native-mcp`。独立 project 为 `mw-native-mcp-acceptance`，独立 PostgreSQL 14、网络和 `native-mcp-pg` volume。计划地址为 `https://localhost:18543/`、MCP `https://localhost:18543/mcp`、图表 origin `https://localhost:18544/`。这些地址目前没有已部署实例。

凭据、数据库配置和自签 TLS 文件仅在 `/tmp/mw-native-mcp-acceptance`。准备脚本已运行；不重复运行覆盖现有私密配置。图表许可库已由本机已有安装复制到本任务 ignored `advanced-host/charting_library/`，未修改其他工作树原件；不要提交库文件。

```bash
# 新环境才需要执行准备：
.venv/bin/python scripts/prepare_native_mcp_acceptance.py

docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml up -d --build

# 仅针对上述隔离数据库生成带 acceptance-fixture 来源标签的确定性数据：
docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml exec -T api python - \
  < scripts/seed_native_mcp_acceptance.py

# 同一容器内创建验收读写凭据：
docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml exec -T api \
  python -m alerts.mcp.credentials issue --agent sdk-acceptance \
  --scope market:read --scope analysis:read --scope charts:read \
  --scope alerts:read --scope alerts:write --hours 24 --output /tmp/agent.token
docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml cp api:/tmp/agent.token /tmp/mw-native-mcp-acceptance/agent.token
chmod 600 /tmp/mw-native-mcp-acceptance/agent.token

# 为 Codex 单独创建只读凭据：
docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml exec -T api \
  python -m alerts.mcp.credentials issue --agent codex-acceptance \
  --scope market:read --scope analysis:read --scope charts:read \
  --scope alerts:read --hours 24 --output /tmp/agent-read.token
docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml cp api:/tmp/agent-read.token /tmp/mw-native-mcp-acceptance/agent-read.token
chmod 600 /tmp/mw-native-mcp-acceptance/agent-read.token

.venv/bin/python scripts/native_mcp_acceptance.py
.venv/bin/python scripts/native_mcp_codex_acceptance.py

# 停止，保留数据：
docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml stop
# 重启：同一命令将 stop 换成 start。
```

实际 SDK 验收须保留 HTTPS 报告；Codex 须保留真实 tool-call 事件及含时间/价位、用户意见问题的分析，并核对 audit。自签 TLS 的 Codex 信任组合仍需实测，准备的 `ca-bundle.pem` 同时包含公共 CA 和本机验收证书。若部署权限或实际客户端授权不可用，保持验收未完成状态，不改用 unraid 或模拟客户端来宣称交付完成。
