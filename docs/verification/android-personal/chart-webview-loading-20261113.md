# APK 专业图表启动卡住

分支 `feat/android-personal-v205`。F0：手机图表使用同源 iframe 引导，并修复历史读取失败阻塞保存视区恢复的问题，增加手机行情错误及重试入口；不修改 APK、API、存储格式及桌面图表加载方式。使用构建、图表/手机浏览器回归及 Ubuntu R1 验证。未跑 CI、未更新 PR、未操作 Unraid。使用 `diagnosing-bugs` 与 `market-watch-mobile-ui` skill。

## 最新结果：历史失败阻塞视区恢复

用户反馈首轮更新后依旧加载。Android WebView 在 2026-11-13 01:40:55–01:41:14 UTC 已请求专业库 bundles，说明同源引导已解决第一层导航阻断；随后历史请求返回 HTTP 200 并取消清理。HTTP 成功不代表历史结果成功，失败状态同样以 200 返回。

新增真实许可 widget 回归：打开平台行情、保存本机 `_mwViewports`，随后让重载后的首次历史返回 `load.state=failed`。`MOBILE_CHART_STARTUP_ONLY=1 MOBILE_CHART_OUTPUT=/tmp/mw-chart-history-red3 node tests/mobile-chart.browser.cjs` 在修复前返回 1：8 秒后“指标”仍 disabled，遮罩仍显示“正在加载专业图表”。临时探针确认 `onChartReady` 与主题恢复已完成，停在 `await restoreViewports()`；探针已移除。红色截图为 `history-before-loading.png`。

原因是失败历史不触发原生 `dataReady`，而保存视区恢复等待该回调，阻塞宿主 `ready`。手机现在监听现有 `mw-history-state` 和原生 `failure(chart)`，在明确历史失败时结束可选视区恢复并释放同步暂停；不伪造数据就绪、不增加超时掩盖失败。宿主显示常驻错误和“重试行情”，仍可操作品种及周期。首次失败发生在宿主就绪前时也会补发当前失败状态。主行情不再同时生成遮挡工具栏的重复通知；指标和桌面的错误通道保留。

重试验证还发现：仅调用既有 `resetData` 不重新请求失败历史。依照固定 v31 的公开 API 契约，手机单图先 `widget.resetCache()`，再走既有重试方法。实际回归证明重试发起请求、读取期间禁用重复操作、成功后消除错误；同一 widget 与本机图表设置保留。

最终检查均通过：

```sh
cd web
npm run build
MOBILE_CHART_OUTPUT=/tmp/mw-chart-history-full node tests/mobile-chart.browser.cjs
node tests/mobile-app.browser.cjs
git diff --check
```

图表专项包括新的保存视区/首次历史失败/重试用例，以及原有周期、指标、参数、导航、深浅主题、375/412px、放大字体、触摸抽屉、离线重连及启动重试。页面错误及禁止业务写入均为空。结果为 `history-browser-proof.json`，错误与恢复截图为 `history-after-*.png`。

Ubuntu 18445 的真实 XAUUSD（Dukascopy）已返回 2000 根 K 线；在该图表真实保存的本机视区上重载并注入一次失败，遮罩退出、错误可见；点击重试后由真实后端重新返回 2000 根 K 线并清除错误。`history-live-proof.json` 区分注入失败与真实供源响应；`history-live-xauusd*.png` 为稳定截图。没有修改真实自选、告警或任务。浏览器重放 APK 的 blob 导航取消策略；这仍不等同于 Android 真机验收，本机没有连接 adb 设备。

最新部署仅替换原 Ubuntu project 的 web：

- 访问：<https://192.168.7.232:18445/m/>；证书校验的 `/readyz` 正常。
- Shell：`be3c7a266f64bc5e`。
- 镜像 tag：`market-watch-web:android-personal-v205-chart-history-20261113`。
- 运行镜像：`sha256:88c1436318d46994eff91db792ce30f200ddf0b2cb701e26bed92d20b8b453df`，容器 running，HTTP 就绪检查通过。
- 本轮回退：私有任务目录的 `before-chart-history-run.json`（0600），保留首轮镜像。启动/停止命令沿用下文；本轮回退时将 `run.json` 换为此文件。

