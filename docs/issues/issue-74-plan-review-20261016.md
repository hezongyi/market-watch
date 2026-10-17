# Issue #74 Python 指标性能方案评审

评审日期：2026-10-16。目标：[Issue #74](https://github.com/hezongyi/market-watch/issues/74) 及方案提交 `09c50059cab1ed1c20c776642de6c770be6e3963`。已核对远端方案分支仍指向该提交。其业务代码与 `b53d2973cd70e8610154bc46a9d516e62ccdadd7` 相同，差异只有两份方案文档和 Issue 模板。

处理状态：用户已认可本评审。五项结论已落实到[修订方案](../chart-indicator-parity-plan-20261016.md)，对应约束和验收见其 §11 对照表。本文保留原方案的评审证据，不表示修订后的方案仍有同样遗漏，也不表示 I0 或业务实现已经完成。

结论：问题值得解决；统一请求、复用输入、保留可验证的过渡结果和后台增量计算的方向合理。但当前方案有三项 P1 需要在实现前修订，另有两项 P2 应纳入交付范围。I0 基线采集可以先推进；不宜把浏览器双重计算作为已经验证的最终架构。

本次为 P0 文档评审，检查为源码核对、现有数值合同测试及定向复现。拟议 I4/I5 涉及重要后台链路，应按 F1 评估，即使没有新增表；不能仅以是否改 schema 判断风险。

**1. [P1] 递归指标缺少首屏初始化协议，窗口加 warmup 不能保证显示一致。**

位置：[方案 §4.1，第 70 行](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/docs/chart-indicator-parity-plan-20261016.md#L70)。

方案让 Worker 使用“当前已接受 K 线、必要 warmup”，同时要求遵守现有状态和逐点校验合同。但 EMA、RSI、MACD、ATR 的结果依赖窗口之前的递归状态；预热到出现非空值不代表已与完整历史一致。现有 [IndicatorState](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/backend/alerts/indicator_state.py#L1) 明确要求从固定起点或已验证 checkpoint 开始。

直接运行现有 EMA500 实现：完整历史为 1,200 根价格 100，随后 800 根价格 200；浏览器持有最后 800 根，其中 500 根作为 warmup、300 根可见。第一根可见柱的窗口计算值为 **200**，完整历史值为 **186.5205336828886**，差 **13.4794663171114**。提供同参数、同输入历史的正确 checkpoint 后，后缀与完整计算完全一致。这是初始化历史不同造成的差异，单纯移植相同算法、标记 `provisional` 或增加普通 fixture 无法消除。

修订建议：区分有限窗口指标与递归指标。递归路径必须定义 seed/checkpoint 的交付位置、输入 revision、算法版本和状态对应的时间边界；未命中时明确是等待正确初始化，还是允许有误差的近似展示。若允许近似，需要给出误差和收敛验收，且与“形成中 K 线”的 provisional 语义分开。不能把窗口起点计算伪装成完整历史起点计算。

Worker 的输入也应明确包含源时间、`end`、`complete`、缺口和组合覆盖/接缝证据。当前 [barsOf](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/advanced-host/bridge.js#L624) 给原生图表的只有展示时间和 OHLCV；这些值不足以重建 Python 的交易时段与缺口规则。应保留与已接受价格同一快照的原始输入，而不是从原生展示数据反推。

**2. [P1] 改参后的 checkpoint 复用承诺漏掉首次出现的新规格。**

位置：[方案 §5.2，第 135 行](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/docs/chart-indicator-parity-plan-20261016.md#L135)，§5.3 第 146 行、I4 和 A4。

“参数变化从兼容 checkpoint 继续”只适用于目标规格已经有兼容状态。现有构造器逐项检查算法和完整 spec；EMA20 的 checkpoint 用于 EMA50 会直接报“指标检查点算法或参数不匹配”。[固定任务 group_key](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/backend/alerts/fixed_indicators.py#L85) 也包含完整 spec，因此跨修订继承不等于跨参数继承。

对于从未计算过的 EMA/RSI/MACD/ATR 参数，复用 frozen input 可以省数据库读取，但仍需要从合法起点回放递归计算，除非目标参数的 checkpoint 已预先存在。A4 当前把改参一概写成“不扫描完整历史”，没有定义这种必然出现的 miss。

修订建议：把输入复用、结果命中、同规格 checkpoint 命中和新规格冷计算分成不同路径；分别记录 SQL 行数和计算步数。A4 仅对可复用状态成立的场景作承诺。必须增加“从未使用过的参数”验收，并说明冷计算期间的精度、等待和资源预算。

**3. [P1] 旧结果保留规则需要保留历史更正时的撤回语义。**

位置：[方案 §4.2，第 80 行](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/docs/chart-indicator-parity-plan-20261016.md#L80)，§6 第 172–175 行。

§4.2 允许不同 input revision/display snapshot 的旧结果继续作为过渡画面，§6 又普遍要求保留旧结果。这需要与“同一输入下修改参数”分开：若历史已经更正，旧指标在受影响区间已知失效，不能继续叠在新价格上，仅靠“正在更新”不能维持输入一致性。

当前 [coordinator](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/advanced-host/indicator-coordinator.js#L76) 会在更正时先 invalidate 受影响后缀；现有浏览器用例也要求更正读取被阻塞期间撤回旧值。该行为是现有正确性合同，不能为消除改参黑屏而一并放宽。

修订建议：明确失效原因和区间。同一已接受输入上的改参可以保留标注旧参数的过渡结果；历史更正、组合修订切换等必须撤回已知失效区间，只保留有证据未受影响的前缀。普通新柱追加不应清空整段历史。若要保留整个旧画面，应同时保留配套旧价格，不能混用两版输入。

**4. [P2] I1 需要明确包含原生结果 Adapter，改 coordinator 不足以消除改参黑屏。**

位置：[方案 I1，第 186 行](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/docs/chart-indicator-parity-plan-20261016.md#L186)，§6。

当前 [native-indicator-results.js](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/advanced-host/native-indicator-results.js#L28) 只在 symbol、周期和 inputs 完全相同时保留 rows。inputs 改变会走原生 clear；identity 改变也会清空 binding 的 rows/coverage。因此仅取消 HTTP、延后 coordinator 提交，不能保证原生 study 在改参期间继续显示旧曲线。

使用实际 Adapter 和模拟原生 engine 的定向复现确认：相同 inputs 的 clear 被拦截；EMA20 改为 EMA50 时调用原生 clear；重启后 coverage 不保留。该复现验证了 Adapter 分支，不替代真实 Chromium 的画面验收。

修订建议：把“过渡展示数据”和“当前请求身份”分别管理，并将原生 Adapter 的支持列为 I1 明确交付物。增加后端响应被刻意延迟时的真实浏览器测试，覆盖 A→B→A 连续改参、多输出原子替换、失败和期间发生历史更正。先证明这个接入路径，再投入八项算法移植。

**5. [P2] 预热和前台优先级需要服务端需求生命周期，否则快速改参仍会积压持久任务。**

位置：[方案 §5.3，第 145 行](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/docs/chart-indicator-parity-plan-20261016.md#L145)，§5.4、§9 资源竞争条目。

浏览器 AbortController 和 generation 可以阻止过期结果提交，但不会撤销已经创建的 FixedIndicatorRun。当前 [claim](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/backend/alerts/fixed_indicators.py#L167) 按更新时间选择任务；run 没有前台消费者或需求到期信息。DisplayIndicatorTask 另有自己的队列和容量限制。

在新规格无法继承递归状态的前提下，连续改参和“版本 × 周期 × 布局指标”预热会放大排队、CPU 和持久输出开销。方案提出并发上限与公平性，但没有定义过期需求如何降级、预热预算如何限制，以及共享任务何时仍须保留。

修订建议：定义服务端可观察的需求有效期、共享消费者规则、前台/预热预算和无活跃需求任务的降级策略；保留可供其他用户复用的权威结果及 lineage。验收加入多图、连续新参数和冷长历史同时存在的场景。复杂指标首次添加或使用全新参数时没有旧结果；有限的默认预热也不能覆盖任意参数，需要在每个 catalog 指标的快速路径表中说明如何达到所承诺的 SLO。

**实施顺序与验收补充。**

建议先做 I0，再完成上述初始化/失效合同及 I1 原生过渡展示验证，随后优先衡量现有缓存和队列优化的收益，再决定 Worker 的必要覆盖范围。现有 provider 模块已经有共享 frozen input、参数隔离的增量结果缓存和每 512 根的 checkpoint；[对应测试](https://github.com/hezongyi/market-watch/blob/09c50059cab1ed1c20c776642de6c770be6e3963/backend/tests/test_provider_indicator_inputs.py#L20) 也覆盖重复读取不重载完整前缀。应先定位现有缓存为何未命中、是否跨进程重复，避免再增加一套承担相同职责的缓存。

性能报告应分别记录用户操作到首值、输入就绪到首值、可见窗口覆盖完成、可见结果权威收敛和完整历史完成；同时记录即时/权威结果差异。页面刷新不能依赖已经消失的内存缓存来验收 500 ms 布局恢复。冷/热定义、目标参数是否预热、采样次数及复杂指标路径应固定，避免只出现一个有效点便判定体验完成。

统一计算 Module 的 Interface 应集中约束逻辑请求身份、输入证据、结果覆盖和精度；Worker 与后端作为两个 Adapter 接入。generation、过渡展示和失效规则由该 Module 收敛，避免 bridge、study 和 stream 各自判断可否提交。

**已执行验证与限制。**

- `PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest backend/tests/test_indicator_state.py -q -p no:cacheprovider`：**39 passed in 1.52s**。
- 使用评审 worktree 中的实际 IndicatorState 完成 EMA500 窗口/完整历史/正确 seed 三路对照，并验证 EMA20 checkpoint 无法用于 EMA50。
- 使用实际原生结果 Adapter 和模拟 engine 验证 inputs 变更时的清理与缓存保留分支。
- 未运行 I0 的真实浏览器时序或部署验收；现有性能数字仍是方案提供的 REST 观测，不构成对 300/500 ms SLO 的验证。

数值复现输入为 `close=[100.0]*1200+[200.0]*800`，`high=close+1`、`low=close-1`，所有柱 complete、无缺口；完整计算从第 0 根开始，窗口计算从第 1200 根开始，首个可见点为全局第 1700 根（0-based）。相同 EMA500 checkpoint 取第 1200 根之前的状态，恢复后处理窗口，得到的所有后缀值与完整计算严格相等。

评审和修订位于独立 worktree `/home/quant/repos/market-watch-issue74-review-20261016`；原评审分支已更名为 `docs/issue74-plan-revision-20261016`，用于发布修订方案并更新 Issue #74。
