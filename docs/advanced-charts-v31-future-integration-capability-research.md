# TV v31.1.0 包：尚可接入的功能与优先级

核查日期：2026-10-02。对象为 `/home/quant/repos/research/TV_v31.1.0_0430.zip`。仅静态源码与已有验收资料核查；本次没有浏览器联调、真实下单或实施功能。

项目对照基线：`v1.5.0`（`37cf4048ca10f3206963c1aec67f49b38140f5a8`）。本文随 v1.5.1 文档修订整理；功能现状按该固定源码核查，不表示运行环境已升级。

## 结论与判断口径

**有值得继续接入的实质模块，最适合当前需求的是 MT4 账户/订单/持仓面板、真实 Bid/Ask 报价、图上订单与成交标记，以及项目自身预警/信号的图表入口。** 新闻、事件标记、盘口、额外周期、币种/单位换算也有接口或实现基础，需补相应数据与后台。[Z2][Z3][Z4][Z5][Z7][R1][R2]

“完整”在本文只表示检查到公开契约及相应前端实现，不表示包自带数据服务、不表示当前安装已逐项跑通。具体分为：

- **前端实装，尚未接数据/业务**：有可调用的公开接口和实际调用/绘制代码，例如 Broker、交易线、marks、news。
- **有实装基础，当前缺能力验收或扩展适配**：例如量相关指标、分布、自定义周期；不把菜单已保留的功能重新说成全未实现。
- **占位/缺件/不能确认完整**：Pine、原生策略回测、原生回放、警报管理；以及当前运行版本缺失的导出等动态文件。

ZIP 中保留多份不同哈希的 library/runtime 和旧资源。**当前入口实际加载的是 `charting_library.js:1` → `runtime.d6871abde1090b0329fe.js` + `library.e2f8b3a016c9e1a0b7a5.js`**；不能因为其他版本同名资源存在就证明当前入口可用。入口自报 `TT v31.1.0`，ZIP 名称不用于证明其所有模块完整。[Z1]

## 当前已有功能，不应再作为“未来缺口”

当前专业图表已接原生工作区、保存加载/自动保存、多图布局与同步、对象树/分组/绘图共享、三类模板、设置与收藏、多列表自选、报价详情、比较叠加、数据窗口、截图下载、八类 Python 指标，以及自研 CSV。普通 Volume 供数和原生 Volume 指标已在 v1.3.3 交付：BTC 是基础资产成交数量，OANDA 是报价数量；未知量保留空值。[R1][R3][R4]

v1.5.0 已整合原生历史缓冲、账户密码/退出、全屏与原生菜单相关源码，不能将其重复列作待开发功能。这里的“账户”是项目登录账户，不是券商交易账户。当前主线没有 `broker_factory` 接入，交易、news/depth/marks 的缺口依然存在；原部署与验收镜像保留各自来源，源码合入不表示组合镜像已完成运行验收。[R5]

旧 `advanced-charts-capability-inventory.md` 表格明确保留的是初次盘点记录，模板、自选、比较、截图等历史“未接入”描述不能作为现在的判断依据。[R1]

## 候选能力矩阵

成本为相对工程量，不是工期承诺。P1 最贴近当前 MT4 使用需求；P2 是分析体验补齐；P3 取决于新的市场/数据需求。

