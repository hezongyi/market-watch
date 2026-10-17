# 浏览器标签与原生自选表：官方能力核对

研究日期：2026-10-17。范围：TradingView 官方公开 Advanced Charts / Trading Platform 文档、本项目现有许可 SDK 类型声明的只读核对。本文不提交许可 SDK，不实现应用功能，也不把 TradingView 网站能力等同于嵌入库能力。

## 一、浏览器标签显示当前品种、价格和涨跌幅

**可以实现；建议由网站宿主管理标签，图表提供当前激活品种与行情。**

- 在本次核对的官方完整 [Featuresets][features] 和本项目现有 SDK 类型声明中，没有查到 `change_title` 或等价的自动管理浏览器标签开关。这个结论限于已核对版本和公开接口，不能扩展为所有历史版本都不存在。
- 官方 `widget.activeChart()` 返回当前激活图表；多图场景用 `activeChartChanged` 事件跟踪激活图，再订阅该图的 `onSymbolChanged()`。官方特别提醒：切换激活图时，原来的图表订阅不会自动迁移，需要自行取消与重新订阅。[Widget API][widget]、[Chart API][chart]、[事件 API][events]
- `onSymbolChanged()` 对应主图品种变化。比较线、指标、鼠标十字线所在的历史 K 线不应改变标签中的品种和最新价格。
- `onTick(tick: Bar)` 是公开的“最后一根 K 线更新”事件，可拿到 `close`，但参数没有品种/图索引，也没有日涨跌基准。多图时不宜直接把最近一次 `onTick` 当作当前激活品种的最新报价。[事件 API][events]
- 报价公开字段直接提供 `lp`（最新成交价）、`ch`（通常相对上一常规交易日收盘价的变化）、`chp`（百分比）、`prev_close_price`；行情接口为 `getQuotes` / `subscribeQuotes` / `unsubscribeQuotes`。[报价字段][quote-values]、[报价接口][quote-api]
- 标签里的涨跌百分比应采用同一供源、同一品种的日涨跌口径，和原生自选表保持一致；不能拿当前 5 分钟/1 小时 K 线的涨跌代替。缺字段时显示缺省状态，不把缺失报价当成 `0.00%`。

建议示例：`SPX 7,659.44 ▼ −1.09% · 守望`。优先保留品种与价格，品牌放在末尾；用网站自己的 favicon。浏览器标题是纯文本，箭头可以表达方向，但不能按字符分别着色。

`document.title` 控制当前文档的浏览器标签标题。[MDN][document-title] 图表在 iframe 内时，修改 iframe 自己的标题不能代替修改最外层网站的标题；跨域嵌入通过现有消息桥传递当前激活品种和行情，由宿主更新标题。`postMessage` 需保留明确的目标 origin，以及接收端的 origin/source 校验。[MDN][postmessage] 本项目的具体 iframe 和报价链路由主方案另附源码证据。

## 二、图 2 的原生自选表

**Trading Platform 有原生 Watchlist，并提供公开读写 API；不能因为一般 Advanced Charts 没有该组件，就断言本项目需要重做列表。** 官方 `widget.watchList()` 明确标注为 Trading Platform 能力。[Widget API][widget] 本项目 SDK 也声明了该接口。

| 能力 | 官方证据与实现边界 |
| --- | --- |
| 多个自选列表、新建/修改/删除/重命名 | 原生 UI 和 `IWatchListApi` 支持；包括 `createList`、`renameList`、`deleteList`、`getAllLists`、`setActiveList`。[Watchlist][watchlist]、[API][watchlist-api] |
| 增删品种与自定义顺序 | `getList` 返回品种数组，`setList` / `updateList` 设置完整数组；可以按目标顺序读写。原生产品介绍还确认 UI 可按名称、价格变化、成交量排序。[API][watchlist-api]、[Trading Platform][platform] |
| 分组 | 列表元素以 `###` 开头即为分组标题；分组可命名、移动、删除。`watchlist_sections` 控制相应 UI，默认开启。[Watchlist][watchlist]、[Featuresets][features] |
| 价格、涨跌额、涨跌幅 | 由 `getQuotes` / `subscribeQuotes` / `unsubscribeQuotes` 供数；复用 `lp` / `ch` / `chp`。[Watchlist][watchlist]、[报价字段][quote-values] |
| 品种 logo | `show_symbol_logos` 加上 `LibrarySymbolInfo.logo_urls`；数据由接入方提供。[Watchlist][watchlist] |
| 持久化 | 默认作为用户设置写入 localStorage；可用 `settings_adapter`，也可订阅列表增删改名事件后自行存储。[Watchlist][watchlist] |

