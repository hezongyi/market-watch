# 原生 MCP 使用与开发

当前候选使用同源 `/mcp`，HTTP/MCP 共用 ChartAlert 应用层；工具和查询契约如下。SDK 负责 JSON-RPC 和 Streamable HTTP，能力注册表负责业务 schema、权限和调度。单前端 Ubuntu 验收与 CI 见 [完成审计](verification/single-frontend-20261026/completion-audit.md)。本文后半段旧 `feat/native-mcp` 实例地址及启动过程为历史验收，不是本候选的启动指令。

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

`issue` 以独占创建、0600 权限写一次 token 文件，不输出明文。重复路径拒绝覆盖。只读凭据不能调用告警写入；告警写入须单独给予 `alerts:write`。自建历史维护写入须同时给予 `market:read` 和 `market:write`，现有告警写凭据不自动获得历史维护权限。数据库迁移为 `s20_agent_capabilities`，增加 `agent_credentials`、`agent_operations`。幂等记录保留首个成功操作的结果，同 agent、同工具、同 key 的不同规范化意图返回 `IDEMPOTENCY_CONFLICT`；同 key 跨凭据仍属于同一 agent 的操作。客户端超时后应使用原 key 重试。

## 能力和数据合同

| Scope | 工具 |
| --- | --- |
| `market:read` | `market_list_instruments`、`market_get_quote`、`market_get_bars`、`system_get_status` |
| `analysis:read` | `indicators_list` |
| `analysis:read` + `market:read` | `indicators_calculate` |
| `alerts:read` | `chart_alerts_list`、`chart_alerts_get`、`chart_alerts_events`、只读历史 `alerts_get_signals` |
| `charts:read` | `charts_list_workspaces`、`charts_get_drawings` |
| `alerts:write` | `chart_alerts_create`、`chart_alerts_edit`、`chart_alerts_lifecycle`、`notifications_ack` |
| `market:read` + `market:write` | `history_create_dataset`、`history_configure_maintenance`、`history_control_maintenance`、`history_submit_task`、`history_control_task`、`history_change_aggregation`、`history_request_artifacts`、`history_reclaim_dataset` |

- 报价和通用 K 线输入使用基础品种 ID，`series_kind` 明确选择 `managed` 或 `provider`。指标另外支持 `history` 和 `composite`，见下文。先发现品种；不能把来源 ID 当成券商可交易映射。管理系列的品种发现沿用网页启用品种目录，平台系列沿用网页市场目录。
- 价格、OHLC 是十进制字符串，时间为毫秒。报价保留网页的 bid/last trade/M1 close 标签；OANDA/Binance 平台报价首期取有限 M1 数据并明确标为 `M1 close`。Yahoo 使用网页共用的市场报价快照，并返回延迟字段。来源不可用返回错误。
- `market_open`（已知时）与 `is_stale` 分开表达休市和陈旧。报价年龄不等于交易可用性。平台报价未获得休市状态时不推断市场正在交易。
- K 线默认 300，最多 2000；批量指标 1–12。`before` 是排他的毫秒游标；`next_before` 可继续分页。`cursor_coordinate` 明确管理系列的 UTC start 与平台系列的 native chart time，日/周/月不可混用。所有 bars 与 indicators 来自 `chart_query.query_chart/data_sync`；网页仍使用同一入口。指标保留完整历史前缀与预热；自建历史和组合默认按实际有效 K 线连续计算，严格模式才因缺口重置。
- 返回页面保留原有 coverage、cache revision、history revalidation、原始历史起点等字段。管理系列使用 `history_revision`，平台系列使用 `cache_revision`；未知起点不伪造。`gaps`、`incomplete_count` 和 `coverage_scope=returned_page` 仅描述当前页面；Yahoo 的 exchange calendar 不由 NY17/UTC0 判断，返回 `gap_assessment=unknown_calendar`、原始 `interval_breaks` 和 `quality=calendar_unverified`，不把休市间隔冒称缺失数据。这些字段不承诺完整历史覆盖。原生图表时间坐标和 K 线 UTC 起止时间可能因 D/W/M 标签不同。
- 旧管理系列指标历史超过 200000 根时拒绝计算（已发布查询统计 `chart_published_bars`，普通管理查询统计实际源周期 candles），避免截短历史后产生不同数值。Provider 保持项目既有缓存填充、超时和取消策略；不创建持久历史维护订阅。三层固定历史/组合采用后台完整初始化和检查点；自建维护通过单独授权的八个写工具管理。
- 默认单请求体 64 KiB、每凭据每分钟 60 次协议请求（包括发现/初始化）、最多 4 个业务调用并行、最多 8 个待处理调用、20 秒调用等待预算。数据库配额跨进程；计算并行额度按 API 进程。同步工作未退出时占用业务 slot，客户端断连设置取消标记。当前部署使用一个 API 进程。
- 告警使用网页相同的 `AlertConfig`、条件校验、数据集绑定和版本事务；`alerts_create`、`alerts_cancel`、`alerts_list` 已退出注册。创建需稳定 `request_id` 和 `idempotency_key`；编辑需当前 `version`；生命周期需 `version`、`control_revision` 和稳定 `request_id`。association 可省略，指定时必须关联真实已保存图格/对象。告警事件最多 500 条，历史 signals 只读查询最多 500 条。审计保存 agent、请求 ID、能力名、资源和结果，不保存原始凭据或完整请求正文。
- 无计划 CRUD、计划表、形态扫描引擎或交易工具。Agent 根据 OHLC、可选指标和画线在对话中分析，区分事实、计算、推断，并征询用户意见。

