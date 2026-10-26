# 自建行情三种维护模式、AKShare 与 Yahoo

状态：实施中；仅本地 Issue 草案，不创建外部 Issue 或 PR。

## 范围与基线

- 按 `docs/managed-history-modes-akshare-yahoo-implementation-plan-20261024.md` 实施全部行为合同。
- 基线：集成分支 `7fc4fbb84e613e12e4540d7582ea78d137bfcdbd`。
- 工作树：`/home/quant/repos/market-watch-history-modes-20261024`。
- 分支：`feat/managed-history-modes-20261024`；task：`mw-history-modes-20261024`。
- 三模式：旧 M1 兼容、D1 派生、原生周期独立归档；AKShare 三市场和 Yahoo 接入；固定图表与指标、维护配置和恢复。
- 不接 FXCM，不修改其他并行任务，不创建 PR，不合并、不发布生产。
- 用户补充：Yahoo 已通过 yfinance 接入。本任务复用既有适配器，仅扩展自建维护入口及固定归档读取参数，不重新接入 Yahoo。

## 风险与检查

F1：新增持久格式、schema 迁移及后台采集/发布路径。检查覆盖旧 M1 身份与产物不变、旧库迁移、确定性多周期更新/失败/恢复、实际端点、前端构建与浏览器、PostgreSQL、CI 与独立 Standards/Spec review。

验收矩阵以方案 A01–A17 为准，逐项证据写入本目录 `report.md`。本地开发和测试先行；用户明确要求**验收前申请**，因此在取得确认之前不启动验收或更新长期实例。最终业务验收使用 `$mw-acceptance` 指定的现有长期实例，保留真实数据和私有配置。隔离迁移测试使用任务独有数据库，不借用长期实例运行破坏性测试。

## 实施顺序

1. S0 基线、接口事实、旧 key/schema 证据。
2. S1 v2 合同与 additive migration，M1 回归。
3. S2 D1 reducer、固定截止与图表/指标。
4. S3 原生周期独立窗口、长期归档、partial、恢复与调度。
5. S4 Yahoo 显式归档与 AKShare 受控调用/目录/按需读取。
6. S5 三模式 UI、周期状态和消费者。
7. S6 本地检查、独立 review、候选和验收申请；获确认后验收并记录证据。