相关公开 featureset：`add_to_watchlist`、`multiple_watchlists`、`watchlist_sections`、`watchlist_import_export`、`watchlist_context_menu`。`watchlist_cross_tab_sync` 是同浏览器跨标签页同步，不等同于账户跨设备同步。[Featuresets][features]

## 三、彩色旗标就是本次要做的品种收藏

用户补充截图并明确：自选表左侧旗标是品种收藏入口，点击后弹出色板，可选红、蓝、绿、黄、紫、青、粉七种颜色。后续方案以这个交互为目标；建立一个名为“收藏”的普通列表不能满足彩色收藏要求。

TradingView 网站有这个原生控件。官方彩旗发布说明明确写到：点击旗标图标选颜色，最近一次颜色作为默认；每个颜色对应动态列表，可在自选表菜单切换；支持通过右键菜单更改单品种或整个列表的旗标颜色。同一品种只归入一个颜色的旗标列表。该说明发表于 2018 年，当时是五色，所述官网订阅限制也属于历史信息，不能据此推导用户截图的七色版本或嵌入 SDK 的许可要求。[官方彩旗发布说明][color-flags-blog] 官方帮助还确认：在筛选器给品种标旗，会自动加入 Watchlist 的 Flagged List。[网站帮助][website-flags]

**截至本次研究，嵌入 SDK 公开支持程度仍须分层判断：**

- 官方 `IWatchListApi` 支持列表及其成员，但未列出读写品种旗标/旗标颜色的方法。[API][watchlist-api]
- 官方 `WatchListSymbolListData` 仅列 `symbols` 与 `title`，没有品种旗标字段；本项目 SDK 声明也相同。[列表数据][watchlist-data]
- `favorites` / `items_favoriting` 指的是常用周期、指标、图表类型和绘图工具，不能作为“品种收藏/红旗”的开关。[Favorites][favorites]、[Featuresets][features]
- 搜到的 `flag` 绘图工具、`FlagmarkLineToolOverrides` 是画在图表上的旗形标注，与自选表行内旗标无关。

**以上公开 API 未暴露字段，并不能单独证明组件没有内置控件。** 是否实际带有色板，还需要检查本项目入口真正加载的版本、组件功能开关和运行结果。当前不能承诺“打开某个已知原生开关即可出现彩旗”，也不能仅凭类型声明断言所有 Trading Platform 版本都没有彩旗。

## 四、针对彩旗的进一步官方资料核对

| 核对层次 | 已确认 | 尚未确认 |
| --- | --- | --- |
| TradingView 官网 | 官方明确提供点旗标选色、按颜色动态列表和改色控件；用户截图要求七色。[官方发布说明][color-flags-blog] | 历史五色说明不能说明目前七色的推出版本、全部细节或嵌入版配置。 |
| 嵌入库公开文档和接口 | Trading Platform 支持原生自选表。官方完整公开文档包、Featuresets、Watchlist 文档和 release notes 已检索。[完整文档包][full-docs]、[Featuresets][features]、[发布说明][release-notes] | 未找到 symbol flag / color flag / flagged symbols 的公开启用项、持久化 API、最低版本或 edition 配置。公开接口缺失不等于运行组件必然不存在。 |
| 当前项目实际打包版本 | 本地 SDK 路径为 `/home/quant/repos/market-watch/advanced-host/charting_library/charting_library.d.ts`，已只读核对公开声明。另已完成实际入口追踪及独立运行，结果见[本地专项分析](native-chart-tab-colored-favorites-20261017.md)。 | 本地组件结果不替代厂商对其他版本、产品配置或私有扩展的支持声明；不凭目录中某个同名旧文件判断。 |

进一步核对范围及限制：

- 官方提供的完整公开文档包约 2.9 MB，此次内容标注为版本 33.0.0。对 `flagged`、`flagging`、`flag symbols`、`symbol flag`、`color flag`、`colour flag`、`flaggedList`、`symbolFlag` 等词检索未命中；最新 release notes 也没有查到彩色品种收藏控件的配置说明。这个结果表示“没有查到公开文档依据”，不表示已穷尽私有客户资料或全部二进制实现。[完整文档包][full-docs]、[发布说明][release-notes]
- 官方 FAQ 明确：嵌入库的部分 UI 与官网不同，二者更新频率也不同；但 FAQ 的 Unsupported features 并未明确点名彩旗。因此 FAQ 不能作为“彩旗不支持”的直接证明。[FAQ][faq]
- FAQ 指向的正式问题库 `tradingview/charting_library` 是受限的私有仓库。本次没有取得其私有 issues / feature requests 内容，不能引用不存在的官方答复。[FAQ][faq]
- 对 TradingView 官方组织的公开 GitHub issues，以及 `charting-library-examples` / `charting-library-tutorial` 的公开问题做了 flag、flagged symbols、watchlist 组合查询，未找到直接确认彩旗控件启用方式的维护者答复。公开的 [issues/98][public-watchlist-issue] 仅确认 Watchlist 属于 Trading Terminal 产品，不能回答彩旗支持与否。