| 优先级 | 能力 | ZIP 中实际状态 | 项目当前缺口 | 后续接入方式与主要依赖 | 相对成本 |
|---|---|---|---|---|---|
| P1 | **MT4 账户、资金、订单、持仓和交易操作** | Trading Platform 的 Broker 契约、账户管理器和交易线有实质实现；示例可模拟订单，真实执行依赖 `broker_factory` 返回自己的 Broker。[Z2][Z3] | 图表未配置 Broker；账户管理器可见但没有资金/订单/持仓通路。[R2] | Windows MT4 桥 → 局域网代理 → 项目交易后台 → Broker 适配。读账户/历史先落地，再逐项映射下单、撤单、改单、平仓、SL/TP。按支持的能力开放按钮，处理 MT4 ticket、手数单位/步进、对冲订单与持仓语义、重连后的状态核对。 | 高 |
| P1 | **图上订单线、仓位线、成交箭头；只读成交复盘** | `createOrderLine`、`createPositionLine`、`createExecutionShape` 实际加载原生工具并返回 adapter，支持价格、数量、文字、颜色和操作回调。[Z3] | 多空盈亏比画线已存在，但真实交易对象和成交记录尚未映射。[R2] | 可以先接 MT4 只读持仓/历史成交，不必第一版就开放交易。订单线/成交标记按账户、品种和真实时间定位；已平仓历史只作展示。开启移动/撤单等回调后再调用交易后台。 | 中；依赖 MT4 读取 |
| P1 | **真实 Bid/Ask、点差与可交易报价** | Quotes 数据契约提供 bid/ask 等字段，交易界面具备相应报价展示基础。[Z4] | `getQuotes/subscribeQuotes` 已实现，但图表 quote 接口以 M1 close 提供 lp/bid，未给完整逐笔 ask/点差。[R6] | 接 MT4 当前报价、服务器时间、品种交易规则；报价服务与 K 线服务分开。区分 MT4、OANDA、Binance 来源，不能用现有 OANDA/Binance 图表价格冒充 MT4 成交价。现有预警后台已保存部分真实 bid/ask，可复用其结构，不能假设已覆盖全部品种持续报价。[R6] | 中 |
| P1 | **预警信号、成交、经济事件的 K 线/时间轴标记** | `getMarks/getTimescaleMarks` 为公开接口，实际 study engine 会调用外部 datafeed，并渲染标记/提示。[Z5] | `supports_marks`、`supports_timescale_marks` 当前均为 false；已有预警/演练信号未投射到专业图表。[R7] | 优先用现有信号和 MT4 成交；按可视窗口分页映射时间、颜色、文字、提示。经济日历需额外数据源；标记展示不等于自带经济日历产品、事件订阅或预警执行。不同来源/系列的数据要明确关联规则。 | 低至中；事件源另计 |
| P1 | **从图表创建自己的预警，并显示价位/状态** | 通用按钮、右键扩展、绘图接口有基础；包原生 Alert 管理/执行仍是空实现。[Z8] | 后台已有预警和通知，但图表没有创建/管理的业务桥。[R7] | 自建“创建预警”入口携带品种、价格、周期，复用现有规则/通知后台，绘制对应线或状态。MT4 的行情来源/品种、预警适用系列需扩展；价格规则可先做，任意趋势线/内置指标自动触发要新增规则能力。 | 中；不属于启用现成警报模块 |
| P2 | **VWAP/锚定 VWAP、OBV 等量相关指标，成交量蜡烛及固定/可见范围分布** | VWAP、OBV、Anchored VWAP 计算，Fixed/Visible Range Volume Profile 构造器/直方图计算与固定分布绘图工具真实存在。[Z6] | OHLCV 已供，菜单保留，但 v1.3.3 没有对这些分析能力逐项验收；细周期选择优化接口也未接。[R3][R4] | 优先在量完整的 BTC 实测计算/图形/保存恢复；接 `getVolumeProfileResolutionForPeriod` 选细粒度数据。OANDA 只能作报价量分析。分布按 K 线高低范围分配量，不是真实逐价成交分布；Up/Down 或 Delta 也不能称为真实主动买卖量。[Z6] | 低至中，主要是验收/适配 |
| P2 | **自定义分钟/小时周期，例如 M2、M3、H2** | 原生周期选择和底层从可用粒度寻找可聚合周期的实现存在。[Z9] | 当前仅九个约定周期；`frames` 校验拒绝其余，启用 `disable_resolution_rebuild`，后台按自有日历分桶。[R8] | 扩展后台周期、聚合、缓存、请求校验、历史预热与 UI。原有 M1 可支持额外分钟/小时；不能只加菜单字符串，也不能借机改变预警周期语义。 | 中 |
| P2 | **新闻侧栏/品种资讯** | `news_provider` 公开契约，真实 `NewsWidget` 注册和 renderer 存在；支持标题、来源、时间、简介及详情。[Z7] | 未配置 news_provider，也无新闻数据服务。[R2][R7] | 先接自己的公告/研究摘要或合适新闻源，按品种过滤；走鉴权父页/后台适配，继续保留独立图表来源隔离。外链/详情还需配合现有 iframe/CSP。 | 中；数据源另计 |
| P3 | **Level 2 订单簿与 DOM 价格梯子** | `subscribeDepth/unsubscribeDepth` 契约及实际 snapshot/update 调用存在；Broker 能力可配置 Level 2。[Z10] | 没有 depth 服务或 Broker；OHLCV 和两档 bid/ask 无法提供订单簿。[R2][R7] | 选择真实提供 L2 的来源，例如交易所 depth；处理快照/增量顺序、重连和订阅。MT4 常规外汇报价不等于 L2，是否有深度须向实际券商核实，不能从 bid/ask 推导虚假盘口。 | 中至高 |
| P3 | **秒线与 Tick 周期** | `has_seconds/has_ticks/seconds_multipliers`、tick→秒构建契约及实际周期选择代码存在。[Z9] | 当前从 M1 出发，没有历史逐笔/秒线供数。[R8] | 增加可靠报价/逐笔采集、历史存储、时间排序与聚合。MT4 桥按文件快照传报价可能漏掉中间 tick，不能因此保证完整逐笔历史或交易所真实成交。 | 高 |
| P3 | **显示币种/单位换算** | datafeed 支持 currency_codes、units 和转换后 resolve；实际 availableCurrencies/availableUnits、setCurrency/setUnit 实装。[Z11] | 元数据与解析尚未提供这些配置/转换后的历史序列。[R7][R8] | 后台提供历史汇率或单位转换序列，例如黄金美元/盎司换为人民币/克；显示转换品种必须与真实交易、原始预警价格分开。 | 中至高，取决于历史汇率 |
| P3 | **交易日志/分析截图归档** | 原生截图/客户端 snapshot 有实现；当前下载已验收。[Z12][R1] | 缺的是自己的交易日记、图片归档及成交/预警关联业务，不是缺截图功能。 | 接 MT4 成交、备注和截图保存到项目后台。可作自建应用功能，不宣传包自带成熟交易日记系统。 | 中 |

