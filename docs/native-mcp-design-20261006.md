# Market Watch 原生 MCP 模块设计

日期：2026-10-06。状态：原方案已在 `feat/native-mcp` 基于 `3c18f60` 实施 P1/P2；本机 Docker 权限不足，真实部署与 Codex 调用验收未完成。下文调查基线和初始技术判断作为原方案保留，最终行为见第 10 节。

调查基线：`62488c6035dbea9533699d569a6605f82c684303`（v1.7.0 工作树 HEAD）。独立工作树：`/home/quant/repos/market-watch-mcp-design`；分支：`docs/native-mcp-design-20261006`。主工作树另有 MT4、告警等未提交设计资料，作为依赖背景阅读，未复制或修改。实施前须重新核对各任务最终集成版本。

## 1. 推荐方向

已确认的产品范围：第一阶段供 Codex agent 调用；分析覆盖 K 线组合、价格结构及图上绘图对象。交易计划仅指 agent 分析后向用户提出建议并征询意见，不新增内部计划表、计划 CRUD、调度或自动执行。首期以读取现有数据和计算为基础，形态的主观解读由 agent 承担；后端确定性扫描按后续需求扩展，不作为开始分析的前置条件。

在现有 Python/FastAPI 项目内增加 MCP Module，提供 Streamable HTTP 入口 `/mcp`。Agent 通过标准 MCP 发现并调用能力，网页和 MCP 共用业务 Module。采用成熟协议库，不自研 JSON-RPC、工具发现或传输。

