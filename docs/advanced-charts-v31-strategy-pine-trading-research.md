# TV v31.1.0 包的策略、Pine 编辑器与交易能力核查

核查日期：2026-10-02。对象：`/home/quant/repos/research/TV_v31.1.0_0430.zip` 与当前 `market-watch`。结论来自 ZIP 原始源码、公开类型声明和项目代码；仅静态检查，未实施接入，未运行浏览器或真实交易验证。

项目对照基线：`v1.5.0`（`37cf4048ca10f3206963c1aec67f49b38140f5a8`）。本文随 v1.5.1 文档修订整理；功能现状按该固定源码核查，不表示运行环境已升级。

当前入口 `charting_library.js:1` 实际加载 `runtime.d6871abde1090b0329fe.js` 和 `library.e2f8b3a016c9e1a0b7a5.js`。ZIP 内另有旧版 bundle；本文以实际加载版本为主要实现证据，旧版只作交叉参考。

## 结论

| 问题 | 该包的实际情况 | 当前项目 |
|---|---|---|
| 有策略接口吗？ | 没有可用的原生 Pine 策略编写、运行或 Strategy Tester 接口；内部 `backtestingStrategyApi()` 首先抛出 `not implemented`。有真实的自定义 JavaScript 指标接口，以及独立的 Broker 下单接口，它们分别是指标展示和交易连接接口，不构成自动策略/回测引擎。[S1][S2][S3] | 后台已有独立的预警规则与演练信号推进，可扩展 Python 插件；原生图表尚未把这些功能接成策略回测，更不自动执行交易。[S6][S7] |
| 指标编辑器是 Pine Script 吗？ | 名称和文案能找到 Pine Editor，但实际加载版本的 `pineEditorTestApi()` 明确抛错，Pine study 创建也直接拒绝。本包不能直接粘贴 Pine Script 源码运行。公开自定义指标接受 JS 构造器或 `StudyScript` JS/TS 回调；`PineJS` 是指标计算辅助 API，不是 Pine Script 文本编译器。[S1][S2] | 接入的是 Python 后台计算结果，通过 JS 指标适配器绘制；原生指标设置窗口只能改参数、样式等，不能作为 Pine 代码编辑器。[S6] |
| 交易模块完整吗？ | 有实质实现的 Trading Platform 前端和 Broker API，包含交易面板、订单/持仓显示及下单、改单、撤单、平仓的接口契约，不能归为仅有文案的空壳。但本包没有已连接真实账户的完整交易系统，真实执行仍依赖接入方的 Broker 实现和交易后台。[S3][S4][S5] | 当前未配置 `broker_factory`，交易暂未接入；保留账户管理器入口也不代表连接了账户。[S6] |

## 策略和 Pine 的关键源码

- 实际加载的 `library.e2f8b3a016c9e1a0b7a5.js:788` 定义 `function Hy(){throw new Error("not implemented")}`；`:790` 中 `pineEditorTestApi(){Hy()}` 和 `async backtestingStrategyApi(){if(Hy(),...)...}` 均先调用该抛错函数。`:785` 的 `_createStudy()` 另明确拒绝 `Pine Script® and java studies`。后面的 facade 名称和加载代码无法绕过第一步抛错，不能当作可用的隐藏策略接口。[S1]
- 实际加载的 `library.e2f8b3a016c9e1a0b7a5.js:470` 底部面板列表仅配置 `paper_trading`，`:857` 将其交给 `BottomWidgetbarBootloader`。ZIP 中另存的 `terminal-configset.479f23e3bb6ebbc0e84a.js:3/5` 不在当前加载链中，其 Pine/回测空构造器仅作历史交叉参考。Pine Editor 和 Strategy Tester 的标签、状态、菜单文案不证明模块完整。[S1]
- 公开 `custom_indicators_getter` 类型为 `(PineJS: PineJS) => Promise<readonly (CustomIndicator | StudyScript)[]>`。传统 `CustomIndicator` 用 ES5 构造器，提供 `main` 和可选 `init`；`StudyScript` 则为 `(ctx: ScriptContext) => void` 回调。`ScriptContext` 提供 `ta`、`math`、行情序列、`indicator()`、`plot()` 等；该回调并不是 Pine 源码字符串，也没有在该契约中提供 `strategy.entry()` 等交易策略 API。[S2]
- 随包三份公开 `.d.ts` 没有 Pine Editor 或 Strategy Tester 的公开运行 API。图上绘制买卖信号、持仓工具，或者调用 Broker 下单，均不能自动获得策略回测、资金曲线和自动运行调度。[S2][S3]

## 交易前端、示例和真实执行的边界

