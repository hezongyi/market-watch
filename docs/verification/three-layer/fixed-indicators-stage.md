# 固定输入指标完整初始化与恢复阶段验证

日期：2026-10-07（Asia/Singapore），分支 `feat/market-data-integration`，前置提交 `b238cc8`。
这是三层行情的指标阶段，不能作为组合策略或整体验收通过的证据。

## 实现行为

- 八个内置价格指标 SMA、EMA、LWMA、BBANDS、RSI、MACD、ATR、STOCH 采用明确版本的
  有界计算状态。从固定版本/组合修订起点初始化，不用当前页面或任意近期根数替代完整递归输入。
  与整段 TA-Lib 计算做数值对照；新扩展指标必须提供完整初始化和检查点契约，缺失则明确拒绝。
- `ah35_fixed_indicators` 保存输入、参数、算法、截止点、任务租约、进度、压缩输出及检查点。
  每次最多处理 2000 根已发布周期柱，按索引向前读取；组合输入周期未处理完时等待，
  不扫描历史 M1 或切到另一来源。图表首次请求提交后台任务并返回进度和原因。
- 计算和发布事务分离；过期拥有者不能发布、重复提交被拒绝。错误保留检查点并退避重试。
  同一个固定输入/周期/指标参数共享任务。无新增观测时不因时钟空转重复创建长历史任务。
- 新输入只继承结束于最早受影响桶之前的不可变块与检查点，随后修复全部后段。
  输入增长复用前段；旧输入输出仍可重现。递归指标的历史复核包含可见价格范围之前的依赖。
- 每个输出带实际依赖起点、接缝依赖、初始化状态。有限窗口移出接缝后解除其标记，
  递归指标保留完整有效段依赖；缺失/不完整柱或未经证明的间隔重置状态。
  接缝处没有柱但跨越已证实闭市区间，仍记录跨源依赖。
- 实时图表的当前临时桶使用确认状态副本，不推进持久检查点或写入确认输出。
  原生指标后台进度变化可触发历史重绘，包括首次轮询前已完成的初始化。
  普通图表展示等待原因。修订、参数、算法和输入变更均不复用错误的状态。
- 带指标 CSV 首次返回 409 等待时仍提交任务，完成后可再次导出；多页合并保留所有指标值。
  缓存本身不阻挡已暂停/归档且无业务引用的历史回收；回收删除指标块和任务。
  图表/策略的真实固定版本引用保护保持原样。

## 验证证据

- 后端全量 **943 passed / 156 skipped / 254.86s**。
  `artifacts/data-integration/fixed-indicators-regression-final.log`。
  跳过的实际 PostgreSQL 用例另行运行，不能算全量本地通过。
- 最后指标数值/流程定向 **50 passed / 6.17s**，覆盖 JSON 检查点、缺口、常量序列、
  参数上下边界、临时计算、修订恢复、依赖范围、CSV 和回收。
  `fixed-indicators-final-unit.log`。全量之后补充的接缝闭市、持久临时状态、旧算法隔离及最后缓存保护
  由后续定向检查覆盖；不将早一轮全量计数当作这些新增检查也已跑过。
- 实际 Ubuntu PostgreSQL 指标/主图表/持久周期 **30 passed / 125.25s**，
  `fixed-indicators-postgres-final-contracts.log`；前一轮包含回收 **27 passed / 87.83s**。
  最终指标完整 PostgreSQL **13 passed / 31.51s**，见 `fixed-indicators-postgres-extra-final.log`。
  真实并发首次请求揭示共享锁升级死锁，改为共享读锁加唯一任务 ID 后复测通过。
  失败原记录保留在 `fixed-indicators-postgres.log`。
- 实际已有两条 OANDA→OANDA 组合，八种指标共 **16 组**与固定完整前段 TA-Lib 一致。
  输入样本分别 2584、2622 根，未把单页前缀当完整输入。
  `scripts/verify_fixed_indicators.py`，`fixed-indicators-real-final.json`。
  工具最初遇到 2000 根页上限和 worker 并发拥有者时未覆盖全段，已加强范围和任务终态检查后重跑；
  不将“暂时无法 claim”当作任务已完成。
- 实际 Chromium/许可原生图表完成固定历史 EMA、组合 RSI 初始化/返回非空结果和显示。
  `fixed-indicators-browser-real.json`、`fixed-indicators-browser-final.log`，两张 `fixed-indicators-native-*.png`。
  复查截图后调整验收工具的显示区间，实际 K 线与 RSI 曲线清晰可见，未隐藏模态错误。
- 原生固定系列、旧柱修订、完整指标完成重绘和原指标适配四个 JS 脚本通过。
  完整指标重绘工具使用实际 Python 固定输入响应，不只模拟前端回调。
  前端生产构建、改动文件 Ruff 与 diff 检查通过。

## 实际环境与启停

Ubuntu 本机独立 Compose project `market-watch-three-layer`，迁移 **ah35_fixed_indicators**。
API、history-worker、web、chart-origin、PostgreSQL 运行；pricing-worker 保持停止。
管理/主图表 `http://127.0.0.1:16629`，原生 origin `http://127.0.0.1:16630`。
升级前备份 `artifacts/data-integration/three-layer-pre-ah35.dump` 已用 pg_restore 列表检查。
源码与构建产物只读挂载，旧观察实例及生产未改动。凭据、备份、图表许可资源不提交仓库。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml restart api history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop'
```

## 尚未完成

组合策略/预警的固定绑定、全依赖门槛、接缝政策、恢复、事务防重与判断证据尚待接入。
还需显式组合修订的准备/原子激活、原生 Dukascopy、统一固定周期回测、维护写 MCP、
剩余业务搜索、真实 Dukascopy→OANDA 与 3–10 品种并发、容量和最终桌面/长期质量验收。
当前真实样本是 OANDA→OANDA；不宣称真实跨供应商指标或策略已验收。
最新空间约 4.8GB/97%，仍须在容量验收中测量。新缓存仍保留旧输入审计，长尾任务规模与回收容量
不是这份短样本报告的结论。实现与质量验收分开，48小时到期不自动通过；不推送/PR，不部署生产，MT4后续。
