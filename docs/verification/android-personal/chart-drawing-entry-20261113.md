# 手机图表绘图入口与设置收口

分支 `feat/android-personal-v205`。F0：手机 Header、绘图入口状态与上下文菜单接入配置。沿用已认可的原生专业图表方向，未跑 CI、未更新 PR、未操作 Unraid。

手机顶部去掉设置齿轮，完整设置仍从右下角价格轴齿轮 → 更多设置… 进入。“绘图”加入画笔图标，展开时高亮；通过公开 `toggle_sidebar` 事件同步按钮的 aria-pressed / aria-expanded，原生边缘开关也能同步。每次初始化默认收起，导航切页保留 widget 当前状态。原生工具菜单、加星、浮动收藏、绘图参数与保存链路保留。

手机上下文菜单不再交给依赖桌面 workspace 的自定义告警桥，清理“创建告警不可用”的错误项；桌面菜单和 Header 配置保持原逻辑。Header 模式使用许可 API 支持的 adaptive，以保留周期收藏。

验证：

```sh
cd web
npm run build
MOBILE_CHART_OUTPUT=/tmp/mw-drawing-entry-final node tests/mobile-chart.browser.cjs
node tests/mobile-app.browser.cjs
```

另通过 `git diff --check`。实际许可 widget 夹具验证：触屏从收藏水平线快捷栏放置、属性窗口、几何修改及重载恢复、原生删除、收藏恢复、原生侧栏与 Header 状态同步、初始收起；底部价格轴菜单进入完整设置，参数丢弃确认保留；375/412px 深浅主题及大字号、横屏、周期收藏、本机存储失败恢复和切页生命周期回归通过。页面错误和禁止业务写入均为空。截图与检查证据见 [chart-drawing-entry](chart-drawing-entry/)，含前后截图、交互 proof 和打磨记录。

真实 XAUUSD 检查首次已取得 2000 根历史，但随后出现一次行情读取超时通知，遮挡顶部操作；关闭并重试后，通过绘图展开高亮、指标、底部完整设置、周期收藏重载和深浅窄屏检查。最终运行页面错误、禁止业务写入、通知均为空。此为 Ubuntu 浏览器实数据与 APK blob 策略重放，不能代替 Android 真机手感和全部绘图工具逐项验收。

实际运行主机 Ubuntu `quant-server`，复用 task/project `mw-android-personal-v205`，仅替换 web，复用原 api、data-worker、tls、postgres；部署前可用内存约 9.1GiB、磁盘约 18GiB，没有新增服务或数据库。

- 地址：<https://192.168.7.232:18445/m/>。
- Shell：`e2d1ff7f3a047bb6`。
- 镜像：`market-watch-web:android-personal-v205-drawing-entry-20261113`。
- 运行 image ID：`sha256:d5e0edf84566f335c29d706674479a9afb63ebe874c952316c6d68a7f5c22a3e`。
- 证书验证 `/readyz` 正常，web running。
- 私有配置备份 `before-drawing-entry-run.json`（0600）保留此次之前的镜像配置，原镜像保留。

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

手机通过“更多 → 检查更新 → 更新页面”获取，无需重装 APK。待用户确认绘图按钮、原生收藏浮动栏与底部设置的真机操作手感。