- Broker API 明确规定 `placeOrder`、`modifyOrder`、`cancelOrder`、平仓及订单/持仓状态更新；类型注释要求接入方在自己的后台处理，并向图表 host 回传状态。`broker_factory(host)` 返回接入方实现的 `IBrokerTerminal`，不是包自行连接券商。[S3]
- `trading.html:109` 配置 `new Brokers.BrokerDemo(host, datafeed)`；示例 `broker-sample/dist/bundle.js:1` 的账户标题为 `Trading Demo Account`，在内存中维护订单/持仓并执行模拟操作。示例的 `executions()` 返回空数组，还明确打印 `Durations are not implemented in this sample.`，不能当作完整真实执行后端。[S4]
- 包中的另一份 `mock_broker.js` 不是全空实现，确实发送 HTTP 请求：`:7` 指向 `http://127.0.0.1:5002`，`:227` 下单 `POST /api/orders`，`:292` 撤单 `DELETE /api/orders/{id}`，`:545` 平仓 `DELETE /api/positions/{id}`。但该服务端实现不在 ZIP 中；某些方法仍只有日志或简化逻辑，例如改单按先撤后建处理。存在请求代码不证明本机服务已运行、真实账户已接通或所有交易能力完整。[S5]
- 因此可以基于该包开发原生图表交易接入。实际工作是实现 Broker 适配层与账户/订单/持仓后台、更新通知和错误处理，并按已实现能力设置配置标志。不能通过简单开启 feature 即获得实盘系统，也不能保证静态检查没有覆盖的所有交易路径都可用。[S3][S4][S5]

## 当前项目与可扩展方向

- 当前 `advanced-host/bridge.js:1108` 注册 `pythonStudies(PineJS, catalog)`；`advanced-host/indicators.js:1` 明确 Python 计算全部指标值，JS 只映射后台序列到图表 API。当前图表扩展路径可支持新增指标，不能直接运行 Pine 源码。[S6]
- 项目后台 `backend/alerts/indicators.py` 有 `validate/lookback/calculate` 插件协议和版本化 `REGISTRY`；`backend/alerts/domain.py:241` 的 `advance()` 推进预警状态；`backend/alerts/service.py:297` 的 `replay_step()` 在历史 K 线上运行规则并收集信号。这是项目自身的预警/演练扩展能力，不等同于包原生 Pine 策略引擎或基于成交、佣金、资金的完整交易回测。[S7]
- ZIP SHA-256 实测为 `e4eabc20e156000b2a8fda7747044fd82b95c714526c7ab7f34bcfe62abaf9ee`，与当前安装清单一致；前次核查已核对 2928 个库条目全部匹配。因此这些结论同样适用于当前安装的原生库，替换成同一个包不会补出 Pine/策略模块。[S8]

## 证据索引

`Z/` 代表 ZIP 条目 `TV_v31.1.0_0430/static/`。行号按原始换行计数，压缩 JS 不采用重新格式化后的行号。

- **[S1]** `Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:785/788/790`（拒绝 Pine study、抛错函数及策略/Pine 测试 API），`:470/857`（实际底部面板配置）；旧版 `library.0dbcc224ae24ceb827f2.js:772/774` 与 `terminal-configset.479f23e3bb6ebbc0e84a.js:3/5` 仅作交叉参考。
- **[S2]** `Z/charting_library/charting_library.d.ts:5172–5186`（自定义 getter）、`:6162–6178`（构造器）、`:17543–17550`（PineJS 与 Std）、`:20162–20182`（ScriptContext）、`:30227`（StudyScript 回调）。全文核查随包 `charting_library.d.ts`、`datafeed-api.d.ts`、`broker-api.d.ts`。
- **[S3]** `Z/charting_library/broker-api.d.ts:1560–1663`（交易请求）、`:1582/1595`（后台处理与状态更新要求）、`:1237` 起（host 回调）；`Z/charting_library/charting_library.d.ts:28042–28050`（`broker_factory`）。
- **[S4]** `Z/trading.html:109`（BrokerDemo）；`Z/broker-sample/dist/bundle.js:1`（实际模拟下单、改单、撤单、平仓、内存缓存、Demo 账户、空 executions、未实现 duration）。
- **[S5]** `Z/mock_broker.js:7/227/292/314–317/542–545`（外部服务与订单/持仓请求）；ZIP 文件清单只有 `static` 目录下前端与示例，没有该交易服务器的实现。
- **[S6]** [advanced-host/bridge.js](../advanced-host/bridge.js#L1108)（当前自定义指标接入）、[交易边界说明](advanced-charts-user-guide.md#L93)；[advanced-host/indicators.js](../advanced-host/indicators.js#L1)；[docs/advanced-charts-user-guide.md](advanced-charts-user-guide.md#L62)（无 Pine 环境）、[交易与策略范围](advanced-charts-user-guide.md#L68)。全文检查 bridge 未配置 `broker_factory`。
- **[S7]** [backend/alerts/indicators.py](../backend/alerts/indicators.py#L21)（插件协议与注册表）；[backend/alerts/domain.py](../backend/alerts/domain.py#L241)（规则推进）；[backend/alerts/service.py](../backend/alerts/service.py#L297)（演练信号推进）。
- **[S8]** [advanced-host/library-manifest.json](../advanced-host/library-manifest.json#L2)；[前次包一致性核查](advanced-charts-v31-alert-module-research.md)。