## 自建历史维护写入

八个维护写工具与网页共用事务命令。创建使用 `dataset`（来源、逻辑品种、准确来源代码、资产类别、精度、日界）和 `maintenance`（历史起点、周期、频率、时区、日更分钟、重叠复查分钟）；当前原始口径为 Bid。外汇/金属默认 NY17，加密默认 UTC0，指数及其他类别需明确日界。历史起点与任务区间为已结束的 UTC 分钟边界。

每次写入必须提供 `idempotency_key`。创建或提交返回固定任务版本，下载在 worker 中进行；管理调用不进行供应商 I/O，也不产生实时需求。暂停计划不暂停已有任务，暂停/取消任务使用 `history_control_task`。归档保留已发布价格；重新配置日更不会替换固定回测或运行组合基线。任务失败不撤掉旧发布。

`history_change_aggregation` 接收 `dataset_id` 和 `aggregation`（`aggregation_calendar`、可选已发布 `version_id`），建立单独日界数据集并复用原始 M1；原版本和价格不改写。M1 版本发布与各周期发布分别检查，`history_request_artifacts` 只接受未回收的已发布父版本。

`history_reclaim_dataset` 是物理回收操作，要求计划已暂停且已归档，并在锁内重查回测、工作区、策略、映射、组合、派生及活动任务引用。存在引用返回错误；可回收时保留身份、清单与回收证据，仍被其他日界或采集缓存引用的分块保留。只读查询的引用报告不是删除授权，也不能替代该事务检查。

实际 Ubuntu 验收见[维护 MCP 报告](verification/three-layer/history-writes-stage.md)。旧原生 MCP 实例说明仍属于其原交付环境，不代表本次三层环境。

## 已保存画线

原生图表库公开 `getAllShapes()/getShapeById().getPoints()` 在保存时生成 `state._mwDrawingProjection`，包含图表索引、symbol、resolution、对象 ID、稳定类型 ID、时间/价格锚点。投影和 vendor state 一起保存并沿用工作区 revision；保存期间图表编辑变化会拒绝该次快照并提示重试。加载时剥离投影扩展，不传给 vendor。不解析私有 vendor sources，不返回 options、正文或任意 vendor 文档。

首期白名单：`horizontal_line`、`trend_line`、`ray`、`rectangle`、`fib_retracement`、`text`、`parallel_channel`、`long_position`、`short_position`。实际验收目前覆盖水平线、趋势线和矩形；未知对象返回 `supported=false` 及空 anchors，不能宣称已解释它。价格坐标必须有限；原生水平线允许 price-only 锚点。原生时间标为 `native_chart_time_ms`。旧 lightweight 工作区的 MCP 活动读取入口已退役，`engine=legacy` 会被明确拒绝，不能把旧 ID 当原生工作区使用。

旧原生工作区没有投影时返回 `UNSUPPORTED_CAPABILITY`，需通过更新后的页面重新保存；未保存改动不可见。缺失工作区返回 `WORKSPACE_NOT_FOUND`。工作区列表不包含文档正文。

