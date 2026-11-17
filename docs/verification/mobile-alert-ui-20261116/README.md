# 手机告警页 UI 验收 · 2026-11-16

基线 `5038fd1e`，分支 `feat/mobile-alert-ui-20261116`，P0 分类及边界见 [任务说明](../../issues/mobile-alert-ui-20261116.md)。

## 页面变化

- 保留规则/记录双视图，覆盖选品种、设置条件、监控、暂停/恢复、触发处理、到期/次数用完及归档。
- 规则列表突出实际执行状态，最近检查作为次级证据；详情点击区与启停开关触摸区独立。
- 规则详情将判定方式、次数和到期改为紧凑摘要，减少三行重复字段，让暂停/编辑与触发记录更容易到达。
- 搜索规则抽屉删除重复刷新按钮，列表沿用下拉刷新与读取失败重试。
- 修复判定方式切换中未选中项被共享主按钮 CSS 覆盖的问题；手机推送字段保持横向说明/开关布局。
- 高级设置、排查、设备回执和投递详情继续按需查看。没有改变触发算法、接口、幂等、提醒处理或配置默认值。

## 验证

- 完整 `npm run build` 通过：TypeScript、Vite、专业图表资源与手机 shell。保留既有大 chunk 提示。
- `MOBILE_ALERT_POLISH_MATRIX=1 MOBILE_ALERT_PULL_REFRESH=1 node tests/mobile-alerts.browser.cjs` 通过，页面错误为空。
- 覆盖 375/412px、浅/深、14/21px（150% 字号），规则、详情、搜索、品种选择、创建/高级设置、记录、触发详情/处理、长代码/条件、错误与异常恢复。
- 真实 Chromium 触摸验证下拉刷新等待/回收、失败后重试、离线/后台/抽屉关闭及分页记录。矩阵发现的规则点击区与开关扩展触摸区重叠已通过 12px 间隔修复。
- 截图等待分页实际到位，避免 350ms 固定等待截到 Embla 滑动中间帧；新增判定方式未选中态不呈主按钮的计算样式检查。
- `git diff --check` 通过，人工复核本目录代表性截图。完整矩阵位于 `/tmp/mw-alert-ui-20261116/accepted`，检查摘要为 `checks.json`。

## 开发实例

Ubuntu 本机 Docker `mw-dev`：<https://192.168.7.232:18443/m/alerts>。本次仅替换 web 容器，后台、数据库、通知配置保持原运行实例。web 镜像 `sha256:828d224a19670df1403af0b86077bd4b8447862ee6e50bbd870f4c2ddb53d73c`，手机 shell `22948f4d06933d15`。

严格 CA 校验的 HTTPS 登录及部署 shell 与验收构建比对通过。真实页面只读浏览器验收通过（375px 浅色 14px、412px 深色 21px），业务写请求和页面错误均为空，见 `deployment-proof.json`。

部署前后 3 条规则的 ID、版本、控制修订、状态、次数、运行编号及配置逐项相等。当前 1 条 active，后台实际 `monitoring`，检查和判定时间新鲜；2 条 completed 保持原状态。告警后台心跳正常，未为了界面测试修改真实规则。

私有更新记录、旧运行配置和启动器位于 `~/.local/share/market-watch-dev/updates/mobile-alert-ui-20261116/`。`mw-dev status` 查看、`mw-dev up` 启动、`mw-dev stop` 停止。回退前确认没有后续部署，再用 `before-run.json` 重建 web 并重启 tls，恢复 `before-mw-dev` 启动器；不需恢复数据库。

本次为 WebView 页面更新，无需重新安装 APK。Android 真机触控、系统键盘和锁屏通知实收不由本次浏览器验收证明；后台业务能力沿用上一轮已验证基线。本任务不涉及 Unraid、合并或正式 tag。

## 追加验收：正常收盘等待保持监控中

代码提交 `8a68c774`。M5 收盘后等待分钟确认、聚合或窗口证明，是后台监控流程的正常阶段。手机列表和详情在本次运行已接管且有有效判定/基准记录、无需恢复基准且无未恢复事件时保持“监控中”，不再短暂切成准备中或展示普通等待区间。详细原因与区间仍可展开排查查看。后台算法、查询、等待期限及审计未变。

首次准备、未知原因、真实来源故障、超过期限后的需处理、规则停滞、服务心跳失效、离线待确认，以及手机通知配置/投递错误继续如实显示。不可补判的真实历史缺口不隐藏。

- `node tests/mobile-alert-view.cjs` 通过，覆盖正常等待及上述边界。
- 完整 `npm run build` 通过，手机 shell `108ab7e02460701c`。
- `MOBILE_ALERT_READINESS=1 MOBILE_ALERT_OUTPUT=/tmp/mw-alert-steady-monitor-20261116 node tests/mobile-alerts.browser.cjs` 通过，375px 浅色14px、412px深色21px；验证列表/详情状态、等待提示消失、按需排查及真实缺口保留，页面错误为空。摘要 `steady-monitor-checks.json`，代表截图 `normal-close-wait-detail-{light,dark}.png`。
- Ubuntu 持久开发实例只读浏览器验证通过，页面错误和业务写请求为空，见 `steady-monitor-deployed-ui.json`。浏览器截图用于 UI 验证；严格 CA 验证由独立 HTTPS 检查完成。
- 严格 HTTPS、已部署 shell 与本机构建一致，3条规则配置、版本、状态、控制修订、次数和运行编号前后相等。2026-11-16 22:38 UTC 当前启用规则实际 monitoring，后台心跳新鲜，见 `steady-monitor-deployment.json`。正常等待转换的边界由 HTTP 夹具覆盖，未修改真实规则制造该状态。

本次仅更新 web 镜像为 `sha256:170512f6491d3de0f55ab94dbd96666e12050cd06fffbaa743c11616f757d1e9`，并重启 TLS 代理以解析 web 新地址；后台和数据库未重启。地址仍为 <https://192.168.7.232:18443/m/alerts>，启动/停止/状态仍使用 `mw-dev up`、`mw-dev stop`、`mw-dev status`。

本补丁的私有配置和前态另存在 `~/.local/share/market-watch-dev/updates/mobile-alert-steady-monitor-20261116/`，没有覆盖上一轮回退记录。回退前确认没有后续部署，使用该目录 `before-run.json` 重建 web、重启 tls，并恢复 `before-mw-dev`；无需数据库回退。APK无需重装，在更多中检查更新应用网页版本。
