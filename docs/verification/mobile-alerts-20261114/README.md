# 手机告警页实施与验收

日期：2026-11-15（UTC）。分支 `feat/managed-live-rollover-20261113`，开发基线 `17af8e25`。已按[认可设计](../../design/mobile-alerts-20261114/README.md)实施。

## 交付范围

- 主屏只保留规则、记录；规则显示共享三行品种身份、条件、周期/次数、执行状态和启用开关，取消统计看板。
- `+` 独立选择自建品种，不依赖先打开图表或添加自选；不可用品种可进入真实数据详情维护后返回。允许同品种创建不同规则。
- 默认直接设置价格条件，支持单价、区间、收盘确认/触价、周期、次数与到期。更多设置提供能力 schema 驱动的独立指标条件、通知选项。保留 M1 收盘、1 次、无限期、手机推送关闭、迟到仅记录的原默认语义。
- 详情可编辑、暂停/恢复、重新开始、归档、查看记录及进入对应品种/周期的专业图表。到期编辑不会擅自恢复，重新开始显式提示清次数/建立新基准，归档保留历史。
- 启用意图、执行状态、投递状态和处理状态分别展示；休市/准备/恢复不冒充监控正常，旧状态或离线显示待确认。
- 规则和触发记录使用服务器稳定游标，归档独立查询。处理本次提醒先停止提醒再标记处理，部分失败原位保留重试并回读，已成功的 ack 不重复执行。
- 使用既有 shadcn/Base UI Drawer、AlertDialog、Field、Select、Switch、Tabs、ToggleGroup 等控件。脏表单统一关闭确认，退场保留内容，成功静默写日志，字段和阻断错误就地显示。

独立指标支持服务器已暴露的指标目录和参数，不代表任意 Python 指标均可告警。已有复杂/画线规则可读并维护生命周期；手机图表创建画线告警所需的服务器对象关联不在本次范围。未修改后台判定、次数、迟到、固定版本或通知执行语义，没有 schema 迁移。

## 风险与兼容

分类 **F0**：手机 UI 改造及兼容的只读 API 扩展。新增 `/api/chart-alerts/page`、`/events/page` 和 `/events/{event_id}`；旧列表与事件接口继续返回原数组结构。网页端 `useAlertData` 默认行为保留，图表指令改动仅在既有手机指令分支内带入周期，未更改网页预取/拉取策略。

## 检查与证据

- 后端：`PYTHONPATH=backend pytest -q backend/tests/test_mobile_alert_history.py backend/tests/test_chart_alert_api.py backend/tests/test_chart_alert_service.py backend/tests/test_chart_alert_capabilities.py`，**31 passed**。包含并列时间游标、分页中插入、归档、旧接口、鉴权、错误游标、处理状态回读、到期编辑后显式恢复。
- 相关后端 Ruff、`git diff --check`、TypeScript 和 `npm run build:ui` 通过。
- `web/tests/mobile-alerts.cjs`、`mobile-alert-view.cjs`：幂等/编辑结果核查、退役来源写入保护、运行/投递/处理状态通过。
- `web/tests/alert-editing.browser.cjs`：既有网页告警编辑并发保护回归通过。
- `web/tests/mobile-alerts.browser.cjs`：新建/区间校验/能力限制、超时后同 ID 同配置核查、快速重复提交、409 保留草稿、脏表单返回、暂停恢复/重新开始/归档、schema 指标、到期编辑后恢复、真实分页、ack 成功 handled 失败后重试、数据维护返回和异常记录复用。375/412px、深浅主题、150% 字号、短视口，运行时控件核对；无脚本错误或上部浮窗。详见 [checks.json](screenshots/checks.json)。
- `mobile-managed-facts.cjs`、`mobile-more.browser.cjs` 相关共享组件回归通过。
- 原生图表专项：`MOBILE_CHART_ALERT_ONLY=1 MOBILE_CHART_OUTPUT=../docs/verification/mobile-alerts-20261114/chart-regression node tests/mobile-chart.browser.cjs`。使用实际许可图表组件与 HTTP 夹具，验证告警详情进入对应品种/H1、周期收藏、上次画面恢复、历史失败显式重试；无网页工作区写入或脚本错误。详见 [proof.json](chart-regression/proof.json)。此专项并非宣称整个历史图表测试脚本已全跑。
- [最终截图](screenshots/checks.json)为稳定构建页面，已复核规则、详情、记录、表单及大字号；`round1/` 保存早期对比，`debug/` 为旧失败调试截图，不是当前结果。
- [Ubuntu smoke](ubuntu/checks.json)：真实隔离 API 和 UI 只读检查，规则/归档/事件接口正常，独立选品种入口返回 7 个真实候选；测试时实际规则和触发记录均为 0。只写登录会话，没有创建/暂停/重启真实规则，没有发送通知。写流程由明确夹具验证。

## Ubuntu 验收实例

实际运行主机：**Ubuntu 本机 Docker**，Compose project/task 均为 `mw-managed-live-rollover-20261113`。

地址：**https://192.168.7.232:18447/m/alerts**。本次为前端与 API 更新；已安装 APK 若连接这个实例，重新打开并获取页面更新即可，无需新安装包。连接其他地址的 APK 不会自动切到该实例。

API 镜像：`sha256:1c50e1756fe7fa5ccb0142dbd8f9aecf56f8f8246f9981a996c235a8e9f42940`。

页面版本：`186ebecb9a4762e7`。

Web 镜像：`sha256:953992d066371405b077fcbbbe02465332f85aee8319419be4b5552d79dd93f9`。

构建使用 `mw-docker build`，task/project 和 acceptance 用途均显式标注；Web 使用根 context 与 `web/Dockerfile`。仅重建本任务 API/Web；数据库和 worker 保持原实例。未更改 Unraid 生产或其他任务。

启动：

```sh
sh /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
```

停止：

```sh
sh /home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

配置备份位于同一私有目录，文件名 `run.json.before-mobile-alerts-20261115T001302Z`、`compose.json.before-mobile-alerts-20261115T001302Z`。不包含在仓库，凭据不输出。原 API 镜像 `sha256:1f40d2a2341316837dae255f10e5a0dba58010c39a62c169bd45e85f70cf7094`，原 Web 镜像 `sha256:fcc379e1ea0b59221679fd1e7db2a4b9c26f80a6bf5a2ea323e172ba601dc9a1` 保留；需回退时仅把当前配置的 API/Web image 恢复到上述 ID，再 `up -d --no-build --no-deps api web`，不回滚数据库或整体覆盖其他服务配置。

## 真机待确认

浏览器夹具和缩小视口不能代替 Android 系统行为。请在手机核验软键盘下字段/底部操作可达、系统返回/滑动关闭时未保存确认、字体与触摸手感；真实后台通知投递和设备收到仍需在明确的测试规则上验收。未将推送服务接受表述为设备收到。

本次未更新 PR、跑远程 CI、合并、打正式 tag 或部署 Unraid。
