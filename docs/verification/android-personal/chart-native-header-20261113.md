# 手机图表原生 Header 与周期收藏

分支 `feat/android-personal-v205`。F0：手机 UI 和原生图表接入配置，另补齐本机固定许可包中缺失的触摸导出模块；不涉及 API、数据库或持久格式变更。按用户已认可的方案 A 实施，未跑 CI、未更新 PR、未操作 Unraid。

移除整个 React 外层图表栏及其品种搜索／更多抽屉。顶部现在使用真实 Charting Library Header：周期收藏快捷按钮、周期菜单、图表类型、指标、设置，以及通过公开 Header 扩展 API 打开原生绘图／光标工具栏的“绘图”按钮。周期控件为 `header_resolutions`；用户澄清后，底部 `timeframes_toolbar` 继续隐藏。手机 Header 不重复显示品种；点原生图例可搜索切换品种。

初始收藏 M5/H1，已有本机收藏优先。用户在原生周期菜单加星或取消后，快捷按钮即时更新，收藏和 K 线周期分别沿原生 settings_adapter／本机图表保存链路写入手机 IndexedDB，重载可恢复。桌面 Header 配置及服务器布局保存边界保持原实现。手机原生菜单的返回处理覆盖实际 menuitem 标记；参数编辑仍保留确认和恢复逻辑。

许可包原始归档缺少 floating-toolbars 引用的 `hammerjs.faf756299593572313c8.js`，底层 Hammer chunk 72141 实际存在。`native-touch-assets.mjs` 在构建 staging 校验两个原生模块 SHA256，生成项目自有 chunk 85652 / module 682937 导出桥，直接复用原生 module 172141。许可源文件不修改、不提交。桥内容计入库目录版本，避免沿用旧 404 地址。第一次 Ubuntu 尝试捕获到该缺失，修复后最终真实验证无页面错误、无通知。

通过的最小检查：

```sh
cd web
npm run build
MOBILE_CHART_OUTPUT=/tmp/mw-native-header-final node tests/mobile-chart.browser.cjs
node tests/mobile-app.browser.cjs
```

另执行 `git diff --check`。图表浏览器夹具使用实际许可 widget，覆盖原生触摸模块 HTTP 加载与真实 Hammer Manager 创建／销毁、周期菜单加星和取消、直接点选、收藏重载、原生绘图与指标、设置和参数丢弃确认、375/412px 深浅主题、14/21px 外层根字号、横屏、保存视窗首次历史失败及重试、正常自动保存静默和真实 IDB 写入失败恢复。手机整体验证保留 20 次切页单一 widget、离线与会话处理、参数恢复和安全页面更新。两组页面错误和禁止业务写入均为空。

最终 Ubuntu 实际 XAUUSD 验证：原生 M5 切换和本机保存，真实历史返回 2000 根；原生周期菜单加星后重载恢复；原生绘图／十字线与指标可打开；返回关闭菜单而不退出图表；375/412px 深色及 375px 浅色截图已查看。没有修改真实自选、告警、任务或服务器偏好；页面错误、禁止业务写入和通知均为空。证据见 [chart-native-header](chart-native-header/)。浏览器模拟 APK 的 blob 子框架限制，不等于 Android 真机验收。

实际运行主机为 Ubuntu `quant-server`，复用独立 task/project `mw-android-personal-v205`，只替换 web 服务。部署前可用内存约 9.3GiB、磁盘约 14GiB；复用原 api、data-worker、tls、postgres，不新增服务或数据库。

- 地址：<https://192.168.7.232:18445/m/>。
- Shell：`692db7eb494e982e`。
- 原生库目录：`charting_library_cac76587a71a1c3f`。
- 镜像：`market-watch-web:android-personal-v205-native-header-touch-20261113`。
- 运行 image ID：`sha256:61025eb72505d18671c8ea78c1802786fca77fb71ba48401f7b394ee27001dd4`。
- 验证：证书校验 `/readyz` 正常，原生 touch bridge HTTP 200，web 容器 running。
- 私有配置备份 `before-native-header-run.json`（0600）保留任务前的已验证镜像；`before-native-header-touch-run.json` 保留首次尝试配置。回退选择前者；原镜像与配置保留。

启动与停止前端：

```sh
docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  up -d --no-build --pull never --no-deps --wait web

docker compose --env-file /dev/null -p mw-android-personal-v205 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/run.json \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-android-personal-v205/live-data.override.json \
  stop web
```

手机通过“更多 → 检查更新 → 更新页面”获取新版，无需重新安装 APK。待用户在真机重点确认原生周期收藏、快捷点选与触摸手感。
