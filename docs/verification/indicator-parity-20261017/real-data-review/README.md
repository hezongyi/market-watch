# 真实 Dukascopy 数据 Playwriter 复验

**后续归因更正：** 用户人工验收确认数据返回后的 Supertrend 绘制和改参体验可接受，窗口加载 bar 的慢点不在本轮处理范围。核对同一样本发现，首次切黄金10.7秒中，窗口history-load结果到约9.9秒才返回，Supertrend在接受计算输入后约110毫秒提交。下文秒级总耗时和EMA500现象保留，但撤下将它们直接作为指标性能/同输入计算一致性阻塞的优先级结论；详见[范围与时间线复核](../scope-attribution-20261017.md)。原始数据、旧标准下失败和CI状态均未改判。

2026-10-17，Ubuntu `quant-server`、独立 Docker project `mw-issue74-20261017`，实际应用 `https://127.0.0.1:18474/advanced-charts`，chart origin `https://127.0.0.1:17475`，Playwriter session 3。API/indicator worker 产品源码 `0216995`，图表源码 `d56ffff`，仓库取证基线 `df0d9eb`。**Issue #74 仍未整体验收通过。**

本轮通过真实 UI 搜索并选择 Dukascopy EUR/USD、添加 EMA；其余 study、改参、周期及品种切换使用实际页面的原生公开 SDK，由 Playwriter 执行。布局复制、命名和保存通过原生 UI，随后真实页面 reload。真实品种是 `DUKA:9105c84af42600ccfa4f03132cc2472b`（EUR/USD）和 `DUKA:c2893271b856e9d2550cadc243bdf793`（XAU/USD）。这些 ID 未由合成 provider writer 写入。本任务的旧 BTCUSDT M1/H1 fixture writer 仍保留，旧自建/组合数据也仍是 fixture；它们不属于此次真实数据证据。

## 发现及处理

1. **验收部署缺少 native-history-worker，首次读取真实缓存空缺品种会持续排队、空白。** 原 BTC H4 空白超过四分钟；切换 Dukascopy 后任务仍为零页。补充本任务专用 `python -m alerts.native_history_loads` 服务（0.5 CPU/384 MiB）后真实 EUR/USD H4 正常加载。此项是部署缺项，已处理；未据此宣称产品算法错误。未重启其他任务或生产，未重置数据库。
2. **高优先级：长周期指标的预热和刷新一致性缺口。** 首次切 XAU/USD H4 时 EMA500 无曲线，初始固定计算起点 `1787947200000`，实际输入仅 218 根；后台补进更早历史后，535 行原生数据仍全部为 null，起点和218根输入未变（`09`、`11`）。复制并保存同一四指标布局再刷新，固定起点变为 `1663185600000`，实际输入增至 6,537 根，EMA500 变为 `4290.8002865866865`（`12`、`13`）。品种、周期和参数未改，四项均有新的实际执行/快照/覆盖证据。空值对不足500根输入本身是合法结果；问题是首次可用输入未满足预热，后台补数不改变已固定起点，而刷新重新选起点，页面也没有说明 EMA500 为什么为空。不是 worker 卡死，也不能靠提高延迟阈值解决。
3. **真实交互仍有秒级等待。** 冷切 XAU/USD 约10.7秒、刷新恢复约9.7秒；切周期约3.2/4.9秒；一次改参遇到真实 `DISPLAY_SNAPSHOT_EXPIRED` 后约4.8秒恢复，另一轮约5.9秒；切回 EUR/USD 约5.2秒，再切已有缓存的 XAU/USD 约6.6秒。热改参20→50→20及EMA500的部分操作约0.29–0.36秒。所有数字均为单次脚本操作到完整四指标证据可读的探索观测，包含轮询/取证开销，不是首像素、p95或正式预算结论。首次添加的旧67/280/268/274ms尤其不能当作交互延迟。
4. **验收 helper 对真实 Dukascopy 大小写误拒绝，已修。** native ticker 为大写，后端 provider revision 保留小写十六进制；仅 provider fixedRevision 分支使用严格比较。新增实际形态回归先失败，改为既有不区分大小写身份比较后通过；不同品种仍拒绝。原四指标失败记录不覆盖，`four-studies-authority-rechecked.json` 用相同原始记录重新验证四项均通过。未改产品镜像。

