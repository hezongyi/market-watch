# 单一业务前端与 ChartAlert 告警体系收敛方案

日期：2026-10-26。状态：方案已形成，业务实现尚未开始。本文件可独立交给执行 Agent。

## 1. 目标、基线与工作目录

目标：Advanced Charts 成为唯一业务前端入口；网页与 MCP 共用 ChartAlert 告警体系；完整退役 Lightweight Charts、旧 Watch 和历史演练。保留仍使用的 React 业务组件与图表原生控件适配。

| 项目 | 固定值 |
|---|---|
| 分析来源 | `/home/quant/repos/market-watch-integration-20261026` |
| 源码基线 | `bec830c3959703287555f935984e80396622d32b` |
| 已准备的独立工作树 | `/home/quant/repos/market-watch-single-frontend-20261026` |
| 已准备的分支 | `refactor/single-frontend-chartalert-20261026` |
| 本方案路径 | `docs/single-frontend-chartalert-consolidation-plan-20261026.md` |
| 任务及 Compose project 建议名 | `mw-single-frontend-20261026` |
| 验收环境 | Ubuntu 本机 Docker，独立 PostgreSQL 14.24、网络、volume、凭据和端口 |

执行前读取工作树 `AGENTS.md`，检查 `git status`、HEAD 和同任务已有进度。基线变化时先检查差异，更新文件定位与验证范围；不要覆盖其他会话工作。当前工作树只新增本方案。

本轮文档属于 P0；后续实现按 F1 处理：改变重要后台执行链路、MCP 告警契约及前端运行方式，需要状态兼容性验证与 Ubuntu R2 关键链路验收。默认不引入 schema 破坏性变更。

## 2. 已确定的产品与架构决策

1. 唯一主界面使用 Advanced Charts，保留桌面编辑、手机只读规则及当前已支持功能。
2. 移除 React 外层页面嵌入独立图表宿主的结构，以及该结构的 `mw-chart-v1` 消息桥。
3. React 可以继续作为业务界面实现。告警、消息和数据中心复用现有组件，不进行框架重写。
4. 继续使用图表原生按钮、输入框、下拉框、侧栏和弹窗。图表库内部 iframe 保留。
5. 后端只有 ChartAlert 生产告警体系。`composite_alerts` 是其组合行情 Adapter，保留；`composite_watches` 属于旧体系，退役。
6. 完整退役旧 Watch：创建、编辑/取消等活动操作、采集触发判定、组合判定、恢复预热、需求登记、API/MCP 活动入口全部退出运行链路。
7. 退役 `/chart-workspaces`、`/legacy/monitoring` 和 `/replay` 的业务页面、专用后台操作与判定代码。清理全部运行引用后移除 `lightweight-charts` 依赖。
8. 新旧告警不自动转换。旧规则停止运行，旧信号、投递记录、审计与历史演练数据保留；不删除数据库表或历史迁移。

### 不需继续追问的默认处理

- 原应用 origin 作为最终业务 origin，保留现有 `/advanced-charts/:workspaceId?` 地址。登录、图表、静态资源与 `/api`、`/mcp` 由同一入口提供，尽量保留原浏览器草稿和已有链接。
- `/settings`、登录、会话恢复继续可用；它们是同一个应用的页面或面板，不是另一套前端。
- 数据中心原生接入失败后显示可重试错误，移除额外 iframe 兼容回退，不长期保留两套运行模式。
- 旧规则及其未完成投递退出运行；已保存的记录不清空，不把旧通知伪造为用户已确认。
- 告警暂保留 API 内运行。明确其生命周期并补充运行状态；不承诺 API 重启期间持续判定。
- 单一告警体系可包含不同数据类型的 Adapter、HTTP/MCP 操作入口和通知 worker，不要求合成一个函数或一个进程。

形成方案没有剩余阻塞问题。若用户后续要求“API 重启期间告警仍运行”或“彻底移除 React”，这是新增架构需求，需要调整本方案。

## 3. 适合同阶段完成的改动

下表为建议实施范围；第 1—4 项直接服务于已确认目标。第 5 项建议作为同项目末尾的独立提交/PR，失败时不阻塞核心收敛。

| 优先顺序 | 改动 | 收益与范围限制 |
|---|---|---|
| 1 | HTTP 与 MCP 共用 ChartAlert 应用层 | MCP 不能因旧入口退役而失去告警操作能力，也不能继续创建 Watch；复用现有事务、幂等、版本与权限机制 |
| 2 | 前端应用运行时按职责提供小 Interface | 会话、工作区、行情订阅、告警/通知各自收拢；不把外壳全部搬进 `bridge.js`，不增加通用插件框架 |
| 3 | 旧规则退役、通知链接、单一构建与部署同时收口 | 清除隐性采集需求与旧待发送任务；手机通知能打开当前事件；最终不再发布两个静态业务服务 |
| 4 | 最小告警业务健康状态 | 在现有健康摘要中区分循环运行、数据等待、单规则失败和投递积压；不引入新监控平台 |
| 5 | 提取共享行情查询 Module | `market_stream_worker` 与 MCP 当前导入 `chart_api`；把已有查询实现移出 HTTP 层，减少调用者对 API 层的依赖，不另写查询算法 |

