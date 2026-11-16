# 手机端与自建实时工作流 PR 验证汇总

2026-11-16，分支 `feat/managed-live-rollover-20261113`，目标 `main`。

## 范围与风险

本分支包含原生行情选择、自建创建/维护/实时接续、固定版本自动轮换与实时保留批次，以及手机端搜索、数据、告警、日志和 Android 外壳的后续打磨。复用后端告警执行链路；页面状态区分规则启用意图、真实执行证据、来源确认和通知投递。

分类 **F1**：固定版本轮换、实时保留和告警执行属于重要后台链路。最小检查采用相关单元回归、独立 PostgreSQL 链路验证、Ubuntu Docker smoke、浏览器交互/截图，以及关键后台链路独立 Standards/Spec 评审。该分支不升级 PostgreSQL 主版本；最近一轮开发实例数据迁移没有 schema 变化，实际备份恢复和内容核验另有记录。

## 提交前复核

- `web/` 下 `npx tsc -b --pretty false` 通过。
- `node tests/mobile-logs.cjs`、`mobile-managed-facts.cjs`、`mobile-alert-view.cjs`、`mobile-sparklines.cjs`、`mobile-alerts.cjs` 全部通过，覆盖日志脱敏/隔离、详情与维护意图、告警执行状态、曲线批量加载和规则编辑。
- `PYTHONPATH=backend python -m pytest -q` 指定 `test_forex_continuation.py`、`test_mobile_alert_history.py`、`test_mobile_data_categories.py`、`test_mobile_identity.py`、`test_oanda_stream_recovery.py`、`test_sparkline_a_shares.py`、`test_watch_quote_identity.py`、`test_chart_alert_health.py`、`test_mobile_symbol_search.py`、`test_provider_dukascopy.py`：**137 passed, 34 skipped**。条件型 PostgreSQL 参数未在这次本地复核重跑，不用跳过结果替代实际 PostgreSQL 验证。
- 相对 `origin/main` 的全部变更 Python 文件 Ruff 检查通过；清理导入排序及无用导入。`git diff --check` 通过。
- 发布前检查变更文本、文件类型及凭据模式；旧失败日志中的测试数据库连接凭据已脱敏。私有配置、数据库备份、TLS 私钥、许可库和完整浏览器状态不纳入提交。

## 已有实测证据

- [告警执行与通知链路](mobile-alert-readiness-20261116/README.md)：通知 84 项、实际 PostgreSQL 运行链路 59 项、目标后端 17 项，以及浏览器完整操作流程。
- [实时流恢复与独立审阅](realtime-stall-20261116/review.md)：SQLite/接口 132 项、PostgreSQL 33 项、消费者回归 180 项；修复后的 Standards/Spec 复核与持续报价/分钟确认观察。
- [普通外汇实时资格](forex-continuation-20261116/README.md)：隔离 PostgreSQL 179 项、兼容性补验、来源边界与 375/412px 浏览器核验。
- [手机端待实现收口记录](../plans/pending/README.md)：各轮共享搜索、标识、详情、静默日志、曲线、UI 和交互验收入口。
- [最新版开发部署与数据恢复证明](development-latest-20261116/README.md)：Ubuntu `mw-dev`，106 表、8,864,473 行逐表行数与内容指纹一致；保留原库和来源恢复点。

## 尚未通过的验收与操作边界

OANDA 间歇性 HTTP 401 尚未确认根因及全面恢复。最近一次只读观察中报价与确认分钟线可能分别处于就绪/恢复状态；新进程请求成功不能替代现有 worker 的持续恢复证据。此前一次持续恢复通过也不代表后续复发已解决。因此本 PR 保持 Draft，不把接口就绪或 worker 心跳等同于实时链路稳定。

Android 真机手势、输入法与锁屏通知仍需实际验收；当前迁移实例外部通知投递沿用来源的关闭设置。迁移后的两条实际规则已达到次数上限、处于完成状态，不能描述为正在监控。

当前开发入口为 `https://192.168.7.232:18443/m/`，Ubuntu 本机 Docker，启动/状态/停止分别为 `mw-dev up`、`mw-dev status`、`mw-dev stop`。18447 后台写入者保持停止；来源数据库和恢复材料保留，旧资源退役因运行异常暂缓。

本次仅提交分支和创建 PR；不合并、不创建正式 tag、不发布 Unraid，也不删除保留资源。
