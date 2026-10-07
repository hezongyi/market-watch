# 组合固定周期持久聚合阶段验证

日期：2026-10-07（Asia/Singapore），分支 `feat/market-data-integration`，前置提交 `894f0d1`。
这是完整三层目标的下一批实现，不证明指标/策略或最终质量已完成。

## 交付行为

- 新增 `ag34_composite_aggregates`，持久保存每个组合修订的九周期任务及受影响桶的不可变输入版本。
  旧组合由 worker 有界补登记任务，不更改定义、基线/T，不产生采集需求。
- 按固定输入事件顺序处理，最多 128 桶、32 天 M1 每 tick。租约和事务进度保证中断续算、
  后继 worker 拒绝旧拥有者发布；同一输入全部受影响桶处理后才推进周期水位。
  持久任务失败保存安全错误类型和退避时刻，保留检查点及已完成旧输入。
- 修订仅重建受影响桶，未变桶复用；旧输入版本可重现。固定历史侧仍读对应周期产物，
  接缝及尾部先接 M1 再聚合，价格、来源分段、量语义和分项质量与原读取器一致。
- 已处理输入的图表走持久周期索引分页，返回 `materialized=true`，确认历史不扫描 M1。
  未处理最新输入沿用原有有界读取，不返回旧缓存冒充新输入，也不把 partial worker 水位当 ready。
  可用 stream 临时桶仍按明确新鲜度和拥有者验证有界重算，不混进固定确认产物。
  时间结束/complete 随查询时刻判断，不能因为持久化时尚未结束就永久冻结为未结束。
- 数据中心概览显示各周期已处理/当前输入、处理时间和失败重试；
  “已处理当前输入”不等于覆盖完整、指标或策略依赖就绪。九行完整显示，滚动区可键盘聚焦。

## 验证

- 最终后端全量 **895 passed / 145 skipped / 294.85s**。
  初轮六个迁移用例仍断言 af33，更新 head 断言至 ag34 后迁移七项与最终全量通过。
  跳过项不当通过，实际所需 PostgreSQL 单独执行。
  `artifacts/data-integration/composite-aggregates-regression.log`，初轮日志另存 `-first.log`。
- 最终实际 PostgreSQL 聚合、并发拥有者、拒绝重复发布、旧定义/迁移及图表分页 **22 passed / 108.14s**。
  受影响桶修订、旧输入读取、长尾、任务失败/中断/恢复、部分事件不发布及闭桶状态均覆盖。
  `artifacts/data-integration/composite-aggregates-postgres-final.log`。
- 最后追加临时 stream 覆盖及过期拥有者检查，聚合本地八项通过（4.95s）、PG 十项通过（26.30s）；
  临时观察只覆盖当前图表桶，不进入持久确认产物，拥有者过期后回到固定确认结果。
  `composite-aggregates-final-local.log`、`composite-aggregates-final-postgres.log`。
- 真实 Ubuntu 已有两条 OANDA→OANDA 组合，**18 个周期**持久产物与固定 M1 参考重算一致。
  确认图表复用产物时强制禁用原始 read_window，所有周期读取仍通过，M1 partitions=0。
  最大当前产物 1206 根，单次读取最大 186.38ms；这是当前小样本，不是并发或长期 SLA。
  `scripts/verify_composite_aggregates.py`，结果 `artifacts/data-integration/composite-aggregates-real.json`。
- 七工具实际 HTTP/MCP 对照通过，读取未改变定义与使用计数；
  `artifacts/data-integration/composite-aggregate-mcp-real.json`。测试一小时只读凭据已撤销，
  容器和主机精确 token 文件已删除。
- 实际 Chromium 产物表、三种桌面宽度、200% 内容缩放、五周期固定输入 HTTP 读取通过。
  截图复查修正表格旧高度限制后，最终三项复核通过；九行完整显示、MN 可见、滚动区可键盘聚焦。
  原生主图表/普通固定历史/导出/名称/保存重载/历史复核原九项继续通过。
  `composite-aggregate-browser-real.json`、`three-layer-charts-real.json` 在 ignored artifacts。
- 三个 JS 回归（固定修订、固定系列、旧自建修订）、最终前端构建、Ruff 和 diff 检查通过。

## 实际环境与启停

Ubuntu 本机独立 project `market-watch-three-layer`，当前迁移 **ag34_composite_aggregates**。
API、history-worker、web、chart-origin、PG 正常运行，pricing-worker 停止。
管理/主图表 `http://127.0.0.1:16629`，原生 origin `http://127.0.0.1:16630`。
升级前独立库备份 `artifacts/data-integration/three-layer-pre-ag34.dump`，pg_restore 列表检查通过；
备份、env、凭据和许可资源不提交。旧观察项目和生产未更改。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml run --rm --no-deps migrate'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml restart api history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop'
```

首次启动及许可资源前提见 [主图表阶段报告](series-access-stage.md)。
本批真实已有采集数据由 history-worker 自动派生，不制造供应商修订事件；
受控修订/恢复由隔离测试库验证，不冒称实际供应商修订观察。

## 未完成范围

完整递归指标预热/检查点、指标修订恢复、固定绑定组合策略/预警、显式修订准备/原子激活、
维护写 MCP、原生 Dukascopy、固定周期回测、业务搜索剩余入口、真实跨供应商/3–10 品种并发和长期质量。
当前 worker 与历史工作循环共享，最多 128 桶/单次且每 tick 休眠；长尾首次派生吞吐需进一步测量，
后续策略负载下的任务公平性与容量仍属整体验收范围。
输入事件的桶去重仍读该次事件 manifest，尚无超大事件分页；目前来源确认批次有界。
没有将本批完整周期缓存当完整策略或整体目标通过；实现验收和质量观察分开，不推送/PR，不部署生产，MT4 后续。