本次不做：全面拆分 ORM、删历史表、微服务化、Kafka/Redis/Kubernetes、重写指标算法、重写行情采集、图表库升级、新策略类型、Pine/官网告警服务、告警独立进程与 API 多副本扩容。

## 4. 源码证据与文件改动地图

以下路径均相对仓库根目录。“新增”项尚不存在，必须先实现再运行后文相应命令。

| 模块范围 | 当前文件及关键事实 | 实施动作 |
|---|---|---|
| 应用入口 | `web/src/main.tsx` 同时包含旧监控、演练、设置；`web/src/app/navigation.ts` 接受旧路径 | 删除旧功能，保留会话/设置/通知定位，改为独立应用入口 |
| 外壳职责 | `web/src/advanced/AdvancedWorkspace.tsx` 承担请求、订阅、草稿、窗口与消息分发 | 迁移为直接调用的运行时，最后删除父页面宿主组件及旧消息分发 |
| 图表宿主 | `advanced-host/bridge.js` 要求 `parent`，业务均转发父页 | 保留图表/datafeed 适配，替换传输和启动依赖，不再要求 parent |
| 原生组件 | `advanced-host/native-alert-shell.js`、`native-ui.js`；`web/src/advanced/nativeAlertUI.tsx`、`NativeAlertControls.tsx` | 保留固定版本契约；通过直接 Interface 获取数据和操作 |
| 数据中心 | `advanced-host/data-center.js` 正常挂载 React，失败创建 iframe | 保留正常挂载，替换父页传输，删除 iframe 回退及专用路由 |
| 前端旧图表 | `web/src/charts/`、`web/src/Chart.tsx`、`web/src/MarketDataPage.tsx` | 按实际引用清理专用实现；确认无引用后删依赖和对应构建脚本 |
| 前端持久状态 | `web/src/advanced/localDrafts.ts`、通知持久化、工作区原生保存 | 保持存储键及文档格式；图表 origin 私有状态如仍有用途需显式盘点 |
| 旧 Watch 业务 | `backend/alerts/business.py`、`service.py`、`composite_watches.py` | 删除旧活动行为；保留仍被新体系调用的共享通知确认和查询能力 |
| 隐含执行与需求 | `market.py`、`live_pricing.py`、`market_usage.py`、`composite_center.py`、`composite_revisions.py`、`calendar_admin.py` | 清理旧判定、预热、引用统计与约束，不删除采集、恢复、账户身份和真实历史保护 |
| 统一告警 | `alert_monitor.py`、`chart_alert_worker.py`、`chart_alert_service.py`、`composite_alerts.py` | 监控循环只调用 ChartAlert；保留数据身份、检查点、幂等及历史不重发语义 |
| HTTP/MCP | `chart_alert_api.py`、`capabilities/actions.py`、`models.py`、`registry.py`、`mcp/adapter.py` | 抽取共享应用行为，旧 Watch 工具退出注册，新工具使用 ChartAlert schema |
| 通知与旧地址 | `notify.py` 当前 click 链接仍是 `/signals?signal=...`；`notification_center.py`、`notification_center_api.py` 有 resolve 能力 | 新链接指向统一事件定位；旧链接保留轻量解析，不能恢复旧生产判定 |
| 旧演练 | `api.py` 的 `/api/replays`、`service.py` 的回放函数、`history_replay.py`、`replay_history.py` | 移除演练活动入口与专用计算；保留旧持久记录需要的结构和引用说明 |
| 共享存储 | `storage.py` 的 Watch/Replay 与历史 FK，SignalRow/Notification/Outbox 等 | 保留模型与 schema 兼容；不因删除旧判定顺带删除共享记录 |
| 历史保护 | `history_retention.py` 包含旧 Watch、Replay 引用 | 区分退役活动需求和历史证据保留；不把不再监控误当作可自动删历史 |
| 构建部署 | `web/Dockerfile`、`web/nginx.conf`、`advanced-host/Dockerfile`、`advanced-host/nginx.conf`、`advanced-host/build-assets.mjs`、`web/scripts/`、`compose.production.yaml` | 一个业务静态产物和 web 服务，同源代理；迁移构建工具和文档的双端口假设 |
| Ubuntu 工具 | `deploy/ubuntu/mw_docker.py`、`mw_preview.py`、`deploy/ubuntu/README.md`、`tests/ops` | 保留任务标签、固定镜像及资源归属；让单前端验收不要求 chart-origin 镜像和独立端口 |
| CI 与回归 | `.github/workflows/ci.yml`、`backend/tests/`、`web/tests/` | 删除退役功能的运行测试，保留历史迁移/记录兼容测试；迁移针对旧桥源码片段的测试 |

不得按 `legacy`、`replay` 或 `Watch` 字符串全局删除。SSE 结果重放、通知事件投影重建、历史迁移与图表内部实现可能仍需要这些概念。

## 5. 目标 Module 与 Interface