## 包完整性的限制与不应优先承诺的方向

1. **Pine Editor、原生策略执行/Strategy Tester、原生 Bar Replay 和原生警报管理不是现成完整模块。** 当前实际 loader 中 `Hy()` 抛出 `not implemented`，回放、回测、Pine 测试接口及部分交易 facade 调用它；非字符串 study 创建也直接拒绝 Pine/java 对象。自定义 JS/Python 指标和 Broker 接入应走公开支持路径，不能用内部 `widget.trading()` 等 facade 代替 `broker_factory`。[Z8]
2. **原生导出与原生“保存样式”对话框仍属于缺动态资源。** 运行时的 48526 映射为 `export-data.bb1bdc415916b47fed24.js`，ZIP 没有该文件；其他旧版 export-data 文件不能直接顶替。当前自研 CSV/保存样式已提供替代；若要导出原生内置指标值，先获得匹配完整资源或明确另开发取数方案，不按此包现成功能承诺。[Z1][Z13][R2]
3. **Footprint、TPO、Session Volume Profile 不按“完整可接入”推荐。** loader 内有枚举、样式和图形名称，但公开类型和调用链不足以证明完整工作模块；`getTpoSummaryPane/getVolumeFootprintSummaryPane` 明确未实现。普通量、报价量及 OHLC 也不提供逐价真实买卖成交。不能因出现名字就给出只开 feature 的承诺。[Z14]
4. **筛选器、社区脚本/观点、云账户/订阅、完整新闻/经济日历、自动形态识别与自动策略交易均不能从这个包直接获得。** 本次确认的 news/marks 是自己的数据接入能力，形态/波浪工具是手工绘图；自动化业务仍需自建服务。未发现可用的公开产品 API 就不把文案和图标列为成熟模块。[R2][Z8]
5. **跨工作区全局画线/服务器截图图库并不是现有缺陷。** 当前实际画线按工作区隔离是已验收的设计；独立绘图存储/共享 API 是可选新范围，若改变产品规则再设计。模板、收藏、截图下载继续视为已实现。[R1]

