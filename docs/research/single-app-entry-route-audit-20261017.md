# Market Watch 单应用入口收敛与路由盘点

日期：2026-10-17。基线：`99124bb31069a813798e3bde097b3f2e2997aaba`（`99124bb`，PR #81）。任务分支：`docs/entry-convergence-route-audit-20261017`。本轮仅分析与记录，应用代码、路由和部署均未修改。依据为该提交的第一方源码，覆盖 React 页面、专业图表宿主、数据中心内部导航、HTTP 入口、通知、Android 和 MCP；未把许可库的文档和示例算作产品路由。本轮未访问生产或读取数据库，不能据此判断旧功能无人使用。

具体的后续 URL、导航、登录页面和跳转契约见[路由、导航与登录收敛建议](single-app-routing-navigation-proposal-20261017.md)。

## 方向判断

建议把专业图表作为默认主界面，统一应用导航、登录恢复和返回行为；数据中心、警报、全量信号、通知设置和历史演练围绕它组织。现在后台会话已经共用，专业图表也由 React 宿主承担认证、数据请求、保存和跨来源通信，收敛工作的重点是产品入口与功能归属。

“单应用”建议定义为同一站点、同一会话、一个默认工作界面和一套导航。图表库继续由隔离来源渲染。管理与演练可以拥有可直接访问的 URL；演练适合完整子视图，数据中心沿用现有管理窗口，避免把所有业务都塞进图表弹窗。导航到功能页后应能返回原工作区，并明确处理未保存内容。

旧 `/chart-workspaces` 编辑器可以列入首批退役范围。专业图表内部的工作区新建、保存和切换属于主应用能力，与这个旧路由应使用不同的退役判断。其他旧 React 页面尚有独有职责，需要先承接功能。依据见下表和后续后台证据。

## 当前页面路由总表

这里按 8 类已存在入口及 1 个兜底分支盘点；“建议去向”均为后续建议，没有实施。

