# 告警与数据页签统一

2026-11-15，`feat/managed-live-rollover-20261113` 工作树局部修改，P0：仅手机布局与样式，无 API、告警执行、存储或数据读取策略变更。保留已有未提交工作。

- 告警“规则 / 记录”使用数据页的紧凑线形页签，统一字号、间距、46px 触摸高度、2px 选中线及分隔线。两页使用 `controls.css` 的共享 `.mobile-page-tabs-nav` 样式，移除原来的重复规则。
- “当前规则”的筛选入口移至标题右上角、加号左侧，只显示筛选图标；44px 点击区域、可访问名称、展开状态和筛选生效强调保留。实际筛选条件与清除入口沿用现有逻辑。
- 记录视图的异常/恢复入口保持原有行为。

## 验证

- `cd web && npm run build` 通过。
- `MOBILE_ALERT_OUTPUT=../docs/verification/mobile-alert-navigation-20261115/alerts node tests/mobile-alerts.browser.cjs` 通过，覆盖创建、编辑、筛选、生命周期、历史记录、提醒处理及深浅主题/窄屏/大字号；真实构建与明确 HTTP 夹具，无真实规则写入。
- `MOBILE_DATA_CATEGORIES=1 MOBILE_DATA_OUTPUT=../docs/verification/mobile-alert-navigation-20261115/data node tests/mobile-data-workflow.browser.cjs` 通过，分类、分页、缓存、刷新、失败、断网及 375/412px × 深浅主题 × 14/21px 字号回归，19 张截图。
- 部署后 `node docs/verification/mobile-alert-navigation-20261115/runtime-check.cjs` 通过，真实 API 只读；8 种尺寸/主题/字号组合逐一比较两页实际字体、页签高度、间距、下划线和边框，全部一致。验证筛选与加号触摸区域、图标布局、筛选抽屉可达和记录入口，16 张截图，页面异常和写请求均为零。认证会话通过私有凭据创建，凭据不归档。
- 已查看夹具与真实页面截图，布局正常；`git diff --check` 通过。
- HTTPS 使用 APK 信任的 CA 验证，手机 shell `6b8272f4fe4fa50f` 与 SW/manifest 一致、6 个资源和 `/readyz` 全部 200，运行镜像与部署记录一致。APK 下载目录原只读挂载保留。

证据：[运行检查](runtime-proof.json)、[部署检查](checks.json)、[告警截图](runtime/alerts-light-375-14.png)、[数据页截图](runtime/data-light-375-14.png)。Android 实机触摸仍由用户确认。

## Ubuntu 验收实例

主机为 **Ubuntu 本机 Docker**，project/task `mw-managed-live-rollover-20261113`；地址 **https://192.168.7.232:18447/m/alerts**。仅替换 web，详情见 [部署记录](deployment.json)。API、worker、数据库及其他任务实例保持原状；无 Unraid 操作，无 PR/CI/正式 tag 操作。

无需新 APK，通过“更多 → 检查更新”应用网页更新。

启动/停止：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

任务私有 `run.json` 与 `compose.json` 已备份为 `.before-mobile-alert-navigation-<stamp>`。回退时只将 web image 改回部署记录的 previous 值，再对同 project 执行 `up -d --no-build --no-deps web`；不覆盖其他服务或恢复数据库。
