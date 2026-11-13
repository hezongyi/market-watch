# 手机图表自动保存提示

分支 `feat/android-personal-v205`，P0：仅去掉手机外层将正常待保存状态显示为警告的 UI 及无用状态传递；专业图表、数据、保存时机和失败处理保持原实现。未跑 CI、未更新 PR、未操作 Unraid。使用 `diagnosing-bugs` 与 `market-watch-mobile-ui`。

图表区域直接使用固定许可的 TradingView v31.1.0。用户看到的“本次图表更改尚未记住”来自 `MobileApp.tsx`，只要收到 `workspace-dirty` 就显示，不以存储写入失败为条件。图表改动后本机保存有 300ms 合并等待；原生延迟的 `onAutoSaveNeeded` 还可能再次触发保存，导致警告反复出现。

在实际 widget 上记录到 dirty 后约 300ms 收到 mobile-saved，指标重新打开能恢复，说明此复现中的保存正常。回归在 workspace 写入处保持请求未完成，断言正常待保存不显示失败警告。修复前命令 `MOBILE_CHART_SAVE_ONLY=1 MOBILE_CHART_OUTPUT=/tmp/mw-chart-save-red node tests/mobile-chart.browser.cjs` 返回 1：`pending autosave must not be presented as a storage failure`，实际警告数为 1。

现在正常保存静默；移除外围警告及只为该警告维护的 React 状态，专业图表运行时和 IndexedDB 写入链路没有修改。真实写入失败仍沿用“本次图表设置未记住…”通知；显式离开/更新前 flush 仍等待保存或报告失败。

通过检查：

```sh
cd web
npm run build
MOBILE_CHART_OUTPUT=/tmp/mw-chart-save-full-final node tests/mobile-chart.browser.cjs
node tests/mobile-app.browser.cjs
git diff --check
```

图表回归增加：保持写入中的正常静默；添加 RSI、重载核对参数；在真实 IndexedDB `put` 边界抛错，确认失败仍有通知；恢复存储、显式 flush 后重载核对最新变更。保留用例开始时既有指标，未删除其他设置。图表与手机端完整回归的页面错误、禁止业务写入均为空。

浏览器证据见 [chart-local-save](a07-feedback/chart-local-save/)，包含修复前警告、正常写入中、实际写入失败和重载截图。Android 真机效果待用户确认。

Ubuntu 实际 XAUUSD 验证通过：切换 M5 后无误导警告，本机保存的 interval 为 `5`；重新加载恢复 XAUUSD/M5，并返回真实 2000 根历史 K 线。没有修改真实自选、告警、任务或服务器偏好，页面错误及禁止业务写入均为零。结果为 `live-proof.json`，截图为 `live-xauusd-saved.png`。证书校验的 `/readyz` 正常，部署容器 running。

部署复用 Ubuntu `quant-server` 的独立 project/task `mw-android-personal-v205`，只更新 web，不新增数据库或其他服务。部署前可用内存约 9.7GiB、磁盘约 13GiB。

- 地址：<https://192.168.7.232:18445/m/>。
- Shell：`e489696f0744a49c`。
- 镜像：`market-watch-web:android-personal-v205-chart-save-20261113`。
- 运行镜像 ID：`sha256:144c30bf2eea138d7dbd56430230d21be2a675faab5221dfaec84011b0864253`。
- 私有回退配置：`before-chart-save-run.json`（0600）；启动/停止命令与 [图表加载验证记录](chart-webview-loading-20261113.md) 相同，回退时使用本轮备份替换 `run.json`。原图表历史修复镜像保留。

手机通过“更多 → 检查更新 → 更新页面”取得新版，无需重新安装 APK。