以下名称为推荐落点，可为适配仓库约定调整；职责与契约必须保持。避免为一次迁移同时维护旧桥 Adapter 和新 Adapter 作为长期方案。

### 前端

- 新增 `web/src/runtime/`，按需使用 `session.ts`、`workspace.ts`、`market.ts`、`notifications.ts`；图表初始化可置于 `web/src/advanced/standalone.ts`。复用现有深度足够的 Module，不强制每个概念都新建文件。
- `session` 的 Interface 负责登录/退出、CSRF 和过期恢复；调用者不再各写一次凭据处理。
- `workspace` 的 Interface 负责打开、保存、草稿与切换。内部持有修订和世代；调用者无需手动传递多套过期标志。
- `market` 的 Interface 提供历史读取、订阅与释放。内部处理取消、订阅代次、旧结果丢弃和断线恢复，保留数据身份与精度。
- 告警与数据中心通过现有组件的 request 回调直接调用应用客户端。不要用全局自发自收的 `postMessage` 模拟被删除的桥。
- 会话就绪后才加载业务数据；图表失败不影响退出登录和访问设置。认证与账户设置不依赖图表原生适配先成功。
- 原生适配器保留图表库版本检查、错误提示和契约回归；不升级第三方包，不复制原生样式伪装成原生控件。

### ChartAlert 应用层与 MCP

- 新增 `backend/alerts/chart_alert_application.py`，承接 HTTP 内当前存在的数据集绑定、用例组织、序列化与查询；核心判定继续在现有 domain/service/worker 中。
- HTTP 与 MCP 是两个真实 Adapter，使用同一 Interface；MCP 不经 loopback HTTP 调网页接口，不直接调用 FastAPI endpoint。
- 公共错误保持协议无关，HTTP 映射为 HTTP 错误，MCP 映射为 `CapabilityError`。
- 复用 `mcp/adapter.py` 的权限、预算、取消和 `AgentOperation` 幂等事务。不要增加第二套幂等表或独立规则存储。
- 创建仍使用 `AlertConfig`；编辑校验 `version`，生命周期校验 `version`、`control_revision` 与 `request_id`。来源绑定、固定历史与画线几何校验不能绕过。
- 网页创建的规则能由 MCP 读取和操作；MCP 创建的规则能在主界面管理。没有图格关联的规则允许不带 association；指定 association 时需验证其真实有效性。
- 建议新工具名为 `chart_alerts_list`、`chart_alerts_get`、`chart_alerts_create`、`chart_alerts_edit`、`chart_alerts_lifecycle`、`chart_alerts_events`。旧 `alerts_create`、`alerts_cancel`、`alerts_list` 的 Watch 契约退出注册，不把旧字段静默解释成新 schema。
- 保留共享 `notifications_ack`。历史信号查询若保留，明确是记录读取，不提供旧规则恢复。`system_get_status.active_alerts` 必须统计 ChartAlert。

### 共享行情查询：建议独立提交

- 新增 `backend/alerts/chart_query.py`，迁出 `DataQuery`、`data_sync`、`query_chart` 及它们实际依赖的业务查询组织；当前文件中只为 HTTP 所需的 Adapter 留在 `chart_api.py`。
- 更新 `market_stream_worker.py` 与 `capabilities/actions.py`，不再导入 `chart_api` 获取查询实现。
- 查询错误、超时、取消、native history 预算和递归指标起点必须保持原义。协议错误在 Adapter 转换。
- 禁止只增加一层转发后仍由 worker 调 HTTP 模块。保留必要的包内兼容导出仅用于短期调用迁移，最终检查运行调用无依赖。
- 不改变 provider/history/composite/managed 系列身份、缓存策略、缺口处理、价格精度和算法版本。

## 6. 依赖顺序与阶段验收

建议按以下顺序交付独立提交或 PR；串行推进，不长期保留两套架构。是否分多个 PR 可由执行 Agent 按可审查性决定，每个交付必须明确未完成范围。

### 阶段 0：盘点与固定行为

1. 记录 HEAD、工作状态、依赖版本与现有 CI 入口；建立 Issue 草案，写 F1 理由和检查范围。
2. 盘点所有 Watch 创建/执行/恢复/使用统计，演练 API、旧工作区 API、图表导出/搜索中的旧 engine 路径及相关脚本。
3. 盘点工作区、草稿、通知持久状态的 origin、key 与文档格式；默认统一到原应用 origin。
4. 建立保留功能清单：登录与密码设置、多工作区、布局/画线/指标、数据中心、来源管理、导出、通知声音、移动只读、MCP。
5. 基于本任务隔离数据准备混合样本：旧 active Watch、组合 Watch、待发送旧通知，以及新 ChartAlert 与事件。不得连接生产数据库取得这些样本。

产物：`docs/verification/single-frontend-20261026/baseline.md`，列出实际调用和兼容性基线，不用行数作为验收目标。

### 阶段 1：统一告警应用 Interface

