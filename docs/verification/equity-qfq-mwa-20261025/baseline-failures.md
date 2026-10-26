# 全量检查中的既有失败

本轮没有取得干净的全量测试结果。首轮实际为 3120 passed、20 failed、3 skipped；修正后重跑原 20 个失败项及新增的 4 个后台加载回归，结果为 16 passed、8 failed。

剩余 8 项已在基线 `ba5407b218c0d5ffb5b946cb83bba4af67f3965e` 的只读源码副本、同一 Python 环境和独立任务 PostgreSQL 逐项运行，失败节点完全相同。见 [机器结果](backend-final-checks.json)、[当前重跑](failed-nodes-current.log) 和 [基线对照](known-failures-baseline.log)。没有添加 skip、xfail 或扩大 SQL 预算。

- 5 项 `test_provider_squeeze_history`：已有指标输入按日历缺口分段，RRS 的 252 窗口未得到测试期望的连续有效观测。基线单独运行同样失败。本次不扩大为指标语义变更。
- 2 项 SQLite 与 1 项 PostgreSQL 目录分页用例：旧测试替身未接受现有 `instrument_catalog` 的 `source` 等关键字，报 TypeError；基线同样失败。本次未改这些替身。

本轮解决了原 20 项中的 12 项：6 项 Yahoo 测试启动种子前置条件、4 项历史迁移夹具与新 schema 的兼容，以及 2 项本次复权描述额外 SQL 的分页预算回归。后者复用同一次 timeframe/manifest 查询，原预算与断言保留。新增 4 项覆盖共享采集忙时等待再完成、两个股票 ticker 的来源预算和真实 PostgreSQL 等待恢复。

这些证据只能说明剩余失败并非本轮引入，不能把全量结果改写为通过。严格数据保留审计仍另有未归因差异，见 [验收报告](README.md)。