手机操作：更多 → 检查更新 → 更新页面，再打开 XAUUSD。无需重新安装 APK；真机结果仍待用户确认。下文保留首轮排查和部署记录。

## 证据与原因

用户在 APK 打开 XAUUSD 时一直看到“正在加载专业图表…”。Ubuntu 18445 的 Android WebView 请求记录显示：2026-11-13 01:11 / 01:21 UTC 已成功取得 charting_library.js、adapter、catalog 与 history-capabilities，但没有后续图表 bundles 请求。WebView 为 Android 16 / Chrome 156；普通 Chromium 的新建及本机设置恢复均可打开 XAUUSD。

`MainActivity.shouldOverrideUrlLoading` 仅放行配置服务器的 HTTPS 导航，因而取消图表库默认的 `blob:` 子框架。图表文档未运行，adapter 无法发出 ready，宿主持续显示加载遮罩。

在实际构建页面与许可 widget 上，于 vendor 插入 iframe 的 `innerHTML` 边界重放取消 blob 导航：修复前 30 秒后指标按钮仍禁用，页面保留同一加载文案。命令为 `MOBILE_CHART_OUTPUT=/tmp/mw-chart-webview-red node tests/mobile-chart.browser.cjs`，返回 1。该重放不等同于 Android 真机运行；本机 adb 当前没有连接设备。

修复仅在 `mobileMode` 启用库原有的 `iframe_loading_same_origin`，通过版本化库目录内的 `sameorigin.html` 引导，符合 APK 既有同源导航规则。无需放宽 APK 导航或重新安装。

## 回归

```sh
cd web
npm run build
MOBILE_CHART_OUTPUT=/tmp/mw-chart-webview-green node tests/mobile-chart.browser.cjs
node tests/mobile-app.browser.cjs
```

两项浏览器回归通过，页面错误及禁止的业务写入为零。图表专项保留 blob 导航取消重放，并断言 iframe 使用 `sameorigin.html`；覆盖实际 K 线、周期、指标、设置、参数确认、主题、导航、本机恢复及失败重试。截图与结果见 [chart-webview-loading](a07-feedback/chart-webview-loading/)。`git diff --check` 通过。

## 部署与回退

实际运行主机 `quant-server`，Ubuntu Docker 独立 project/task `mw-android-personal-v205`，只更新既有 web 服务。预览 <https://192.168.7.232:18445/m/>，CA 校验的 `/readyz` 返回 ready。

- Shell：`376cc5fbcea24616`。
- Web 镜像：`sha256:e2947b293b51ea2c52f4741388b5c96703b47562c449fec9010d1a33de857546`。
- 构建：`mw-docker build`，显式指定 worktree 根 context、`web/Dockerfile`、component web、task/project 及 purpose acceptance。
- 回退配置：私有任务目录 `before-chart-webview-run.json`，保留上一镜像。

启动/更新命令如下；停止时将末行改为 `stop web`。回退时将 `run.json` 替换为 `before-chart-webview-run.json` 并执行相同 up 命令，不改数据库。

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web
```

Ubuntu 实际 XAUUSD（Dukascopy）首次打开、导航返回及本机状态重载均通过同源 iframe 打开，加载遮罩消失，两次历史结果各返回 2000 根真实 K 线。实际验收未修改自选、告警或任务，页面错误与禁止的业务写入均为零。供源期间一次请求临时失败，随后新会话读取成功；不将供源的单次成功等同于持续可用性保证。证据为同目录的 `live-proof.json` 和 `live-xauusd-*.png`。

APK 更新路径：“更多 → 检查更新 → 更新页面”，再打开 XAUUSD。真机结果待用户确认。