1. 提取应用行为，接入网页与新 MCP 工具，保留全部权限/幂等/版本语义。
2. 建立跨入口验收：网页建规则 → MCP 读/编辑；MCP 建规则 → 网页读/生命周期控制。
3. 对相同请求重试、并发操作与重复观察验证：只出现一个逻辑规则/事件/Outbox；只读令牌不能写。
4. 在可用新入口上验证完成后，再移除旧 Watch 的 MCP 工具与 HTTP 活动入口。旧 API 写请求返回明确退役结果，可用 410；无需保留旧 schema 和业务执行器仅为生成错误。

阶段完成：不再存在可创建旧 Watch 的公开运行入口；新告警操作能力完整。

### 阶段 2：退役旧执行、演练与旧图表

1. 从 `alert_monitor.run` 移除 `composite_watches.step`；保留 cadence、错误恢复和单规则事务语义。
2. 清理 `market.py` / `live_pricing.py` 内的旧规则判定、预热与暂停状态更新；采集、确认、恢复、ownership/fencing 不变。
3. 清理 `market_usage`、组合 readiness/impact、旧策略指标预热、日历变更限制中的活动 Watch 依赖；保留当前 ChartAlert 和真实历史证据依赖。
4. 移除旧演练、兼容工作区与旧监控页面、菜单和活动 API。移除 MCP 的 legacy workspace/drawings 运行路径，明确拒绝旧 engine，不重解释旧 ID。
5. 清理 `web/src/charts/`、`Chart.tsx`、已无调用的旧页面与脚本，使用包管理器移除 Lightweight Charts 并更新 lockfile。
6. 仅删除旧业务专用的纯判定、回放、聚合辅助代码；`domain.py` 中仍使用的日历和 K 线语义，以及 `service.py` 中仍使用的通知确认需要保留或迁入恰当 Module。

新增 `backend/alerts/retire_legacy.py`：

- 默认只预览，显式 `--apply` 才修改；使用现有配置连接，输出数量/标识和可核验结果，不打印凭据。
- 将尚活动的旧 Watch 转为既有取消终态，保留规则、state、armed_at、绑定和历史记录；Audit 记录退役原因和变更清单。
- 精确处理旧告警未完成 Outbox：依据旧 `watch_id` 与无 `chart_alert_id` 的持久关联识别；不得取消 ChartAlert 或未知来源消息。
- 取消发送任务而不填写 `ack_at`；通知状态须如实展示“退役停止提醒”，不新增数据库列只为这一显示。
- 可重复运行，第二次没有新增状态变化。保持 Notification→Outbox 锁顺序。
- 通知 claim/retry 入口仅允许当前告警体系重新进入待发送状态，防止归档旧消息被重试功能重新投递。

执行退役写入前，停止该隔离实例旧判定写入者与投递 worker，等待已领取投递结束，再执行；新版本启用后才恢复通知投递。生产同类操作留待发布授权。

阶段完成：采集和监控不再执行旧规则、旧需求不再保活采集；重启不恢复旧告警；新数据流正常。保留历史 ORM/schema 不表示保留旧业务执行链路。

### 阶段 3：前端独立化与原生界面收口

1. 把外壳承担的会话、应用路由、工作区生命周期、订阅、草稿、通知迁入直接调用的运行时。
2. 在唯一入口初始化图表库。数据中心、告警、通知挂载保留的 React 业务组件与原生控件，改为直接 request/事件回调。
3. 去掉宿主对 `parentOrigin`、父页 ready/init、消息 RPC 和跨业务 iframe 作用域的要求；保留图表内部 iframe 的加载与适配。
4. 保留旧请求作废、切换 A→B 后丢弃 A 结果、释放订阅、保存期间继续编辑不被误标已保存等行为。
5. 保留 `mw.last-workspace.v1` 等仍有效键及原生布局 schema，迁移前后读取同一已保存工作区。关联图表 ID、告警 association 与绘图 ID 不重新生成。
6. 数据中心原生适配失败显示明确错误与重试，移除 `fallbackFrame` 及 `/chart-data-center` 专用兼容入口。其他仍实际存在的同类跨应用回退逐一处理。
7. 保持安全的登录后跳转白名单。旧监控/旧工作区/演练链接进入退役说明或主界面，不悄悄恢复旧功能。
8. 更新通知 click 链接；保留 `/signals?signal=...` 的轻量解析，复用 notification-center resolve 定位新事件。已退役旧事件显示只读说明；有效历史确认链接在授权范围内仍可确认，不触发新判定或重投递。

阶段完成：无外层“专业图表工作区”iframe，不依赖父页面参数，原有保留功能都由一个应用承载。

### 阶段 4：单一产物、部署和业务健康

