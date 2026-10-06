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
- K 线默认 300，最多 2000；批量指标 1–12。`before` 是排他的毫秒游标；`next_before` 可继续分页。`cursor_coordinate` 明确管理系列的 UTC start 与平台系列的 native chart time，日/周/月不可混用。所有 bars 与 indicators 来自 `chart_api.query_chart/data_sync`；网页仍使用同一入口。指标保留完整历史前缀、预热、缺口重置和 null 语义。
- 返回页面保留原有 coverage、cache revision、history revalidation、原始历史起点等字段。管理系列使用 `history_revision`，平台系列使用 `cache_revision`；未知起点不伪造。`gaps`、`incomplete_count` 和 `coverage_scope=returned_page` 仅描述当前页面；Yahoo 的 exchange calendar 不由 NY17/UTC0 判断，返回 `gap_assessment=unknown_calendar`、原始 `interval_breaks` 和 `quality=calendar_unverified`，不把休市间隔冒称缺失数据。这些字段不承诺完整历史覆盖。原生图表时间坐标和 K 线 UTC 起止时间可能因 D/W/M 标签不同。
- 管理系列指标历史超过 200000 根时拒绝计算（已发布查询统计 `chart_published_bars`，普通管理查询统计实际源周期 candles），避免截短历史后产生不同数值。Provider 保持项目既有缓存填充、超时和取消策略；不创建持久历史维护订阅。长期历史任务继续使用网页现有维护流程，未自动暴露给 agent。
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

## Ubuntu Docker 验收运行步骤

工作目录 `/home/quant/repos/market-watch-native-mcp`。验收实例已在 Ubuntu 22.04.5 主机 `quant-server` 的 Docker 29.1.3 实际运行。独立 project 为 `mw-native-mcp-acceptance`，PostgreSQL 14，网络 `mw-native-mcp-acceptance_default`，volume `mw-native-mcp-acceptance_native-mcp-pg`。地址为 `https://localhost:18543/`、MCP `https://localhost:18543/mcp`、图表 origin `https://localhost:18544/`，仅绑定 Ubuntu 本机回环地址。

`quant` 已加入 docker 组；当前会话若尚未刷新组身份，可用 `sg docker -c 'docker compose ...'` 执行下列命令，或重新登录。验收已实际使用此方式启动、停止和恢复本 project，未操作其他 project。

凭据、数据库配置和自签 TLS 文件仅在 `/tmp/mw-native-mcp-acceptance`。准备脚本已运行；不重复运行覆盖现有私密配置。图表许可库已由本机已有安装复制到本任务 ignored `advanced-host/charting_library/`，未修改其他工作树原件；不要提交库文件。

TLS 使用独立 `ca.pem` 签发的 `CA:FALSE` 服务端 leaf；不要把 `CA:TRUE` 根证书用作服务端证书，Codex 的 rustls 会拒绝。浏览器需信任该本机验收 CA；SDK 使用 `ca.pem`，Codex 脚本同时设置 `CODEX_CA_CERTIFICATE` 和 `SSL_CERT_FILE` 指向包含公共 CA 与验收 CA 的 `ca-bundle.pem`。验收证书有效期 7 天，agent 凭据为 24 小时；新凭据使用新的 output 文件名，避免覆盖已有文件。

```bash
# 新环境才需要执行准备：
.venv/bin/python scripts/prepare_native_mcp_acceptance.py

docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml up -d --build

# 新数据库才需要 seed，已有 fixture 会拒绝重复：
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

# 真实网页 -> 原生对象保存 -> PG -> HTTP MCP：
NODE_PATH=/home/quant/repos/market-watch/web/node_modules \
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu \
node web/tests/native-mcp-drawings.browser.cjs

# 停止，保留数据：
docker compose --env-file /tmp/mw-native-mcp-acceptance/compose.env \
  -f docs/verification/native-mcp/compose.yaml stop
# 重启：同一命令将 stop 换成 start。
```

验收 EURUSD 来源明确为 `acceptance-fixture`。真实网页画线使用独立 `MCPFIXTURE` 已发布合成快照；该品种名称明确标为 SYNTHETIC，无上游品种映射，`binance` 仅用于既有按需路由识别，不代表它的价格来自 Binance。画线报告同时保存 `synthetic_market_data=true` 与 `data_source=acceptance-fixture`。实际 Binance 验收另读 `BTCUSDT provider`，不混用这两份数据。

实际 SDK HTTPS、浏览器数据库保存和 Codex 调用均已通过，证据见 [验收记录](verification/native-mcp/acceptance.md)。Codex 脚本检查成功调用、无工具错误、EURUSD H1/H4 非空、后台指标、已保存画线及最终征询问题，以 0600 保存事件/错误日志；精确指标由 `indicators_calculate` 计算，时间/价位引用与事实/计算/推断区分仍需人工核对。未实施生产发布。

### 图表告警集成后的指标合同

`indicators_calculate` 默认 `provisional=false`，未收盘最后根的指标值为 null。明确传 `provisional=true` 可计算当前临时 K 线；对应数值点含 `provisional:true`，收盘前可能改变。网页图表仍默认实时显示临时最后根。

provider 查询可传 `calculation_origin` 固定递归历史起点；从响应 `page.calculation_origin` 读取并在后续分页/轮询复用，避免更早缓存回填改变EMA/RSI等的起点。managed published仍使用 `dataset_start` 对齐其已发布历史。

共用信号查询现在同时返回旧策略与图表告警事件：旧策略的 `watch_id` 有值、`chart_alert_id` 为空；图表事件相反。逐事件通知确认不改变告警次数、规则版本或运行轮次。MCP `alerts_create`/`alerts_cancel` 保持原有旧策略接口，不推断它们可以创建或编辑新版图表规则。
