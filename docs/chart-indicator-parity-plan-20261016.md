# 平台、自建与组合行情 Python 指标交互性能方案

状态：用户已确认目标，**方案阶段；暂不实现业务代码**  
日期：2026-10-16  
项目：market-watch  
代码基线：`v1.25.8` / `b53d2973cd70e8610154bc46a9d516e62ccdadd7`  
工作树：`/home/quant/repos/market-watch-rest-native-fix-20261015`  
分支：`release/v1.25.8-20261016`  
关联 Issue：[#73 专业图表自选列表与指标体验](https://github.com/hezongyi/market-watch/issues/73)

本文是后续 agent 的交接方案。目标是让平台行情、自建行情和组合行情中的 Python 指标，在添加、首次加载、修改参数和恢复布局时，具有与 TradingView 内置指标一致的即时反馈节奏；计算结果仍须保持现有 Python 算法、交易日、缺口、临时 K 线和历史修订语义。

## 1. 范围和术语

| 用户称呼 | 当前 `series_kind` | 本方案含义 |
| --- | --- | --- |
| 平台行情 | `provider` | OANDA 等平台/供应商行情；上游历史可能需要 REST 或缓存补齐 |
| 自建行情 | `managed` | 正在维护并持续发布的自建行情 |
| 自建固定历史 | `history` | 已发布的固定自建历史；作为自建行情的一种，不得遗漏 |
| 组合行情 | `composite` | 固定历史与实时来源按组合修订、接缝和展示快照拼接 |

四类内部身份必须继续隔离。显示“像内置指标”描述的是用户可见的交互和等待行为，不表示把内部 ticker、组合修订或 Python 结果身份混在一起。

四类动作均在范围内：

1. 从指标选择器添加 Python 指标；
2. 图表首次加载或切换品种/周期后显示指标；
3. 在设置框修改参数或显示输入；
4. 恢复保存布局、重建多图或刷新页面后恢复指标。

## 2. 已测证据和当前瓶颈

以下是生产只读 REST 测量，不是浏览器最终首屏承诺。真实 Chromium DOM 时序仍需在 Ubuntu 隔离环境完成 W0。

| 链路 | 观测 | 说明 |
| --- | --- | --- |
| 平台 `MWP:OANDA:USD_CAD` H1 | 无指标首次约 2623 ms；其中上游约 2495 ms。SMA20 约 195 ms，参数改为 SMA50 约 112 ms（后续命中缓存） | Python 计算本身不一定慢，首次行情历史/上游往返才是主要延迟 |
| managed `EURUSD` H1 | 约 40–60 ms | 当前数据量和缓存较热；代码仍可能为每次带指标请求读取完整已发布历史 |
| 固定历史 `MWH:*` H1 | 首次返回 `values=0`、`calculation.status=pending`；后台完成后才返回完整值 | `FixedIndicatorRun` 按约 2000 根一轮推进，页面可能长时间看到空值 |
| 组合 `MWC:*` H1 | SMA20 首次约 274 ms 但状态仍 pending；SMA50 首次空值，约 6 秒后 complete | `FixedIndicatorRun` 之外，组合展示后缀还可能创建 `DisplayIndicatorTask`；后台有积压时可扩大到几十秒 |
| 组合实时来源 | 生产部分数据集曾为 `recovering`，`quote_ready=false`，部分 quote 已过期 | 实时快照恢复会触发 reset/reload，导致价格和指标不同步；不能把恢复状态当成普通指标完成 |

源码证据：

- `advanced-host/indicators.js` 明确为“Python computes every value; JS only maps backend series”；原生指标直接使用浏览器已有 K 线，执行模型不同。
- `advanced-host/indicator-coordinator.js` 每次最多读取 2000 根、最多 100 页，并有 30 秒总 deadline；参数变化可能重新读完整递归前缀。
- `backend/alerts/provider_cache.py` 在带指标时需要冻结完整计算前缀，随后调用 `provider_indicator_inputs.compute()`。
- `backend/alerts/managed_dataset.py` 的带指标路径会统计并读取完整发布历史，用户只看三百根也可能触发长历史计算。
- `backend/alerts/fixed_indicators.py` 首次请求创建 `FixedIndicatorRun`，状态初始为 `pending`；`history_versions.worker_tick()` 每轮只推进一个任务。
- `backend/alerts/display_indicator_jobs.py` 为组合展示后缀另起后台任务，且同样按有限页推进。
- `advanced-host/bridge.js` 的请求、取消和展示快照恢复目前分散在多个路径，旧参数结果可能在新结果到达前被清空。

## 3. 目标行为

“像内置指标一样”拆成可测的用户时序：

1. **已加载行情时添加指标**：用户操作后立即出现指标对象和状态；首个满足 warmup 的可见值目标 p95 `<300 ms`。
2. **修改参数**：保留旧结果作为过渡，目标 p95 `<500 ms` 出现新参数的首个可见值；不因等待新结果而整段空白。
3. **首次加载/冷启动**：行情和指标输入并行；有足够输入后先显示即时结果，后台继续补齐权威历史，不让用户等待几十秒才看到第一条线。
4. **布局恢复**：按保存的 study identity 去重、复用已接受的 bars/checkpoint，目标 p95 `<500 ms` 重新出现首个可见值；旧布局结果不能串到新品种、周期或参数。
5. **权威收敛**：普通缓存场景后端权威结果目标 `<2 s`；冷平台历史、长固定历史和实时恢复须显示明确的 `preparing/provisional/ready/error` 状态，不能无限空白或等待 30 秒后才报错。
6. **实时更新**：新柱和形成中柱只追加/更新受影响后缀；同一计算身份不重复扫描整段历史。

W0 取得真实浏览器基线后，可以调整目标数值，但任何调整必须按冷/热、三类行情、四类动作分别记录，不能用平均值掩盖组合或固定历史长尾。

## 4. 推荐架构：即时结果和权威结果分层

### 4.1 即时显示层

在浏览器端新增受控的 Python study display calculator（优先 Web Worker，避免阻塞 TradingView 主线程），输入是当前已接受的 K 线、必要 warmup 和指标规格。它只负责首屏和参数交互，不改变后端告警或历史认证。

第一批覆盖现有标准目录：`SMA`、`EMA`、`LWMA`、`BBANDS`、`RSI`、`MACD`、`ATR`、`STOCH`。计算必须按 `backend/alerts/indicator_state.py` 的状态、预热、缺口和临时柱规则实现，并以 Python 结果 fixture 做逐点校验；不能只用一段简化的滚动平均替代真实语义。

`SWING_SR_V1`、Supertrend 以及以后带复杂形态/绘图依赖的插件先走“后端预热 + 旧结果保留 + 明确状态”路径；在最终验收前必须为每个已发布 catalog 指标选择一种满足同一 SLO 的即时路径，不能永久留下“该指标例外”而不提示。

即时结果必须带上：`series_kind`、instrument、timeframe、study spec、参数、算法版本、计算起点、输入 revision、是否 provisional。只接受仍匹配当前 chart generation 的结果。

### 4.2 后端权威层

后端继续负责完整历史起点、固定历史/组合修订、检查点、历史更正、组合接缝、最终 canonical result 和告警使用。即时结果到达后，后台结果按 identity 原子替换；如果输入 revision 或 display snapshot 不同，旧结果只能继续作为过渡画面，不能宣称已经同步。

后端响应统一包含以下状态字段，前端和 stream 共用：

```text
calculation: {
  status: pending | partial | complete | error,
  run_id,
  cursor,
  target_end,
  calculation_origin,
  input_revision,
  algorithm,
  error
}
```

`partial` 只表示已经计算的区间，未完成区间必须是 null/明确缺失；不能把零值当作未完成结果。

### 4.3 统一 identity、取消和去重

请求和缓存键至少包含：

```text
series_kind + instrument + timeframe + revision/display_snapshot
+ indicator name/version + canonical params + calculation_origin
+ provisional mode + dependency revision
```

要求：

- 添加、参数编辑、布局恢复使用同一 coordinator 协议；每个操作有 request generation 和 AbortController。
- 新参数到达后取消尚未提交的旧请求，但保留旧参数的已接受结果直到新结果可替换。
- 同一图表多 pane、多图或 stream 订阅共享一次输入读取和一次同规格计算；不同品种、周期、修订、参数不能串缓存。
- 旧 generation 的 HTTP、worker、SSE、展示任务完成后不得提交。
- 30 秒 deadline 只保护后端请求，不作为用户第一次反馈的等待时间；到 deadline 必须返回可重试的错误和已接受的旧/即时结果。

## 5. 分类型实施方案

### 5.1 平台行情（`provider`）

当前瓶颈主要是冷历史/上游 REST，而不是 SMA 等普通算法。实施顺序：

1. 主图 `getBars` 建立 provider snapshot 后，指标请求直接复用同一 snapshot 和已接受 bars/warmup，不再为每个 study 重新触发上游历史读取。
2. `provider_indicator_inputs.freeze/compute` 的输入和结果缓存提升为跨请求可观测的共享缓存；缓存键绑定 dataset revision、history epoch、calculation origin、规格和临时柱状态。
3. 形成中柱只重算最后受影响状态；历史更正旋转 epoch，按 checkpoint 回放受影响后缀。
4. 首次冷历史仍由后台补齐，但即时层使用已加载窗口先画；供应商失败显示状态，不把旧 snapshot 与新指标混合。

验收重点：同一 provider snapshot 下同时添加三项指标只有一次输入读取；冷/热首屏分别记录上游请求数、SQL/扫描量和首个可见值。

### 5.2 自建 managed 行情（`managed`）

当前 `managed_dataset.data()` 带指标时可能读取完整已发布历史。建议：

1. 按 `published revision + timeframe + calculation_origin + spec` 建立可复用的递归 checkpoint/result cache；优先复用现有发布修订和指标状态结构。
2. 参数只改变指标规格时，从最近兼容 checkpoint 继续，不重新从 dataset 起点读取全部行；数据修订时从最早受影响的 checkpoint 回放后缀。
3. 查询返回当前可见区间的即时/已缓存结果和完整 `calculation` 进度；前端不因完整历史未完成而清空当前窗口。
4. 同周期多指标共享一份 frozen input；同一参数的多 pane 共享计算，展示映射保持独立。

在 W0/W1 证明现有进程内缓存不能跨 API 进程满足目标前，先不要新增数据库表。若确需持久化，新增缓存必须以 revision、算法版本和参数完整隔离，并走 F1 schema/回滚评审。

### 5.3 自建固定历史（`history`）

固定历史是不可变输入，最适合提前准备：

1. 历史版本发布或用户首次打开周期时，按默认指标/最近布局指标预热 `FixedIndicatorRun`；预热任务不得阻塞 K 线交付。
2. 复用 `FixedIndicatorBlock` 的 checkpoint lineage；参数变化只在新规格下建立 run，能够继承相同输入前缀时必须继承。
3. API 首次响应可以返回已完成前缀和 `partial`，不能以 `values=0` 伪装成“已加载”；前端即时层先覆盖可见窗口。
4. worker 任务按前台图表需求、可见周期和恢复布局优先级调度；普通后台维护仍保持公平，避免单个长历史饿死所有图表。

### 5.4 组合行情（`composite`）

组合同时受固定历史、接缝、实时来源和展示快照影响，是最高风险链路：

1. 组合修订建立或切换时预热常用指标；优先使用该修订已经存在的 fixed prefix 和 checkpoint。
2. `FixedIndicatorRun` 与 `DisplayIndicatorTask` 合并同一用户需求的优先级/状态展示，避免前端只看到空值而不知道在等哪一个任务。
3. 实时来源 `recovering` 时，先展示已确认的组合历史和即时指标；实时快照恢复单独显示，不阻塞历史指标首个可见值。
4. 组合新 quote 只推进形成中柱和受影响后缀；不因每次 quote 创建完整历史 run。展示 snapshot 失效时按现有恢复协议重新取价格和指标，不接受异版结果。
5. REST 初始结果和 stream 更新必须使用同一 `revision/input_revision/display_snapshot`；结果比较按 identity，而非只按时间戳。

验收必须覆盖：来源正常、来源 recovering、组合修订切换、接缝附近参数修改、实时新柱、断线后恢复和多图共享。

## 6. 前端交互状态和参数修改规则

study UI 不再采用“删除旧 study → 等后台完成 → 重新创建”的黑屏流程。建议状态如下：

```text
idle → preparing → provisional/partial → ready
                         └────────────→ error（可重试）
```

- 添加：先创建原生 study 和即时 worker 任务，再发后端权威请求。
- 参数修改：立即生成新 identity，旧结果保持可见并标记“正在更新”；新结果第一次有效后原子替换。
- 删除或切换图表：取消该 generation 的 worker/HTTP/stream 任务；不能取消其他 pane 共享的输入计算。
- 恢复布局：按布局中的 study spec 去重预取；同一 identity 命中结果缓存时直接恢复，不重新创建后台 run。
- 失败：保留最近一次可验证结果，显示可重试错误；没有任何可验证结果时显示明确的加载/失败面板，不能无限空白。

## 7. 实施阶段和交付物

### I0：浏览器真实基线（必须先做）

- Ubuntu 隔离 Docker 补齐 Chromium 依赖并登录测试账户。
- 采集三类行情 × 四类动作的事件：study click、study created、首次有效值、即时结果、`/api/charts/data`、后台 run、stream update、最终权威值和 layout ready。
- 冷/热、单指标/多指标、300 根/长历史、正常/`recovering` 组合分别保存脱敏 JSON。
- 交付请求瀑布、DOM/事件时序和当前 p50/p95；未完成前不得以总耗时猜测优化收益。

### I1：统一指标请求协议

- 统一 spec/identity、generation、取消、去重、状态和错误合同。
- 让多个指标共享一次 bars/input 读取；参数编辑不清空旧结果。
- 交付 coordinator 单元测试和过期响应/切换/布局恢复测试。

### I2：即时显示层

- Worker 先实现标准八项指标，逐点对照 Python oracle；覆盖 warmup、缺口、NY17、临时柱和多输出。
- 将即时结果映射到现有 native study，不改变 `indicators.js` 的输出/样式合同。
- 复杂指标先接“旧结果 + 后端预热 + 明确状态”，同时为最终即时路径建立测试夹具。

### I3：平台 snapshot 和增量缓存

- 主图历史与指标共享 provider snapshot；避免重复上游读取。
- 形成中柱只增量计算；历史更正按 epoch/checkpoint 回放。
- 交付供应商请求数、输入扫描量和 p95 对比。

### I4：managed/history checkpoint

- managed 按发布 revision 建立可复用 checkpoint/result；history 复用现有 `FixedIndicatorRun/Block` lineage。
- 参数变化从兼容 checkpoint 继续；任务按前台需求提升优先级并返回 partial。
- 若需要 schema，单独提交迁移、回滚和 F1 评审，不与前端体验补丁混合。

### I5：组合预热、实时接续和恢复

- 修订建立时预热；合并固定指标与展示后缀的用户可见状态。
- `recovering` 时先展示确认历史，快照恢复单独处理。
- 验证 REST/stream 同身份、接缝、断线、修订切换和多图。

### I6：综合验收

- 三类用户行情（自建含 `managed`、`history`）× 添加/首次/改参/布局恢复 × 标准/复杂指标。
- 后端、web、worker、Ubuntu R1/R2、浏览器视频和事件 JSON 均通过后，才形成候选清单。
- 生产只读只验证请求、状态和版本，不改偏好、告警、配置或部署资源。

## 8. 验收矩阵

| ID | 可观察结果 | 证据 |
| --- | --- | --- |
| A1 | 已加载 bars 时添加标准 Python 指标，首个有效值达到 `<300 ms` 目标 | 浏览器 performance timeline、study DOM/事件 JSON |
| A2 | 修改参数时旧结果不黑屏，新结果首值达到 `<500 ms` 目标 | 参数前后 identity、取消/提交序列和视频 |
| A3 | 平台冷/热请求不为每个指标重复上游读取 | provider snapshot、HTTP/SQL 计数和 p95 |
| A4 | managed 参数变化从 checkpoint 继续，不扫描同一完整历史 | checkpoint 命中、扫描行数、revision 对照 |
| A5 | 固定历史首次请求有 partial/progress，后台完成后原子替换 | `FixedIndicatorRun`、cursor、前后端结果对照 |
| A6 | 组合在正常和 recovering 状态都先显示可验证历史指标 | live snapshot 状态、组合 run/display task、浏览器事件 |
| A7 | 布局恢复复用 identity，切换/删除不会提交旧结果 | generation、AbortController、缓存命中和负向测试 |
| A8 | Python 最终结果与现有 Python oracle 逐点一致 | 标准八项及复杂指标 fixture，含缺口/NY17/临时柱 |
| A9 | stream 新柱只更新受影响后缀，无整段重算和重复订阅 | worker 计算计数、payload diff、长时回放 |
| A10 | 超时/失败有明确状态和重试，不无限空白 | 断网、worker 错误、30 秒预算和恢复证据 |

## 9. 风险、边界和回滚

- **算法分叉风险**：即时层若与 TA-Lib/Python 不同会造成短暂错误显示。所有即时计算必须带 `provisional` 和 identity，并用 Python oracle 逐点测试；权威结果到达后替换。
- **私有 TradingView 运行时**：只通过现有 study/bridge API 接入，不改许可库；浏览器版本和资源 hash 固定后再测。
- **缓存污染**：任何缓存缺少 revision、origin、参数或 provisional 维度都视为缺陷；旧 generation 结果拒绝提交。
- **组合恢复状态**：不能把 `quote_ready=false` 当成指标无数据；历史指标和实时恢复状态分开呈现。
- **资源竞争**：解除串行等待后要设置 worker/API/供应商并发上限，监测 503、队列长度、CPU、内存和数据库扫描量。
- **持久化变更**：默认先复用现有结构；新增表、迁移或改变固定结果格式属于 F1，必须独立回滚和恢复验收。
- **生产边界**：本方案不授权生产部署、镜像切换、数据库迁移、工作区修改或供应商配置修改；生产仅允许明确的只读验证。

回滚顺序：先关闭即时显示 feature flag，恢复纯后端 native 映射；再独立回退 provider snapshot/cache、worker 优先级和组合预热。旧的 Python 权威计算和固定结果表必须保持可读，不能用回滚清理历史结果。

## 10. 后续 agent 接手清单

1. 阅读本文件、`docs/pro-chart-watchlist-plan-20261016.md` 和仓库 `AGENTS.md`；确认业务基线仍为 `b53d2973`，工作树干净。
2. 先做 I0，补齐真实 Chromium 依赖和浏览器时序；不要先改业务代码。
3. 按 I1 → I2 → I3 → I4 → I5 → I6 小提交实施，每阶段更新证据和未覆盖项。
4. 复杂指标不能以“后台 pending”作为永久完成条件；要么接入即时计算，要么用实测权威预热达到同一首值 SLO，并在 UI 中明确状态。
5. 不把生产凭据、完整浏览器状态、完整生产响应或私有许可资源提交仓库。
6. 完成 I6 后只形成候选清单；合并、正式 tag、生产镜像、Unraid 切换和生产回滚仍等待单独授权。

当前状态：方案已形成；代码实现、生产部署和生产配置修改均未开始。
