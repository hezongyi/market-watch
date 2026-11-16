# 手机图表未选品种空态打磨

2026-11-15，`feat/managed-live-rollover-20261113` 当前工作树。P0：局部空态布局与导航入口调整，不改变图表运行时、行情请求、预取和存储策略，保留其他未提交工作。

## 变化

- 使用现有 shadcn Empty、Button 和 Lucide 图标，页头对齐手机其他页面的字号和边距；空态图标采用导航一致的蜡烛图图形，轻色背景，无虚构行情曲线。
- 以图标、标题、简短说明、主次操作建立层级，移除“真实系列”等技术措辞。
- 主按钮“前往自选”，可从既有列表打开图表；次操作“查看自建行情”进入数据页。不创建重复搜索器，也不自动选择或替换用户已有品种。
- 375/412px 与深浅主题，系统字号放大时自然增高；短屏减小留白、支持内部滚动，底部导航可继续使用。
- 共享的离线图表空态同步规范页头/文字/按钮排布，保留“等待连接图表”和“重新连接”。已有专业图表及原生工具栏不受影响。

修改文件：`web/src/mobile/ChartState.tsx`、`MobileApp.tsx`、`chart-controls.css`。

## 验证

- `cd web && npm run build`：通过，见 [build.log](build.log)，原有 Vite 大包提示保留。
- [capture.cjs](capture.cjs)：使用隔离浏览器 profile，实际构建截图与现有 Ubuntu 环境只读验收；所有浏览器 API 写请求均拦截，登录由独立请求完成。不改变真实自选、图表本机选择或服务端配置。
- `CHART_EMPTY_BEFORE=1 node docs/verification/mobile-chart-empty-20261115/capture.cjs`：修改前真实环境 8 张截图，见 [before](before/proof.json)。
- `CHART_EMPTY_LOCAL=1 node docs/verification/mobile-chart-empty-20261115/capture.cjs`：最终构建 13 张截图，见 [local](local/proof.json)。覆盖深浅主题、375/412px、14/21px 根字号，以及 375×480 和 812×375 短屏，检查无横向溢出、按钮至少 48px、次操作可滚动至导航上方、未选择时无图表 iframe、两项导航正确、连接核验失败时的离线空态。脚本通过返回 503 模拟服务不可用，不能据此宣称断网 PWA 重载或真机系统手势验收完成。
- 图表既有回归：`MOBILE_CHART_CONTINUITY_ONLY=1 MOBILE_CHART_OUTPUT=../docs/verification/mobile-chart-empty-20261115/chart node tests/mobile-chart.browser.cjs` 通过。覆盖真实许可图表的原生周期控件、周期收藏、返回、十字线和延迟查询时上次图表回显，见 [chart.log](chart.log)。本次最终改动只补缩短空态文案与短屏样式，未修改图表代码。
- 截图逐一抽查普通/大字号和短屏，短屏首屏操作可见，未增加动画或加载提示。浏览器截图不能代表 Android 真机已验收。
- `git diff --check` 通过。

## Ubuntu 验收

仅更新 Ubuntu 本机 Docker 的 web 服务，沿用现有项目隔离，不启动其他服务。

https://192.168.7.232:18447/m/chart

镜像和原镜像见 [deployment.json](deployment.json)，构建日志见 [docker-build.log](docker-build.log)。部署后 13 张截图及两个导航入口验证通过，无页面异常，见 [after/proof.json](after/proof.json)；进入自选后自动发生的 quote/sparkline/resolve/subscribe 后台请求在浏览器拦截，未发送到服务，不以此验收行情链路。HTTPS、shell、资源、健康与 APK 下载保留检查见 [checks.json](checks.json)。无需新 APK，通过“更多 → 检查更新”应用网页更新。已选过品种的用户会继续看到既有图表；空态只在没有本机图表品种选择时出现，不为展示新 UI 清除真实用户选择。

启动/停止：

```sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

回退：将私有 run.json、compose.json 的 web image 改回 deployment.json 的 previous 值，然后仅替换 web：

```sh
docker compose -p mw-managed-live-rollover-20261113 \
 -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
 up -d --no-build --no-deps web
```

未提交 commit、更新 PR、运行远程 CI、打正式 tag 或部署 Unraid。