## 增加能力

在 `capabilities/actions.build_registry()` 的显式装配清单加入一个 `Capability`：名称、说明、Pydantic 输入/输出模型、不可变 scope 集合、read/write 效果和业务 handler。同步 read handler 接收 `(context, input)`；async read handler 同样接收显式上下文；同步 write handler 接收 `(context, input, db)`，使用 dispatcher 提供的事务，不自行 commit。

注册表检查重复名称、模型、权限与效果一致性、写入的幂等键。启动时冻结；新文件需要显式导入并发布重启。SDK Adapter 自动生成 schema、发现和调用，不需改 MCP server。写入输出校验、业务动作、幂等记录和成功审计处于同一事务。

算法扩展沿用 `chart_indicators.register()`，通用指标工具自动发现。重复算法 ID 拒绝注册；需要稳定 ID/版本、参数、输出和历史要求。测试已通过真实 SDK 协议验证新增动作发现，并验证新增指标发现/计算。

## 历史原生 MCP 实例验收记录（不用于当前候选启动）

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

自建历史（`history`）和组合（`composite`）默认使用
`indicator_input_policy="observed_display_v1"`，与图表实际行情计算口径一致。
外汇每天少十几根 M1 属于常态：按已有 M1 聚合 OHLC，不要求分钟数齐全，
不补造价格，也不因此重置 EMA/RSI。整根周期没有数据时留空，下一根有效 K 线继续计算；
周期数按实际存在的 K 线计数。原始 `complete`、`coverage_complete` 等证据仍保留，
不影响默认数值可用性；指标的 `calculation.input_policy` 和 `value_status` 表明计算口径与状态。
例如一天收到 1,425 根 M1，仍正常生成 D1 并参与 EMA20、RSI14 和 MACD。
需要完整覆盖检查时，显式传 `indicator_input_policy="strict_confirmed_v1"`；
两种口径使用独立计算状态。旧 `managed` 和供应商原生 `provider` 查询保持既有严格口径。

`indicators_calculate` 默认 `provisional=false`，未收盘最后根的指标值为 null。明确传 `provisional=true` 可计算当前临时 K 线；对应数值点含 `provisional:true`，收盘前可能改变。网页图表仍默认实时显示临时最后根。

provider 查询可传 `calculation_origin` 固定递归历史起点；从响应 `page.calculation_origin` 读取并在后续分页/轮询复用，避免更早缓存回填改变EMA/RSI等的起点。managed published仍使用 `dataset_start` 对齐其已发布历史。

共用信号查询现在同时返回旧策略与图表告警事件：旧策略的 `watch_id` 有值、`chart_alert_id` 为空；图表事件相反。逐事件通知确认不改变告警次数、规则版本或运行轮次。MCP 使用上表的六个 `chart_alerts_*` 工具管理当前规则；旧 Watch 工具已退役，历史事件确认不会重新激活旧规则或重投递。

## 已发布历史版本的指标

`indicators_calculate` 接受 `series_kind="history"`，`instrument` 为数据中心已发布的
历史版本 UUID，或 `MWH:<版本UUID>`。必须显式指定类型；不能用数据集 ID、品种代码或
“最新版本”代替版本 UUID。可从 `history_get_dataset` 的各周期发布信息取得版本，
再用 `history_get_version` 检查其清单和可用性。仍需 `market:read` 与 `analysis:read`。

```json
{
  "instrument": "<已发布的历史版本UUID>",
  "series_kind": "history",
  "timeframe": "H1",
  "limit": 300,
  "indicators": [
    {"name": "EMA", "version": "1", "params": {"period": 20}},
    {"name": "RSI", "version": "1", "params": {"period": 14}}
  ]
}
```

返回该版本的 `page.bars`、`page.indicators`、`page.version_id`、`history_version_id`、
`history_checksum` 和 `input_manifest={version_id,checksum}`。指标的
`calculation.input_evidence.history_version_id` 与价格版本一致，算法、参数、完整起点、
覆盖和依赖由同一图表后端返回。数据中心发布新版本不会改变这次指定的版本。
这里接通已有版本输入，不新增复算快照或跨调用回放协议。

