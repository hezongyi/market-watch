# 刷新旧 UI 清理与原生唯一呈现（2026-10-19）

用户报告刷新先出现旧通知 UI，随后原生新 UI 覆盖；进一步确认“只保留新 UI，不用备份，清理旧 UI”。源码候选 `1f3385b`，在当前分支与当前 Ubuntu Docker 实例实施，保留其他任务和已有数据，未合并 main、未创建正式 tag、未发布生产。

增量 **F0 / Ubuntu R1**：仅删除旧呈现路径和旧分页/控件分支，保留原生中心与即时浮窗；未修改通知 runtime、IndexedDB、后端、schema、时间戳、交易确认或手机投递。原 PR 整体 F1/R2 证据继续有效。未创建旧 UI 的备份实现或备用入口。

## 原因与最终处理

正常刷新即复现：父页约 266ms 挂载 `.nc-fallback-entry` 与旧面板，2743ms 原生就绪才卸载，见 [初始失败数据](before-results.json) 和 [旧界面闪现截图](01-old-panel-flash.png)。父页将 `!notificationReady` 同时用于初始化和故障，导致每次启动走备用呈现。并非旧资源缓存导致这次双 UI。

- 从 `AdvancedWorkspace` 删除旧入口、旧面板、旧即时浮窗及其组件导入、回调。移除 `.nc-fallback`、`.nc-fallback-entry`、`.nc-popup`、旧分页样式。
- `Panel` 与 `NoticeBubble` 是新版原生壳复用的内容，保留它们的原生实现；移除非原生开关、旧搜索/图标/按钮、分页查询与上一页/下一页路径。只保留原生控件和连续滚动。
- 正常启动不出现另一套界面；工作区查询完成前也不提前显示空工作区操作页。深链仍等原生就绪后打开对应记录。
- 明确接入失败或现有 25 秒超时，仅显示一条重载操作提示；没有通知列表、浮窗或第二消息入口。按钮先遵守现有未保存保护，重载后恢复原生 UI；提示不进入布局流。
- 根部接收/本机上传继续运行，未确认交易和本机记录保留。用户刷新即可，无需删除本机数据。

## 真实页面验收

Playwriter session 7，在任务自有 Chrome 新建页，登录沿用现有会话。回归脚本：[`web/tests/notification-startup.playwriter.cjs`](../../../web/tests/notification-startup.playwriter.cjs)，执行：

```bash
node /tmp/mw75-playwriter-runtime/node_modules/playwriter/bin.js -s 7 --timeout 90000 -f web/tests/notification-startup.playwriter.cjs
```

脚本在旧候选运行时明确失败 `Retired notification UI must never mount`，新候选全部通过。[完整转场/桥接消息/尺寸断言](startup-results.json)：

| 场景 | 结果 |
| --- | --- |
| 带 notifications 深链正常进入、刷新、普通图表刷新 | 原生入口/中心正常，父页旧 UI 从未挂载，搜索不自动聚焦，真实历史列表可读 |
| 图表主文档延迟 6 秒 | 8270ms 原生就绪，全程无旧 UI/恢复提示 |
| 阻断图表主文档 | 25485ms 才出现一个重载按钮，无旧 UI；iframe 始终 x0/y0/w1600/h1000 |
| 点击重载恢复 | 恢复原生中心并撤去提示，无旧 UI；未修改或确认交易 |
| 原生通知适配器明确失败 | 在真实组合 host bundle 的适配器入口注入一次错误，2934ms 收到 unavailable，2936ms 显示重载操作；不打开旧 UI |
| 移除适配器故障后恢复 | 2430ms 原生就绪，中心及真实历史正常，无 pageerror |

截图：[新版实际列表](02-native-only.png)、[超时仅重载操作](03-timeout-reload-only.png)。所有 8 个场景通过，pageerror 为空。移除全部临时路由后，再运行原最小复现 `/tmp/mw75-refresh-ui-repro.js`，旧面板出现断言转绿。

此外刷新先前保存真实 EURUSD 待确认交易的验收浏览器，原生交易浮窗及“确定”按钮仍在，父页旧通知 DOM 为 0；未点击确定或手机停止。见 [截图](04-unconfirmed-native-trade.png)、[结果](trade-retention.json)。没有新触发交易。

故障注入仅作用于任务自有浏览器响应，没有改服务器资源。第一轮注入脚本曾继承原静态资源缓存头，导致验收浏览器缓存了测试错误响应；已清理该任务 Chrome 的 HTTP 资源缓存，未清 IndexedDB/localStorage/cookie，也未接触用户浏览器。最终注入显式 no-store 并移除 ETag/长度等头，完整重跑通过，所有路由已移除。此项是验收脚本修正，不是应用修复手段。

## 实例与检查

Ubuntu quant-server `192.168.7.232`，task/project `mw-issue75-v2-20261018`，地址：<https://192.168.7.232:18280/advanced-charts/mw75-real?panel=notifications>，沿用原密码。现有 15 个长期服务保持运行，API/PG healthy；真实行情供源和 worker 保留。只重建 web/chart，外部手机投递继续关闭。[镜像与运行状态](runtime.json)。

构建走 `mw-docker build --repo . --component web|chart --tag market-watch-web:issue75-v2-candidate|market-watch-chart:issue75-v2-candidate --task mw-issue75-v2-20261018 --project mw-issue75-v2-20261018 --purpose acceptance`；Web 增加 `--build-arg VITE_ADVANCED_CHART_ORIGIN=https://192.168.7.232:18281`。

启动/更新：`python3 /tmp/mw75-integrated-compose.py up -d --no-build --no-deps web chart`，随后 `docker exec mw-issue75-v2-20261018-gateway-1 nginx -s reload`。停止展示服务用同一 wrapper 的 `stop web chart`，完整项目用 `stop`，保留 volume，不使用 down -v。私有有效配置仍位于任务状态目录，未归档凭据。

本地 TypeScript/Vite、通知 runtime、真实 IndexedDB 持久化、上海宿主 TZ 的时区/桥接、路由 continuation、图表 tab 回归和两个正式 Docker 构建通过，`git diff --check` 通过。初次清理阶段编译发现旧分页回调遗留引用，已连同旧分页代码移除，最终构建通过。

CI 源码候选：<https://github.com/hezongyi/market-watch/actions/runs/39269161355>；提交证据时 CI 尚在运行，以 PR #87 checks 为准，不以先前候选的成功替代当前结果。自审核对仅有原生呈现调用点，不改变 8 秒/悬停/焦点或交易确认规则。用户暂缓的系统浮窗不消失反馈不在本轮范围。
