# 回测统一固定周期产物阶段验证

日期：2026-10-07（Asia/Singapore），分支 `feat/market-data-integration`，前置 `e0823ff`。
本阶段让固定历史回测读取图表相同周期产物，不等于完整三层或长期质量通过。

## 行为

固定回测去除另一套即时M1聚合。图表、指标、回测共用已发布的不可变周期产物读取器；
逐块校验压缩内容，核对父M1版本/校验和/规则与周期清单。长历史流式读取，不受页面20000根截断。
回测保留完整前缀压缩预热、最近500根显示上下文及原有区间20000根限制，不同步重建缺失周期。
只纳入结束时间不晚于回测截止的桶，未来价格仍隐藏；partial/unknown/confirmed及量语义原样保留。
所选周期与D1均须发布，完整输入清单保存实际周期checksum和父M1清单，seek及保存恢复沿用该清单。
新版本、改日界或后续追加其他周期不改旧回测。旧保存回测仍直接读取原快照，不重新生成其输入。

桌面回测选择器开放已发布且payload可用的Dukascopy/OANDA历史，标明来源与NY17/UTC0。
九周期可回放，周期等待明确展示并由用户提交后台准备，不将M1就绪当作所有周期就绪。
固定历史禁用旧来源历史补数按钮，维护入口指向准确数据集详情；报价和实时需求不因回测产生。
标题/保存列表显示品种、来源和日界，并使用自建精度。
现有模拟预警仍支持M1/M5/M15/H1/H4/D1；M30/W1/MN显示价格回放能力及预警限制，按钮禁用。
没有扩充交易/模拟执行引擎或改变旧预警规则。

## 验证

- 全量后端 **980 passed /195 skipped /290.87s**，`fixed-replay-full.log`；跳过不算通过。
  其后新增模拟质量门槛测试另由末次回测定向验证覆盖，产品实现不再改动。
- 本地回测/周期/日界/回收/MCP/指标 **57 passed /44.15s**，`fixed-replay-local-final.log`。
  九周期图表价格及质量完全一致；禁止原M1读取后仍创建回测；21003根预热跨块完整保留。
  未发布M1或D1拒绝，父版本/输入清单固定，无实时需求。
- 最后回测 **14 passed /14.70s**，`fixed-replay-last-local-final.log`；实际PG回测
  **10 passed /32.45s**，`fixed-replay-last-pg.log`。补充已确认来源分钟仍不能令未知覆盖高周期
  通过模拟判断，保留 `source_confirmed=true` / `coverage_complete=false` 并暂停预警。
  最初测试试图将未确认M1发布为固定版本，被既有采集合同正确拒绝，已改用缺口周期验收。
- 实际Ubuntu PG回测/回收/周期 **23 passed /94.33s**，`fixed-replay-pg-final.log`；
  指标/维护 **17 passed /64.42s**，`fixed-replay-indicators-pg.log`。
  独立测试schema，覆盖实际HTTP创建/seek、六周期价格与覆盖、引用/回收并发、旧规则兼容。
- 首轮测试源错误地返回65天单页，违反31天合同；修正为真实分页接口后通过。
  `fixed-replay-local.log`、`fixed-replay-pg.log`保留失败证据，不将测试数据错误当产品通过。
  原有回收pending-period测试曾因fixture预先发布D1失去测试意义，改为仅回测fixture显式准备D1。
- 实际浏览器首轮OANDA AUDUSD M1：仅M1就绪时创建禁用，用户准备D1并等发布后创建；
  下一根价格/覆盖/量字段与同版本图表一致，保存恢复和导出清单相同，未来柱不泄露。
  `fixed-replay-browser-real.log`保留待发布门槛证据。
- 最后加强实际Dukascopy及OANDA EURUSD NY17 H4，各**10根已结束H4**与图表产物完全一致。
  输入父版本分别 `faa275a2-9e2e-4d25-b6c0-ed80775c14c0`、`d38d2616-3f82-4d74-bec3-c49b298e2e2a`。
  `fixed-replay-browser-final.log`、`fixed-replay-higher-real.json`、`fixed-replay-browser-real.json`。
  这不是Dukascopy→OANDA组合验收，也不证明长时间源数据完整。
- 1024/1440/1920、键盘焦点、200%内容缩放通过；实际复查截图 `fixed-replay-1024.png`。
  最后前端构建、Ruff/diff通过；创建的回测证据保留，不创建行情租约、真实订单或外部通知。

## 环境与启停

Ubuntu本机独立Compose `market-watch-three-layer`、PG14，迁移aj37不变。
16629 `/readyz` 当前实际就绪；管理/回测 `http://127.0.0.1:16629/replay`，origin16630。
API/history-worker/pricing-worker/web/chart-origin/PG运行，delivery禁用，测试实时预警暂停。
API加载本批代码后重启，其他项目/旧观察/生产未改。凭据/许可/截图与日志在忽略目录。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml restart api history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime up -d --no-deps pricing-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker pricing-worker web chart-origin'
```

## 未完成

原生Dukascopy平台周期、统一搜索剩余业务入口、组合旧Watch策略兼容、真实跨源和多品种并发、
源参数身份/大目录/调度容量、完整桌面兼容及长期质量继续。回测筛选目前沿用原有下拉入口，
没有完成主方案要求的所有入口统一搜索。额外模拟预警周期能力不冒称已实现。
实现与长期质量分开；完整目标未完成，不推送/PR，MT4后续。