冷启动使用现有固定指标任务，响应成功返回 K 线、已有指标值、`pending` 和
`indicator_progress`。继续以相同版本查询可取得进度和结果；不要求全部历史任务结束才读取
已算完的可见区间。逐指标检查 `calculation.visible_complete` 与覆盖；计算完成后仍可因
预热不足、无效输入或稀疏信号返回 null；严格模式还可能因缺口重置而返回 null。不要将 null 当零。

版本不存在、未发布、已回收或请求周期产物尚未发布时返回 `DATA_UNAVAILABLE`，
不切换版本、不下载、不补建周期产物、不续订行情。单次限制仍为 1–12 个指标、最多 2000 根
可见 K 线。`before`/`next_before` 是排他的 UTC 毫秒 `start`；D/W/M 的 `chart_time`
只是图表标签，指标 `time` 对应 K 线的真实 `start`。

默认 `provisional=false`，指标使用已收盘的有效观测，不要求分钟覆盖完整；K 线保留闭合、确认和覆盖标记。
`provisional=true` 沿用网页对版本末尾不完整周期的临时计算，临时值带有标记。
不接受 `published=true`、`dataset_start`、`calculation_origin`、`composite_revision_id`
或 `input_revision`；固定历史的计算起点与输入已由版本确定。

## 已建立组合的指标

`indicators_calculate` 继续要求 `analysis:read` 和 `market:read`，支持显式
`series_kind="composite"`。`instrument` 是已保存的组合 ID，也接受 `MWC:<ID>`。
搜索候选不等于已经建立组合；此工具不创建组合、不续订行情、不调用供应商补数。

```json
{
  "instrument": "<已建立的64位组合ID>",
  "series_kind": "composite",
  "composite_revision_id": "<可选的组合修订ID>",
  "timeframe": "H1",
  "limit": 300,
  "indicators": [
    {"name": "EMA", "version": "1", "params": {"period": 20}},
    {"name": "RSI", "version": "1", "params": {"period": 14}}
  ]
}
```

省略组合修订时，共享读取只解析一次活动修订。`page.revision_id`、
`page.input_revision`、`page.history_version_id`、`page.history_checksum`、`seam` 和
`rule_version` 描述本次价格依据；每个指标 `calculation.input_evidence` 与页面对应。
指定非活动修订时，来源、精度、日历和历史基线也取自所选修订。

可用 `input_revision` 选择现有保留的非负确认输入修订，但必须同时指定
`composite_revision_id`。组合拒绝 `published=true`、`dataset_start` 和
`calculation_origin`；这些组合字段也不能用于 managed/provider。单次仍限 1–12 个指标、
最多 2000 根可见 K 线，`before` 为排他的 UTC 毫秒游标。日/周/月 `chart_time` 是图表标签，
指标点的 `time` 对应真实 K 线 `start`。

默认 `provisional=false`，指标采用已收盘的有效输入，不因常见分钟缺口拒绝计算。K 线仍保留
`time_closed`、`source_confirmed`、`coverage_complete` 和来源 `segments`。
`provisional=true` 绑定本次展示快照，临时指标和依赖带有标记；不能同时指定
`input_revision`，临时值不推进已确认的指标状态。

冷启动可登记现有固定指标后台任务；响应仍成功返回价格、已完成结果、`pending` 和
`indicator_progress`。逐个检查指标的 `calculation.visible_complete`、`coverage`、
`required_coverage`、`status`、`cursor`、`target_end`、`error`、`next_at`。
可见覆盖完成不要求完整历史任务已结束，也不保证每个点有信号。
预热不足、无效输入、严格模式缺口后重新初始化或稀疏信号产生的 null/空事件保留原样，结合
`dependencies.initialized`、缺口和 K 线状态判断；不得将 null 当零或仅凭全 null 推断任务未完成。

每次响应内部保证同源、同版本。再次调用（含重试和分页）重新选择输入，不保证跨次快照一致；
`run_id`、`display_snapshot_id` 是解释与诊断字段，不开放为该 MCP 工具输入。
`history_revision` 可能包括计算进度，并非可重放的数据版本。
允许的业务写入仅为共享计算任务、结果及审计；临时模式还复用现有展示快照缓存。
没有网页 client 或消费者租约，不建立实时市场需求。
