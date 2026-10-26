# 执行基线

2026-10-26，Ubuntu 本机；工作树 `/home/quant/repos/market-watch-single-frontend-20261026`，分支 `refactor/single-frontend-chartalert-20261026`。HEAD `bec830c3959703287555f935984e80396622d32b`。开始时仅方案未跟踪，无已有实现。风险/范围见 `issue-draft.md`。

## 实际活动调用

- HTTP `/api/watches` GET/POST、`/{id}/cancel` 调 `business` → `service.create_watch`；MCP `alerts_list/create/cancel` 同样创建/读取旧 Watch。
- `market.py` 在采集与补历史后调用 `evaluate_watch/evaluate_quote`；`live_pricing.py` 在报价/close sample/恢复后调用旧判定、`rewarm_watch` 并更新旧 Watch 暂停状态。
- `alert_monitor.run` 每轮顺序调用 ChartAlert worker 与 `composite_watches.step`。后者还被组合 readiness、修订 impact/预热引用。
- `market_usage.py` 把 active Watch 及 CompositeWatchBinding 计入需求；`calendar_admin.py` 用 active Watch 阻止日历修改。
- `api.py` 仍提供 `/api/replays` 新建、step、seek、add watch、读取/导出；专用计算在 service/history_replay/replay_history。
- `capabilities/drawings.py` 接受 `engine=legacy` 并读取 ChartWorkspace；旧工作区 HTTP/前端/导出引用需随阶段 2 收口。
- `history_retention.py` 对 Watch、Replay、CompositeWatchBinding 的历史引用保护必须保留，不能按“不活跃”解除历史证据保护。
- HTTP ChartAlert 当前独占 dataset_for、序列化/列表/事件/用例事务；MCP active_alerts 当前统计 Watch。

## 持久化及 origin

- 原 web origin：`mw.last-workspace.v1`；sessionStorage `mw.chart-return.v1`；工作区草稿 `mw-tv-draft:<id>`、`mw-tv-draft:v2:admin:<writer>:<id>`、`mw-tv-draft:v3:admin:<writer>:<id>`。v3 envelope `{draftVersion:3,version,at,baseRevision,document}`。
- 偏好草稿 `mw-preference-draft:v1:admin:<writer>:<key>`，包含版本、操作、base、value；告警草稿 `mw-chart-alert-draft:<workspace>`。
- 通知 IndexedDB `mw-professional-notices-v1`，声音 `mw.web-sound`，生命周期 `mw-notice-document-ended:<document>`；通知设置草稿 `mw.notifications-draft.v1`；主题 `mw.app-theme`。
- 保存布局由 AdvancedWorkspace.document 持久化，原生投影 `_mwDrawingProjection`；保留 workspace/chart/drawing ID 与 association。宿主私有 origin 状态继续盘点，不搬动原应用 origin。

## 必须保留

登录/退出、会话恢复、密码与通知/声音/系统设置；多工作区打开/保存/刷新/复制/切换、布局/画线/指标参数、草稿和保存竞争；原生告警/通知/数据中心、来源管理与导出；移动只读、MCP、后台无浏览器判定及通知确认。

## 工具与回归基线

web React 19、TypeScript ~5.7、Vite ^6、Lightweight Charts 5.2.1；私有 Advanced Charts 固定 bundle 指纹、patch-native-reserve/toolset、资源 SHA256。后端锁定 requirements.lock；每项任务独立 .venv/node_modules。

CI 入口 `.github/workflows/ci.yml`：后端 pytest+ops+changed Ruff、PG14.24 迁移与指标兼容、web build 和原生/浏览器回归、Compose config。迁移/历史兼容测试保留；旧业务活动测试需用退役和新业务行为测试替换。

混合样本仅在本任务隔离数据库创建：active/paused 普通及组合 Watch、旧 Signal/Notification/Outbox（含 claim/ack 情形）、ChartAlert 与事件、来源未知消息；预览→apply→重复 apply 核对状态/审计/历史记录与新规则不变。执行旧退役写入前停止本任务判定与投递，等待已领取结束。

## 当前进度

本文件保留执行前盘点；当前实现与验收见 progress.md / results.md。未操作生产。