方案约束：保持用户要的七色旗标收藏语义。先确认当前实际加载的原生组件是否包含可支持的色板入口；若需向 TradingView 核实，应提供当前打包版本并直接询问“是否支持 Watchlist symbol color flags，公开启用参数、读写/持久化接口，以及所需产品版本”。不将官网有控件、组件文件含 flag 字符串、公开 API 有该能力这三种证据互相替代。

## 版本与验证范围

- 官方文档使用 `latest`，可能领先于本项目 SDK：例如最新 `createList` 文档有第三个可选 `listId` 参数，本项目现有声明只有两个参数。实施以当前打包版本和实际运行验证为准。
- 本篇官方资料研究未启动服务或执行第三方示例；另有对当前本地 SDK 的独立浏览器运行核对，方法与范围见[专项分析](native-chart-tab-colored-favorites-20261017.md)。未修改正式登录、路由、图表布局或收藏存储。
- 后续最小行为验证应包含：多图切换标题跟随当前激活主图；快速切换品种不串报价；鼠标查看历史不改最新价；自选表增删排序分组持久化；点旗标弹出七色色板、改色/取消、跨普通列表一致显示，以及刷新后的收藏颜色恢复。

## 来源

以下来源均在 2026-10-17 实际访问：

1. [TradingView Featuresets][features]
2. [IChartingLibraryWidget：activeChart / watchList][widget]
3. [IChartWidgetApi：onSymbolChanged / symbol][chart]
4. [SubscribeEventsMap：activeChartChanged / onTick][events]
5. [DatafeedQuoteValues][quote-values]
6. [IDatafeedQuotesApi][quote-api]
7. [Trading Platform：Watchlist 概述][platform]
8. [Watchlist 接入、分组及存储][watchlist]
9. [IWatchListApi][watchlist-api]
10. [WatchListSymbolListData][watchlist-data]
11. [Favorites][favorites]
12. [TradingView 网站帮助：筛选结果和标旗品种加入自选表][website-flags]
13. [MDN Document.title][document-title]
14. [MDN Window.postMessage][postmessage]
15. [TradingView 官网：The evolution of flagged symbols][color-flags-blog]（2018-10-29，历史五色功能说明）
16. [官方 FAQ：网站与嵌入库差异、私有 issues 入口][faq]
17. [官方完整公开文档包][full-docs]
18. [官方 release notes][release-notes]
19. [官方 examples 仓库 issues/98][public-watchlist-issue]（仅确认原生自选表产品归属，不证明彩旗支持）

[features]: https://www.tradingview.com/charting-library-docs/latest/customization/Featuresets/
[widget]: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartingLibraryWidget/
[chart]: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartWidgetApi/
[events]: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.SubscribeEventsMap/
[quote-values]: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.DatafeedQuoteValues/
[quote-api]: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IDatafeedQuotesApi/
[platform]: https://www.tradingview.com/charting-library-docs/latest/trading_terminal/
[watchlist]: https://www.tradingview.com/charting-library-docs/latest/trading_terminal/Watch-List/
[watchlist-api]: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IWatchListApi/
[watchlist-data]: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.WatchListSymbolListData/
[favorites]: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.Favorites/
[website-flags]: https://www.tradingview.com/support/solutions/43000473930-how-to-add-the-screener-search-results-to-the-watchlist/
[document-title]: https://developer.mozilla.org/en-US/docs/Web/API/Document/title
[postmessage]: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
[color-flags-blog]: https://www.tradingview.com/blog/en/flagged-lists-improved-9521/
[faq]: https://www.tradingview.com/charting-library-docs/latest/resources/Frequently-Asked-Questions/
[full-docs]: https://www.tradingview.com/charting-library-docs/charting-library-context.txt
[release-notes]: https://www.tradingview.com/charting-library-docs/latest/releases/release-notes/
[public-watchlist-issue]: https://github.com/tradingview/charting-library-examples/issues/98#issuecomment-486336211
