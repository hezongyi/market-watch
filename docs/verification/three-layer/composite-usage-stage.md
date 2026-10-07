# 组合共享需求与实际OANDA采集生命周期验证

日期：2026-10-07。此为C阶段需求链路，不证明公开组合图表或D阶段策略完成。
Ubuntu独立Compose project `market-watch-three-layer`；旧观察和生产环境未改动。

## 行为

- 需求读取集中于`market_usage`：图表临时需求、active Watch、当前版本且未到期的active ChartAlert。
  暂停、过期和旧配置版本不维持采集；持久消费者不依赖浏览器续租。
- 已有组合的实际图表需求可以续租，按明确映射解析OANDA目标；多个消费者共享一个精确来源身份。
  搜索、目录管理、映射保存或补数不建立需求；不同账户不混入当前stream。
- OANDA目录允许空居民品种，记录账户实际支持的其他资产目录，不默认启动采集。
- worker无需求时不claim账户owner、不启动stream；全无需求后按配置宽限释放。
  订阅集合变化和预热需求增长正常重建连接。正常退出清空owner与错误，无故障退避；
  原有真实断线、认证故障与旧世代fencing仍保留。
- 新增显式Compose `realtime` profile中的`pricing-worker`，与当前独立PG/network共享，
  不暴露端口，不投递通知，不下单。默认`up`不启动此profile。

## 证据

- 本地需求/生命周期/实时/行情API初次73项通过；加入图表预警、来源身份、补数兼容后106项通过。
- 实际Ubuntu PostgreSQL需求4项与实时owner2项，共6项通过。
  active Watch和当前ChartAlert持久需求、暂停/到期释放由实际PG验证；尚未证明组合策略计算完成。
- 实际OANDA Practice生命周期：先启动worker，确认零需求时无owner；显式续租两个组合图表需求，
  实际订阅集合只有EURUSD；stream报价、REST恢复、同一个共享owner通过。
  来源及组合确认尾部推进到固定准备截止点之后，输入修订递增。
- 撤销两个精确测试需求后，worker在10秒配置宽限及轮询内正常释放：owner inactive、无错误或失败次数，
  LiveState inactive，恢复就绪false，实际需求为空。随后停止本次worker，未留下实时采集。
- 初次空闲测试取到了bootstrap的旧Instrument，修正为准确OANDA实例断言后通过；没有为了测试改动旧实例。
- 代码Ruff及diff空白检查通过。完整回归另见本阶段最终补记，不沿用旧第二层结果作为本次证明。

实际API健康，访问<http://127.0.0.1:16629/market-data>。启动/停止worker在工作树根执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime up -d pricing-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop pricing-worker'
```

API/history-worker/web启停方式见[组合输入阶段](composite-inputs-stage.md)。凭据在ignored env，不提交。
脚本：[`verify_composite_usage.py`](../../../scripts/verify_composite_usage.py)。
原始证据在ignored `artifacts/data-integration`：`composite-usage-final-local.log`、
`composite-usage-postgres.log`、`composite-usage-{idle,start,connected,release,released}.json`及运行日志。

## 未完成范围

公开组合读取及拼接后统一聚合、显式修订切换、映射/组合UI与搜索/MCP，完整策略依赖、
指标接缝政策、异步预热、恢复修订/防重，原生Dukascopy、统一回测输入与整体验收继续推进。
此阶段共享采集成功不代表策略可用、覆盖完整或质量观察通过。未push/PR/生产发布或下单。

## 最终回归补记

首次全量857通过/116跳过、1失败：旧日历确认空响应不携带checkpoint。
兼容边界保留其有限闭市证据判断，不给空响应补造M1或检查点；带价格的数据确认仍严格校验。
修复后完整后端866 passed /116 skipped /33 warnings，207.94秒。
完整结果包含本批共享需求和当时8项聚合测试；随后增加临时柱owner测试及临时观测覆盖收紧，
另做最终定向本地/实际PG验证，详见[组合聚合阶段](composite-series-stage.md)。
原始全量日志`composite-input-usage-full-regression-final.log`，不把跳过的PG测试视为通过。
