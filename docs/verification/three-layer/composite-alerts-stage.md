# 固定组合策略与图表预警阶段验证

日期：2026-10-07（Asia/Singapore），分支 `feat/market-data-integration`，前置提交 `0a5c7d6`。
本报告对应持久图表规则入口；三层整体、旧 Watch 策略入口及长期质量仍须继续验收。

## 实现行为

- 原生图表与统一告警表单支持组合系列，保存准确修订、历史版本/校验和、映射、日界和指标算法。
  日更或图表切换不转移运行规则。接缝依赖默认拒绝，明确 `accept_raw` 才允许包含接缝的指标输入；
  两种政策均不将接缝本身的价格跳变判为新穿越。
- 持久规则解析准确实时目标，在图表关闭、租约过期后仍维持共享采集。
  周期聚合、指标完整初始化/修复、确认水位、有效来源拥有者和依赖覆盖分别设置门槛。
  正常异步计算等待保持比较前态；真实断线、来源世代变化、修订、漏判及过期输入建立新基准，不补发旧事件。
- 显式抽样 Bid 模式检查新鲜度、可交易状态、价差、临时桶对齐及桶内此前所有 M1 依赖。
  不承诺全 tick 或追认断线期间触价；临时指标只在确认状态副本计算。
- `ai36_composite_alerts` 保存不可变判断记录，包括无事件和基准记录。
  判断、状态、信号、通知/队列同事务提交，竞争工作者不会重复发布同一逻辑事件。
  数据中心使用页列出每条规则固定修订、政策、状态及原因。
- 指标有效段刚重置时不继承无效前段的接缝依赖；算法升级为 `fixed-indicator-state-v3`，
  不重新解释 v2 缓存。完整有效前段数值算法保持不变。
- 实际原生库将固定 ticker 转为大写，告警元数据查找已统一身份规范化。
  回归先复现原失败，再验证修复，不通过隐藏提示框完成验收。

## 验证证据

- 后端最终全量 **959 passed / 174 skipped / 229.49s**，
  `artifacts/data-integration/composite-alerts-regression-final.log`。跳过不计通过。
- 实际 PostgreSQL 组合规则与固定指标 **28 passed / 67.57s**，
  `composite-alerts-postgres-fixed-isolation.log`。
- 实际 PostgreSQL 组合规则与旧图表预警迁移/并发 **23 passed / 69.56s**，
  `composite-alerts-postgres-legacy-recheck.log`。首次发现旧断言错误：PG 失败降级整体回滚，
  SQLite 的部分 DDL 已执行；修正各数据库事务期望后通过。原失败 `-legacy-final.log` 保留。
- 最后本地组合规则及旧迁移 **17 passed / 19.31s**，`composite-alerts-local-final.log`，
  覆盖全量之后的 PG/SQLite 期望修正。
- 原生固定系列大小写回归及图表告警桥接 **7 项**通过；前端生产构建、Ruff 和 diff 检查通过。
- Ubuntu 实际浏览器创建固定价格规则，离开图表后确认输入继续增长，读取不可变无事件记录；
  实际 EMA19 的 reject/accept_raw 两种政策均进入 ready。
  该真实样本有效指标段不含接缝，不能代替跨源接缝拒绝场景；接缝拒绝由上述合同用例覆盖。
  `composite-alerts-browser-real.json`、`composite-alerts-browser-real-final.log`。
  加强验收 `composite-alerts-browser-durable.log` 已通过：实际等待图表租约归零，
  再核对后续确认输入推进与判断记录。三种桌面宽度的按钮边界、键盘焦点和 200% 内容缩放
  留有 `composite-alerts-form-{1024,1440,1920,zoom}.png`；使用页截图含三条准确固定规则。
- 原生失败截图及日志保留，首次失败没有创建规则。
  测试创建的规则结束后暂停；未向外部服务发送通知、未执行交易。

## 实际环境与启停

Ubuntu 本机独立 Compose project `market-watch-three-layer`，PG14，迁移 **ai36_composite_alerts**。
API/history-worker/web/chart-origin/PG 运行；本阶段启用独立 pricing-worker 进行真实行情验证。
管理/主图表 `http://127.0.0.1:16629`，原生 origin `http://127.0.0.1:16630`。
升级前 `three-layer-pre-ai36.dump` 已通过 pg_restore 列表检查。delivery 禁用。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml restart api history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime up -d --no-deps pricing-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop pricing-worker'
```

隔离 PG HTTP 测试曾触发共享 API bootstrap，提前创建空判断表，导致迁移重名失败。
已禁用测试 fixture 的 API/供应商启动副作用，核实共享实例仍在 ah35 且该表零行后仅移除该空表，
成功正式迁移 ai36。原失败、受控修复及成功日志分别为 `composite-alerts-migration.log`、
`composite-alerts-empty-table-repair.log`、`composite-alerts-migration-final.log`。
权威核对通过实际 API ORM 连接，未将 public schema 的空查询当应用库事实。
旧观察、其他项目与生产未改；凭据、许可资源、数据库备份和浏览器产物不提交。

## 剩余范围

显式组合新修订准备/原子启用、维护写 MCP、原生 Dukascopy、统一周期回测、
剩余策略/回测搜索入口、真实 Dukascopy→OANDA、3–10 品种并发、容量和完整桌面质量继续。
当前真实验证是 OANDA→OANDA，未用合成观测冒称真实跨供应商或真实触发事件。
实现与质量分开，稳定版本后另做 48 小时工程观察；到期不自动通过。
磁盘约 4.7GB/97%，没有全局清理；不推送/PR、不改生产，MT4 后续。
