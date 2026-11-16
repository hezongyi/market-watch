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

## 验收边界

实机锁屏、Android 系统后台限制和真实手机通知实收不由浏览器或本机假接收器证明。短时运行观察也不等于全天上游无故障。现有规则、版本、运行次数及历史保留，不为获得“监控中”截图重新启用结束规则。部署目标为 Ubuntu 本机持久 `mw-dev`，不涉及 Unraid、合并或正式 tag。
