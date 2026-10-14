# 原生 Charting Library 更新合同与 Market Watch 接入层

日期：2026-10-14。代码基线：`v1.25.3` / `6679a70d0d38f5b3d786d1d022f65065a4b8fc28`。本次仅研究，不修改应用或生产。

## 结论

原生图表正常持续更新使用 `getBars` 装入历史、`subscribeBars` 更新最新柱或追加新柱。普通报价变化和 M1 跨分钟不需要清空历史。`resetData` 是 TradingView 提供的显式重新取数接口，但“哪些变化算历史修订、何时调用它”由 Market Watch 接入层决定。

“平台行情”表示供应商原生周期数据，并不表示 TradingView 内置行情源。平台与组合在 v1.25.3 默认都经过我们自己的共享 SSE、历史变化检测和图表恢复逻辑。因此不能用平台行情作为没有后加机制的对照组。

当前代码确实存在历史变化触发重新取数的设计。正常尾柱更新也可以走不重载的原生 callback；要减少闪烁，首先要准确区分尾柱更新、状态变化与已绘制旧柱的实际修订，不能简单禁止所有历史恢复。

## 一手资料与可访问性

直接核对了本地 licensed Charting Library v31.1 的公开类型声明与本项目源码。许可文件保持 ignored，本文不复制或提交许可源码。

本次直连 TradingView 官方站点失败（网络不可达），因此以下官方 URL 是可供读者复核的定位链接，不宣称本次成功抓取。精确合同还与本地一手类型声明和仓库此前官方资料调查互相核对：

