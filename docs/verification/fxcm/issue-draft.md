# FXCM 平台行情与自建历史接入

状态：实现、真实 native/API 适配器验证、定向回归和 F1 审查已完成；独立 Ubuntu Docker 已运行，本机独立验收分阶段通过，远程 CI 未执行。

## 范围

从 `v1.28.0`（`59ed3a3f3fc727da76d13149934d999ebee04218`）的隔离工作树新增 FXCM 来源适配与注册接线。平台使用真实 FXCM 原生周期，自建历史以同源 BID M1 为输入，复用既有目录、版本、聚合、维护和任务流程。

范围不包含交易、报价流、实时备用、组合实时来源、全局切换、FXCM 专用 worker/调度器/表或告警迁移。默认关闭 FXCM；列表、搜索和无需求状态不会登录、刷新目录或预热历史。

## 已完成证据

- 工作树为 `/home/quant/repos/market-watch-fxcm-history-20261024`，分支 `feat/fxcm-platform-managed-20261024`；当前差异尚未提交，未创建 PR、未合并、未发布。
- 使用官方 ForexConnect Linux 1.6.5 SDK 与最小 native helper，保持主服务 Python 3.11；不提交 SDK、凭据或许可材料。
- 真实有限会话在 NoPrice、无 table manager 下成功。有限观察未见报价订阅、offer/account/trade/other 更新或交易调用。
- 实际目录为 517 个品种；`EUR/USD` 精度 5，`XAU/USD` 精度 2。两个品种的 BID M1/H1/D1 及 M1 向前分页成功。
- 应用适配器真实读取成功，单次 session 复用成功，25 秒闲置后退出；脱敏样本 SHA256 为 `a4d1710157eab3958947d6263ff0f89ba4a26707bee99766b82e07cdef928fb3`。
- FXCM 相关回归 41 项通过；受管历史 PostgreSQL 回归 22 项通过；另在任务专属 PostgreSQL 补跑此前缺少 `TEST_POSTGRES_URL` 的 38 项测试，全部通过。
- F1 Standards 与 Spec 独立审查闭环。审查中发现的异常清理/跨进程节流以及 FXCM 目录刷新超时问题均已修复并复测。详见 [review.md](review.md)。

## 独立整栈验收

Ubuntu `quant-server` 上的 Compose project `mw-fxcm-history-20261024` 已运行，迁移成功。实际 UI `https://192.168.7.232:18910`，chart `https://192.168.7.232:18911`。用户明确授权在当前资源条件直接验收，持续记录资源，不停止其他任务或清理其资源。

两品种三周期/翻页真实 HTTP、配置后五分钟无需求、双图共享、受管导入/增量/固定版本图表及均线、暂停/恢复、worker有序重启和自然到点日更均通过（分阶段复验）；最终关闭后五分钟空闲观察通过。实际验收发现的五项边界/ID/周末请求问题已补先红后绿回归，详见 `evidence/acceptance-fixes.json`；它们晚于原独立审查，未宣称重新双审。

详见 [验证记录](README.md)、[可用性报告](../../fxcm-api-feasibility.md)、[机器契约](api-contract.json) 和 [实现检查](evidence/implementation-checks.json)。
