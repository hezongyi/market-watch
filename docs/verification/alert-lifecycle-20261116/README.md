# 告警全生命周期验收 · 2026-11-16

基线 `96e9ea7e`，分支 `feat/alert-lifecycle-20261116`。范围及 F1 分类见 [任务说明](../../issues/alert-lifecycle-20261116.md)。沿用后台触发、幂等、接管、结算、重试及保留策略，补齐手机端读取、状态和操作确认；没有数据库迁移或推送配置变更。

## 自动验证

- 前端 `node tests/mobile-alerts.cjs`、`node tests/mobile-alert-view.cjs`：通过。覆盖未知编辑结果完整配置/版本回读、HTTP 200 损坏响应、冲突不重写、执行/生命周期/投递的区分。
- 完整 `npm run build`（包含 `tsc -b` 和私有专业图表构建）：通过。
- 后端 mobile history、chart API/notifications、price execution/settlement：57 passed, 1 skipped。
- 后端 reliability/close/inputs/health/cadence/wakeup/notice：首次 100 passed, 4 failed；4 项为 OANDA 重构后旧 monkeypatch 接点，改用实际 `oanda_stream.request_slot` 后该文件 28 passed。没有修改运行时来迁就测试。
- 实际隔离 PostgreSQL：`test_mobile_alert_runtime_postgres.py`、`test_price_alert_reliability_postgres.py`、`test_chart_alert_health_postgres.py`、`test_price_alert_execution.py`、`test_price_alert_settlement.py`、`test_notice_reliability_postgres.py`，125 passed, 1 skipped。三个既有 Alembic 弃用警告。使用既有测试 PG 的每测试独立 schema，不访问持久开发库。覆盖后台接管、重启恢复、事务/去重、暂停恢复、HTTP 假接收器 503→200、到期结算、保留与异常投影。
- 改动后端文件 `ruff check` 通过。

## 构建页面与截图

`web/tests/mobile-alerts.browser.cjs` 使用本次完整构建、本机 HTTP 夹具和浏览器，不请求真实上游、不写真实规则或发手机推送。

```bash
cd web
MOBILE_ALERT_OUTPUT=/tmp/mw-alert-lifecycle-20261116/matrix MOBILE_ALERT_POLISH_MATRIX=1 node tests/mobile-alerts.browser.cjs
MOBILE_ALERT_OUTPUT=/tmp/mw-alert-lifecycle-20261116/readiness MOBILE_ALERT_READINESS=1 node tests/mobile-alerts.browser.cjs
MOBILE_ALERT_OUTPUT=/tmp/mw-alert-lifecycle-20261116/lifecycle MOBILE_ALERT_LIFECYCLE=1 node tests/mobile-alerts.browser.cjs
```

全部通过，浏览器 pageerrors 为空。`browser-checks.json`、`readiness-checks.json`、`lifecycle-checks.json` 保存具体覆盖项。375/412px、深浅主题、14/21px 字号（150%）、短视口，检查列表/详情/筛选/创建/高级设置/记录/处理和退场。此目录保留代表性稳定截图，完整截图位于以上本机目录。

新增故障场景确认：能力失败原位重试；保存及首次回读都丢失后不重复旧版本写入；结算留在当前规则、禁编辑恢复；结束规则推送失败仍在需处理；详情读失败后自动恢复并清除旧读取错误；接口 200 但处理未提交不假报完成，再试不重复 ack；认证受阻可重试，对应设备回执及次数独立回读。

独立 Standards 与 Spec review 已完成。指出的未知 2xx 响应、结算列表分类、恢复后的旧读取错误三项均已修复并复核。浏览器故障夹具连续三次 503，确保跨过 API 内部有界自动重试，验证下一轮读取恢复。

## 持久开发实例部署结果

Ubuntu 本机 Docker project `mw-dev`，地址 <https://192.168.7.232:18443/m/alerts>。实际运行源码 `89b887ffe8106d362ce8d523b3e756a1fdd49cde`，后台四服务使用 `sha256:22c9c97e88e44417cba89312c2820e61bbffd62c1d86755e094606724f6694dc`，web 使用 `sha256:97d1ca3876d10113b162837ae52a768f505fd13ca8c2f85dd88383f66ff39932`。镜像按任务 `mw-alert-lifecycle-20261116`、development 用途登记；完整私有图表库仅本机参与构建，未提交。

`mw-dev status` 查看；`mw-dev up` 启动；`mw-dev stop` 停止。启动入口已指向本次固定镜像及原开发库 `dev_mobile_20261116`。APK 仍为 0.1.4，本次为 WebView 页面和后台更新，不需重装。

部署前备份 1,221,167,630 字节，SHA256 `452fbd1a799414aba2fcddf0449bc7d67532e66399b03a71147b7f92712f9620`，`pg_restore --list` 可读取。私有备份、原配置、原启动器和数据指纹位于 `~/.local/share/market-watch-dev/updates/alert-lifecycle-20261116/`，不提交仓库。需要回退时，使用该目录 `before-run.json` 对原四后台服务及 web 执行 Compose `up -d --no-build --no-deps --wait`，重启 TLS 并恢复 `before-mw-dev` 启动器；没有 schema 变更，不需恢复数据库或删除新记录。回退需先核实后续是否已有其他部署。

2026-11-16 15:40:24–15:42:05 UTC 连续五次只读采样：

- 自有 CA 严格 TLS、ready/login、schema、实际源码与镜像匹配。网页 shell `602ef5a7f32880c7` 与本机完整构建一致。
- 部署前后 148 个品种配置、13 个维护配置、2 条规则、4 个规则版本、图表 workspace/preferences、140 个 dataset 及 241 项稳定偏好核对通过；供源、凭据及通知设置保留。
- 告警心跳持续推进，各后台角色为 idle/running。真实两条规则均为 completed（次数用完），没有启用规则；不得据此宣称真实规则正在监控。
- 四个 OANDA 品种 EURUSD/USDJPY/XAUUSD/USDCAD 均从启动后恢复态转为 connected，最终报价与确认 K 线就绪、确认错误为空，报价序号和已确认 M1 均推进。首轮黄金出现一次确认 timeout，随后自动恢复，没有通过清状态制造成功。
- 真实服务手机页面 375px 浅色和 412px 深色150%字号通过，列表/详情生命周期正确，浏览器错误与业务写请求均为空。证据为 `deployment-checks.json`、`deployed-ui-checks.json` 及两张部署截图。

Draft PR [#139](https://github.com/hezongyi/market-watch/pull/139) 以 OANDA 修复 PR #138 分支为 base，避免重复差异；未合并。完整 CI 为异步附加检查，以 PR 当前状态为准。

## 验收边界

实机锁屏、Android 系统后台限制和真实手机通知实收不由浏览器或本机假接收器证明。短时运行观察也不等于全天上游无故障。现有规则、版本、运行次数及历史保留，不为获得“监控中”截图重新启用结束规则。部署目标为 Ubuntu 本机持久 `mw-dev`，不涉及 Unraid、合并或正式 tag。
