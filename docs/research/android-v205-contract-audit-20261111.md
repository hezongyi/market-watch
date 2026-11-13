# Android v2.0.5 接口与实施缺口核对

日期：2026-11-11。只读核对固定 Git 对象和现有预览；未调用真实业务 API、未运行后端、未验证手机。本文区分代码中存在的契约与后续待实现能力，不能作为运行验收。

基线：`v2.0.5` → `1bb935bdf1195c4da532cb2e6f62faca2198e6c4`。本地 rev-parse 与 origin 的 ls-remote 解引用一致，标签对象 `36a433a3fd7d6ddef65bb270e7f0899121039e2d`。

当前文档树基于更早的预览任务；本核对全部通过 `git show v2.0.5:<path>` / `git grep ... v2.0.5 -- <paths>` 进行，不能将当前工作树的旧应用文件当 v2.0.5。

## 1. 代码事实及影响

下列位置、行号均指 **v2.0.5 对象内**，可用 `git show v2.0.5:<path>` 复核。

| 编号 | 事实 | 一手证据 | 实施结论 |
| --- | --- | --- | --- |
| E01 | 登录/session 返回 csrf、subject=admin，Cookie HttpOnly；写请求检验 CSRF | `backend/alerts/api.py:89` authenticated，`:105` login，`:146` session | 复用同源认证；本地隔离键可用 origin+subject，无新账号/令牌系统 |
| E02 | 通用偏好有独立 revision 条件写；native 自选使用 mw.watchlists.v1 | `backend/alerts/advanced_api.py:143` router 和 preference save；`advanced-host/chart-runtime.js:2884`；`advanced-host/watchlists.js:2` | 自选共享原格式；手机 active 独立，修改须处理 revision，不直接复用 native 全量 active 保存 |
| E03 | 旧 coarse pointer 仍为只读路径；当前工作区 runtime 写服务器 | `web/src/advanced/ChartApplicationPage.tsx:184`；`web/src/runtime/workspace.ts`；`advanced-host/workspaces.js:2` | 单纯包装 WebView 不满足交互；新 `/m/` 明确启用手机操作并配置本地布局边界 |
| E04 | 专业图表 runtime 实际获取全指标列表；已有原生选择器与参数通路 | `advanced-host/indicator-picker.js:13` getStudiesList，`:246` openIndicators；`advanced-host/native-ui.js:346`；`advanced-host/native-indicator-dialog.js` | 沿用真实注册目录和原生 UI，不用 preview catalog 或告警指标集限制图表 |
| E05 | 原生布局能序列化，但现有保存链路还调用 server save | `advanced-host/viewports.js:17` captureChartLayout，`:33` widget.save；`advanced-host/chart-runtime.js:2231`、`:2479` | 手机复用序列化并换成本地存储，禁服务器布局、共享通用设置和最近桌面状态写入 |
| E06 | 四类系列有不同编码；裸代码永久代表 managed | `backend/alerts/chart_series.py:6` 至 encode/decode | ticker 和 kind/id/修订完整保存；不能把 MWP/MWH/MWC 去前缀后按名称猜源 |
| E07 | 目录有分页、来源/类型筛选；报价为批量 POST，最多100 symbols | `backend/alerts/market_data.py:228` QuoteQuery，`:565` series/page，`:573` quotes，`:921` quote_snapshot | 复用目录和报价；动态能力及 freshness 不得硬编码 |
| E08 | 现有历史缓存读取仅支持 managed；图表 provider 数据读取会调用 provider_data | `backend/alerts/market_data.py:305` read_cached_history / series_kind 校验；`backend/alerts/chart_query.py:232` data_sync、provider 分支 | 不能说已有统一 sparkline 接口；增加小型有界缓存读取端点，不从所有自选发整日普通图表请求 |
| E09 | provider 已有本地 snapshot 读取；fixed/composite 读取具有额外业务语义 | `backend/alerts/provider_cache.py:204` snapshot_transaction、`:306` snapshot；`backend/alerts/series_access.py:130` chart_data | 复用查询部分，检查并排除 ensure、warm_defaults、renew_demand 等副作用；可选 cache access touch 与采集任务不同 |
| E10 | 行情订阅、取消、接受与单页共享流已存在；显式 heartbeat 约每0.5秒发送 | `backend/alerts/market_stream_api.py:126` 至 `:176`；`web/src/advanced/providerSubscriptions.ts` | 复用注册/generation/sequence/result_epoch；SSE 标题使用同一流，不建额外头部连接 |
| E11 | Stream 类型和既有绑定未暴露 named heartbeat 的 UI 观察信息；legacy audit SSE 用注释 heartbeat | `web/src/advanced/providerSubscriptions.ts:6` Stream 及 open；`backend/alerts/api.py:527` events | 增可选 transport 观察回调/heartbeat 接口；注释心跳不会变成 EventSource onmessage，不能拿本地钟替代真实通信 |
| E12 | 新建/编辑明确仅 composite；旧来源只允许 pause/archive | `backend/alerts/chart_alert_application.py:318` require_executable_source，`:323` action；`:42` capabilities | 价格表单按组合能力/price_modes 决定可用；不扩大为六源直接告警，不自动生成组合 |
| E13 | association 可空，不关联的规则不需要工作区；新建和编辑/生命周期有各自并发及幂等字段 | `backend/alerts/chart_alert_application.py:118` Create、`:123` Edit、`:128` Action、`:333` validate_association；`backend/alerts/chart_alert_service.py:48` AlertConfig | 固定价格创建 association=null；无需服务端手机布局；既有规则编辑保留关联，不编造 locator |
| E14 | execution 已包含准备/监控/休市/恢复/blocked/settling 等状态及接管、检查、输入、缺口、incident 和手机配置 | `backend/alerts/chart_alert_application.py:190` execution_dict；`backend/alerts/price_alert_reasons.py` | 替换早期“等待可靠性任务”的假设；直接接入现有契约，但仍需运行验证，不承诺机制绝无遗漏 |
| E15 | health 有 chart_alerts / runtime roles / delivery_enabled / ntfy_configured | `backend/alerts/api.py:397` health；`backend/alerts/chart_alert_health.py:41` summary | 结合规则 execution 与后台健康，不用启用状态冒充持续工作，不缓存 topic/token |
| E16 | chart-alert events 是触发信号+通知关联，不等于所有异常；通知中心有列表、详情、timeline、changes、stream 和 observations | `backend/alerts/chart_alert_application.py:252` events；`backend/alerts/notification_center_api.py:67` router；`web/src/notifications/runtime.ts:85` NoticeRuntime | 异常/恢复复用通知中心与既有 store/去重；触发 ack 和 notice handled 保持各自含义 |
| E17 | notification-center stream 的空批次是注释心跳；现有前端 runtime 另有 changes 轮询 | `backend/alerts/notification_center_api.py:129` stream；`web/src/notifications/runtime.ts:944` changes | 后台记录无需为了手机重复接第二套协议；不可用它表示行情 SSE 最近 heartbeat |
| E18 | 当前前端懒加载图表 manifest/library/runtime；Nginx 单前端 fallback，CSP worker-src self/blob | `web/src/runtime/chart.ts` prepareChart；`web/nginx.conf` | `/m/` 最小 SW 壳可作为新增实施方案，但仓库配置不证明 Find X8 已通过；图表 manifest/runtime 必须按版本匹配 |