建议先修首次历史预热和固定计算起点的持久策略：在首次提交长周期结果前保证足够历史，缺少输入时显示明确状态；布局恢复应复用同一已确认起点，或以明确的新世代切换并重新计算全部依赖，避免刷新悄然改变输入基线。先用本轮“首次进入→后台补数→保存→刷新”构造产品回归，再优化快照更新导致的价格重读等待；暂不进一步放宽预算。

## 已通过的有限检查

- EMA20、BBANDS20/2、MACD12/26/9、Supertrend10/hl2/3/wilder 在真实 EUR/USD H4 显示；更正 helper 后四项均匹配实际提交的执行、快照、修订、起点、参数与全部可见 source rows。
- EMA20→50→20→500、H4→H1→H4、EUR/USD→XAU/USD→EUR/USD→XAU/USD 的记录均匹配当前品种/周期/参数及当前提交覆盖。此检查允许合法 null；因此 XAU EMA500 空白没有被错误解释成可见有限值通过。
- 原生“复制…”创建独立布局 `Issue74 真实 Dukascopy XAU H4 四指标 20261017`；刷新后未丢失或复制指标，参数保持。其计算起点变化另列为缺口。
- 实际 pageerror 记录为空。结束时已移除本轮 response/pageerror observer，恢复 applyBatch，禁用本页 reload probe。保留真实 XAU/USD 四指标布局供人工查看。
- 独立 SMA 初始化的 EMA500 递推对真实 EUR/USD H4 的9,556根同快照、同修订输入重算，末点与实际原生 last() 值完全一致（误差0，容差1e-12）。**仅一个末点，不是整段可见曲线或其他三个指标的独立数值 oracle。** 原生 generation 在两个捕获间从27到29，但身份、provider snapshot、input revision严格一致；脚本显式核对。

## 保留的取证失败与限制

- 初版 observer 对无限 SSE 调用 json 并等待，脚本超时；当时页面 EMA 正常。已排除 event-stream 并重建本轮自有页面；`four-studies-interrupted.json`及日志保留，不作为产品故障。
- 四指标原失败来自上述大小写 helper；重判单独存档，不回写原始记录。
- 独立 oracle 补证最初误用浏览器 Fetch Response 的 `status()`，随后直接使用 native 大写品种重放得到404；修规范化后两次旧快照得到真实422，均不作数值通过。另一次成功读取EUR/USD源数据，但 native each callback误读数组的 `.value`，保存了null数组。因此最终只使用另一个记录中相同身份/快照/修订的实际 last()，没有把缺失整段数据改判通过。脚本与原响应都保留。
- 此次只检查两个真实 provider 品种。没有真实生产自建/组合数据验收；没有完成四指标全段独立 oracle、实时更正并发、多图公平性、维护压力或30次延迟组。
- PR #84 的 CI run `39021184862` 仍失败：Backend **10 failed / 2560 passed / 11 skipped**；Web、Compose、classification通过。9项日志的直接对比差异包含 execution cache/计数/时间字段；另1项并发修复探针未触发。尚未完成针对性重跑，不能把失败自动认定为基线，也不能据此断言已发生数值污染。

## 文件及复核

`manifest.json` 包含每份任务原始文件和归档文件的SHA-256。JSON/日志使用确定性gzip，PNG和脚本原样归档；原凭据、compose、Cookie、CSRF值和完整浏览器状态未纳入。

关键文件：`09-eurusd-to-xauusd.json.gz`、`11-xau-ema20-to-500-after-backfill.json.gz`、`12-before-reload.json.gz`、`13-reloaded-real-layout.json.gz`、`16-real-eurusd-ema500-source.json.gz`、`16-real-eurusd-ema500-oracle.json.gz`，及对应截图。脚本保留原任务路径，属于诊断取证，不能不加准备直接重跑或覆盖原结果。

启动：`docker compose -p mw-issue74-20261017 -f /tmp/mw-issue74-20261017/compose.json up -d`；停止保留数据：将 `up -d` 换成 `stop`。访问需要同时能连接应用18474和图表17475。未合并、未正式tag、未发布生产。