- [Required methods / getBars](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/#getbars)
- [Required methods / subscribeBars](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/#subscribebars)
- [Datafeed subscriptions](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/datafeed-subscriptions/)
- [Datafeed issues / Internet connection issues](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Datafeed-Issues/#internet-connection-issues)
- 仓库已有官方资料调查：[`docs/native-large-history-official-research.md`](../native-large-history-official-research.md)，约第 95–127 行。

## 原生更新机制

| 场景 | 原生合同与预期动作 | 证据 |
| --- | --- | --- |
| 初次打开、切品种／周期、向左取更多历史 | 库按日期和数量需求调用 `getBars`，接入层返回历史数组；库负责缓存和绘制 | 本地 `advanced-host/charting_library/charting_library.d.ts:12737`，官方 getBars |
| 当前 M1 柱中有新报价 | `subscribeBars` 提供的实时 callback 返回最新柱完整 OHLC；同一时间戳更新最新柱 | 本地 d.ts:12749–12758；官方 subscribeBars；当前 bridge.js:109–112 |
| 开始下一分钟 | 实时 callback 返回更大时间戳的新柱；图表追加。可以先完成旧的最新柱，再追加下一柱 | 官方 subscribeBars；当前 bridge.js:109–112 |
| 已落后于最新柱的历史价格／量实际修订 | 不能通过实时 callback 回写更早柱。先失效缓存，再用 `chart.resetData()` 重新获取历史 | 官方 subscribeBars；已有官方调查:107–115；本地 d.ts:10893–10903、12421–12426 |
| 断线后需要重新同步 | 由接入层处理连接恢复与数据一致性；可使用缓存失效和重新取数。不能把一次网络恢复直接等同于历史一定变了 | 官方 Datafeed issues；当前 bridge.js:1362–1380 |

`onResetCacheNeededCallback` 是库交给接入层的缓存失效通知；`widget.resetCache()` 对所有品种／周期产生同等效果。`chart.resetData()` 强制该 chart 重新请求数据。这两个公开能力不能推出“库每分钟主动重置图表”。本地 d.ts:12421–12426、10893–10903。

原生订阅以 listener ID 隔离。切品种／周期时新旧订阅可能短暂并存，接入层需要一直遵守各自身份，直到具体 ID 被退订；不能把新订阅当作旧订阅已经消失。官方 Datafeed subscriptions；本地 d.ts:12749–12764。

注意：历史重取不同于页面刷新、iframe 重建或 widget 销毁。当前这条路径调用现有 chart 的 `resetData`；图表主序列和依赖指标可能暂时重新加载，但不能表述为整个网页刷新。证据：[`advanced-host/viewports.js`](../../advanced-host/viewports.js):318–357。

## 我们后加的机制

| 功能 | 所属层 | 当前出处 |
| --- | --- | --- |
| 历史取数与最新柱 callback API、原生缓存和绘制 | TradingView 库公开合同 | 本地 d.ts:12737–12764 |
| 平台行情与组合行情身份、供应商缓存、组合 M1 展示观察值 | Market Watch | `backend/alerts/provider_cache.py:293`；`backend/alerts/market_stream.py:431` |
| SSE 共享订阅、后台计算、generation／sequence 与旧响应 fencing | Market Watch | `web/src/advanced/AdvancedWorkspace.tsx:234`；`advanced-host/bridge.js:206`、2540 |
| `history_changed`、`tail_retracted`、`history_gap` 等事件分类 | Market Watch | `backend/alerts/market_stream.py:430`、550 |
| 收到 reset 后暂停普通交付、失效应用缓存、重新加载 | Market Watch 使用原生 API | `advanced-host/bridge.js:2587`、383、1470 |
| 重新加载后恢复原视口，并在用户操作时取消恢复 | Market Watch | `advanced-host/viewports.js:318` |
| 组合 DisplaySnapshot 与 Python Supertrend 的快照绑定／结果批次 | Market Watch | `advanced-host/bridge.js:2608`；`backend/alerts/market_stream.py:439` |

## v1.25.3 的实际默认路径

默认 `marketPollingFallback` 为 false，仅 URL 显式 `marketPolling=1` 开启旧回退方式：[`advanced-host/bridge.js`](../../advanced-host/bridge.js):84。

```text
TradingView 调用 getBars
  → bridge.query
  → Market Watch 历史接口／供应商缓存或组合结果
  → 历史 callback 返回 bars
  → 保存已交付窗口、时间游标、revision／snapshot 观察凭据

TradingView 调用 subscribeBars
  → registerMarketBar（平台和组合均如此）
  → 共享 /charts/stream/subscribe + SSE /api/charts/stream/events
  → parent.postMessage(market-event)
  ├─ bars：acceptMarketBars → sub.cb 最新柱／追加新柱
  └─ reset：recoverMarketBar → reloadHistory
       → sub.reset() 缓存失效
       → chart.resetData() 历史重取
       → onDataLoaded 后恢复视口、重新注册订阅
```

出处：[`advanced-host/bridge.js`](../../advanced-host/bridge.js):1023、360、1261–1287、100–124、2587–2613、383–395、1470–1510；[`web/src/advanced/AdvancedWorkspace.tsx`](../../web/src/advanced/AdvancedWorkspace.tsx):234–249；[`advanced-host/viewports.js`](../../advanced-host/viewports.js):318–357。

组合主图的 bars 事件会先进入展示批次协调，绑定快照和指标后再交付。平台 bars 通常直接进入 `acceptMarketBars`。这是两者展示一致性的实现差异，并不改变它们共享 reset 恢复通路的事实。bridge.js:2608–2613。

旧 `provider-event` 分支会先 `reviewProviderReset`，验证已交付历史确实变化后才刷新，而正常生产默认共享 `market-event` 分支收到 reset 就恢复。不能把旧分支的复核行为误认为默认共享路径一定也有。bridge.js:1276–1287、1349–1388、2587–2605、2619–2636。

`reloadHistory` 只匹配品种／周期相关的 chart（也检查引用该源的 study），并恢复相关视口；通常并非所有无关图表同时刷新。历史导航窗口则有独立源刷新流程。bridge.js:1304–1320、1470–1510。

## 生产只读验收证据（2026-10-14）

这次验收使用生产只读浏览器，不保存用户布局、不新建规则。它直接确认两种行情都走默认 `market-event`，不是 URL `marketPolling=1` 的 legacy polling／旧 `provider-event` 分支：

| 行情 | 观察窗口 | 分钟接续 | tail 更新 | M1 `resetData` | 视频逐帧观察 |
| --- | ---: | ---: | ---: | ---: | --- |
| 组合 EURUSD | 约 7.5 min | 7 | 113 | 6 | 每次 reset 都出现整张 K 线暂时清空，约 0.1、0.2、0.3、0.4、0.6、0.7 s；无时间倒退或视窗／柱宽跳变 |
| 平台 EURUSD | 约 5.4 min | 5 | 22 | 5（另观察到 M5 1 次） | 10 Hz 视频逐帧确认 5 次清空，约 0.2、0.4、0.2、0.3、0.3 s |

因此“平台行情是原生图表自然会这样闪”不成立：闪烁来自我们在两种数据集上共同采用的 `history_changed → resetData` 重取策略。原生库的 callback 合同仍要求真实已绘制历史修订时走缓存失效和重取；需要优化的是 reset 的触发判定、事件分类和恢复交付时机，而不是把证据归因给平台供源或把旧柱直接用实时 callback 覆盖。以上是验收与架构分析，不是本次报告内的修复。

脱敏浏览器事件证据：[`composite-m1.json`](../verification/m1-production-20261014/composite-m1.json)、[`platform-m1.json`](../verification/m1-production-20261014/platform-m1.json)。视频逐帧结论由主验收任务核实：更密的 10 Hz 视频捕获到了平台闪烁，早期 200 ms canvas 采样未出现两次连续空白，不能据后者宣称平台不闪。组合事件带 `affected_start`，指向前一分钟；平台事件目前仅有 `history_changed`，仍需后端差异证据细化成因。

## 平台行情为什么也可能重取

平台默认共享流的判定是：查询已接受边界 `before` 之前、在依赖起点或已显示起点之后的 `ProviderBar`；只要存在 `revision > 1` 且 `changed_at` 新于接受观察时刻，就返回 `reset / history_changed`。数据集 invalidated_at 更新也会返回相同事件。对于实时页，用 `< before` 排除当下最新柱；历史页用 `<= before`。[`backend/alerts/market_stream.py`](../../backend/alerts/market_stream.py):497–508。

`ProviderBar.revision` 按整个 payload 是否变化递增，`changed_at` 也按整个 payload 是否变化更新；没有只看 native 图表 `time/open/high/low/close/volume` 投影。`complete`、来源确认／覆盖状态、成交量等也可能使 payload 不同。[`backend/alerts/provider_cache.py`](../../backend/alerts/provider_cache.py):340–369。该文件另有 `price_input`，但它包含完整性状态，而且该流历史检测没有使用它来决定 native 图表是否必须重取。provider_cache.py:285–290；market_stream.py:497–508。

因此代码证据能确认：平台也拥有我们设计的重载路径，且变化判断较宽。可以提出“旧 M1 柱完成状态或非绘图字段变化可能触发不必要 reset”的具体嫌疑；仅凭代码还不能断言本次生产每一个平台 reset 都是该原因。需要逐事件比对旧／新 payload 及交付顺序。

组合现在通过两个 DisplaySnapshot 的实际差异判断已加载窗口，真实差异仍返回 `history_changed`；正常尾柱与确认交接不会自动都变成重置。`display_verified` 还防止底层输入 revision 不同再次触发重置。[`backend/alerts/market_stream.py`](../../backend/alerts/market_stream.py):439–459、524–533。

## 最早接入和后来演进的 Git 证据

不能把项目最早版当作没有自定义逻辑的“纯原生供源”：初版已包括自写 datafeed、轮询和 revision 检测。

| 提交 | 日期 | 代码所证明的行为 |
| --- | --- | --- |
| `d5d3bea` `feat: add isolated licensed chart integration preview` | 2026-09-29 | 最早 bridge.js:175–216 定义 getBars／subscribeBars；219–253 自写轮询，history_revision 不同调用 sub.reset；340 附近自写定时 tick |
| `3697f27` `fix: invalidate matching chart cache on historical fill completion` | 2026-09-29 | 引入匹配品种／周期 `reloadHistory`，明确调用 sub.reset 与 chart.resetData |
| `ee3ae2c` `fix: distinguish streamed tail updates from historical revisions` | 2026-09-29 | 将简单 revision 变化改为接受历史窗口 revision 检查，普通流尾更新走 callback；真正历史变化才 reloadHistory |
| `5c32221` `feat(charts): validate progressive refresh with public viewport restoration` | 2026-09-30 | 引入后续 refreshChartHistory／公共视口恢复路线 |
| `a71439b` `Implement dual market datasets and provider cache as local candidate` | 2026-10-01 | 引入 provider-subscribe／provider-event；其 reset 调用 reloadHistory，平台供源是后来接入的机制 |
| `932a4fd`、`d0b8716` | 2026-10-04 | 引入／完善 reviewProviderReset：运输缺口先验证历史，而非直接宣称历史修订 |
| `294316c` `wip: implement shared market SSE subscriptions pending Ubuntu acceptance` | 2026-10-08 | 引入共享 market-event（后续多次修正，最终进入正式版本） |
| `d818d49` `fix: retain composite bars and Supertrend display snapshots` | 2026-10-13 | 组合展示柱留存、DisplaySnapshot 实际变化检查与展示指标绑定进入 v1.25.3 |

核对命令为 `git show COMMIT:advanced-host/bridge.js`、`git show COMMIT -- advanced-host/bridge.js` 与 `git log -S PATTERN -- PATH`。上述是接入层演进，不是 TradingView 库版本演进。

## 设计建议（尚未实施）

1. 正常更新优先遵守原生合同：完整更新当前柱；收到新分钟时有序追加。若最终确认的是仍为最新的一柱，可先通过实时 callback 交付最终值，再追加下一柱，避免把普通确认拖到已经变成历史后处理。
2. 分离“源数据审计／确认状态变化”与“已绘制图表数据变化”。确认状态更新但 native time/OHLC/volume 不变时，更新凭据和后台状态，不必主图 reset；量变化也不能一律忽略，取决于实际图表及指标使用量。
3. 只有已交付旧柱的绘图数据实际变化、依赖指标的已显示结果需要重建、历史确实有缺口或源绑定变化时才启动对应恢复。不能一律吞掉 history_changed，否则会保留错误历史或错误 Supertrend。
4. 复核共享 SSE 的平台路径是否应复用旧 provider 分支的“先证实再恢复”合同，并让组合与平台采用一致的展示差异分类。已确认真实变化后仍可使用库规定的 reset 恢复；增加视口保护只能控制跳动，不能保证 reset 重画没有短时空白。
5. 验证时同时记录事件理由、旧／新 native 投影、最新柱交付顺序、resetData 次数、视口和绘图行数。必须覆盖多个 M1 跨分钟、同价确认、不同价真实修订、成交量变化、递归指标、重连和历史浏览，不能仅看最终截图。

以上建议解决的是触发策略和交付顺序；没有发现公开合同支持用普通 subscribeBars 回写更早历史柱，所以不建议以该方式绕过原生历史修订要求。
