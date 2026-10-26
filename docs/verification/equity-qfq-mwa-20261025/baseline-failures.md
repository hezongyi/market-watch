# 全量检查中的既有失败

本轮没有取得干净的全量测试结果。首轮实际为 3120 passed、20 failed、3 skipped；修正后重跑原 20 个失败项及新增的 4 个后台加载回归，结果为 16 passed、8 failed。

剩余 8 项已在基线 `ba5407b218c0d5ffb5b946cb83bba4af67f3965e` 的只读源码副本、同一 Python 环境和独立任务 PostgreSQL 逐项运行，失败节点完全相同。见 [机器结果](backend-final-checks.json)、[当前重跑](failed-nodes-current.log) 和 [基线对照](known-failures-baseline.log)。没有添加 skip、xfail 或扩大 SQL 预算。

- 5 项 `test_provider_squeeze_history`：已有指标输入按日历缺口分段，RRS 的 252 窗口未得到测试期望的连续有效观测。基线单独运行同样失败。本次不扩大为指标语义变更。
- 2 项 SQLite 与 1 项 PostgreSQL 目录分页用例：旧测试替身未接受现有 `instrument_catalog` 的 `source` 等关键字，报 TypeError；基线同样失败。该项为首次重跑状态；后续已修正替身，结果见下文。

本轮解决了原 20 项中的 12 项：6 项 Yahoo 测试启动种子前置条件、4 项历史迁移夹具与新 schema 的兼容，以及 2 项本次复权描述额外 SQL 的分页预算回归。后者复用同一次 timeframe/manifest 查询，原预算与断言保留。新增 4 项覆盖共享采集忙时等待再完成、两个股票 ticker 的来源预算和真实 PostgreSQL 等待恢复。

这些证据只能说明剩余失败并非本轮引入，不能把全量结果改写为通过。严格数据保留审计仍另有未归因差异，见 [验收报告](README.md)。


## 目录夹具修正后的最新结果

3项目录失败已修正：只补齐测试替身的现有关键字参数，不修改产品实现或减弱断言。两份目录测试11通过；最新失败节点重跑19通过、5失败。证据：[红例](catalog-mocks-red.log)、[目录全文件](catalog-mocks-green.log)、[最新失败节点](failed-nodes-catalog-followup.log)。

因此上文8项是历史基线对照结果，当前剩余5项全部属于RRS。原方案明确排除修改独立RRS任务，已请求用户授权扩大范围，未取得回复前不修改其实现。另按原方案§9.2执行五份PG测试62通过、0跳过。没有新的干净全量结果，未用局部检查替代全量通过。


## 用户确认的独立处理

用户认可本轮接入按已通过业务证据交付，RRS作为独立既有指标问题处理。5项失败仍未修复，原全量未取得绿色，不再等待本轮RRS扩大范围授权。复现、证据和后续验证要求已记录于 [独立待办](followups/rrs-native-sparse-history.md)，本轮不修改RRS实现。
