# 手机图表十字线、Header 顺序及 Python 指标

这是本日较早一轮的实现记录。后续已按用户要求将手机增强指标窗口换为简洁原生窗口补入 Python，并更新验收 Shell；当前行为和部署见 [连续显示与原生 Python 指标](chart-continuity-20261113.md)。

分支 `feat/android-personal-v205`。F0：手机 Header 入口与既有指标选择器接入，没有 API、数据库或持久格式变更。未跑 CI、未更新 PR、未操作 Unraid。

按用户要求移除右上绘图按钮，换成直接控制原生触屏 tracking 的“十字线”按钮。点击开启并高亮，再点关闭；启用时通过公开 selectLineTool 切回 cursor，避免残留画线模式。复用固定 v31 触屏接口，使用原生 crossHairMoved 与手势结束同步实际状态，支持原生长按进入／轻点退出。绘图仍从原生左侧边缘入口进入，收藏浮动栏保留。

后续用户指定顺序：周期 → 十字线 → 指标 → K 线类型。采用手机作用域 CSS 对固定原生 Header 的 flex 分组排序，不移动许可 DOM 或修改许可源文件。375/412px 深浅主题、150% 外层字号均验证顺序和可见性。

发现手机此前原生指标列表未展示 custom Python studies，而 custom_indicators_getter 和后台计算已接入。现在手机保留原生指标按钮，点击转交已有 chartIndicatorPicker / chartNativeIndicators 扩展，复用原生控制器、搜索、分类、添加、详情与收藏，显示“我的 Python”。单独加载现有 indicator-picker.css，不套用桌面 chart-menu.css。桌面配置与指标实现未改。

检查通过：

```sh
cd web
npm run build
MOBILE_CHART_OUTPUT=/tmp/mw-crosshair-order-final node tests/mobile-chart.browser.cjs
node tests/mobile-app.browser.cjs
```

另通过 git diff --check。实际许可 widget 夹具验证原生 tracking 开关、CDP 触屏拖动读数位置、长按进入和点击退出时按钮状态同步、从绘图工具切回 cursor、工具收藏和画线保存删除；指标分类列出 Python SMA；底部完整设置、参数丢弃、周期收藏、加载失败／重试和本机保存错误恢复正常。页面错误与禁止业务写入为空。截图与 proof 见 [chart-crosshair-python](chart-crosshair-python/)。

Ubuntu 实际 XAUUSD：真实历史、十字线开关和拖动、原生绘图边缘入口、Python 指标分类与添加 SMA、后台指标返回及图中曲线显示；验证后移除浏览器本机 SMA，不改服务器自选／告警／任务／偏好。真实数据验证临时脚本只暴露 widget 测试句柄和重放 APK blob 限制，不能代替 Android 真机验收。

实际主机 Ubuntu quant-server；复用 task/project mw-android-personal-v205，仅替换 web，复用原 api、data-worker、tls、postgres。部署前可用内存约 9.3GiB、磁盘约 18GiB，没有新增服务或数据库。

- 地址：<https://192.168.7.232:18445/m/>。
- Shell：`3d81f3b71fe93fbb`。
- 镜像：`market-watch-web:android-personal-v205-crosshair-python-20261113`。
- image ID：`sha256:75f12c940bdc5b50c9006aac00c2c4ba4322aaa2d3cab2de410d4c22aebbfafe`。
- web running，证书校验 /readyz 正常。
- 私有配置备份 before-crosshair-entry-run.json 保留绘图按钮版本；before-crosshair-python-run.json 保留中间十字线版本，权限均 0600，旧镜像保留。

启动／停止 web：

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

手机使用“更多 → 检查更新 → 更新页面”，无需重装 APK；真机待确认十字线拖动与 Python 指标添加的手感。