1. 在 `web` 构建中合并现有图表资源与业务组件。可新增 `web/scripts/build-single-frontend.mjs`，先在 staging 构建资源，再合成唯一应用入口，避免两个 index 相互覆盖。
2. 继续保留图表 vendor 固定版本、指纹补丁、资源哈希和失败即停止校验，正确处理 library_path、脚本加载顺序、懒加载 chunk 与字体/样式路径。
3. 最终 `web/Dockerfile` 构建完整前端；因需要读取 `advanced-host`，调整 Docker context 为仓库根并更新 `mw-docker` 对 web 的默认路径和测试。不要绕过工具的任务归属机制。
4. Web Nginx 提供应用、图表资源与同源 API/MCP/SSE 代理。调整 CSP 使同源请求与图表内部资源可用，保留 HttpOnly/Secure Cookie、CSRF、路径约束、下载及必要 blob 能力，避免宽泛解除限制。
5. 删除活跃 Compose 中 chart-origin 服务和 `VITE_ADVANCED_CHART_ORIGIN` 依赖。清理双端口 TLS、发布清单、构建脚本、CI 与 README 中的运行假设。归档部署文件保留历史，不批量改写。
6. 修改 Ubuntu preview 的单前端模式与工具测试；不把生成两个静态服务后换同一域名代理视作完成部署收敛。
7. 在现有健康摘要中增加 ChartAlert 监控循环的最后成功时间、最近错误、当前 active/blocked/stale 数量；复用受限频率 heartbeat 与现有持久化能力，不逐条告警写高频审计。
8. 明确告警 owner 为 API 进程；循环完成无 active 规则也可健康，行情正常休市不等于监控循环故障。`/readyz` 继续表示基础可用，不冒充业务新鲜度。

阶段完成：一个业务静态镜像、一个业务 web 服务/入口；后端必要 worker 不因“单一”而被合并。图表库内部 iframe 与维护 profile 不计作另一业务前端。

### 阶段 5：共享查询提取，建议独立 PR

按第 5 节提取共享查询 Module。优先只移动既有实现和调整错误 Adapter，验证 HTTP/MCP/SSE 的相同输入具有相同身份、数据与指标结果。若发现需要修改行情或计算语义，停止这一扩展，单独记录后续任务，不阻塞阶段 1—4。

## 7. 检查、测试与验收命令

以下命令用于执行阶段；本轮只写方案，未安装依赖、运行测试或启动容器。

### 环境准备和已有回归

```bash
cd /home/quant/repos/market-watch-single-frontend-20261026
git status --short
git rev-parse HEAD
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install -e . --no-deps
npm --prefix web ci
```

不要复用其他任务的可写 venv/node_modules；已经存在的本任务依赖可复用。

按实际改动运行有意义的现有测试，至少覆盖统一告警、采集、恢复和通知。原旧功能的活动测试随删除移除，历史迁移与数据保留测试保留。

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_alert_monitor_cadence.py \
  backend/tests/test_chart_alert_service.py \
  backend/tests/test_chart_alert_api.py \
  backend/tests/test_chart_alert_worker.py \
  backend/tests/test_chart_alert_notifications.py \
  backend/tests/test_composite_alerts.py \
  backend/tests/test_live_pricing.py \
  backend/tests/test_oanda_rest_batch.py \
  backend/tests/test_market.py \
  backend/tests/test_native_mcp.py \
  backend/tests/test_advanced_workspace.py \
  backend/tests/test_observed_indicators.py
.venv/bin/python -m pytest -q tests/ops
npm --prefix web run build
```

还需覆盖现有通知投递/确认测试；按源码核实对应文件。迁移 `web/tests/single-app-routing.cjs`、`advanced-native-save-race.cjs`、`notifications-runtime.cjs`、`notifications-persistence.cjs` 与原生控件/价格拖动回归，避免仅删掉依赖旧桥源码片段的测试便声称通过。

新增并接入 CI 的行为测试，名称可以调整：

- `backend/tests/test_legacy_retirement.py`：混合数据、幂等退役、旧通知阻断、新告警和历史记录不受影响。
- `backend/tests/test_chart_alert_capabilities.py`：跨 HTTP/MCP、权限、schema、幂等、版本冲突、无旧 Watch 写入。
- `backend/tests/test_chart_alert_health.py`：循环运行/失败/过期与单规则数据状态区分。
- `web/tests/single-frontend.browser.cjs`：单一入口、多工作区/草稿恢复、会话过期、原生面板、移动只读、通知定位、无额外业务 iframe 回退。
- 新增 `npm run test:single-frontend`，调用迁移后的相关回归和上述浏览器测试；所有路径、地址和私有凭据文件通过参数或环境输入，不硬编码历史任务。

需要共享查询提取时，再运行 `test_market_stream*`、`test_native_series*`、固定指标与 history/composite/provider 查询回归。测试通过后没有新增变更或失败，不无意义重复全套。

### Ubuntu R2 隔离验收

先只读检查 `docker compose ls`、已占端口、`free -h`、`df -h` 及 Docker 数据分区。预设 HTTPS 19643，若冲突选择新端口并记录，不停止其他任务。

新增 `deploy/ubuntu/single-frontend.acceptance.yaml` 后才运行以下命令。Compose 必须定义 postgres、migrate、api、web、TLS 网关与 verify；按实际验证需要加入历史、pricing、market-stream、通知投影 worker，使用独立资源与明确 CPU/内存/日志上限。PG 固定版本/digest 与检查值沿用 `deploy/ubuntu/README.md`。

外部真实通知默认关闭；供源由任务显式启用。使用可控样本证明确定性触发和恢复，再以只读真实源 smoke 核对获取行为，不将合成价格冒充真实行情。独立测试数据库使用 PostgreSQL，测试 skip 不计通过。

在仓库外私有目录创建 env 和 TLS/测试凭据文件；下列 env 中包含镜像名、测试数据库连接、独立密码/登录 hash、端口与证书路径，不提交仓库，不输出展开后的敏感配置。

```bash
export MW_TASK=mw-single-frontend-20261026
export MW_PROJECT=mw-single-frontend-20261026
export MW_PRIVATE_DIR=/home/quant/.local/share/market-watch-tasks/mw-single-frontend-20261026
export MW_COMPOSE_FILE=deploy/ubuntu/single-frontend.acceptance.yaml
export MW_ACCEPTANCE_URL=https://localhost:19643

