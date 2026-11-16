# 手机告警页下拉刷新

2026-11-15，`feat/managed-live-rollover-20261113` 工作树，P0 手机端局部交互修改；保留原有未提交修改。沿用现有 API、告警执行、通知及持久化语义。

## 实现

- 规则、归档规则与触发记录在列表顶部支持下拉刷新，复用数据页的 `usePullRefresh`、56px 阈值及刷新动效。标题与页签保持可见，各列表拥有实际滚动区。
- 规则重读当前已加载页及执行服务状态；归档视图重读已加载的归档规则；记录重读当前已加载范围，保留搜索及处理状态。
- 新增 `AlertListRefresh.tsx`，刷新完成和失败均收回提示；切页、切筛选、断网、进入后台时清除本次刷新状态，迟到完成不会重新打开提示。短拉、横向手势、非顶部及刷新中不重复触发。
- `useSymbolSearch.refresh()` 仅增加返回原读取 Promise，调用方式与数据处理保持兼容，供记录列表等待实际完成。规则读取保留原 mutation fence；归档读取复用可取消请求。规则详情抽屉中的记录保留原布局，不加第二层滚动容器。

## 验证

- 完整 Web 构建通过，包括 TypeScript、Vite、图表资源和手机 shell。
- `cd web && MOBILE_ALERT_PULL_REFRESH=1 MOBILE_ALERT_OUTPUT=../docs/verification/mobile-alert-pull-refresh-20261115/pull node tests/mobile-alerts.browser.cjs` 通过。新增场景使用 Chromium CDP 实际触摸拖动与松手，验证慢请求、重复拉取、短拉/横拉/非顶部、失败保留及恢复、归档过滤、记录搜索保留、切页、断网和后台切换。告警原有创建、编辑、幂等、冲突、生命周期、历史分页、提醒处理和截图回归同时通过。
- `cd web && node tests/mobile-symbol-search.browser.cjs` 通过，覆盖共享刷新、分页、关闭取消、迟到响应、缓存和离线保护。结果归档于 `search.log`、`search/checks.json`。
- `mobile-alerts.cjs`、`mobile-alert-view.cjs` 通过，原有告警能力与状态语义保持。
- 已查看慢刷新、失败、规则/记录、深浅主题与大字号截图，见 `pull/`；页面异常为零。`git diff --check` 通过。
- 部署后真实 API 只读复验见 [运行记录](runtime-proof.json)：规则、记录的真实读取与刷新提示收回，及 375/412px × 深浅主题 × 14/21px 字号布局。仅创建认证会话，无真实规则/通知写操作。Android 真机触摸手感仍需用户确认。
- 使用 APK 信任的 CA 校验 HTTPS，手机 shell/SW/manifest 版本一致，6 个资源与 readyz 均 200；运行容器镜像一致，下载目录只读挂载保留，见 [检查记录](checks.json)。

## 部署

实际主机：Ubuntu 本机 Docker。project/task：`mw-managed-live-rollover-20261113`。访问 **https://192.168.7.232:18447/m/alerts**。

仅更新 web，镜像、前一镜像与配置备份时间见 [部署记录](deployment.json)。无需新 APK，在“更多 → 检查更新”应用网页更新。未运行远程 CI、修改 PR、打正式 tag 或操作 Unraid。

启动/停止：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

私有 `run.json`、`compose.json` 已备份为 `.before-mobile-alert-pull-refresh-<stamp>`。回退时仅将 web image 改回 previous 值，再执行同 project 的 `up -d --no-build --no-deps web`，不整体覆盖其他服务或数据库。