## 2. 已选择的最小补充

以下是**计划新增/适配**，基线尚不能直接提供完整产品：

1. `/m/` 五页容器、本地布局/设置适配和旧桌面只读路径隔离。
2. IndexedDB 的上次数据快照和一份原生图表配置。复用现有通知 store，不增加 SQLite 或本地告警引擎。
3. `/m/` 作用域的最小静态页面壳及版本更新；只在在线成功安装后支持离线冷启动。无真实 SW/WebView 证据前不得标“已支持”。
4. 共享行情流增加可观察的连接/事件/heartbeat 信息，不能打开头部专用流。
5. `POST /api/market-data/sparklines`，批量最多20系列、本机已有日内数据、固定当前窗口、单项最多1600点，缺缓存返回空/不可用，不创建采集和历史任务。接口精确约束见实施任务书第6节；backend router 注册需在真实实现中补齐。
6. Kotlin 外壳、可信来源/返回/生命周期适配及 Find X8 专项验收。

不新增行情供应商、市场、周期、目录刷新机制、价格判定算法、App 后台推送或完整手机数据管理。以上边界避免原型演示扩大成另一套业务系统。

## 3. 仍需在实施阶段实测的事实

- 当前许可库的实际完整指标、自定义注册、参数/副图、十字线手机激活/退出接口及序列化恢复。已核对存在相关能力不等于所有组合在 Find X8 可用。
- 手机模式下固定价格规则 association=null 的端到端创建，以及带关联旧规则只编辑允许字段时的兼容验证。
- 小图四类系列数据读取的时间/版本语义、查询预算和无需求副作用；不能绕过已有 composite/display snapshot 的一致性要求。
- 实际 HTTPS 地址、会话和 CSRF、目标系统/WebView、IDB/SW 冷启动、更新、旋转/回收/覆盖升级。
- 执行 worker 异常、行情断线、到期结算、触发事件、通知中心恢复、ntfy 服务接收和锁屏手机实收。后端字段存在不证明部署角色配置正确。

这些是有明确步骤的技术验收项，不是需要用户继续决定产品方向的开放问题。先最小真机纵向验证，再完成页面。

## 4. 复核命令与本轮验证范围

```bash
git rev-parse 'v2.0.5^{commit}'
git ls-remote origin 'refs/tags/v2.0.5' 'refs/tags/v2.0.5^{}'
git show v2.0.5:backend/alerts/chart_alert_application.py
git show v2.0.5:backend/alerts/market_stream_api.py
git show v2.0.5:web/src/advanced/providerSubscriptions.ts
git show v2.0.5:backend/alerts/market_data.py
```

本轮仅运行只读 Git 核对、文档链接/命令落点检查与 diff 检查；没有执行 npm/pytest/Gradle、Docker、生产操作、真实接口或设备验收。正式执行的验证命令及产物列在实施任务书。

本轮文档自检结果：3 份权威文档代码块闭合、4 个相对链接可达；29 个引用的既有代码/验证文件在 v2.0.5 对象中存在；5 项关键告警契约断言通过；旧 rc.1/四入口/待选走势等冲突条款已排除；`git diff --check` 通过。检查不执行待实现命令，也不把计划新增文件误报为基线已存在。