| 当前地址 | 当前职责及入口 | 建议去向 | 源码依据 |
| --- | --- | --- | --- |
| `/` | 旧 Dashboard：行情、旧 Watch 创建/列表/取消；旧侧栏品牌和专业图表“守望主页”都回这里。 | 作为统一默认入口，登录后进入专业图表；原 Dashboard 的存量监控管理先移到过渡路径或新壳。 | [main.tsx:249](../../web/src/main.tsx#L249)、[main.tsx:334](../../web/src/main.tsx#L334)、[main.tsx:379](../../web/src/main.tsx#L379) |
| `/advanced-charts` | 专业图表 React 宿主，加载隔离来源 iframe；已自带工作区、告警与数据中心集成。旧侧栏仍标作“专业图表（验证版）”。 | 主应用默认界面；首轮保留这个已用地址，根地址跳转至此，减少路径变更。 | [main.tsx:150](../../web/src/main.tsx#L150)、[main.tsx:260](../../web/src/main.tsx#L260)、[AdvancedWorkspace.tsx:1552](../../web/src/advanced/AdvancedWorkspace.tsx#L1552) |
| `/chart-workspaces`、`/chart-workspaces/:id` | 旧多图编辑器，独立加载旧工作区与模板，使用 lightweight/line-tools 路径。 | 优先撤下主导航；旧 URL 先保留兼容访问。停止旧编辑器前明确历史查看/导出方式，不把旧 ID 当专业工作区 ID。 | [main.tsx:152](../../web/src/main.tsx#L152)、[Workspace.tsx:153](../../web/src/charts/Workspace.tsx#L153)、[Workspace.tsx:185](../../web/src/charts/Workspace.tsx#L185) |
| `/signals`，包括 `?signal=<id>` | 全量信号页，展示旧 Watch 和图表告警、通知状态、手机接收情况、确认及失败重试；ntfy 点击落点。 | 保留兼容路由，逐步接入统一的全量通知/信号入口。专业图表告警日志目前仅覆盖其中一部分。 | [main.tsx:345](../../web/src/main.tsx#L345)、[main.tsx:845](../../web/src/main.tsx#L845)、[main.tsx:932](../../web/src/main.tsx#L932) |
| `/replay`，包括 `?dataset_version=<UUID>` | 历史演练、已保存演练、步进/定位/导出、模拟预警；数据中心会显式跳入。 | 保留路由和固定版本语义，作为主应用中的完整子视图逐步整合。 | [main.tsx:349](../../web/src/main.tsx#L349)、[main.tsx:965](../../web/src/main.tsx#L965)、[AdvancedWorkspace.tsx:270](../../web/src/advanced/AdvancedWorkspace.tsx#L270) |
| `/settings` | ntfy 优先级、夜间静音、真实测试通知、网页声音试听、worker/历史服务/备份健康信息。 | 保留兼容路由；迁入统一设置入口后再退原页面。已有图表样式设置和密码修改不能替代这些职责。 | [main.tsx:353](../../web/src/main.tsx#L353)、[main.tsx:1311](../../web/src/main.tsx#L1311) |
| `/market-data` 及白名单子路径 | 已是兼容地址：登录后转为 `/advanced-charts?data_center=<编码地址>`，再打开图表内的数据中心。 | 沿用现有收敛方式，保留业务子路径、过滤和定位参数。 | [main.tsx:149](../../web/src/main.tsx#L149)、[location.ts:1](../../web/src/market-data/location.ts#L1)、[AdvancedWorkspace.tsx:806](../../web/src/advanced/AdvancedWorkspace.tsx#L806) |
| `/chart-data-center?session=<UUID>` | 数据中心原生界面适配失败时的内部兼容 iframe；需要宿主与会话上下文，不能单独当首页。 | 作为内部兼容端点保留；不能被“统一跳专业图表”的通配规则吞掉。 | [main.tsx:148](../../web/src/main.tsx#L148)、[data-center.js:135](../../advanced-host/data-center.js#L135)、[Window.tsx:118](../../web/src/market-data/Window.tsx#L118) |
| 其他路径 `*` | 旧 Shell 内显示“页面不存在”，回到根地址。部分前缀先经过 App 手工分派。 | 收敛时统一有效路径、末尾斜线和未知路径处理，明确返回主应用的行为。 | [main.tsx:148](../../web/src/main.tsx#L148)、[main.tsx:361](../../web/src/main.tsx#L361) |

**登录不是独立页面路由。** 当前没有注册 `/login`：`App` 在原访问地址内检查 `/api/session`，未登录时显示登录表单，成功后 `setLogged(true)`，继续分派同一 URL。因此访问 `/` 后登录会进入旧 Dashboard；直接访问 `/advanced-charts` 后登录已经会进入专业图表。默认收敛只需改变根地址的产品含义，并保留显式业务深链接。[main.tsx:64](../../web/src/main.tsx#L64)、[main.tsx:80](../../web/src/main.tsx#L80)、[main.tsx:95](../../web/src/main.tsx#L95)。

当前旧侧栏共有六个入口：行情与监控、图表工作区、专业图表、信号中心、历史演练、提醒与设置。[main.tsx:256](../../web/src/main.tsx#L256)。专业图表菜单则是“守望主页”、历史容量、样式、历史刷新、改密码和退出等；返回主页会重新载入 `/`，目前未把全量信号、通知设置和演练组织成同一套导航。[bridge.js:2317](../../advanced-host/bridge.js#L2317)、[AdvancedWorkspace.tsx:790](../../web/src/advanced/AdvancedWorkspace.tsx#L790)。

`web/src/MarketDataPage.tsx` 仍有旧数据管理实现，但全源码检索仅命中其定义，当前主入口与构建入口均未引用；它是后续死代码核查候选，不是额外的在用路由。[MarketDataPage.tsx:67](../../web/src/MarketDataPage.tsx#L67)。

## 数据中心的内部路由与状态

这些是现有数据中心中的业务地址。直接访问时由上一节的兼容跳转接入专业图表，不代表另一套应用。

| 地址/状态 | 业务内容 | 源码依据 |
| --- | --- | --- |
| `/market-data?tab=managed`，省略 tab 时同此 | 自建行情 | [Center.tsx:68](../../web/src/market-data/Center.tsx#L68) |
| `?tab=platform`、`composite`、`tasks`、`sources`、`calendar` | 平台行情、组合行情、任务与记录、来源状态、交易日历 | [Window.tsx:12](../../web/src/market-data/Window.tsx#L12)、[Center.tsx:67](../../web/src/market-data/Center.tsx#L67) |
| `/market-data/platform/configure?instrument=...` | 平台行情配置 | [Center.tsx:59](../../web/src/market-data/Center.tsx#L59) |
| `/market-data/datasets/new` | 创建数据集 | [Center.tsx:61](../../web/src/market-data/Center.tsx#L61) |
| `/market-data/datasets/<64位十六进制ID>` | 数据集详情；section 支持 overview、coverage、versions、maintenance、references、chart、seam、usage；另有版本、周期及分页参数 | [Center.tsx:63](../../web/src/market-data/Center.tsx#L63)、[location.ts:24](../../web/src/market-data/location.ts#L24) |
| `/market-data/datasets/<ID>/mapping` | 数据映射配置 | [Center.tsx:62](../../web/src/market-data/Center.tsx#L62)、[location.ts:2](../../web/src/market-data/location.ts#L2) |
| `/market-data/composites/<64位十六进制ID>` | 组合详情与固定修订相关视图 | [Center.tsx:65](../../web/src/market-data/Center.tsx#L65)、[location.ts:2](../../web/src/market-data/location.ts#L2) |

现有 `centerLocation` 会白名单过滤路径和 query，保留允许的 hash、return_to/return_key；数据中心还按工作区保存分区、滚动及返回上下文。主应用应复用这些语义。[location.ts:6](../../web/src/market-data/location.ts#L6)、[Window.tsx:42](../../web/src/market-data/Window.tsx#L42)、[Window.tsx:72](../../web/src/market-data/Window.tsx#L72)。

专业图表已识别的产品打开参数是 `data_center` 和 `platform`：前者打开指定数据中心地址，后者会创建平台行情工作区；打开后对应参数会被清理。当前没有按 URL 指定专业工作区或信号 ID 的完整恢复契约；普通启动取的是按 updated_at 排序的首个工作区，不能称为已实现“恢复上次访问工作区”。[AdvancedWorkspace.tsx:84](../../web/src/advanced/AdvancedWorkspace.tsx#L84)、[AdvancedWorkspace.tsx:207](../../web/src/advanced/AdvancedWorkspace.tsx#L207)、[AdvancedWorkspace.tsx:806](../../web/src/advanced/AdvancedWorkspace.tsx#L806)、[advanced_api.py:259](../../backend/alerts/advanced_api.py#L259)。

## 功能承接缺口

| 能力 | 专业图表现状 | 对收敛的影响 |
| --- | --- | --- |
| 看盘、原生布局、画线、指标、工作区保存 | 已集成。宿主承担数据、保存、偏好和隔离通信。 | 可以承接默认主界面。 |
| 数据管理 | 已有图表内数据中心及旧地址兼容；仍有内部 fallback 端点。 | 继续沿用，保留深链接与 fallback。 |
| 图表告警与事件确认 | 已有警报列表、图表告警日志、定位与确认；读取 `/chart-alerts/events`。 | 可继续作为图表侧面板，但全量信号需要补齐旧 Watch 范围。 |
| 旧策略管理 | 新旧规则分别持久化，专业图表不管理旧 Watch。 | 根页替换时至少保留旧 Watch 列表、状态和取消能力。 |
| 通知与声音设置 | 图表设置、告警配置、密码修改已集成；ntfy 全局设置和测试仍在 `/settings`。旧 Shell 的网页新信号声音由自身 AudioContext、`/api/events` 和轮询驱动。 | 需定义全局通知设置与网页声音归属，不能把图表的状态提示当成完整通知系统。 |
| 演练 | 数据中心会跳到独立 `/replay`；该页承担固定历史版本、模拟规则与导出。 | 保留完整子视图，迁入同一导航后再退旧外壳。 |
| 手机和首次使用 | coarse pointer 设备走只读图表；确认事件是允许的例外。没有工作区时显示创建提示，但手机不能新建。 | 默认入口切换要覆盖已有工作区、空账号、手机三种情况，提供可达的通知/设置和明确空态。 |

事实依据：[AdvancedWorkspace.tsx:90](../../web/src/advanced/AdvancedWorkspace.tsx#L90)、[AdvancedWorkspace.tsx:207](../../web/src/advanced/AdvancedWorkspace.tsx#L207)、[AdvancedWorkspace.tsx:334](../../web/src/advanced/AdvancedWorkspace.tsx#L334)、[AdvancedWorkspace.tsx:1476](../../web/src/advanced/AdvancedWorkspace.tsx#L1476)、[AdvancedWorkspace.tsx:1563](../../web/src/advanced/AdvancedWorkspace.tsx#L1563)、[ChartAlertsPanel.tsx:121](../../web/src/advanced/ChartAlertsPanel.tsx#L121)、[ChartAlertsPanel.tsx:203](../../web/src/advanced/ChartAlertsPanel.tsx#L203)、[main.tsx:192](../../web/src/main.tsx#L192)、[main.tsx:214](../../web/src/main.tsx#L214)、[main.tsx:224](../../web/src/main.tsx#L224)、[main.tsx:1311](../../web/src/main.tsx#L1311)、[bridge.js:2348](../../advanced-host/bridge.js#L2348)。

## 后台与数据边界的主要结论

1. **后台已经是一套应用会话。** 专业图表、旧图表、数据中心、策略和通知均进入同一个 FastAPI app；各业务 router 接收同一 `authenticated` 依赖。统一登录默认落点主要是前端导航决策，后台登录响应只有 `csrf`，没有跳转地址。证据：[api.py:92](../../backend/alerts/api.py#L92)、[api.py:104](../../backend/alerts/api.py#L104)、[api.py:138](../../backend/alerts/api.py#L138)、[api.py:1020](../../backend/alerts/api.py#L1020)。
2. **旧“图表工作区”的页面退役与 `/api/charts` 退役是两件事。** 旧页面实际使用 `/chart-workspaces`、`/chart-workspaces/:id`，`/charts` 是其请求使用的业务 API 前缀；专业图表仍调用该前缀中的行情、历史容量、历史任务、储备、导出、订阅与 SSE 接口。证据：[Workspace.tsx:378](../../web/src/charts/Workspace.tsx#L378)、[Workspace.tsx:412](../../web/src/charts/Workspace.tsx#L412)、[AdvancedWorkspace.tsx:240](../../web/src/advanced/AdvancedWorkspace.tsx#L240)、[AdvancedWorkspace.tsx:711](../../web/src/advanced/AdvancedWorkspace.tsx#L711)、[AdvancedWorkspace.tsx:1290](../../web/src/advanced/AdvancedWorkspace.tsx#L1290)、[nativeHistoryLoads.ts:39](../../web/src/advanced/nativeHistoryLoads.ts#L39)。
3. **旧工作区有独立、尚未证明可丢弃的持久数据。** `chart_workspaces` 保存旧图表文档，`chart_indicator_templates` 保存旧指标模板；专业图表使用另外的 `advanced_chart_workspaces`、`advanced_chart_preferences`。不能把两种 workspace ID 或 JSON 文档互换。证据：[storage.py:1109](../../backend/alerts/storage.py#L1109)、[storage.py:1217](../../backend/alerts/storage.py#L1217)、[chart_api.py:260](../../backend/alerts/chart_api.py#L260)、[advanced_api.py:304](../../backend/alerts/advanced_api.py#L304)。
4. **旧工作区还有 MCP 消费者和历史回收约束。** `charts_list_workspaces`、`charts_get_drawings` 公开支持 `engine=legacy`，直接读取 `ChartWorkspace`；历史数据回收也把旧工作区中的引用作为阻挡条件。证据：[capabilities/actions.py:401](../../backend/alerts/capabilities/actions.py#L401)、[capabilities/models.py:113](../../backend/alerts/capabilities/models.py#L113)、[capabilities/drawings.py:63](../../backend/alerts/capabilities/drawings.py#L63)、[history_retention.py:186](../../backend/alerts/history_retention.py#L186)。
5. **通知仍深链到旧 React 页面。** 正式 ntfy 推送点击 `/signals?signal=<id>`，测试通知点击 `/settings`。其中 `/api/signals` 覆盖旧策略和图表告警事件，专业图表的 `/api/chart-alerts/events` 只返回图表告警事件；不能直接把全部旧信号链接替换成图表告警列表而声称功能等价。证据：[notify.py:109](../../backend/alerts/notify.py#L109)、[api.py:321](../../backend/alerts/api.py#L321)、[business.py:264](../../backend/alerts/business.py#L264)、[chart_alert_api.py:192](../../backend/alerts/chart_alert_api.py#L192)。

## 后台 HTTP 与静态入口

| 入口/路由族 | 当前行为及边界 | 证据 |
| --- | --- | --- |
| 业务网站任意路径 | Docker 的 web Nginx 使用 `try_files $uri $uri/ /index.html`，页面路径由 React 解释；不是后端各写一份页面。 | [web/nginx.conf:33](../../web/nginx.conf#L33) |
| `/api/*` | web Nginx 统一代理到 API；关闭响应缓冲，读超时 3600 秒，兼容图表 SSE。改入口时应保留 API/SSE 代理语义。 | [web/nginx.conf:22](../../web/nginx.conf#L22) |
| `/healthz`、`/readyz` | Nginx 显式代理 API 健康检查；不应被页面跳转吞掉。 | [web/nginx.conf:10](../../web/nginx.conf#L10)、[api.py:372](../../backend/alerts/api.py#L372) |
| `/mcp`、`/mcp/` | Nginx 显式代理；API 仅在 `mcp_enabled` 时于 lifespan 添加 GET/POST/DELETE/OPTIONS 路由；使用独立 agent Bearer 凭证。 | [web/nginx.conf:12](../../web/nginx.conf#L12)、[api.py:63](../../backend/alerts/api.py#L63)、[mcp/auth.py:91](../../backend/alerts/mcp/auth.py#L91) |
| `alerts.site` 的 `/assets` | 另一种单主机部署方式，从 `web/dist/assets` 直接挂载静态资源。 | [site.py:11](../../backend/alerts/site.py#L11) |
| `alerts.site` 的页面 fallback | 只允许根路径、`/signals`、`/replay`、`/settings`；`/advanced-charts`、`/chart-workspaces`、`/market-data/*` 均不在此白名单，直接访问会 404。 | [site.py:17](../../backend/alerts/site.py#L17) |
| chart-origin 静态站 | 静态 `try_files ... =404`，没有 SPA fallback；CSP 的 `connect-src 'none'` 阻止图表源直接向网络 API 发请求；只显式代理数据中心的两个公开静态资产。 | [advanced-host/nginx.conf:24](../../advanced-host/nginx.conf#L24)、[advanced-host/nginx.conf:29](../../advanced-host/nginx.conf#L29) |

**部署事实及适用范围：** 根 Dockerfile 的默认命令是 `alerts.api:app`，网站由独立 web 镜像提供；生产模板仍分别定义 web 与 chart-origin。仓库也保留 systemd 的 `alerts.site:app` 服务文件。因此这次发现的是**两套已提交配置的路由覆盖不一致**，不等于已核实生产在运行哪一套旧配置。证据：[Dockerfile:22](../../Dockerfile#L22)、[web/Dockerfile:9](../../web/Dockerfile#L9)、[compose.production.yaml:159](../../compose.production.yaml#L159)、[trading-alerts-api.service:9](../../deploy/systemd/trading-alerts-api.service#L9)。

**建议：** 用户看到的一套应用可以继续使用隔离 chart-origin。不要把“一个入口”顺带解释为取消 iframe 隔离或合并 origin；这是另一个安全与许可边界变更。现有 overlay 明确要求 `VITE_ADVANCED_CHART_ORIGIN` 为独立 HTTPS 图表源。证据：[compose.advanced.yaml:4](../../compose.advanced.yaml#L4)。

## API 路由族与退役边界

| 路由族 | 现有职责 | 对页面收敛的判断 |
| --- | --- | --- |
| `/api/login`、`/api/session`、`/api/logout`、`/api/account/password` | 管理员登录、会话、退出、密码修改。 | 保留同一套服务；改默认页面无需另建鉴权。 |
| `/api/instruments`、`/api/candles`、`/api/watches*`、`/api/session-range` | 旧策略和行情业务。 | 页面可逐步退役，业务接口不能随导航一起删除。 |
| `/api/signals`、`/api/notifications/*`、`/api/events` | 信号、确认、失败重试与事件流。 | 与真实通知链路关联，先明确替代交互。 |
| `/api/settings/notifications`、`/api/notification-tests*`、`/api/devices*`、`/api/device/*` | 通知设置、实测推送、Android 配对、设备收件/确认。 | 旧设置页退役前需把这些能力移入新壳；设备和通知动作接口仍需保留。 |
| `/api/imports*`、`/api/replays*` | 导入、回放、回放导出及固定数据版本。 | 数据中心仍会跳 `/replay`；页面下线需要功能接替。 |
| `/api/charts/*` | 共享图表数据、provider、导出、旧工作区与模板、历史能力。 | 只能细分，不可整个按旧页删除。 |
| `/api/charts/stream/*` | 统一行情订阅、接受、取消和 SSE。 | 专业图表依赖，保留。 |
| `/api/advanced-charts/*` | 专业图表工作区、原生图表保存、模板和偏好。 | 新应用的核心持久化接口，保留。 |
| `/api/market-data/*`（含 history/composite/live router） | 数据中心、品种搜索/解析、历史、组合、实时状态。 | 专业图表和原生数据中心依赖，保留。 |
| `/api/chart-alerts/*` | 专业图表告警 CRUD、生命周期、几何与日志。 | 专业图表依赖，保留。 |

路由事实来源：[api.py:108](../../backend/alerts/api.py#L108)、[api.py:200](../../backend/alerts/api.py#L200)、[api.py:254](../../backend/alerts/api.py#L254)、[api.py:554](../../backend/alerts/api.py#L554)、[api.py:605](../../backend/alerts/api.py#L605)、[api.py:706](../../backend/alerts/api.py#L706)、[api.py:822](../../backend/alerts/api.py#L822)、[api.py:1020](../../backend/alerts/api.py#L1020)、[chart_api.py:385](../../backend/alerts/chart_api.py#L385)、[market_stream_api.py:122](../../backend/alerts/market_stream_api.py#L122)、[advanced_api.py:110](../../backend/alerts/advanced_api.py#L110)、[market_data.py:535](../../backend/alerts/market_data.py#L535)、[history_api.py:113](../../backend/alerts/history_api.py#L113)、[composite_api.py:50](../../backend/alerts/composite_api.py#L50)、[live_api.py:30](../../backend/alerts/live_api.py#L30)、[chart_alert_api.py:152](../../backend/alerts/chart_alert_api.py#L152)。表中退役判断是建议，不是本次代码变更。

## 登录与默认落点约束

已确认：

- `Credentials` 仅含 password。`POST /api/login` 建立数据库 `LoginSession`，设置 HTTP-only、Secure 可配置、SameSite Strict 的 `session` cookie，返回 `{csrf}`；没有后端重定向或 `next` 字段。[api.py:104](../../backend/alerts/api.py#L104)、[api.py:131](../../backend/alerts/api.py#L131)。
- 所有业务 router 使用同一个 cookie 会话，未登录/过期返回 401；非 GET/HEAD/OPTIONS 需要 `X-CSRF-Token`，失败返回 403。[api.py:92](../../backend/alerts/api.py#L92)、[api.py:1020](../../backend/alerts/api.py#L1020)。
- 前端 API 客户端请求根路径 `/api${path}`，写操作携带同源凭据与 CSRF；因此专业图表作为同一网站的页面无需第二次登录。[web/src/api.ts:39](../../web/src/api.ts#L39)、[web/src/api.ts:112](../../web/src/api.ts#L112)。
- 修改密码可使其他会话失效，保留这一账户能力不能只保留登录按钮。[api.py:169](../../backend/alerts/api.py#L169)、[api.py:188](../../backend/alerts/api.py#L188)。
- 通知确认使用独立短用途 Bearer grant，Android 使用设备 token，MCP 使用 agent credential；三者均不等于网页登录会话，不能统一重定向到登录 HTML。[api.py:285](../../backend/alerts/api.py#L285)、[api.py:585](../../backend/alerts/api.py#L585)、[mcp/auth.py:100](../../backend/alerts/mcp/auth.py#L100)。
- **真正的页面回跳机制是保留原 URL。** `App` 首次挂载调用 `/api/session`；未登录时直接在当前 pathname 渲染登录表单，成功后仅 `setLogged(true)`，没有独立 `/login` 页、`navigate` 或 return-to 参数。因此直接打开 `/advanced-charts` 后登录会进入图表，直接打开 `/signals?signal=...` 后登录仍在该地址；根路径才落旧 Dashboard。[main.tsx:64](../../web/src/main.tsx#L64)、[main.tsx:80](../../web/src/main.tsx#L80)、[main.tsx:95](../../web/src/main.tsx#L95)、[main.tsx:148](../../web/src/main.tsx#L148)、[main.tsx:332](../../web/src/main.tsx#L332)。
- 会话失效的现有行为需区分：刷新后会因首次 session 失败显示当前地址的登录；**已经打开的页面**后续请求 401 时 API 客户端只抛 `ApiError`，不会集中把 `logged` 改为 false。统一入口实现时应明确这项已有缺口的处理范围，不能把“自动回登录再回跳”写成已具备的事实。[main.tsx:71](../../web/src/main.tsx#L71)、[web/src/api.ts:138](../../web/src/api.ts#L138)、[main.tsx:207](../../web/src/main.tsx#L207)。
- 专业图表的 home/退出动作当前均 `location.assign('/')`；退出之前会先尝试保存未保存图表。根地址转专业图表后，home 的含义与旧策略管理的替代入口也要一起定义。[AdvancedWorkspace.tsx:790](../../web/src/advanced/AdvancedWorkspace.tsx#L790)。

建议的行为契约：普通根地址登录后进入专业图表；显式打开兼容旧路由的用户仍能回到原目的地。保留 query/hash（通知的 signal、回放的 dataset_version、数据中心的定位信息），并验证会话过期再登录后的恢复。默认入口与旧路由跳转应收敛到一处规则，不在 Nginx、Python 与 React 各写互相冲突的规则。前端已有参数、内部入口及尚未实现的恢复行为见前面的页面总表和数据中心盘点。

## 通知、移动端、数据中心和脚本外部入口

| 来源 | 已确认目标 | 迁移含义 |
| --- | --- | --- |
| ntfy 正式推送 | `PUBLIC_URL/signals?signal=<id>`；包含独立 POST `notification-actions/<id>/ack`，其 Bearer grant 处理确认。 | 首次收敛保留 `/signals` 兼容。未来改成专业图表深链，须落到具体事件并可确认；旧消息已经发出的 URL 无法靠以后修改生成器更新。 |
| ntfy 测试推送 | `PUBLIC_URL/settings`，另有 POST 测试确认 URL。 | 设置页退役时同步处理新测试通知落点，继续兼容已发旧链接。 |
| 设备配对响应 | 返回 `server_url=settings.public_url` 和设备 token。 | 网站 origin 若不改变不需重新配对；如改 origin 则属于独立设备兼容问题。 |
| Android Companion | 通知点击原生 `MainActivity`；每 5 秒同步 `/api/device/sync` 并调用 `/received`、`/ack`。 | 不依赖网站图表页路由；保留设备协议即可。客户端明确不跟随 HTTP 重定向。 |
| 图表数据中心打开回放 | postMessage 仅允许 `/replay` 或 `/replay?dataset_version=<UUID>`；宿主页调用 `location.assign`。 | `/replay` 仍是活跃功能入口。即使从主导航移除，也要保留路由并保持固定版本参数。 |
| 运维/验收脚本 | `verify_managed_compatibility.py`、`verify_ten_year_replays.py` 直接调用 `/api/replays`、step、seek、export。 | 这些是 API 消费者，不能因“旧回放页面”减少 API 兼容。 |

证据：[notify.py:99](../../backend/alerts/notify.py#L99)、[notify.py:114](../../backend/alerts/notify.py#L114)、[api.py:285](../../backend/alerts/api.py#L285)、[api.py:321](../../backend/alerts/api.py#L321)、[api.py:605](../../backend/alerts/api.py#L605)、[ReminderService.java:35](../../mobile/src/app/marketwatch/reminder/ReminderService.java#L35)、[ReminderService.java:49](../../mobile/src/app/marketwatch/reminder/ReminderService.java#L49)、[AndroidManifest.xml:9](../../mobile/AndroidManifest.xml#L9)、[advanced-host/data-center.js:245](../../advanced-host/data-center.js#L245)、[AdvancedWorkspace.tsx:270](../../web/src/advanced/AdvancedWorkspace.tsx#L270)、[verify_managed_compatibility.py:65](../../scripts/verify_managed_compatibility.py#L65)、[verify_ten_year_replays.py:42](../../scripts/verify_ten_year_replays.py#L42)。

事件范围的实际差异：旧信号列表查询 SignalRow 与 Notification，不按 chart_alert_id 筛选，并返回 watch_id 和 chart_alert_id；专业图表事件接口明确过滤 `SignalRow.chart_alert_id.is_not(None)`。所以通知迁移必须决定“旧策略信号仍去旧信号页”或“在新壳加入覆盖全部信号的收件箱”，不能仅改 pathname。[business.py:264](../../backend/alerts/business.py#L264)、[chart_alert_api.py:192](../../backend/alerts/chart_alert_api.py#L192)。

定位能力的现状：ntfy 已生成 `?signal=`，但当前 `Signals` 组件直接渲染传入 signals 列表，没有读取该 query 或按 ID 滚动/筛选；旧 URL 目前是“进信号页”而不是已经完成的事件定位。保留旧链接的兼容性和未来增加精确定位应分别记录。[main.tsx:845](../../web/src/main.tsx#L845)、[main.tsx:875](../../web/src/main.tsx#L875)。

邮件审计范围：在 `backend/alerts`、`mobile`、`scripts`、`advanced-host` 的第一方源码中检索 SMTP/sendmail/mailto/email 发送与 UI 深链，本次未找到邮件发送器或邮件内页面链接；命中的 `email.utils` 用于 HTTP 日期解析。当前已确认的外部消息实现是 ntfy 和 Companion，此结论不覆盖仓库外自动化或生产反向代理配置。[notify.py:129](../../backend/alerts/notify.py#L129)、[api.py:634](../../backend/alerts/api.py#L634)、[provider_yahoo.py:11](../../backend/alerts/provider_yahoo.py#L11)。

## 旧图表工作区的持久化与依赖

| 数据 | 旧图表工作区 | 专业图表 |
| --- | --- | --- |
| 工作区表 | `chart_workspaces` | `advanced_chart_workspaces` |
| 文档格式 | schemaVersion、layout、splitX/splitY、panels、sync、drawings；panels 内含品种、周期、指标、时区、视区；画线是旧工具名称与 timestamp/price 锚点。 | engine=`tv31`、schemaVersion、symbol/series_kind/interval，以及不透明图表 state；原生保存适配器维护相同专业工作区表。 |
| 模板/偏好 | `chart_indicator_templates`（指标列表） | `advanced_chart_preferences`（study/drawing/chart/setting 内容及 revision） |
| CRUD | `/api/charts/workspaces`，save/copy/delete；`/api/charts/templates`。 | `/api/advanced-charts/workspaces`，save/delete；native-charts 与 preferences 接口。 |
| 并发写入 | workspace revision 乐观锁，冲突 409；复制会重建画线 ID。 | workspace/native/preferences 同样有 revision 冲突保护。 |

格式与接口证据：[storage.py:1109](../../backend/alerts/storage.py#L1109)、[storage.py:1217](../../backend/alerts/storage.py#L1217)、[chart_api.py:260](../../backend/alerts/chart_api.py#L260)、[chart_api.py:610](../../backend/alerts/chart_api.py#L610)、[chart_api.py:676](../../backend/alerts/chart_api.py#L676)、[chart_api.py:703](../../backend/alerts/chart_api.py#L703)、[advanced_api.py:198](../../backend/alerts/advanced_api.py#L198)、[advanced_api.py:283](../../backend/alerts/advanced_api.py#L283)、[advanced_api.py:304](../../backend/alerts/advanced_api.py#L304)、[advanced_api.py:124](../../backend/alerts/advanced_api.py#L124)。

已确认的额外依赖：

- MCP 的 legacy workspace/画线查询直接读取旧表；专业表缺少已验证 projection 时会报不支持，而不是自动从旧表迁移。[capabilities/drawings.py:63](../../backend/alerts/capabilities/drawings.py#L63)、[capabilities/drawings.py:136](../../backend/alerts/capabilities/drawings.py#L136)。
- 后台历史回收把 ChartWorkspace.document 和 AdvancedWorkspace.document 都作为引用扫描对象；清掉旧工作区可能同时解除某历史数据集的回收阻挡。移除入口与删除数据因此风险不同。[history_retention.py:88](../../backend/alerts/history_retention.py#L88)、[history_retention.py:191](../../backend/alerts/history_retention.py#L191)。
- 名为 `migrate_legacy_templates` 的函数只读取 **AdvancedWorkspace.document.templates**，写入 AdvancedPreference，并保存一次性 marker；它没有读取 ChartTemplate 或 ChartWorkspace。不能用该函数名当作“旧图表工作区已经迁移”的证据。[advanced_api.py:72](../../backend/alerts/advanced_api.py#L72)。
- MCP 的图表数据能力直接复用 chart_api 的 DataQuery/query_chart；即使未来 HTTP 层拆旧 workspace CRUD，也不能删除整个 chart_api 或共享行情计算。[capabilities/actions.py:8](../../backend/alerts/capabilities/actions.py#L8)、[capabilities/actions.py:115](../../backend/alerts/capabilities/actions.py#L115)。
- 备份工具按 Base.metadata 的所有表统计并做全库备份；现有旧工作区表属于数据库备份范围，页面隐藏后不会自动从备份消失。[backup.py:65](../../backend/alerts/backup.py#L65)、[backup.py:103](../../backend/alerts/backup.py#L103)。

尚未确认：生产 `chart_workspaces`、`chart_indicator_templates` 的实际行数、最后更新时间、使用频率；浏览器是否仍有未保存内容；仓库外 MCP 调用者是否在使用 engine=legacy；是否已有手工导出的历史工作区。只读源码不能回答这些问题，本次未触碰生产。

## 旧 Watch 管理不能随根 Dashboard 消失

已确认：旧策略 `Watch` 与专业图表 `ChartAlert` 是分别持久化的 `watches`、`chart_alerts`，两套 owner/lifecycle；专业图表告警列表不会自动接管旧 watch。[storage.py:669](../../backend/alerts/storage.py#L669)、[storage.py:733](../../backend/alerts/storage.py#L733)、[chart_alert_api.py:177](../../backend/alerts/chart_alert_api.py#L177)。

旧 Dashboard 当前包含“我的监控”的 active/paused 状态、创建按钮和取消按钮；取消调用 `/api/watches/:id/cancel`，后台将 active watch 写为 cancelled 并记录审计。这既是旧策略管理入口，也是在后台持续执行时的用户停止入口。[main.tsx:439](../../web/src/main.tsx#L439)、[main.tsx:554](../../web/src/main.tsx#L554)、[main.tsx:611](../../web/src/main.tsx#L611)、[business.py:249](../../backend/alerts/business.py#L249)。

后台 realtime-worker 循环调用 market.once/import_once；行情处理会查询 active Watch 并 evaluate_watch，价格 tick 路径同样按 active Watch 运行，触发后建立 SignalRow、Notification、Outbox。关闭或替换旧 Dashboard 不会取消这些数据库里的监控，也不会停止真实通知。[realtime_worker.py:41](../../backend/alerts/realtime_worker.py#L41)、[market.py:578](../../backend/alerts/market.py#L578)、[service.py:202](../../backend/alerts/service.py#L202)、[service.py:457](../../backend/alerts/service.py#L457)、[service.py:409](../../backend/alerts/service.py#L409)。

**建议：** 根地址改专业图表时，把原 Dashboard 迁到明确的兼容路径（例如 `/legacy/monitoring`，这是建议的新路径而非现存路由），或先把 watch 的列表/状态/取消能力接入新壳；至少保留一个明显的管理入口。不要在入口调整中隐式取消旧监控，也不要让它们继续执行而失去用户控制入口。相应历史信号与投递失败重试仍由旧 Signals 承接，直到新壳覆盖同等业务范围。[main.tsx:932](../../web/src/main.tsx#L932)。

## 建议的收敛顺序与这次可下线的范围

1. **先收敛默认入口和导航。** 普通用户访问根地址/登录后进入专业图表；旧 React 路由继续可达，明确为兼容入口。对应通知和回放链接先保持可用。
2. **旧图表工作区可以先从主要导航下线并停止新建。** 若要立即停止旧编辑器渲染，原路由需要承接“已退役、查看/导出历史数据”的兼容页；至少让历史 workspace ID 有可解释的落点。不能直接把旧 ID 交给专业图表 save/load，也不能为清 UI 顺手删表。
3. **保留共享 `/api/charts/*` 和全部后台告警/采集/回放能力。** 可另做精细依赖清理，区分 legacy workspace/template CRUD 与新图表共享服务；保留 MCP legacy 读取直到其契约单独退役。
4. **功能逐个迁进新壳再退 React 页面。** 设置涉及账户、设备、通知测试；信号涉及旧策略；回放还有数据中心深链。每项均应先定义新入口与参数映射。
5. **旧数据清理单独立项。** 若只是隐藏入口/加兼容跳转，不需要 schema 迁移。若转存/删除工作区、改变历史回收引用或移除 MCP legacy 支持，则已越过纯 UI 范围，需独立定义备份、数据映射、回滚和兼容验收。

上述为建议，不表示本次已实施。最小后续验收应覆盖：根地址首次登录、已有会话、显式旧路由、过期后登录恢复、已发送通知的 signal 链接与确认、带 dataset_version 的回放、直接刷新专业图表/数据中心、共享图表 SSE 与历史加载、旧 workspace/MCP 读取及数据引用保留。

## 建议的首批改动与后续阶段

首批聚焦以下范围，预计为兼容 UI/路由变更 F0；实际实现前按最终 diff 复核分类：

1. `/` 登录后进入现有 `/advanced-charts`，已有会话访问根地址也得到相同结果；旧业务显式地址保持目的地。
2. 从主导航撤下旧“图表工作区”，旧 URL 先保留兼容访问；停止新建和停止渲染旧编辑器分别确认，避免把撤菜单扩大成数据删除。
3. 将旧 Dashboard 的存量 Watch 管理放到明确的兼容路径，例如 `/legacy/monitoring`。这是建议新增路径，当前尚不存在；首次切换必须让旧监控仍可查看与停止。
4. 复用专业图表现有左上角“守望”菜单提供信号、设置、演练等路径，在其他功能页提供返回图表入口；调整当前“守望主页”的含义及旧“专业图表（验证版）”标签。专业图表布局保持不变，不增加导航栏或常驻侧栏。数据中心只保留图表中已有按钮，不重复列入守望菜单。路由由可信父宿主处理，图表子来源只发明确导航意图。
5. 覆盖无工作区、手机只读、未保存退出/切页，以及实际使用的 HTTP fallback。统一默认落点不吞掉 API、通知动作或内部数据中心窗口。

下一阶段优先把全量信号/通知和全局通知设置接入同一应用，再整合演练外壳。页面可以保留自己的 URL，重载和浏览器后退应恢复业务上下文；旧地址在接替能力完成前保持兼容。数据中心的筛选、版本和返回状态已有实现，可作为复用基础。路由和重页面按需加载，避免把管理页加载成本全部加到看盘首屏；本轮未测量包体或启动耗时，不承诺性能数字。

最后再处理旧编辑器源码、模板/布局迁移、MCP legacy 契约以及旧表清理。涉及持久格式、重要通知后台链路或数据回收语义时，风险按 F1 或更高重新评估；独立定义兼容、备份和恢复证据。

UX 取舍参考本次 `ui-ux-pro-max` 的导航检查：关键功能保留可分享深链接，核心导航持续可达，返回恢复状态，复杂主流程使用完整视图。React 查询命中按需加载建议；实现依据仍以本仓库 React 19 和 Router 7 的实际接口为准，本轮没有设计新视觉系统。

## 后续实施的最小验证清单与本轮验证范围

| 场景 | 后续需要验证的结果 |
| --- | --- |
| 无会话访问 `/`、有会话访问 `/` | 均进入专业图表主流程；无会话先显示登录。 |
| 未登录直接访问信号、设置、演练及数据中心旧链接 | 登录后仍到对应功能，保留允许的 query/hash；没有统一回首页丢目的地。 |
| 旧工作区 URL 与数据 | 兼容访问或明确退役承接可用；旧数据与 MCP 读取无意外变化。 |
| 旧 Watch | 列表、状态、取消入口可达；导航调整不会隐式改变后台监控状态。 |
| 全量信号与已发 ntfy 链接 | 旧策略和图表告警都能查看、确认；失败重试和手机接收信息仍可访问。 |
| 回放与固定版本 | 数据中心跳转、dataset_version 选择、步进、导出语义不变。 |
| 图表导航与保存 | 复用现有菜单，图表布局与可用面积不变；数据中心按钮仍可用且菜单无重复入口。访问功能页和返回后正确选择工作区；脏状态处理明确，退出仍按已有保存保护执行。 |
| 数据中心原生适配失败 | `/chart-data-center?session=...` 兼容 iframe 继续工作，不被默认路由重定向破坏。 |
| 首次无工作区、手机、会话过期 | 可理解的空态、可达的兼容功能与登录恢复，不出现无出口页面。 |
| HTTP 入口和共享服务 | 实际启用的 Nginx/Python fallback 支持目标页面；API、SSE、设备与通知确认接口保持原协议。 |

本篇路由盘点按 P0 文档范围自审源码引用和路由覆盖，未执行应用构建、端到端浏览器验收或 CI。后续登录预览和本地 SDK 控件运行核对分别见[登录定稿](../design/login-approved-20261017/README.md)及[标签与彩旗专项](native-chart-tab-colored-favorites-20261017.md)，不作为路由已实现的证据。生产旧工作区、旧模板、旧监控的存量及真实使用情况仍需在彻底退役前单独核实。本分支未创建 Issue/PR、合并、正式 tag 或部署应用。
