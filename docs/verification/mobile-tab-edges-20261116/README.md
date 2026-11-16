# 手机分页滑动白边修复

2026-11-16，`feat/managed-live-rollover-20261113` 当前工作树。P0：仅调整手机共享分页及列表的 CSS 布局，不更改接口、手势算法或后台任务。保留本工作树此前改动。本次不运行远程 CI、不更新 PR。

## 原因与修改

原分页视口与内容共用页面的 16px 留白，数据/告警的 375px 屏幕中实际只在 x=16、宽343px 的区域滑动。两侧留白固定，内容移出视口时提前截断，形成静止白边。抽屉同样多留16px（不含其1px外框）。

- `controls.css`：滑动视口向两侧扩展到容器边缘，16px 阅读边距移到各面板内部。每页内容和边距一起移动。
- `data-controls.css`、`alerts-controls.css`：列表滚动区同步至整宽，内部仍保留16px阅读距离。
- `watch-controls.css`：管理面板只清纵向 padding，保留共享横向留白。
- 四处统一覆盖数据分类、告警规则/记录、事件记录抽屉、管理自选。导航、抽屉头部和静止时的信息层次保持。

对比：[数据拖动](data-comparison.png)、[告警拖动](alerts-comparison.png)、[自选管理拖动](watch-comparison.png)。均为实际构建界面和原生 CDP 触摸中帧，内容随当前实例数据变化。

## 验证

- [完整构建](build.log)、[Docker候选构建](docker-build.log)与 `git diff --check` 通过。
- 定向只读探针：原版本对整宽断言失败，见 [baseline](baseline.log)；本次构建及最终部署通过，见 [deployed](deployed.log)。数据/告警视口覆盖屏幕；抽屉覆盖其内容边界，仅保留原有1px外框。375px浅色常规字、412px深色150%字号均无页面横向溢出，详见各目录 proof.json。
- [手势回归矩阵](motion-matrix.json)：使用本次构建的静态资源及18447只读接口，375/412px、深浅主题、100%/150%字号；四处跟手切换、相邻面板、短滑、取消/多指/斜滑/边缘、键盘、快速切换和 reduced motion 通过；无页面异常或业务写入。
- [数据分类回归](categories.json)：12组检查、30张截图，分页、缓存、切页位置、下拉刷新及失败/离线恢复通过。入口：在 `web/` 运行 `MOBILE_DATA_CATEGORIES=1 node tests/mobile-data-workflow.browser.cjs`。
- [部署后中帧](deployed/)再次确认真实网页资源，未注入候选CSS。源码中使用的测量探针在本机 `/tmp/mw-tab-edges-20261116/probe.cjs`，仅用于本次只读截图；前后测量与截图已归档。
- 以上是浏览器触摸和截图验收；Android真机手感及系统边缘返回仍由用户确认。

## 部署与回退

Ubuntu本机Docker，地址 **https://192.168.7.232:18447/m/data**。仅重建 `mw-managed-live-rollover-20261113` 的 web 容器，其他容器身份及镜像保持，详见 [部署核查](deployment.json)。HTTPS通过APK内CA校验；readyz、实际HTML、手机壳与APK 0.1.4下载SHA256通过。手机壳版本 `1c03a9e69e547921`，无需重装APK，在“更多 → 检查更新”应用网页更新。

启动/停止沿用本任务私有目录 `/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/` 的 `start.sh` / `stop.sh`。回退时仅将私有 run.json 与 compose.json 的 web image 恢复为 deployment.json 的 previous，再执行：

```sh
docker compose -p mw-managed-live-rollover-20261113 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/run.json \
  up -d --no-build --no-deps web
```

本次私有配置备份为该目录的 `mobile-tab-edges-20261116-backup/`，不回退数据库或其他服务。