## 推荐实施顺序

建议第一阶段做 **MT4 只读账户/持仓/订单 + 实际 bid/ask + 图上成交/信号标记**，形成可对照 MT4 的真实数据闭环。第二阶段沿同一个 Broker 后台逐项接下单、SL/TP、撤改单和平仓。第三阶段接图上预警和量指标专项，随后按需求增加新闻/事件、自定义周期。盘口、Tick/秒线、币种转换均等真实数据条件满足再开。

MT4 接入的底层方案已另见 [MT4 桥接研究](mt4-live-trading-bridge-research.md)。这里仅给功能选项和边界，不替代 MT4 桥的券商/版本实测，也不声明任意 Trading Platform 方法都在这个混合资源包中完整可运行。

## 一手证据索引

`Z/` 指 ZIP 原始条目 `TV_v31.1.0_0430/static/`，行号按原始换行计数。下列 JS 引用主要采用实际入口加载的 e2f 文件，不使用格式化后的行号。

- **[Z1]** `Z/charting_library/charting_library.js:1`：入口依赖 JSON 指向 runtime.d687 与 library.e2f，自报 TT v31.1.0。当前项目 [advanced-host/index.html](../advanced-host/index.html#L23) 加载这个入口；[安装清单](../advanced-host/library-manifest.json#L2) ZIP SHA-256 为 `e4eabc20e156000b2a8fda7747044fd82b95c714526c7ab7f34bcfe62abaf9ee`，与此前包一致性核查相同。
- **[Z2]** `Z/charting_library/charting_library.d.ts:28042–28050`：broker_factory；`Z/charting_library/broker-api.d.ts:1560–1663`：placeOrder、modifyOrder、cancelOrder、closePosition、SL/TP 和状态更新要求；`Z/trading.html:109`：BrokerDemo；`Z/broker-sample/dist/bundle.js:1`：内存模拟账户与操作；见 [前次交易核查](advanced-charts-v31-strategy-pine-trading-research.md)。
- **[Z3]** `Z/charting_library/charting_library.d.ts:11309–11391`：交易原语公开契约和回调；`Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:781–782/785`：实际调用 ensureLineToolLoaded，再创建图表原语返回 adapter。它们不自行执行后台交易。
- **[Z4]** `Z/charting_library/datafeed-api.d.ts:188–218/391`：Quotes 字段与 API；`Z/charting_library/charting_library.d.ts:27933–27941`：bid/ask/spread trading customization；[现有报价 API](../backend/alerts/market_data.py#L482) 的 M1 lp/bid 映射。
- **[Z5]** `Z/charting_library/datafeed-api.d.ts:264–289/870–940/1084`：marks/timescale marks 契约、标记内容；`Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:835`：真实外部 getMarks/getTimescaleMarks 调用，`:489`：时间轴标记更新。
- **[Z6]** `Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:132`：Anchored VWAP；`:140–149`：VolumeByPriceExpr、Fixed/Visible Range Volume Profile；`:143`：`_addHistoryBarToHistogram` 按 low/high 分配 volume，且 NaN volume 转成 0；`:185`：OBV；`:196`：VWAP。`:309` 固定分布工具 loader；`Z/charting_library/bundles/runtime.d6871abde1090b0329fe.js:4/7` chunk70059 映射，`Z/charting_library/bundles/line-tool-volume-profile.ede3648b1a480330f891.js:1–3` 真实 LineToolFixedRangeVolumeProfile 类。`Z/charting_library/datafeed-api.d.ts:374–387` 是选取更细分辨率的公开接口。
- **[Z7]** `Z/charting_library/charting_library.d.ts:16978–17000/28015–28038`：NewsItem/news_provider；`Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:852`：newsProvider 接到 getNews override；`:858`：注册 NewsWidget、Details、DataWindow；`:103`：news renderer；`Z/charting_library/bundles/widgetbar.c6e39002f99475679d03.js:17` 给 news 设置真实 NewsWidget 构造器，不能靠默认 ctor:null 判断未实现。
- **[Z8]** `Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:785`：Pine/java 对象创建明确拒绝；`:788`：Hy 抛错；`:790`：replayApi/backtestingStrategyApi/pineEditorTestApi 等调用 Hy；`:794`：trading/waitTrading 同样未实现。警报空实现另见 [警报核查](advanced-charts-v31-alert-module-research.md)，回放见 [回放核查](advanced-charts-v31-replay-module-research.md)。
- **[Z9]** `Z/charting_library/datafeed-api.d.ts:640–683`：intraday/seconds/ticks 数据条件；`Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:124`：tick、seconds 和可聚合粒度选择实际实现。
- **[Z10]** `Z/charting_library/datafeed-api.d.ts:64/353–373`：DOM 数据和订阅；`Z/charting_library/broker-api.d.ts:561`：Level2 标志依赖 depth；`Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:840`：调用 subscribeDepth，区分快照/更新。仅说明实际接收深度的基础存在，不代表 MT4 数据源有 L2。
- **[Z11]** `Z/charting_library/datafeed-api.d.ts:128/783–798/1044–1055`：币种/单位和转换请求；`Z/charting_library/charting_library.d.ts:14065/14072`：setCurrency/setUnit；`Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:399/764/835`：实际转换参数与可用列表。
- **[Z12]** `Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:794`：takeClientScreenshot 使用 clientSnapshot；[截图已交付证据](advanced-charts-current-acceptance.md)。
- **[Z13]** `Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:783`：exportData 加载 48526；`Z/charting_library/bundles/runtime.d6871abde1090b0329fe.js:3/6`：映射 export-data.bb1bdc415916b47fed24.js；ZIP 文件清单没有此条目。[缺件处理](advanced-charts-user-guide.md#L87)。
- **[Z14]** `Z/charting_library/charting_library.js:1` 和 `Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:362`：内部类型名；`:660`：TPO/Volume Footprint summary pane 未实现。此证据不足以推出全包每条 TPO/footprint 绘制路径都为空，但也不足以承诺完整产品。
- **[R1]** [当前交付核对](advanced-charts-current-acceptance.md)、[能力盘点的历史说明](advanced-charts-capability-inventory.md)、[偏好适配](../advanced-host/preferences.js)、[自选持久化](../advanced-host/watchlists.js)。
- **[R2]** [图表使用与限制](advanced-charts-user-guide.md#L58)，尤其量分析、新闻/深度和交易边界；[当前 widget 配置](../advanced-host/bridge.js#L1105) 没有 broker_factory/news_provider。
- **[R3]** [v1.3.3 Volume 交付](chart-v1.3.3-delivery.md)：普通 Volume 已供、其他量分析未声明；[当前 resolveSymbol OHLCV 元数据](../advanced-host/bridge.js#L392)。
- **[R4]** [图表量分析边界](advanced-charts-user-guide.md#L64)、[锚定/分布工具边界](advanced-charts-user-guide.md#L83)。NaN→0 的内部计算提示量分析上线前尤其要验证缺量，不能仅用普通 Volume 缺量显示∅的验收替代。
- **[R5]** 固定基线 `37cf4048ca10f3206963c1aec67f49b38140f5a8` 为 `v1.5.0`，已合入原 v1.4.0 历史缓冲与图表 UI/账户源码；见 [v1.5.0 源码交付](chart-v1.5.0-source-delivery.md)。当前主线静态检索没有 Broker 接入。未把 Git 发布等同于运行部署。
- **[R6]** [现有图表 quote 供数](../backend/alerts/market_data.py#L482)、[真实报价预警保存](../backend/alerts/service.py#L389)、[市场后台按规则需求采样 quote](../backend/alerts/market.py#L512)。
- **[R7]** [marks 当前关闭](../advanced-host/bridge.js#L329)、[预警信号与演练](../backend/alerts/service.py#L297)、[现有信号存储](../backend/alerts/service.py#L362)。
- **[R8]** [九周期映射](../advanced-host/bridge.js#L48)、[拒绝未支持周期](../advanced-host/bridge.js#L425)、[disable_resolution_rebuild 配置](../advanced-host/bridge.js#L1154)、[行情系列标识限制](../advanced-host/series.js#L16)。