首选官方 Python SDK 满足基础注册与 ASGI 集成；独立 FastMCP 项目作为需要更丰富组合、鉴权集成时的候选。核查时官方最新发布为 [v2.3.0](https://github.com/modelcontextprotocol/python-sdk/releases/tag/v2.3.0)，当前主分支示例使用 `mcp.server.MCPServer`；旧资料中的 SDK 内置 FastMCP 与独立 `fastmcp` 包不能混用。实施时固定发布版本并按对应 tag 核对生命周期与注册 Interface。上游比较与证据见 [参考项目研究](native-mcp-references-20261006.md)。

“原生”的含义是：MCP 随项目维护、调用项目自己的事实和业务规则；不要求 agent 模拟网页操作、不另建一套行情/告警事实来源。初期同进程挂载，使用现有数据库与 worker，不为每个 agent 启动行情采集。

## 2. 当前能力与缺口

| 用户希望使用的功能 | 已核实代码 | 接入判断 |
| --- | --- | --- |
| 看价格 | `api.py:instruments`，`storage.py:Quote`，平台行情模块 | 可复用；需明确报价、成交价、M1 收盘价及来源，不能统一冒称实时成交价 |
| 看 K 线、历史与数据质量 | `api.py:candles`、`chart_api.py:data/data_sync`、`market_data.py` | 可复用；管理系列与平台系列有不同周期、身份和覆盖语义 |
| 看告警、信号与通知结果 | `api.py:watches/signals`、`service.py` | 可复用；当前旧告警为一次性模型，新告警设计不能提前视为已实现 |
| 建立或取消现有告警、确认通知 | `create_watch`、`cancel_watch`、`acknowledge` | 可接入写操作，需补统一的权限、幂等和审计上下文 |
| 看指标 | `chart_indicators.py` 的 8 个 Python 指标与注册函数 | 可复用 SMA、EMA、LWMA、BBANDS、RSI、MACD、ATR、STOCH；前置历史、缺口、修订语义必须保持一致 |
| 看形态 | 当前后端未发现统一形态识别 Interface | 首期 agent 基于 OHLC 历史分析 K 线组合与价格结构；后端扫描为可选扩展。图上对象读取需核实工作区存储格式并补只读投影 |
| 做交易计划 | 用户确认仅分析并征询意见 | 在 Codex 对话内形成建议；不新增内部计划 Module |
| 下单、改单、撤单、平仓 | MT4 接入设计及 D1 只读验证资料 | 依赖交易 Module 真正完成；本轮不调用终端或执行交易 |

代码链接：[HTTP 入口](../backend/alerts/api.py)、[图表取数](../backend/alerts/chart_api.py)、[图表指标](../backend/alerts/chart_indicators.py)、[预警指标](../backend/alerts/indicators.py)、[告警业务](../backend/alerts/service.py)、[指标维护](python-chart-indicator-maintenance.md)。

特别注意：原生图表库内置指标在浏览器计算，不能因网页能显示就宣称 MCP 后台也能计算。图表 Python 指标与预警指标目前是两种 Interface，注册前者不会自动获得预警支持。

## 3. 模块组织

建议新增下列位置，名称为设计示意：

```text
backend/alerts/
  capabilities/
    registry.py          # 能力定义、注册检查、公开目录
    context.py           # 调用者、权限、请求身份、截止时间
    market.py            # 行情与历史查询的共享业务入口
    analysis.py          # 指标查询；以后承接形态查询
    alerts.py            # 告警与通知共享业务入口
  mcp/
    server.py            # SDK 实例与 ASGI 生命周期
    adapter.py           # 能力定义 -> MCP tools / resources
    auth.py              # agent 身份验证与 scope 映射
```

调用关系：`Agent → MCP Adapter → 注册能力的业务 Interface → 现有行情/指标/告警 Module`；网页 HTTP Adapter 调用相同业务 Interface。

迁移按实际接入功能逐个完成，不先重构全项目。`chart_api.router()` 内的 `data_sync` 是嵌套函数，不能简单导入；应连同历史预热、缓存、超时与取消语义提取为共享查询。`api.instruments()` 的报价选择逻辑同样提取，避免 MCP 另写一份查询得到不同价格。

业务调用不依赖 FastAPI `Request`、Cookie 或 MCP 会话。共享 Interface 接受显式调用上下文与类型化输入，返回类型化结果；HTTP 和 MCP 分别映射协议错误。使用线程或受限计算执行器承接当前同步数据库/TA-Lib 工作，不阻塞 ASGI 事件循环。网络等待和计算不持有长数据库事务。

## 4. “以后注册一下就能用”如何实现

区分两种注册：

1. **新增业务动作**：实现一个可调用业务 Interface，注册名称、说明、输入/输出模型、权限、效果类型和处理函数。MCP Adapter 自动生成工具 schema、发现列表和调用入口。
2. **新增指标/形态算法**：注册到该领域的算法目录。通用 `indicators_list/indicators_calculate` 或 `patterns_list/patterns_scan` 自动发现，不为每个 RSI 参数或每种形态生成一个 MCP tool。

注册记录示意，以下不是已经可运行的 SDK 代码：

```python
registry.register(Capability(
    name="market_get_quote",
    description="读取指定来源的最新价格及时间、口径、新鲜度",
    input_model=QuoteQuery,
    output_model=QuoteResult,
    scopes={"market:read"},
    effect="read",
    handler=market.get_quote,
))
```

公共约定：

- 输入/输出采用 Pydantic 模型；每个工具有具体 schema，不使用一个任意 `execute(action, dict)` 工具隐藏全部能力。
- 注册时校验重复名称、模型、效果与权限；启动时由明确模块清单加载，启动后冻结目录。新增 Python 文件仍需加入加载清单并发布重启；不承诺任意文件放进去就自动生效。
- 在请求入口统一处理身份、scope、额度、截止时间、审计、结构化错误。发现列表按权限过滤，实际调用必须再次检查权限，不能只隐藏名称。
- 写能力按业务声明支持幂等键；工具说明或 MCP `readOnlyHint` 等 annotation 只是提示，不承担授权。
- 注册不替代算法实现、业务验证、数值测试和数据库迁移。新能力具备后，MCP 的重复接线工作可以省掉。
- 新功能默认内部可见，明确注册才对 agent 开放；不把后台管理、密码、备份和任意 SQL 自动导出。

指标目录优先衔接正在进行的指标体系改进：稳定算法 ID/版本、参数约束、输出声明、预热要求、支持的输入字段。现有 high/low/close 输入不能假装支持所有需要 open/volume 的形态算法。

## 5. 建议工具目录与阶段

工具名为建议，最终在实现时固定。

| 阶段 | 工具 | 范围 |
| --- | --- | --- |
| P1：读取现有能力 | `market_list_instruments`、`market_get_quote`、`market_get_bars` | 来源和系列明确，分页取数，质量可见 |
| P1 | `indicators_list`、`indicators_calculate` | Python 后台真实支持的算法；支持批量计算同一份数据 |
| P1 | `alerts_list`、`alerts_get_signals`、`system_get_status` | 分页与过滤；运行状态只返回适合 agent 阅读的字段 |
| P1：图上对象读取 | `charts_list_workspaces`、`charts_get_drawings` | 拟定只读工具；先核实已保存工作区能否可靠投影对象、坐标与图表身份，明确尚未保存的浏览器状态不可见 |
| P2：现有业务写入 | `alerts_create`、`alerts_cancel`、`notifications_ack` | 复用正式业务规则、写权限、幂等和审计 |
| P3：可选确定性形态扫描 | `patterns_list`、`patterns_scan` | 有固定识别规则、批量扫描或告警需求时实现并注册；不阻塞 P1 的 agent 分析 |
| P4：交易 Module 完成后 | `trading_get_account`、`trading_list_orders`、`trading_preview_order`、`trading_submit_order`、`trading_get_command` | 同时扩展改单、撤单、平仓；只开放实际实现并验收的动作 |

可同时提供 Resources：指标目录、行情口径说明、能力清单；Tools 始终提供必要发现功能，兼容不主动读取 Resources 的客户端。Prompts 可后续提供“盘前分析”“检查告警”模板，不是后台定时计划或权限策略。

首期典型调用：Codex 发现 EURUSD 的可用来源 → 取 H1/H4 历史 K 线及按需指标 → 读取相关告警和已保存图上对象 → 列出候选形态、证据时间/价位、确认条件与失效条件 → 提出分析建议并询问用户意见。这个过程不创建内部计划，也不执行订单。

后续若启用 `alerts:write`，可按用户任务创建告警并返回监控 ID。平台的持续监控由后台执行，MCP 连接关闭不应终止已创建的告警。

### 5.1 Agent 分析与确定性计算的分工

- 最新单点价格只能说明当前观测，不能支撑形态识别。K 线组合需完整 OHLC，价格结构需足够历史及相关周期；成交量仅在来源具备真实、明确口径时作为补充。
- Agent 可用历史数据推理候选吞没、双底、头肩结构、趋势和支撑阻力；不要求先有 RSI/MACD，也不把语言模型判断宣称为经过固定算法验证的事实。
- 指标是可选分析输入。精确 SMA/RSI/MACD 数值交由现有后台算法；agent 如需自定义计算，应通过可复核代码完成，注明输入与方法，不靠阅读大量数字心算。
- 批量扫描、持续告警、回测和跨次一致性需要明确的确定性规则。届时实现注册式形态算法；算法版本、阈值及确认时间必须明确。不设置未经定义的胜率或置信度。
- 用户绘制的趋势线、水平线和区域是独立数据，不能由行情推断为用户已画对象。拟从已保存图表文档提取白名单字段：工作区/图表身份、来源/品种/周期、对象 ID/类型、时间与价格锚点、保存版本和时间。屏幕像素不能直接冒充价格坐标；未知对象类型返回不支持。
- 若存储内容无法可靠解释，先核实公开序列化格式或建立持久化只读投影，再宣称支持图上对象；不能用截图推测代替已保存对象事实。客户端未保存的改动不在后端可见范围。
- Agent 输出区分“数据事实、计算结果、分析推断”，引用具体区间和关键价位。计划建议留在对话中，由用户决定下一步。

## 6. 数据与计算合同

所有市场结果必须携带实际来源、品种身份、系列类型、价格口径、观测时间、查询时间、数据质量；历史结果另外携带周期、日历、覆盖/缺口、修订信息、分页游标。来源名称不能代替可执行账户与券商品种映射。

- 价格/金额等精确十进制返回字符串；指标浮点值遵循现有算法，NaN 输出 null，不能把 null 当 0。
- 报价说明是 bid、ask、last 还是 M1 close，正常休市与数据过期分开。没有真正 quote 时可返回有标签的替代数据，不静默改口径。
- 指标默认使用完整 K 线；如支持未收盘计算，必须显式标记 provisional。保留递归指标历史起点及缺口重置行为，MCP 不单独截一段最近数据重算造成与网页不一致。
- 形态结果包含算法版本、参数、使用的数据区间、形成时间、确认时间与证据点。需要后续 K 线确认的形态不能把未来信息写回成历史当时已知结论；置信度只有算法定义后才返回。
- 限制返回 K 线数量、批量指标数、时间范围、并发与耗时；工具目录说明这些限制。建议首期 K 线默认 300、上限不超过现有 2000，最终按数据路径验证。
- 区分查询已有数据、有限缓存填充和持久历史维护。会创建长期任务或订阅的动作独立注册为写能力。明确管理缓存填充造成的资源成本，不能因为名字叫 get 就完全不设额度。
- 慢速历史下载使用项目持久 job ID 与查询结果工具，不依赖 agent 一直保持连接；初期不依赖客户端可选的 MCP Tasks 支持。
- 业务错误返回稳定 code、message、retryable 与所需上下文，如 `DATA_UNAVAILABLE`、`INSUFFICIENT_HISTORY`、`UNSUPPORTED_CAPABILITY`；协议层校验、认证失败使用适当协议/HTTP 错误。没有数据不报告工具成功取得了完整数据。

## 7. 身份、生命周期及未来交易

现有 `authenticated()` 是浏览器 Cookie + CSRF，不能直接当成 agent 认证。首期为受控客户端提供可撤销、可过期、按 agent 分配的访问凭据，数据库仅存摘要，并绑定 scope；受控静态 Bearer 接入只是部署方案，不宣称它实现了完整 MCP OAuth 授权发现。

目标客户端如依赖标准远程 OAuth 流程，应接合规授权服务，验证 token 的 issuer、audience、有效期与 scope，并提供对应发现信息。MCP 会话 ID 不是身份，也不能把 agent 凭据转发给上游行情或券商。

HTTP/ASGI 集成需要验证：

- `/mcp` 精确路径、尾斜杠、反向代理转发和 SDK endpoint 配置，避免意外变成 `/mcp/mcp`。
- 主 FastAPI lifespan 显式启动/关闭 MCP session manager 或子应用 lifespan；仅 mount 不保证子应用生命周期自动执行。
- 保持既有 bootstrap/provider start/stop 仅按当前设计运行；MCP 注册和客户端连接不能重复启动 worker。
- 验证 Host/Origin、代理信任范围、请求体上限、超时、断连取消；认证保护所有 MCP 请求。正式网络访问使用 HTTPS。
- 初期优先无状态工具调用，业务进度放数据库；若启用有状态会话，扩多进程前再验证会话路由与共享状态。
- 默认不提供独立 stdio 进程，避免每个客户端启动一套后台。确需 stdio 客户端兼容时，可增加连接既有 HTTP 入口的桥接方式。

建议 scopes：`market:read`、`analysis:read`、`charts:read`、`alerts:read`、`alerts:write`、`trading:read`、`trading:execute`。具体读写还需核对账户、品种及资源权限。

未来交易复用 MT4 设计中的持久指令 Interface，MCP 不直接调用 EA。下单采用预检/提交/查询结果，提交授权来自明确的用户交易任务或预先配置的有限执行策略；计划文本、工具描述和报价内容不能给自己授予权限。可绑定账户、最大数量/金额、有效期与品种范围。

`trading_submit_order` 使用稳定幂等键及规范化意图摘要，同键不同意图报冲突；超时先查询原指令。预检不锁定价格，提交和终端执行前都要复核权限、报价、手数步进与相关版本。已接收不等于已成交；结果未知不能自动重新下单。此阶段依赖交易模块自己的防重、租约、核对和恢复机制，不能只靠 MCP 包装保证。

## 8. 实施与验收顺序

1. 对齐最新集成基线，固定协议库版本；以最小 P1 工具验证用户实际使用的 Codex 客户端的初始化、发现和调用，记录客户端版本及连接配置。
2. 提取共享行情/图表查询 Interface，保持既有网页行为；引入注册表、调用上下文和只读权限。
3. 补齐 P1 行情、告警、指标与已保存图上对象读取及 Codex 连接文档，再接 P2 写操作。P3 为可选算法扩展，P4 等待交易模块；不实施计划 CRUD。

验收覆盖：

- 使用 SDK 客户端或 Inspector，通过真实 HTTP 传输完成 initialize、tools/list、tools/call；检查结构化输出，不以直接调 Python 函数替代协议验收。
- 同一数据快照/参数下网页与 MCP 得到相同价格口径、K 线与指标；检查不足历史、陈旧报价、缺口、修订与来源不可用。
- 验证 Codex 实际使用工具完成一次有数据证据的分析并征询用户意见；不以模拟客户端替代 Codex 验收，不以分析文本作为固定形态算法的数值验收。
- 已保存画线读取保持图表身份、锚点、版本一致；验证未保存改动、未知对象和缺失工作区不会被误报为已读取。
- 无凭据、过期、撤销、越权均拒绝；枚举不到的工具也不能通过直接调用绕过权限。
- 注册一个测试能力后能自动发现并调用；注册新指标后通用算法工具可发现，重复 ID 启动失败。
- 写操作重试与并发不会重复创建；审计包含 agent 身份、动作、资源、结果，不记录明文凭据。
- 验证 MCP 开关、主应用生命周期、客户端断连和资源预算，不重复启动后台。
- 未来交易另验重复提交、执行结果未知和重启恢复；不在 P1/P2 声称覆盖交易。

部署验收仅在 Ubuntu 本机 Docker 的独立 Compose project、网络、volume、数据库与端口运行，使用隔离数据和通知配置。交付时记录真实访问地址、启动/停止命令及结果；本轮只有调查文档，没有创建验收实例，也没有变更 unraid 生产。

## 9. Codex 接入与剩余技术验证

产品范围已明确，无需继续追问计划模块或形态类别。实施时核对用户实际 Codex 客户端的 HTTP MCP 与认证配置，验证候选访问凭据方案；具体配置以对应客户端版本和实测为准。

本次尝试获取 [官方 OpenAI Codex MCP 文档](https://developers.openai.com/codex/mcp)及其 Markdown 入口，均返回 Forbidden。因此本修订没有将尚未核实的配置键或认证兼容性写成已验证事实。实施时重新读取官方文档并完成客户端实测；此处只是接入参考入口，不是本次成功读取的证据。

另一个技术验证点是已保存图上对象的结构化读取。先检查本地使用的图表版本和工作区存储，明确可读取对象类型、坐标与新鲜度；第一期不把“agent 能分析价格”当成已经实现了画线读取。

## 10. 2026-10-06 实施记录

开发工作树 `/home/quant/repos/market-watch-native-mcp`，分支 `feat/native-mcp`，最新集成基线 `3c18f60`。交接中的两篇未跟踪方案已复制到此任务工作树保留，原设计工作树及主工作树的其他改动未覆盖。

- 固定 `mcp==2.3.0` 与传递依赖。采用官方 SDK 公开 low-level Server handler Interface，因为项目注册表已拥有完整输入/输出模型和权限目录；无需为同一模型再生成 Python 函数签名。协议仍完整由 SDK 处理。
- 提取 `business.py` 和 `chart_api.query_chart/data_sync`，HTTP 与 MCP 共用价格、告警规则、K 线和指标。平台 `cache_revision` 与管理 `history_revision` 分别保留，不伪造相同语义。
- 注册 13 项 P1/P2 能力；opaque credential 摘要/过期/撤销、scope 过滤及调用授权、配额、并发、超时、取消、审计和事务幂等已实现。交易和内部计划未开放。
- 原生保存文档没有公开可靠的全部 vendor 序列化合同，采用公开图表 API 的保存时只读投影。实测稳定对象类型为 `horizontal_line/trend_line/rectangle` 等 ID，水平线、趋势线、矩形的单图/双图保存刷新已验证。旧文档需重存，未知类型及未保存改动不冒称读取。
- Codex CLI 0.160.0 的 HTTP URL 和 bearer-token-env-var 配置已本机核实；官方 OpenAI MCP 网页与 Markdown 请求仍为 403。实际 Codex HTTP 调用还未运行。

完整运行/扩展合同、私密配置准备、独立 Compose 和待执行验收命令见 [原生 MCP 使用与开发](native-mcp-usage.md)；逐项证据见 [验收记录](verification/native-mcp/acceptance.md)。本条记录不构成生产发布授权，未操作 unraid。
