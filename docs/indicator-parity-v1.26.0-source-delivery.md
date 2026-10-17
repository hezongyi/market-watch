# Issue #74 收口与 v1.26.0 源码发布

用户在真实验收中认可指标加载和改参体验，并于 2026-10-17 明确决定收口；授权解决 CI、修复复审 findings、检查通过后直接合并 PR #84 并推送源码 tag，无需再次确认。发布门槛为最终 PR head 的 backend/web/compose 全部通过；实际检查、合并提交及标签目标以 [PR #84](https://github.com/hezongyi/market-watch/pull/84) 和不可移动标签解析结果为准。此授权不包含生产部署。

## 最终范围

- 保持当前固定计算起点与 Python 数学口径，不将递推指标截成最近 N 根。EMA500 首次只有 218 根时全空符合初始化条件；刷新后使用更多输入产生数值，未发现相同输入算法不一致。旧起点在更早历史到达后仍保留的初始化策略，本轮暂不调整。
- 用户认可行情返回后 Supertrend 绘图和改参体验；窗口获取 bar 的速度不在本轮优化范围。
- 保留原始分场景性能矩阵及所有失败、超时、证据缺失记录。用户实际体验验收与本次收口不等于原 A1–A16、p95 或所有压力场景均通过，不回写旧矩阵 verdict。
- 纳入精确输入/结果复用、合法 checkpoint、有界前台计算、需求生命周期和调度；纳入真实快照过期恢复、同价格凭据续期以及 OANDA 历史/latest 同账户价格口径。

## CI 修复

此前完整 CI 的 10 项失败由下列测试兼容问题组成；保留原失败记录，不归为可忽略 baseline：

1. 8 项 provider 并发修复测试及 1 项 MCP/browser 对比，将请求执行诊断与确定性结果一并比较。仅排除明确列举的缓存命中、SQL 行数、计算步数、checkpoint 位置和时间戳，继续严格比较所有数值、参数、起点、输入版本/快照、覆盖及 `input_rows`。未知执行字段不会自动排除。
2. managed 并发修复探针挂在旧 `read_rows`，新路径使用 `managed_indicator_inputs.freeze`，因而未执行任何修复。探针改挂实际 freeze 边界，分别覆盖冷输入与缓存命中；保持旧输入/证明一致、新修订可见及订阅更正检测断言。

完整依赖的 Ubuntu 候选容器中，上述用例及新增缓存分支 **11 passed**。负对照只修改容器 `/tmp/issue74-closeout` 的独立测试源码副本，将 managed 事务隔离降为 READ COMMITTED；两个场景均在 dependency_revision 一致性断言失败。原副本已恢复，应用 `/app`、验收数据和产品代码未改。

本轮 CI 修复仅更改测试，不改指标算法、输入起点或执行策略。独立 Standards/Spec 静态复审对本轮测试与版本/收口资料均未发现阻塞项；静态复审不替代远端完整 CI，合并和推 tag 仍须满足上述发布门槛。

## 已有验收与限制

- [OANDA account-v6 实施、部署和 Playwriter 证据](verification/indicator-parity-20261017/oanda-account-v6/README.md)：真实 GBPJPY M15→M5 无指标/有 Supertrend 共 2,704 帧，无 blank/drop/reset/history_changed；Dukascopy 对照 687 帧通过。
- [真实 XAU 两个月组合与凭据恢复](verification/indicator-parity-20261017/real-composite-and-flash-v5/README.md)：真实 Dukascopy 历史和 OANDA Practice 组合，H1/M15/H4、改参、保存刷新复验；账户补丁部署后原组合 H4 指标末点不变。
- [迁移/兼容验证](verification/indicator-parity-20261017/implementation.md)：恢复副本 upgrade→downgrade→upgrade 保留 12,412 根发布柱、既有结果块/checkpoint；旧二进制读取迁移后保存的 EMA500 结果成功。
- [原始严格矩阵](verification/indicator-parity-20261017/scenario-budgets/matrix-v2-execution/README.md)及[阶段记录](verification/indicator-parity-20261017/acceptance-checkpoint-20261017.md)作为历史证据保留；本记录的用户收口决定优先于旧文档的当前状态描述。

周末只覆盖已有完成柱，未证明开盘新柱接续、全部供应商休市重启恢复、完整多图压力/公平性或原计划全部 oracle 边界。EMA500 自动重新初始化和真实历史更正时避免整图重载可作为后续独立工作；本次没有以抑制真实更正来避免闪空。

## 发布与回退

风险分类 **F1**：新增可回退需求表及重要 worker 调度链路；本轮最终 CI 修复和版本整理本身只涉及测试、版本及资料。采用既有 Ubuntu R1、真实 PostgreSQL 迁移/兼容证据、独立 Standards/Spec 复审及完整 PR CI，无新依赖。

- Python/web 与 npm 锁文件根版本：`1.26.0`；源码 tag：不可移动附注标签 `v1.26.0`，指向 PR #84 最终 main 合并提交。
- 生产部署须先验证备份/恢复，迁移至 `av49_indicator_demands`，核对显式 OANDA account membership 和新缓存身份；旧价格缓存保留，不能混用新旧口径。Yahoo 生产默认启用规则保持。
- 回退优先恢复旧应用及配置，additive 表可保留；需要 downgrade 时先停止新需求写入，再降级至 `au48_display_indicator_tasks`，只删除可重建需求/调度状态，不删除既有结果和 checkpoint。参见迁移文件及已有真实恢复证据。
- 验收实例为 Ubuntu `quant-server`，project `mw-issue74-20261017`，应用 `https://127.0.0.1:18474/advanced-charts`、图表 `https://127.0.0.1:17475`。保留实例和数据供复核；启动/停止使用 `docker compose -p mw-issue74-20261017 -f /tmp/mw-issue74-20261017/compose.json up -d` / `stop`。私有配置与凭据不入库。

本次仅合并源码并推送 Git tag；未构建正式生产镜像、未改标验收镜像、未迁移或切换生产，也未删除永久数据。
