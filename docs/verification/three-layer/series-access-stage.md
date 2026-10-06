# 三层搜索、固定输入主图表与导出阶段验证

日期：2026-10-07（Asia/Singapore）。分支 `feat/market-data-integration`，前置提交 `3f85c3b`。
本报告覆盖本批统一选品和图表入口，不证明完整 C/D/E 或长期质量通过。

## 本批实现

- `/api/market-data/series/search` 和只读 MCP `series_search` 共用查询逻辑，返回平台、
  有已发布周期的固定历史版本、已明确保存有效映射且基线可用的组合候选。
  搜索、解析、观察列表命名不创建组合、不续租采集。首次带 client 的组合图表读取才幂等建立需求。
- `MWH:<UUID>` 固定历史版本，`MWC:<64hex>` 固定组合定义，`MWP:` 保留平台原生含义；
  旧 bare/MD/MC 保留原自建含义。原生库大写 UUID/hash 时，Python/JS 都规范化后解析，
  不改变固定版本。保存的高级图表偏好和观察列表也参加历史引用保护。
- 普通图表及原生图表调用同一固定产物/组合读取器。原生 getBars 每页最多 2000 根，
  最多 32 页、一次最多 20000 根；同一次读取固定组合修订与确认输入版本，使用排他游标。
  固定历史不触发旧维护入口，组合只续租自身需求。NY17 高周期图表标签与真实 UTC 边界分开。
- 新类型的指标请求明确拒绝页面截断计算；完整初始化与检查点仍待下一批完成。
- 固定历史和组合 CSV 导出读取同一固定输入，导出不建立组合或实时需求、不创建历史补数任务。
  最多 2000 实际观测，周期产物 pending 返回 409。输出保留固定历史、组合修订、确认输入修订、
  来源确认/时间结束/覆盖和分段来源；组合分页固定同一输入，临时流观察不进入导出。
- 原生图表顶部用解析后人类品种名，身份仍为完整 qualified ticker；观察列表命名不捏造价格。

## 实际浏览器问题与修复

初始脚本只检查 pageerror 和成功图表请求，虽然返回 passed，截图却有来源未接入弹窗。
加强原生通知、可见 UI 和失败 HTTP 检查后稳定复现。
失败请求来自已保存观察列表里的 `MWP:EURUSD`/`MWP:XAUUSD`，当前配置不能解析这些别名的原生周期。
移除比较预置列表不能消除问题，证实不是比较列表或组合输入本身。

根因是原生数据 feed 在 resolveSymbol 错误回调之外又发送全工作区 error；
解析单个不可用观察条目因此阻挡有效主图表。保留原生错误回调，由请求控件表示不可用，
不把其升级为全局弹窗，不替用户改写保存的来源身份。
真实测试保留上述观察列表，核对所有 422 都来自已保存平台条目，主图表通知为空、
可见 UI 无错误弹窗、顶部显示 EURUSD，保存重载保留组合 ID。
这些条目尚不支持原生周期的能力限制仍真实存在，不能表述为 Dukascopy 原生接入已完成。

## Ubuntu 隔离环境与启停

实际 Compose project `market-watch-three-layer`，独立 PostgreSQL 14、网络及 volume，迁移 `af33_composite_inputs`。
管理及主图表入口 `http://127.0.0.1:16629`，原生库独立图表 origin `http://127.0.0.1:16630`。
API、history-worker、web、chart-origin、PostgreSQL 已运行，pricing-worker 保持停止。
旧观察项目和生产未变更。env、登录、浏览器截图、报告 JSON 及许可库均为 ignored artifacts。

chart-origin 使用已有本机镜像 `mw-range-main-chart:horizontal-labels1`。
许可库从该镜像新建的精确命名临时容器复制至 ignored 目录后，临时容器已删除；
不读取或修改其他任务运行实例。Compose 只读挂载 host JS 及独立许可资源，当前没有生成生产哈希 bundle。

```sh
VITE_ADVANCED_CHART_ORIGIN=http://127.0.0.1:16630 npm --prefix web run build
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d postgres migrate api history-worker web chart-origin'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml restart api history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop'
```

启动要求已在本机准备 ignored env 和许可库；凭据/许可内容不提交仓库。

## 验证证据

- 本地新固定输入/导出及旧导出 13 项通过（3.43s）。5 个 JS 回归脚本通过：固定系列、
  旧平台、旧自建、原生保存、观察列表恢复。最后前端构建、Ruff、diff 检查通过。
- 实际 7 工具 HTTP/MCP 输出一致，固定输入排他分页一致，定义与需求数量不改变。
  `artifacts/data-integration/series-search-mcp-real.json`；完成后短期凭据已撤销并删除。
- 最终实际 PostgreSQL 32 项通过（130.76s），覆盖固定历史/组合访问和导出、原平台及引用保护。
  日志 `artifacts/data-integration/series-access-final-postgres.log`。
- 加强后的真实 Chromium 八项通过：固定历史原生图表、三类搜索、组合 M1/H4、原生保存重载、
  普通图表固定历史、观察列表失败隔离、名称与身份、实际固定版本 CSV。真实请求，无 HTTP/bar fixture。
  原生库可见子 frame 检查顶部 EURUSD 和无 ApiError 弹窗；pageerror 为空。
  仅允许已保存平台观察条目的已知 422，其余业务错误使脚本失败。
  `artifacts/data-integration/three-layer-charts-real.json` 和对应截图。
- 最终后端全量 883 passed / 131 skipped / 228.89s；跳过项不算通过，所需 PostgreSQL 另行运行。
  日志 `artifacts/data-integration/series-access-regression.log`。

## 完整目标仍需完成

持久尾部周期聚合、深历史修订重绘与缓存修复、完整递归指标预热/检查点、
显式修订准备和原子激活、固定输入组合策略/预警的恢复与防重、维护写 MCP、
Dukascopy 原生 adapter、统一固定周期回测、策略/回测搜索联动、真实跨来源组合和 3–10 品种并发。
组合观察列表当前只返回名称，不提供合成最新报价；大目录分页/候选索引仍需完善。
真实浏览器当前使用 OANDA→OANDA，不冒称跨供应商验证。
实现验收与质量观察分开；没有启动或宣称完成新三层 48 小时观察。
不推送、不提 PR、不合并、不部署生产、不下单；MT4 后续。