# 阶段 4 已更新 web 构建 context 后再执行。
mw-docker build --repo . --component api \
  --tag market-watch-api:single-frontend-20261026 \
  --task "$MW_TASK" --project "$MW_PROJECT" --purpose acceptance
mw-docker build --repo . --component web \
  --tag market-watch-web:single-frontend-20261026 \
  --task "$MW_TASK" --project "$MW_PROJECT" --purpose acceptance

docker compose --env-file "$MW_PRIVATE_DIR/acceptance.env" \
  -p "$MW_PROJECT" -f "$MW_COMPOSE_FILE" config --quiet
docker compose --env-file "$MW_PRIVATE_DIR/acceptance.env" \
  -p "$MW_PROJECT" -f "$MW_COMPOSE_FILE" up -d --no-build
docker compose --env-file "$MW_PRIVATE_DIR/acceptance.env" \
  -p "$MW_PROJECT" -f "$MW_COMPOSE_FILE" ps

# verify 服务在容器内设置 TEST_POSTGRES_URL 与 CHART_ALERT_TEST_DATABASE_URL。
docker compose --env-file "$MW_PRIVATE_DIR/acceptance.env" \
  -p "$MW_PROJECT" -f "$MW_COMPOSE_FILE" run --rm verify \
  python -m pytest -q \
  backend/tests/test_chart_alert_postgres.py \
  backend/tests/test_composite_alerts_postgres.py \
  backend/tests/test_live_pricing_postgres.py \
  backend/tests/test_market_stream_postgres.py \
  backend/tests/test_observed_indicators_postgres.py
```

verify 镜像/挂载必须先包含本候选源码和所列测试，不假设生产镜像自带测试。不得让 PostgreSQL 验收 URL 指向共享或生产数据库。

新增 `scripts/single_frontend_acceptance.py`，接收 `--base-url`、`--credentials-file`、`--output`；使用本任务混合样本验证退役前后状态、MCP、关闭网页后的检查点推进，以及单一 URL 下资源和接口可用。先实现脚本与 fixture，再运行：

```bash
.venv/bin/python scripts/single_frontend_acceptance.py \
  --base-url "$MW_ACCEPTANCE_URL" \
  --credentials-file "$MW_PRIVATE_DIR/credentials.json" \
  --output docs/verification/single-frontend-20261026/acceptance.json
MW_BASE_URL="$MW_ACCEPTANCE_URL" \
MW_ACCEPTANCE_CREDENTIALS_FILE="$MW_PRIVATE_DIR/credentials.json" \
npm --prefix web run test:single-frontend

# 暂停本任务验收并保留数据库与现场。
docker compose --env-file "$MW_PRIVATE_DIR/acceptance.env" \
  -p "$MW_PROJECT" -f "$MW_COMPOSE_FILE" stop
