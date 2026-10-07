# 显式组合修订准备与原子启用阶段验证

日期：2026-10-07（Asia/Singapore），分支 `feat/market-data-integration`，前置提交 `04dd578`。
此阶段补全明确换基线、映射和日界的修订操作，不等于三层整体或长期质量通过。

## 行为与输入

- 数据中心“接续与修订”选择已有固定M1版本、该版本数据集已审核映射、UTC拼接点及原因。
  改日界选择同一来源M1的派生版本，复用原始采集；不能借此静默改历史供应商或价格口径。
  非日界拼接必须明确声明新的分钟接续规则，否则拒绝。
- 请求固定父修订、版本校验和、有限补数截止和创建时受影响规则，独立幂等准备。
  重复编号不同参数拒绝；日更、列表轮询和准备完成均不修改当前启用指针。
  列表、候选和修订详情读取无采集需求或指标准备副作用。
- M1查询完成后固定激活准备输入；等待完整九周期发布和水位，再异步初始化已有规则所用指标。
  指标仍使用完整固定起点与检查点，不截短递归前段。准备完成不保证每根历史柱完整，策略仍逐依赖设门槛。
  算法变化明确要求重新准备，不能把旧算法结果作为当前算法的准备证据。
- 启用校验原父修订仍为当前启用项、准备就绪、账户未变，指针与不可变启用证据同事务写入。
  记录旧/新修订、固定输入、分钟事件边界与实际启用时间；并发切换不能覆盖其他已启用项。
  同请求响应丢失可幂等核对，已有规则保持固定修订，迁移需显式编辑规则并重新初始化。
- 组合ID保持稳定。图表实际请求、元数据、日历显示、未来坐标和实时需求采用所选修订的准确历史/映射。
  原候选重新打开仍共享原组合；旧修订继续可读，旧规则的准确目标仍独立维持需求。
- 修订列表分页；请求超时先查询对应编号，再允许用同编号核对，不清空表单或重复创建。
  准备轮询有界且轮换，超过20条未完成项时后续项不会被前20条长期等待遮住。

## 证据

- 本批全量 **964 passed /181 skipped /261.89s**，`composite-revisions-regression.log`。
  跳过不计通过。最后分页/响应丢失核对及轮询公平性补充由后述定向验证覆盖。
- 本地组合/主图/预警/使用/API **30 passed /14.62s**，`composite-revisions-local-expanded.log`。
  最后修订+需求 **10 passed /6.42s**，`composite-revisions-final-local.log`；
  新增HTTP按请求编号及单修订核对 **6 passed /9.03s**，`composite-revisions-local-retry-final.log`。
  最后修订/预警 **19 passed /12.79s**，`composite-revisions-last-contracts.log`。
- 实际 Ubuntu PostgreSQL 修订、需求、主图 **21 passed /81.77s**，`composite-revisions-postgres-final.log`。
  最后修订完整 **8 passed /28.38s**，`composite-revisions-final-postgres.log`。
  最终含HTTP核对的实际PG **8 passed /32.54s**，`composite-revisions-last-postgres.log`。
  覆盖多工作者同时创建/启用、失败事务回滚、旧输入/规则保护、NY17→UTC派生、
  先指标完成再启用、超过20条任务轮换、实际迁移及有数据降级保护。
- 实际浏览器首轮启用独立无规则组合成功，但不能支持已有规则保护的真实结论。
  已加强为创建持久EMA19规则，等待就绪后准备新修订：真实OANDA M1查询、
  九周期和固定EMA19初始化完成后明确启用，七条已有规则身份保持不变。
  `composite-revisions-browser-with-rules.log`、`composite-revisions-browser-real.json`。
  新修订 `a7a5f1b9-92d8-45f0-9a0e-6fa075228935`；原修订
  `b9864edf-a6e4-4dab-a492-aed216af5751` 的同输入价格可复现。测试持久规则结束后已暂停。
- 实际两个新修订从创建到启用分别 **71.9秒**（无指标）和 **203.6秒**（已有持久指标、共享后台任务）。
  这是短样本首次准备数据，不宣称为3–10品种、长历史或确认延迟SLA结果。
- 桌面1024/1440/1920、键盘焦点及200%内容缩放通过；截图 `composite-revisions-form-*.png`，
  `composite-revisions-activated.png` 已实际复查。修正复选框布局后重跑，不把按钮存在当边界可用。
  最后前端构建、Ruff/diff通过。供应商数据未经人为插入；不存在订单或外部消息发送。

## 实际环境与启停

Ubuntu本机独立 project `market-watch-three-layer`，PG14，迁移 **aj37_composite_revision_changes**。
API/history-worker/pricing-worker/web/chart-origin/PG运行。管理/主图表 `http://127.0.0.1:16629`，
原生origin `http://127.0.0.1:16630`。delivery禁用；旧观察、其他项目和生产未改。
升级前停止本项目写入工作者，`three-layer-pre-aj37.dump` 经 pg_restore列表检查，正式迁移成功后恢复健康。
凭据、备份、许可资源与浏览器产物位于忽略目录，不提交仓库。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml restart api history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime up -d --no-deps pricing-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop pricing-worker'
```

## 剩余交付

维护写MCP、原生Dukascopy平台周期、回测统一固定周期产物、其余业务搜索及旧策略入口、
真实Dukascopy→OANDA、3–10品种多图/维护并发、目录容量、完整桌面兼容与长期质量继续。
本次真实日界保持NY17，只显式更改分钟拼接规则；NY17→UTC派生与切换由实际PG合同验证，
不冒称真实供应商日界切换已做。同一原始来源的不同经济产品映射仍需既有明确审核依据。
当前剩余空间约4.8GB/97%。实现与质量分开，稳定版本后另做48小时观察，到期不自动通过。
不推送/PR、不改生产，MT4后续，完整目标尚未完成。
