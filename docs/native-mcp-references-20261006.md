# 原生 MCP 上游参考核查

核查日期：2026-10-06。仅访问第一方文档、GitHub 源码和 PyPI 包元数据；未安装框架、运行 MCP、连接券商或部署实例。本文是技术选型参考，不代表依赖兼容性或端到端验收已完成。

## 建议

Market Watch 首选 **官方 Python SDK + 项目自己的能力注册表 + 共享业务服务**。官方 SDK 已提供函数注册、参数 schema、tools/resources/prompts、Streamable HTTP 和 ASGI 接入，足以实现“新能力注册后即可供 agent 发现和调用”。用户身份、权限、数据归属、审计和交易幂等属于业务边界，应集中在项目的能力调用入口，不交由 REST 自动转换隐式决定。

独立 FastMCP 是合理备选：模块组合、命名空间、过滤和鉴权适配较丰富。如果团队希望直接复用这些能力，可采用它以减少基础设施代码。官方 SDK 与独立 FastMCP 是不同包，不能混用示例；截至本次核查分别已经进入 2.x 与 4.x。[1][2][3]

## 框架比较

| 项目 | 已核实能力 | 本项目定位与限制 |
| --- | --- | --- |
| [官方 Python SDK](https://github.com/modelcontextprotocol/python-sdk)；MIT | `MCPServer`、`@mcp.tool()`、resources/prompts；标准传输；返回 ASGI 应用；`TokenVerifier` 扩展令牌验证 | **推荐协议基础**。项目持有稳定的 capability 定义与调用入口，再由 SDK 适配 MCP；授权、数据库上下文和业务审计仍需项目实现。 |
| [独立 FastMCP](https://github.com/PrefectHQ/fastmcp)；Apache-2.0 | `from fastmcp import FastMCP`；函数工具；子服务 `mount` 与 namespace；HTTP ASGI 挂载；JWT/外部 OAuth 等鉴权扩展；FastAPI/OpenAPI 转换 | **功能较完整的框架备选**。不是官方 SDK 中历史同名类的可直接替代包。默认 `auth=None`，挂载不会自动完成项目数据授权。 |
| [FastAPI-MCP](https://github.com/tadata-org/fastapi_mcp)；MIT | 按 FastAPI OpenAPI 生成 tools；按 operation ID/tag 过滤；ASGI 内部请求；请求头转发；FastAPI 依赖与 AuthConfig 集成；HTTP/SSE 挂载 | **适合已有 REST 的快速试用**。其源码确实从 OpenAPI 转换工具，并非另有业务能力注册层；工具语义与 REST 耦合。注册发生在 setup 阶段，不能假定运行时新增 route 自动热更新。 |

能力及许可证依据：[官方 README/LICENSE][1]、[FastMCP README/LICENSE][2]、[FastAPI-MCP README/LICENSE][4]及下文直接源码。许可证为各仓库自身许可证；不推导交易数据、第三方图表或券商服务的使用授权。

## 版本与维护基线

本次 PyPI 元数据报告 `mcp 2.3.0`、`fastmcp 4.0.11`、`fastapi-mcp 0.4.0`。[3] 这是核查时最新发布元数据，不表示 Market Watch 已采用这些版本。开发时须固定精确版本、生成 lock，并验证现有 FastAPI/Starlette/Pydantic 依赖与生命周期。

读取 GitHub commits API 得到以下默认分支基线；日期是提交时间，不是仓库活动时间：

| 仓库 | commit | 提交时间（UTC） |
| --- | --- | --- |
| Python SDK | `91941ed4d3985d59def99e090baa3f880c626cc8` | 2026-10-05 13:22:35 |
| FastMCP | `5baeacfe20eca735cb949564b4915f93a622b916` | 2026-10-05 01:44:36 |
| FastAPI-MCP | `e5cad13cabfc725bbcb047e526816d887d96da62` | 2025-08-10 09:07:00 |
| Alpaca MCP | `a82ad1ccb740609abc99e10376e42d8e9c1037a1` | 2026-09-25 12:52:24 |

可复核固定 commit 链接：[SDK](https://github.com/modelcontextprotocol/python-sdk/commit/91941ed4d3985d59def99e090baa3f880c626cc8)、[FastMCP](https://github.com/PrefectHQ/fastmcp/commit/5baeacfe20eca735cb949564b4915f93a622b916)、[FastAPI-MCP](https://github.com/tadata-org/fastapi_mcp/commit/e5cad13cabfc725bbcb047e526816d887d96da62)、[Alpaca](https://github.com/alpacahq/alpaca-mcp-server/commit/a82ad1ccb740609abc99e10376e42d8e9c1037a1)。API 事实来自在线文档和默认分支；没有把 main 当作发布 tag。主任务随后成功读取 [SDK v2.3.0 README](https://github.com/modelcontextprotocol/python-sdk/blob/v2.3.0/README.md)，确认该 tag 同样使用 `MCPServer`；完整发布包行为仍应通过锁版后的最小集成测试确认。

## 接入要点

### 官方 SDK

官方当前 README 使用 `from mcp.server import MCPServer`，`@mcp.tool()` 从类型标注和函数文档生成工具描述。[1] 不应照搬旧文章的 `mcp.server.fastmcp.FastMCP` 并假定属于当前 API。

[ASGI 文档](https://py.sdk.modelcontextprotocol.io/run/asgi/)说明：`mcp.streamable_http_app()` 返回 Starlette 应用；可挂到 FastAPI。挂载到 `/mcp` 时，可令内部 `streamable_http_path="/"`，避免路径重复。宿主必须在自己的 lifespan 内进入 `mcp.session_manager.run()`，不能只 mount 后忽略会话管理器；也不能覆盖 Market Watch 原有后台任务与数据库的生命周期。配置真实访问域名对应的 Host/Origin allowlist。

[鉴权文档](https://py.sdk.modelcontextprotocol.io/run/authorization/)提供 `TokenVerifier.verify_token`，返回 `AccessToken` 或 `None`；与 `AuthSettings` 同时配置，后者包括 issuer、resource URL 和 required scopes。SDK 作为资源服务器验证令牌并提供受保护资源元数据，**不负责发行项目令牌**。服务端须从已验证令牌建立用户上下文；工具参数中的 user/account ID 不能替代这一身份。

### 独立 FastMCP

[FastAPI 集成](https://gofastmcp.com/integrations/fastapi)提供两条路径：将 REST 自动转换为 MCP，或将自己定义的 MCP 挂进 FastAPI。对本项目优先采用后者：`mcp.http_app(path="/")` + `app.mount("/mcp", mcp_app)`，并组合原应用与 MCP lifespan。文档明确建议为 LLM 精心设计工具，OpenAPI 转换适合起步与原型，不推荐直接镜像复杂 API。

[组合文档](https://gofastmcp.com/servers/composition)允许按行情、告警、指标、计划划分本地子服务，再挂入统一服务并设置 namespace；本地挂载可反映后续增加的组件。项目仍建议启动时显式装配和检查重名，不把热插拔作为首期要求。

[鉴权文档](https://gofastmcp.com/servers/auth/authentication)说明默认 `auth=None`；支持 TokenVerifier、JWTVerifier、RemoteAuthProvider、OAuthProxy 等。单纯 TokenVerifier 不提供完整 OAuth 发现流程。业务能力 scope、账户归属和订单权限仍必须在调用边界校验，不能把成功登录等同于全部操作授权。

### FastAPI-MCP

[server.py 固定源码](https://github.com/tadata-org/fastapi_mcp/blob/e5cad13cabfc725bbcb047e526816d887d96da62/fastapi_mcp/server.py)中的 `setup_server()` 调用 `get_openapi` 和 `convert_openapi_to_mcp_tools`，然后按 operation ID/tag 过滤；默认转发请求头 allowlist 为 `authorization`。这不意味着项目基于浏览器 cookie 的登录可以直接复用，需显式设计 agent 凭据和身份传播。

README 仍示例 `mcp.mount()`，但该源码已将其标注废弃，默认是 SSE；应参考 `mount_http()` 而非原样复制 README。其 [pyproject](https://github.com/tadata-org/fastapi_mcp/blob/e5cad13cabfc725bbcb047e526816d887d96da62/pyproject.toml)声明 `mcp>=1.12.0` 且未给上界；不能据此认定已验证 SDK 2.x 兼容，需锁版测试。

## 交易适配参考：Alpaca MCP

[Alpaca 官方 MCP](https://github.com/alpacahq/alpaca-mcp-server)是券商具体实现参考，MIT。当前默认分支的 [pyproject](https://github.com/alpacahq/alpaca-mcp-server/blob/a82ad1ccb740609abc99e10376e42d8e9c1037a1/pyproject.toml)为项目版本 `2.3.2`，固定 `fastmcp==3.4.7`，不能把独立 FastMCP 最新版 4.x 与它混同。

值得借鉴的是 [server.py](https://github.com/alpacahq/alpaca-mcp-server/blob/a82ad1ccb740609abc99e10376e42d8e9c1037a1/src/alpaca_mcp_server/server.py) 及 README 中的组织方式：

- `toolsets.py` 按业务分组维护 operation ID allowlist；`tool_registry.py` 管工具名称、描述与输出风险分类。
- 简单功能通过 OpenAPI 生成，复杂下单和历史行情由专门 override/register 函数提供，统一装配到 server。
- 默认 paper 模式，可通过 `ALPACA_TOOLSETS` 缩小能力；若不配置则默认开放全部工具，这个默认值不宜直接照搬到 Market Watch。
- 有 schema/registry 一致性检查、server 构造测试及 paper 订单生命周期集成测试的分层方法。

其 README 明确：远程 MCP OAuth 未配置，HTTP 绑定地址或 Host/Origin 校验不等于认证。它解决的是 Alpaca API 适配，不能直接提供 Market Watch 的本地告警、形态、指标、计划或 MT4 功能，也不能取代项目后续的下单预览、幂等、额度控制、账户归属和结果核对。

因此采用“**框架参考 SDK/FastMCP，交易模块参考 Alpaca 的注册表与适配结构**”，而不是把 Alpaca 作为整个项目的 MCP 核心。

## 注册即暴露的落地规则

以下为项目设计建议，不是上游承诺：

1. 功能实现先成为共享业务服务，HTTP 与 MCP 都调用同一个服务入口。
2. 每项能力注册稳定名称、输入/输出模型、说明、权限 scope、是否有副作用和处理函数；MCP 层从注册表生成工具。
3. 启动时校验重名、模型、权限声明和未实现能力；只注册可用且明确选择开放的功能。
4. tools/list 和 tools/call 都执行权限规则，返回值保留来源、时间、时区、单位、数据新鲜度；行情查询不得把历史缓存描述成实时价格。
5. 未来交易能力分开注册 preview/submit/cancel；注册工具不会自动完成券商连接、交易授权与业务风控。

[1]: https://github.com/modelcontextprotocol/python-sdk/tree/91941ed4d3985d59def99e090baa3f880c626cc8
[2]: https://github.com/PrefectHQ/fastmcp/tree/5baeacfe20eca735cb949564b4915f93a622b916
[3]: https://pypi.org/pypi/mcp/json
[4]: https://github.com/tadata-org/fastapi_mcp/tree/e5cad13cabfc725bbcb047e526816d887d96da62

PyPI 交叉来源：[FastMCP 元数据](https://pypi.org/pypi/fastmcp/json)、[FastAPI-MCP 元数据](https://pypi.org/pypi/fastapi-mcp/json)。