```

自签名证书在本任务客户端和浏览器中按任务配置受信任，不全局关闭 TLS 验证。浏览器测试应保存脱敏截图/结果，不能提交完整浏览器状态或凭据。

主要验收场景：

1. 同一 origin 登录、访问设置、加载图表、API 和 SSE，无 parent 参数或独立 chart-origin 服务。
2. 打开、保存、刷新、复制和切换现有工作区；布局、画线、指标参数和告警关联保留。
3. 保存捕获期间继续编辑、A→B 切换后 A 请求返回、网络中断恢复，不覆盖新状态。
4. 告警和数据中心的原生控件可键盘操作；原生适配失败显示错误和重试，不启动额外业务 iframe。
5. 网页/MCP 的创建、读取、编辑、暂停恢复一致；重试、并发、重复观察不会重复计数和投递。
6. 旧 Watch 和组合 Watch 不能再创建或执行；采集重连、确认、补历史、服务重启后也不会恢复；旧信号和引用数据保留。
7. 旧待投递任务停止，新告警投递/确认不受影响。新通知和旧 `/signals` 深链接均可定位或给出真实退役说明。
8. 所有浏览器关闭且兴趣过期后，ChartAlert 持久需求与检查点仍推进。API 重启可暂停循环，恢复后不重复告警，不声称重启期间持续运行。
9. 非法/只读 MCP 写操作被拒绝；服务端仍验证所有条件与来源；退出登录后不继续业务读取。
10. 无 schema/持久文档格式变化，已部署 schema 与混合状态可读取；迁移 head 保持单一，历史迁移测试继续通过。

### 静态收口检查

```bash
rg -n 'lightweight-charts' web/src web/package.json web/package-lock.json
rg -n 'composite_watches|evaluate_watch|evaluate_quote|evaluate_close_sample|rewarm_watch' backend/alerts
rg -n 'parentOrigin|mw-chart-v1|VITE_ADVANCED_CHART_ORIGIN|fallbackFrame' web/src advanced-host
rg -n 'from .*chart_api import.*(DataQuery|data_sync|query_chart)' backend/alerts
```

这些命令是盘点入口，`rg` 无匹配会返回 1，不是测试失败。第一项在运行源码/依赖中应无匹配；第二项不能再有可执行旧判定路径。第三项只允许为图表内部实现确有用途的内容和明确历史资料；不得存在已承诺移除的业务桥与回退。第四项仅在建议的查询提取完成后作为完成门槛。历史迁移/保留 ORM 中的旧名称允许存在并说明用途。

## 8. 数据、部署与回退边界

- 不删 Watch、Replay、旧工作区表；不删除 SignalRow、Notification、Outbox、HistoryVersion 或原生日历等共享模型。
- `history_retention` 继续保护被保存证据实际引用的历史；不自动释放这些引用以腾空间。未来永久清理单列任务。
- 先验证旧数据读取与幂等退役，再移除旧业务执行器。禁止把反复退役写入塞进每次 API 启动。
- 生产切换需要停止旧判定/投递写入者、处理在途投递、备份与退役清单留档，再切换统一版本；不能让旧实例在退役后继续运行。这里只编写并验证流程，不操作生产。
- 回退应用与回退旧规则状态是不同操作。候选回退不得自动重新激活旧 Watch 或重发旧通知；数据状态如需恢复，依据精确清单另行决定。
- 生产模板改动保留全部后端有效 `ALERTS_YAHOO_ENABLED=true`、代理和其他既有配置。生成发布候选时核对，不重写历史 release 文件。
- 本任务阶段默认交付开发、测试、适用验收与 Draft PR；合并 `main`、正式 tag、传输生产镜像、Unraid 备份/迁移/切换均须本次明确授权。
- 验收资源退役先运行 `mw-docker retire --task "$MW_TASK" --project "$MW_PROJECT"` 查看清单。永久数据/volume 删除、工作树删除与生产资源删除按 `AGENTS.md` 单独授权；不使用 `down -v` 或全局 prune。

## 9. 完成标准与停止条件

核心阶段 1—4 全部完成后，才可宣称“一个业务前端、一套生产告警体系”：

- 只有一套活跃业务前端产物、入口和 web 服务；无外层业务 iframe 宿主及其消息桥。
- 旧图表、演练、Watch 的活动入口、执行、预热、需求保活和旧投递路径均已退役；Lightweight Charts 从运行依赖移除。
- 网页与 MCP 使用同一 ChartAlert 模型、条件验证、版本/幂等和事件事务，不存在另一个规则执行器。
- 原有保留功能、工作区/草稿/历史数据兼容性、后台判定和通知行为通过以上最小有意义回归与隔离 R2。
- 构建、CI、Compose、Ubuntu 工具、通知深链接、当前 README/架构索引与实现一致。
- 交付包含实际主机、实际 URL、固定候选镜像 ID、启动/停止命令、测试结果与 skips、未测限制及回退说明；不能把计划地址写成运行地址。

共享查询提取是否完成单独报告，不因其尚未完成而伪称 worker 已无 HTTP 模块依赖，也不把它当作“单前端”达成条件。

必须停止并报告的情况：需要删除持久数据/改变规则计算语义、任务隔离或资源不足、私有图表控件无法维持已承诺功能、现有数据格式无法无损兼容、出现生产操作或合并检查点。其他局部文件组织、测试选择、任务端口调整由 Agent 自行决定。

## 10. 后续演进阶段：告警进程、ORM 文件与图表库升级

本节为后续路线图，未扩大当前阶段 0—5 的执行范围。没有核实当前存在必须立即升级图表库的缺陷或新版本需求。

| 事项 | 建议时机 | 启动条件与交付边界 |
|---|---|---|
| 当前核心收敛及共享查询提取 | 先完成阶段 0—5，核心收敛和查询提取分别验收 | 固定单前端、ChartAlert 与保留功能基线 |
| 独立告警进程 | 核心收敛验收通过后的下一项专项改造，三项中优先级最高 | 目标是 API 独立重启时告警仍有行情并持续判定；独立 PR 和隔离 R2 |
| ORM 定义按业务拆文件 | 边界稳定后，结合相关功能修改逐组进行 | 不改表结构，不搬数据，不安排一次性全面重写 |
| Advanced Charts 版本升级 | 有已确认的目标版本收益或缺陷修复需求时 | 在已稳定的新前端上单独升级，重新适配和回归，不与进程迁移捆绑 |
| 数据库物理拆表、分库或旧表永久清理 | 目前不安排 | 只有实测容量/性能问题或明确历史保留需求才单独建任务 |

### 10.1 独立告警进程具体做什么

当前 `provider_service.start()` 在 API 生命周期内启动来源预热、实时维护、清理和告警循环。现有 pricing、market-stream 等 worker 不能代表全部告警输入维护都已经独立。

专项改造内容：

1. 为现有 `alert_monitor.run` 增加独立进程入口，例如新增 `backend/alerts/alert_worker.py`。仍调用同一 ChartAlert 判定实现，使用同一数据库与幂等事件事务。
2. 停止 API 启动同一告警循环；明确部署角色与唯一调度归属。迁移完成后默认只有独立角色负责调度，不长期双跑。
3. 逐类盘点 managed/provider/composite 告警的持久输入需求。把仍依附 API 的必要来源实时维护、恢复与需求续持移入合适的后台角色，优先复用既有 worker。
4. 保留采集 ownership、去重、请求限额和数据库租约，不在多个角色各运行一次完整 `provider_service.start()`。
5. 告警角色启动只依赖数据库、迁移结果和必要供源配置；不能要求 API HTTP 健康后才能完成自身启动与输入恢复。
6. 配置独立启动/停止、优雅退出和业务心跳。对每次发布实际涉及的角色说明重启影响，不承诺所有后台服务同时升级时零中断。

关键验收：先建立实时行情，再停止 API；覆盖已支持的 managed/provider/composite 告警，证明来源输入和告警检查点继续推进，并由可控后续观察产生一次事件。随后独立重启 API、告警进程及必要供源角色，验证恢复、不漏掉已承诺处理的观察、不重复计数/投递。休市等待和未获取到的真实价格路径不能伪造为已监控。

单独搬判定线程而不处理来源输入维护，不算达到“API 停机仍持续告警”。此项增加进程部署和健康管理成本，但能直接改善 API 重启对监控的影响，优先级高于单纯整理文件。

### 10.2 ORM 拆文件与数据库拆表的区别

此前“全面拆表”的表述过于笼统。本方案建议的是有需要时拆分 ORM 定义所在的代码文件；数据库表的实际结构不因此改变。

可按供源/历史、组合、告警、通知、任务等业务组拆出模型文件。共享一个 SQLAlchemy Base/metadata，统一 Session/事务入口；处理模型注册顺序、外键引用与事件钩子，避免重复注册或循环导入。`alerts.storage` 可以作为稳定的公共导出入口，兼容现有业务与历史迁移导入。

一次只迁移一组，验证 metadata、外键、事件注册和已有迁移行为没有变化，不生成无意义 schema migration。只有改某组功能时集中模型确实增加定位成本，才顺手拆这一组。

数据库物理拆表/分区、分库是另一类项目：会影响查询、事务与数据迁移。本项目目前继续共享 PostgreSQL；没有实测依据，不为架构整齐而安排物理拆分。旧表永久删除也属于独立的数据保留与清理决策。

### 10.3 图表库升级具体做什么

这里指升级 Advanced Charts 第三方版本。当前原生侧栏、控件加载与构建补丁绑定 v31.1.0 的具体版本指纹及内部模块；升级不能只替换 vendor 文件或改版本号。

专项改造内容：

1. 明确目标版本与需要的修复/功能；核对实际许可包和版本说明，不假设最新版本具备所需能力。
2. 在独立分支替换库资源，逐项重新验证原生侧栏、弹窗、输入框、下拉框、菜单和搜索适配。
3. 重新适配并验证 `patch-native-reserve.mjs`、`patch-native-toolset.mjs` 及构建指纹/资源哈希；不能为通过构建取消版本检查。
4. 验证旧工作区布局、绘图、指标与模板文档兼容，新旧保存往返能保留业务身份和告警关联；记录格式变化和回退边界。
5. 回归历史导航、缩放、多图同步、递归指标、图上告警、数据中心、通知与移动只读。只允许具有明确需求的行为变化。

建议等单一前端建立稳定回归基线后，再由目标版本收益触发专项升级。这样图表行为变化能归因到版本适配，无需同时排查旧链路退役、外壳迁移和第三方升级。

## 11. 可直接交给执行 Agent 的启动指令

```text
读取 /home/quant/repos/market-watch-single-frontend-20261026/AGENTS.md 和
/home/quant/repos/market-watch-single-frontend-20261026/docs/single-frontend-chartalert-consolidation-plan-20261026.md。
在已准备的同任务工作树与分支接续，先检查 HEAD、git status 和任务进度，不覆盖其他会话工作。
按方案阶段 0—4 执行：完整退役旧 Watch/兼容图表/历史演练，统一网页与 MCP 到 ChartAlert，
把 Advanced Charts 改为唯一业务前端，保留原生控件与 React 业务组件，合并静态构建和部署。
一并处理旧规则状态与待投递任务、通知深链接、最小告警健康状态和现有数据兼容性。
阶段 5 共享查询提取作为独立提交/PR推进；若需改变行情语义则记录为后续任务，不阻塞核心交付。
先建立 Issue 草案并按 F1 组织最小有效回归、独立 Ubuntu Docker R2、CI、自审与适用独立 review，完成 Draft PR。
不要逐步要求确认；不合并、不发布生产、不删除永久数据。只在方案和 AGENTS.md 规定的检查点停止。
```
