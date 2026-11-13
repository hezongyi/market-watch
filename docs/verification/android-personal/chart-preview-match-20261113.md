# 手机上次图表预览漏命中修复

用户反馈进入图表先显示“准备图表”，等待后才出图，没有按已认可方案先显示上次画面。本轮延续 F0 手机客户端范围，不跑 CI、不更新 PR、不操作 Unraid。

已复现的缺陷：同一 DUKA 数据集，自选/接口保存小写十六进制 ID，原生图表部分 API 返回大写；预览查找和外层显示条件此前均精确比较原字符串。真实 XAUUSD 浏览器中，将本机 chart-selection 切成大写、保留小写预览并延迟历史请求，预览可见断言失败；同一缓存单测也先失败。修复用与原生系列规则一致的数据集 ID 归一化，覆盖预览查找、显示、选中状态和预热去重/复用，保留来源、周期、主题、用户隔离，不把不同来源同名代码合并。

完整图表回归还两次复现：重载 M5 后 H1 预览消失。原生在正常恢复中重复发出图表类型通知，旧代码将其视为用户修改，清空全部预览。现在只在类型实际变化时失效；study_event 排除价格轴通知及已存在 study 的恢复通知；绘图排除单纯点击。真实新增/删除指标、参数与绘图修改仍触发失效。自动保存成功后也更新预览，使截图对应已持久化布局。

“准备图表”覆盖层现在在原生 Header 就绪时撤下，不再等待整个 onChartReady 初始化回调。没有匹配预览的新目标可以看到原生顶部控件和安静更新状态；已有匹配画面先显示带时间的预览，行情及指标就绪后替换。供应商策略、整份历史 result 协议、桌面行为、价格轴均未改。

验证通过：

```sh
cd web
npm run build
node tests/mobile-chart-preparation.cjs
node tests/mobile-cache.cjs
node tests/mobile-transport.cjs
node tests/advanced-market-request-scheduling.cjs
node tests/advanced-history-admission.cjs
MOBILE_CHART_OUTPUT=/tmp/mw-chart-preview-fix-final node tests/mobile-chart.browser.cjs
MOBILE_CHART_IDENTITY_ONLY=1 MOBILE_CHART_OUTPUT=/tmp/mw-chart-preview-identity-final node tests/mobile-chart.browser.cjs
MOBILE_CHART_CONTINUITY_ONLY=1 MOBILE_CHART_OUTPUT=/tmp/mw-chart-preview-continuity-final node tests/mobile-chart.browser.cjs
```

完整许可 widget 回归、身份差异专项及连续显示独立复验均无页面错误；身份专项覆盖大写目标使用小写预览，以及无预览且历史挂起时顶部控件不被覆盖。截图与 proof 见 [chart-preview-match](chart-preview-match/)。另通过 git diff --check。临时事件日志已从源码及测试移除。

更新 Ubuntu 候选后，对真实 XAUUSD 再运行同一大小写复现路径：浏览器本机 selection 为大写，预览 ID 为小写，延迟真实历史请求；先显示对应预览，Header 可见，新数据就绪后预览消失、显示实时图表。`errors=[]`、禁止业务写入 `writes=[]`；只调整验收浏览器自己的本机缓存，不改真实自选、告警、任务或服务器偏好。截图及 proof 见 [live](chart-preview-match/live/)。

Ubuntu quant-server 隔离 Docker project `mw-android-personal-v205`，只更新 web，复用本任务原服务/数据库。构建前可用内存约 9.3GiB、磁盘约 16GiB，无新增服务。通过 mw-docker build 构建，候选：

- 地址：<https://192.168.7.232:18445/m/>。
- Shell：`dc5c780916904e2f`。
- 图表脚本：`chart.cd9b2e98f04b22d5.js`。
- 镜像：`market-watch-web:android-personal-v205-preview-match-20261113`。
- image ID：`sha256:051d795da93423ce5e0bc03d1733c6d4e87f53ea0e7c1ac065e97a9ce401cea6`。
- web healthy，证书校验 `/readyz` 及 Shell 正常；私有旧配置 `before-chart-preview-match-run.json` 权限 0600。

启动/停止命令沿用 [上一轮部署记录](chart-continuity-20261113.md#部署与手机更新)，run.json 已固定当前候选 image ID。手机通过“更多 → 检查更新 → 更新页面”更新，不清除本机缓存，不需重装 APK。尚未连接 Android 真机调试，用户手机的最终恢复行为仍待确认；首次从未生成预览的目标不能凭空恢复旧画面。
