# 原生图表 UI 复用调查与数据中心方案（2026-10-09）

> 实施更新：本轮已采用同一原生文档内的业务界面和独立 vendor React roots，复用真实弹窗、侧栏、搜索、输入、下拉、复选框及纯品种选择。HTTP、认证和 CSRF 留在可信主应用。跨源业务 iframe 仅作失败兼容路径；下文调研时的“现状／尚未验证”描述保留作为研究记录。最终实现与逐项验收见 [实施验收报告](../verification/native-data-center-20261009/README.md)。

## 调查边界与来源

本笔记核对当前安装的 TradingView Trading Platform **v31.1.0**，版本证据是 [package.json:3](../../advanced-host/charting_library/package.json#L3)。声明文件是厂商随许可库交付的第一方 API 合约；以下 `d.ts` 行号均指 [charting_library.d.ts](../../advanced-host/charting_library/charting_library.d.ts)，不是其他版本的网上示例。本笔记不复制许可实现，不改产品代码，不操作生产或用户行情数据。

**在线限制：本轮没有成功读取官方在线文档正文。** `www.tradingview.com` 的 HTTPS 请求多次超时，`tradingview.com` 请求被重置；官方 GitHub Pages 候选地址和 `tradingview/charting-library-docs` 候选仓库返回 404。这不能证明官方文档或私有仓库不存在。文中官方 URL 来自安装版声明文件的第一方注释，是便于复查的链接；不应表述为本轮已经读取的在线证据。公开/非公开的判断以安装版类型、模块实际导出和本仓库调用方式为准。

本机 ESM 模块只导出 `widget`、`version` 和图表/交易枚举，没有导出 `Dialog`、`Input`、`Select`、`SymbolSearch` 等通用 UI 构造器。声明也只公开 `widget`（108 行）和 `version()`（657 行）等运行入口，不是可随意 import 的 UI 组件库。

## 核心结论

1. **原生图表设置窗口可以通过公开 API 打开，可以配置其中已定义属性和功能；公开 API 没有增加任意业务页面/Tab 或替换窗口内容的入口。** `executeActionById("chartProperties")` 打开的是实际图表设置，不接受 pages/children/renderer 参数（10919、29455 行）。`overrides`、`settings_overrides`、featuresets 改属性值和已定义功能，不是自定义表单 schema（5031、5264 之后、4668/4699 行）。
2. **原生商品搜索可以原封不动使用，并连接自己的数据和筛选。** 可配置搜索回调、分页、交易所、类型、品种信息、图标和选中结果转换。**它没有公开的独立搜索输入/搜索面板组件，可直接嵌进数据中心。** 公开 `symbolSearch` 是打开原生窗口的动作。
3. **原生通知/确认窗口是官方支持的复用点，但只公开标题、字符串正文、回调。** `DialogParams` 没有 HTMLElement、React children、业务导航或自定义按钮定义（6679–6686 行）；不能把调用通知窗口后替换 DOM 表述为官方支持的组件扩展。
4. **本仓库“同步设置”已经复用了真正的 NoticeDialog 外壳，但内容挂载和控件样式涉及内部 DOM 约定。** 它先 `showNoticeDialog`，再查找 `warning-dialog`、哈希 class，替换 content，并加载固定 CSS bundle（[sync-settings.js:65](../../advanced-host/sync-settings.js#L65)）。可说明“原生外壳＋业务表单”，不能说明“全部控件经公开 API 原生复用”。数据中心当前则是浏览器 `<dialog>`＋跨源 iframe（[data-center.js:8](../../advanced-host/data-center.js#L8)）。
5. 用户提出的 **“数据中心沿用设置窗口结构；品种查找沿用原生商品搜索”** 在产品体验上合理。若要求真正用设置共用的弹窗/侧栏和嵌入搜索组件，需 **当前 v31.1.0 内部组件适配**，由运行时验证确定可用边界，不能仅按 CSS/DOM 外观推断行为完整。

## 组件与能力矩阵

“公开调用原生组件”指厂商 API 创建/打开真正的原生界面；“配置”指改变该界面公开的数据或属性；“内部适配”指依赖未公开 Renderer、模块、DOM 或哈希 class，版本升级须单独复核。

| 组件/区域 | 本机公开复用方式 | 可修改程度 | 不能从公开接口得到的能力 | 证据 |
|---|---|---|---|---|
| 顶部按钮 | `createButton`，等待 `headerReady` | 原生样式模式设文本、tooltip、点击；HTML 模式返回 HTMLElement 可自定内容；可移除 | 任意指定插入到某个原生按钮后面不是该类型的参数；原生样式模式返回字符串 id，不是完整组件实例 | d.ts 5828、5942、11905–11933；[Widget API](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartingLibraryWidget/) |
| 顶部下拉菜单 | `createDropdown` → `IDropdownApi` | 标题、SVG、提示、左右对齐、各项标题/图标/回调；`applyOptions`/`remove` | 不是页面中的通用 Select；参数没有任意 React item renderer | d.ts 6939–6960、11983、12832；[Widget API](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartingLibraryWidget/) |
| 图表右键菜单 | `onContextMenu`、`context_menu.items_processor`、`renderer_factory` | 增删重排菜单项；通过 actionsFactory 创建动作；公开提供自定义 renderer factory | 不意味着可修改所有其他弹窗/控件 Renderer | d.ts 5610–5651、11885；[Context menu](https://www.tradingview.com/charting-library-docs/latest/ui_elements/context-menu) |
| 通知弹窗 | `showNoticeDialog` | 自定义标题、正文字符串、结束回调；默认 OK | 任意业务 children、设置式导航、搜索控件、自定义 actions 不在 `DialogParams` | d.ts 6679、11988；[DialogParams](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.DialogParams/) |
| 确认弹窗 | `showConfirmDialog` | 标题、正文、确认/取消结果回调；默认 OK/CANCEL | 任意多步表单或按钮布局不在参数内；Broker Host 的确认 API 是另一套特定交易上下文接口 | d.ts 11994、10510–10528；[Widget API](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartingLibraryWidget/) |
| 图表设置弹窗 | `executeActionById("chartProperties")` | `overrides`/`applyOverrides` 改图表默认/运行属性；`settings_overrides` 覆盖已保存设置；featuresets 控制已定义选项 | 新增“数据中心”任意 tab/page，替换标题/内容与保存逻辑，独立通用设置窗口 constructor | d.ts 10919、12061、29455、5031、5266–5287；[Chart actions](https://www.tradingview.com/charting-library-docs/latest/ui_elements/Chart#execute-action-by-id)、[Overrides](https://www.tradingview.com/charting-library-docs/latest/customization/overrides/Overrides) |
| 商品搜索窗口 | `executeActionById("symbolSearch")`，原生 header/快捷键 | 自己的数据、分页、exchange/type filter、结果文字、描述、logo、选中 ticker/name 转换 | 独立嵌入组件、任意结果行 renderer、下载/导入/删除按钮列、多选、跨页选择、任意平台/状态筛选栏 | d.ts 12715/12728、6397/6443、20199、5264、29455；[Symbol Search](https://www.tradingview.com/charting-library-docs/latest/ui_elements/Symbol-Search) |
| 添加比较窗口 | `executeActionById("compareOrAdd")`，`compare_symbols` | 预设比较品种；搜索源可区分 Compare | 原生比较页不是数据中心通用搜索容器，选中默认行为是添加/比较序列 | d.ts 5169、80–85、29455；[Widget Constructor](https://www.tradingview.com/charting-library-docs/latest/configuration/Widget-Constructor) |
| 指标选择窗口 | `executeActionById("insertIndicator")` | `custom_indicators_getter` 供自定义指标；`studies_access` 控制可选项；favorites | 任意业务指标任务列表/状态列/操作表不能经此 API 插入 | d.ts 4798、5186、29455；[Custom studies](https://www.tradingview.com/charting-library-docs/latest/custom_studies/) |
| 指标设置弹窗 | `showPropertiesDialog(studyId)` | 自定义 study metainfo 定义 inputs/defaults/styles；整数、小数、价格、bool、文本、品种、周期、时间、颜色等自动原生控件；样式 override | 通用业务表单不是该 API 的用途；不可在此声明任意 React UI 或网络任务页面 | d.ts 585–600、11282、19325–19398、26859；[Study inputs](https://www.tradingview.com/charting-library-docs/latest/custom_studies/metainfo/Custom-Studies-Inputs) |
| 画线属性弹窗/工具条 | `showPropertiesDialog(drawingId)`，`drawings_access`、绘图 overrides | 可见工具、图形颜色/线宽/文字等公开属性；模板/收藏 | 独立导出颜色拾取器、线型控件、字体面板或任意属性 tab | d.ts 4690、11282、5887；[Drawing overrides](https://www.tradingview.com/charting-library-docs/latest/customization/overrides/Drawings-Overrides) |
| 周期/图表类型/坐标轴/日期区域 | 图表 API、featuresets、`changeInterval`/`scalesProperties` 等动作 | 支持周期、time_frames、格式、价格精度、单位/货币、原生菜单相关功能 | 独立可嵌入的 Interval/Color/Date picker 不从模块导出 | d.ts 10879、5055、29455；[Resolution](https://www.tradingview.com/charting-library-docs/latest/ui_elements/Resolution)、[Price scale](https://www.tradingview.com/charting-library-docs/latest/ui_elements/Price-Scale) |
| 图层树/数据窗口 | `paneObjectTree`；Trading Platform `widgetbar.datawindow` | 展示图表绘图、study/series 和当前数据；按既定 feature 控制 | 任意数据中心导航树/表格 schema 挂进去没有公开接口 | d.ts 29455、29274；[Trading Platform](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/) |
| 图表保存/加载窗口 | `showLoadChartDialog`、`showSaveAsChartDialog`、`save_load_adapter` | 自定义存储和 layouts/templates 列表、保存/加载行为 | 与 datasets 不同领域；不能重标为行情删除/导入窗口而保留公开支持 | d.ts 11998/12002、5117、12968；[Save/load handlers](https://www.tradingview.com/charting-library-docs/latest/saving_loading/save-load-adapter) |
| Watchlist | Trading Platform `widgetbar.watchlist`、`watchList()` | 多列表、内容、标题、分组、readonly、增删列表、事件；自己的 quotes | 不是任意 CRUD 表；原生 API 没有任意按钮列/每行回收、引用预览 UI | d.ts 12088、14700、29207、29264；[Watchlist](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/Watch-List) |
| Details/商品资料 | Trading Platform `widgetbar.details`；`showSymbolInfoDialog` | quotes 字段、short_name/description/exchange、价格数据；Security Info 可加 `additional_symbol_info_fields` | 切勿混淆 Details quote card 与 Security Info 弹窗；不提供任意完整业务 page | d.ts 6463、6488–6527、5198、29262；[Details](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/#details) |
| News | Trading Platform `widgetbar.news`、`news_provider`、`news()` | 自己的新闻列表、标题、link/fullDescription、源 | 原生新闻不是下载任务页；没公开任意 React widgetbar 新 panel 插槽 | d.ts 12094、28011–28038、29272；[News](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/news) |
| Order Ticket/交易确认 | Trading Platform Broker API | 订单能力 flags；`customFields` 支持 Checkbox/TextWithCheckBox/ComboBox/Text；订单/持仓样式与动作 | 字段扩展只在交易 ticket 中，不是通用设置表单组件库；不可当数据中心表单捷径 | d.ts 27900–27922、30301；[Order ticket custom fields](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/order-ticket#add-custom-fields) |
| Account Manager | Trading Platform Broker API `accountManagerInfo()` | **公开可加 custom pages/tabs**，每页一个或多个 tables；自定义 columns、getData、change/delete delegate、HTML 单元格 formatter、context actions | 这是交易账户面板的公开扩展能力，**不是图表设置 tabs**；不适合为数据中心假装 Broker 或改变订单语义 | d.ts 816–964、10172；[Account Manager custom pages](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/account-manager/#custom-pages) |
| 一般输入框/Select/Checkbox/Tab/滚动/颜色控件 | 在原生窗口内部存在；部分可由 study metainfo/trading custom fields 自动生成 | 在上述具体领域配置得到对应控件；CSS 能改变显示样式 | 没有对业务页面公开 export 的基础 UI 工厂；克隆 DOM/class 只得到外观，交互须自行实现 | d.ts 模块运行导出、585、30301；本机 ESM 实际导出表 |

## 商品搜索：公开支持到什么程度

### 可直接落地的范围

- Datafeed `searchSymbols(userInput, exchange, symbolType, onResult, searchSource?)` 负责数据，不需要复制原生搜索框。`searchSource` 区分 SymbolSearch、Watchlist、Compare、IndicatorInputs（80–85、12715 行）。
- 当前安装版支持可选 `searchSymbolsPaginated(options, onResult)`；存在时库优先使用它。`start` 是已返回结果数，不是 page number；回调是 `(items, symbolsRemaining)`，没有更多结果时设 0（12717–12728、27428–27449、30161–30162 行）。这不是数据中心任意分页表格 API。
- `onReady` 的 `exchanges` 和 `symbols_types` 定义原生筛选内容：空数组隐藏该筛选，`value=""` 表示全部（6386–6443 行）。可以把平台来源映射为现有筛选的候选值，但应在数据语义上明确，它不能凭空增加一整套来源/归档/任务状态筛选控件。
- Result item 公开 symbol/description/exchange/ticker/type 和 logo_urls/exchange_logo（20199–20264 行）。唯一 ticker 必须保留真实身份；展示名可格式化，不能为了显示 `EUR/USD` 而让不同源身份混用。
- `symbol_search_request_delay` 可调请求间隔（4814 行）；`header_symbol_search`、`symbol_search_hot_key`、`allow_arbitrary_symbol_search_input` 控制已定义行为（29557–29573 行）；可选择 logo 功能开关。
- `symbol_search_complete` 可在选择后异步返回 `{symbol,name}`（5244–5264、27415–27425、30235 行）。官方注释明确 **加入 watchlist 时不调用该 override**。

### 重要限制

`symbol_search_complete` 的返回类型没有 `cancel`、`handled`、`preventDefault`，也没有“仅填数据中心表单、不切换图表”的显式模式。不能把一个永不 resolve 的 Promise 当正式取消机制；拒绝/异常是否有合适 UI 必须实测。标准搜索选中流程属于原生图表/比较/指标品种输入领域。

若产品希望“查到品种先进入下载/维护/创建表单，最后点击打开图表”，公开商品搜索不能仅靠回调声明就保证该流程。可选路线是：保留原生搜索为**切换图表**；数据中心仅做管理；或使用隔离的内部 Search Renderer 适配获得 picker 行为，先验证选择/cancel/来源筛选/键盘/空结果/分页生命周期。

## 数据中心窗口：两种复用路线

### A. 公开 API 为主

真正的原生商品搜索承担快速找品种/切换图表；数据中心管理页面依照原生设置窗口的尺寸、字体、左侧导航、控件规格设计。通知与简单危险操作确认采用公开原生 Notice/Confirm。

优点：升级耦合最少。边界：数据中心业务表单和容器依然由应用实现，不能宣称是“把原生图表设置改成数据中心”。如果仍通过 `showNoticeDialog` 后替换 content，则已跨入内部 DOM 适配，应如实记录。

### B. 原生组件内部适配（更贴近用户当前目标）

独立数据中心窗口使用当前安装版设置/通用 popup Renderer 的壳与导航能力，业务页由自己的 renderer 挂载；搜索优先保留原生完整搜索窗口，确有内嵌要求时再适配内部 Search 组件。**不得打开真实图表设置后覆盖其内容/复用其保存事务**，避免隐含改动图表属性和原生设置状态。

把厂商内部模块访问封装为单一版本适配层，对外只公开 app 自己的 `openDataCenter`、`pickSymbol`、`confirmAction`、`dispose` 等接口。版本/manifest 哈希不符或 renderer 校验失败时明确退回可用业务窗口，不能静默留下半个原生弹窗。业务 API、权限、删除保护、幂等 token、任务状态不进入厂商内部对象。

本地源码可发现 Renderer/模块只证明有潜在接缝；实际复用需验证其构造依赖、provider/context、异步 chunk、widget owner、theme、focus/keyboard、drag/resize、取消与销毁。运行时 POC 的结论应作为单独验证证据引用；下文附本轮实际运行验证；未经运行的扩展仍不视为已完成实现。

先验证 **popup/设置侧栏＋两页独立内容**，以及 **商品搜索原生选中后仅返回品种**；本轮这两项最小验证已通过，完整业务整合还需后续验收。不建议一开始将所有 Input/Select/Checkbox/Color 等内部控件逐个抽取，因为 dependency/context 与升级成本更广。

## 外观和持久化的公开能力

- `theme`、`changeTheme`、`getTheme` 管理 light/dark（5155 之后、12191/12202 行）。自定义主题 `custom_themes` 与 `customThemes().applyCustomThemes/resetCustomThemes` 支持 light/dark 的七组颜色梯度及 white/black（6282–6319、5302、12420、12654）。每组梯度有 19 个位置（29858–29878）。这是颜色扩展，不是结构/布局 API。
- `custom_css_url` 在图表 iframe 加载自定义样式；`custom_font_family` 针对图表 pane/价格时间坐标，其他 widget 字体需 CSS（5066–5086 行）。`setCSSCustomProperty/getCSSCustomPropertyValue` 是公开接口（12402/12414）。使用它们共享 token 可行；覆盖私有哈希 class 的稳定性仍须自担。
- `custom_translate_function` 接收原文/单数原文/译文，返回文本或 null（5241 行）；可改文案，不能因此新增窗口能力。
- `enabled_features/disabled_features` 控制厂商已声明功能；不接受任意业务 component 名称（4668/4699、29466 之后）。
- `settings_adapter` 支持自己的初始设置及 set/remove 存储，`save_load_adapter` 支持 layouts/templates/drawings（5150、5117）；这是保持主题/偏好的一部分。不要把来自 saved layout 的颜色 override 与当前主题混为单一优先级，参考厂商注释链接 [Customization precedence](https://www.tradingview.com/charting-library-docs/latest/customization/customization-precedence)。

## 版本与判断置信度

| 判断 | 依据/置信度 |
|---|---|
| 当前许可库 TT v31.1.0 | 第一方安装包描述与本轮 runtime `version()` 一致，已核对 |
| 当前版 public `searchSymbolsPaginated` 可用 | 本机 d.ts 明确声明，高；该方法的历史首次发布版本本轮无法在线核实，不猜测 |
| Advanced Charts 与 Trading Platform 能力不同 | d.ts 对 `watchList()/news()` 明确 Trading Platform only，TT options 继承 ChartingLibraryWidgetOptions 并增加 widgetbar/Broker 等，高；不能把 TT 组件说明成所有 Advanced Charts 均有 |
| 公开 API 没有 arbitrary chart-settings tabs/embedded SymbolSearch UI | 完整本机声明与实际 ESM exports 检索，高；没有扩展参数，不代表通过非公开实现绝对不可做 |
| 原生内部设置 Renderer/Search 适配可用范围 | 必须由当前版本 runtime POC 核实；静态发现不提供升级兼容保证 |
| 官方 latest 文档和新版本能力 | 本轮正文不可访问，未核实；不要用本机 v31.1.0 合约推断 latest 变化 |

本轮结果是调研记录与方案边界，没有部署变更或对现有验收数据的修改。

## 本轮实际运行验证

在 Ubuntu 本机既有隔离验收图表服务上加载真实许可库，Playwright 只拦截一个研究页面，用合成 `TEST` 行情创建临时 widget。没有登录管理后端，没有写用户工作区、偏好或行情，没有构建新镜像。基线 `34bc606`。运行版本为 `TT v31.1.0 (internal id 6b804c486857f27920cf761aa7eb6e29d9bb6362 @ 2026-04-08T18:21:25.992Z)`。

| 验证 | 实际结果 | 能说明的范围 |
|---|---|---|
| 打开图表设置、商品搜索、指标选择 | 三者实际使用相同的 `wrapper-b8SxMnzX` 通用外壳；1440×1000 下尺寸分别 610×564、840×680、390×600 | 外壳共享、业务内容不同；尺寸不是统一常量 |
| 通知与确认 | 使用另一套简单弹窗外壳 `wrap-B02UUUN3`，均为 480×202 | 简单确认可用公开 API；外观不能类推任意扩展 |
| 独立组合 `AdaptivePopupDialog`＋`DialogSidebarWrapper/Item`＋`DialogSearch` | 两页导航切换、输入“微软”并更新独立状态、标题拖动、原生关闭按钮通过；原图表商品保持不变 | 原生基础组件可独立组合，已实际挂载，非 DOM 克隆 |
| 独立原生品种选择 `showSymbolSearchItemsDialog` | 选 `TEST:GBPUSD` 得到回调且关闭窗口，图表仍为 `TEST:EURUSD` | 可以做“只选品种”的原生弹窗；本轮用合成 datafeed，未接数据中心后台 |
| 暗/亮主题 | 独立外壳打开时调用临时 widget 的 `changeTheme`，实测壳背景从 `rgb(31,31,31)` 变为 `rgb(255,255,255)` | 主题共享路径通过；不代表所有表格/表单和窄屏已验收 |
| 浏览器错误 | 最终运行 `errors=[]`，总结果 `passed=true` | 仅覆盖此研究场景 |

证据：[运行报告](../verification/native-ui-research-20261009/runtime-dialogs.json)、[独立原生组件暗色截图](../verification/native-ui-research-20261009/shared-shell.png)、[亮色截图](../verification/native-ui-research-20261009/shared-shell-light.png)、[仅返回品种的选择窗口](../verification/native-ui-research-20261009/pure-picker.png)。这些是组件接缝验证，**不是最终数据中心 UI，也不是重构已上线**。

运行时发现的内部复用点如下。编号只对本轮实际加载的构建有效，不能作为厂商稳定 API。目录内存在其他构建残留 bundle，因此不能靠扫描任意同名文件决定编号。

| 内部复用点 | 本轮模块编号 | 验证深度 |
|---|---|---|
| `PopupDialog` / `AdaptivePopupDialog` | 68243 / 450259 | 后者独立挂载，前者为其底层 |
| `SimpleDialog` | 637679 | 导出及原生通知/确认运行已确认 |
| `DialogSidebarItem` / `DialogSidebarWrapper` | 649867 | 独立挂载、点击切换 |
| `DialogSearch` | 357723 | 独立挂载、受控输入；真实商品搜索与指标选择都引用它 |
| `InputControl` / `Checkbox` | 909536 / 343577 | 导出存在，未逐个独立验证 |
| `Select` / `SelectPopover` | 221339 / 327995 | 导出存在，未独立验证 overlay/context |
| `ColorSelect` / `FontSizeSelect` / `LineWidthSelect` / `LineStyleSelect` | 693129 / 4542 / 632819 / 862584 等 | 导出存在；数据中心本次无需全部引入 |
| `SymbolSearchDialogContentItem` / search body context | 620748 / 48591 | 导出存在；结果行依赖搜索上下文，未验证任意业务表格用途 |
| 商品搜索入口 / 低层选择入口 | 21021 / 457185 | 低层入口“只返回选择”通过；完整搜索结果的自定义数据源未验证 |
| 图表设置业务 Renderer | 509021 | 已确认取消执行 `model.undoToCheckpoint`，不用于数据中心 |

内部控制器还包含 `customSearchSymbols`、`searchInput`、`contentItem`、`footer`、`onSearchComplete` 等注入点，但它们的函数签名和生命周期没有公开合约。不能只发现参数名就承诺任意结果渲染、内嵌整套搜索和升级兼容。导出扫描只取有限候选，不是整库全部组件的穷举。

本轮实际加载的入口是 `runtime.d6871abde1090b0329fe.js`、`library.e2f8b3a016c9e1a0b7a5.js`、`symbol-search-dialog.86ad5d2523fa1a9364fb.js`、`general-chart-properties-dialog.311239ad3d978a22c448.js`。内部参数与取消事务的静态依据分别是上述本地商品搜索和设置 bundle；组件组合与行为依据是归档研究脚本及运行报告，不引用其他残留构建的编号。

复现需现有许可库与 Chromium 环境，研究脚本仅加载库与合成数据，不需要管理员密码：

```sh
MW_DATA_CENTER_CHART_ORIGIN=https://192.168.7.232:19944 \
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
node docs/verification/native-ui-research-20261009/probe.cjs
```

输出到忽略的 `artifacts/native-ui-research/`。模块编号失配时应失败并重新核对版本，不能自动改猜测编号。证据不含许可源码、登录状态、Cookie、密钥或真实用户数据。

## 推荐方案：原生通用弹窗＋设置侧栏＋原生搜索输入

采纳用户提出的窗口与搜索方向，具体落到 **设置和搜索共用的通用组件**。数据中心是独立管理窗口，保留自己的导航、查询、表单草稿、后台任务和图格命令控制器。图表设置仍管理图表属性，商品搜索仍承担快速切换商品。

### 窗口结构与修改范围

| 数据中心区域 | 实施方式 | 修改到什么程度 |
|---|---|---|
| 外壳、标题栏、关闭、拖动、弹层与焦点机制 | 实际 `AdaptivePopupDialog` / `PopupDialog` | 自定义标题“图标＋数据中心”、业务内容、宽高和关闭策略；保留原生底层机制，逐项验收 |
| 左侧五个分区 | 实际 `DialogSidebarWrapper/Item` | “自建行情、平台品种、组合行情、任务与记录、来源与能力”；图标、选中态、点击逻辑由自己的状态提供 |
| 顶部查询 | 实际 `DialogSearch` | 搜索图标、输入和原生间距；传入中文 placeholder/value/onChange。输入只筛选当前管理列表 |
| 平台、商品类型、状态等筛选 | 简单项优先内部 `Select`，复杂项保留业务控件并统一 token | 数据与语义由后台提供；不伪装成图表设置的属性页，也不把行情类别塞进股票/外汇类型 |
| 列表和详情 | 应用自己的业务渲染 | 名称、来源、周期、覆盖范围、状态、导入/维护/删除/打开图表；原生搜索列表没有通用 CRUD 表能力 |
| 创建/组合表单中的“选择品种” | 低层原生品种选择弹窗 | 返回身份填入草稿，避免自动切换图表；真实来源、分页和取消需整合验证 |
| 删除确认、简单消息 | 公开 `showConfirmDialog` / `showNoticeDialog` | 字符串内容与确认结果；复杂未保存提醒保留独立草稿保护流程 |
| 表单按钮与校验 | 应用控制器管理，简单原生控件逐步适配 | 保存、放弃、提交等行为只操作业务草稿；不借用图表设置确认/取消/模板事务 |

桌面建议先按 **1120×720**、左侧约 **200 px** 设计，最大尺寸受视口约束；不是强行套用 610 px 宽的设置窗口。头部仅保留一个图标＋标题和原生关闭控件。长列表在内容区滚动，分区、查询和当前表单操作保持可见。窄屏沿用原生 adaptive 机制并验证导航折叠与表格横滚，不额外叠一套大边框、标题和关闭按钮。

### 搜索职责与重复入口收口

数据中心的查询是 `query → 当前列表`；选列表行、浏览详情或输入文字不应更改图表。只有明确点击“打开图表”才发出图格命令，主机确认接受后立刻关闭窗口，后台加载状态在图表侧显示。保留现有 `19d8b2b` 的单行反馈、旧请求失效、目标图格与工作区校验。

汉堡菜单右侧的原生商品搜索继续负责快速找商品并切换图表。先补齐它的数据接入，再移除单独“行情搜索”：当前 [bridge.js:431](../../advanced-host/bridge.js#L431) 的 `onReady` 未供 exchanges/types；[searchSymbols:442](../../advanced-host/bridge.js#L442) 只查当前行情类别，忽略商品类型参数，也没有实现原生分页。单独入口位于 [series-picker.js:4](../../advanced-host/series-picker.js#L4)。后台桥接已有搜索与分页端点：[AdvancedWorkspace.tsx:825](../../web/src/advanced/AdvancedWorkspace.tsx#L825)。

收口应覆盖平台、自建、组合三类的检索，明确显示来源/类别并保持唯一 ticker；支持名称/代码、类型过滤、来源过滤和真正的分页。`EUR/USD`、`BTC/USDT` 等展示格式继续使用现有统一显示规则，后台身份不改变；股票保留 `MSFT`、`AAPL`，不强行生成不存在的交易对。原生 public exchange 筛选与平台来源的语义需明确，原交易所字段与 provider provenance 不能混成一个身份。

低层“只返回品种”弹窗用于组合配方等选择场景；管理页面的过滤栏只用 `DialogSearch`，不搬整套商品搜索窗口。完整内嵌结果列表可作为后续选择控件能力，不作为所有管理页面改造的前置条件。

### 当前跨源 iframe 的处理

现状是 [data-center.js:8](../../advanced-host/data-center.js#L8) 自建浏览器 `<dialog>`，里面嵌应用 origin 的 iframe；[Window.tsx:163](../../web/src/market-data/Window.tsx#L163) 又渲染标题、关闭、导航、内容和底栏。两层窗口、不同文档的 CSS 与主题、滚动和焦点需要人工协调，是它不容易自然跟随原生窗口的结构原因。

建议首阶段在图表库文档内渲染**真正的原生外壳＋导航＋查询**；应用 iframe 调整为纯业务内容，删除其重复标题、关闭、导航和外层窗口间距。查询、分区与关闭请求通过已有 session/origin 校验的 `postMessage` 桥接。HTTP 请求、权限和 Cookie 仍在应用 origin 处理，业务详情/表格/表单继续复用 `Center` 等既有实现。iframe 的主题 token 由主机同步；这一步要如实称为“原生容器与查询＋业务内容”，不是全部表单控件原生化。

必须实测父文档与 iframe 间的 Tab/Shift+Tab、Esc、焦点恢复，选择器弹层层级及 dirty guard。iframe 不是不可用，而是它的内部 React/CSS 不会自动继承父文档的 native context。这些行为未通过前不交付。

如果后续目标升级为**全部表单控件也直接使用内部原生组件**，再把业务 UI 挂到同一原生文档，用经过验证的库内 React/root/context；数据仍经应用桥接。不能把应用自身 React hooks 树直接塞给另一个 React runtime，也不能仅复制哈希 class 宣称复用了控件。此路径改造面更大，本次推荐先实现用户明确要求的弹窗与搜索。

### 版本适配与模块接口

所有私有导出、异步 chunk、React/root/context、主题与弹层处理集中在一个 `NativeUiAdapter`。业务页面不接触 module id、webpack registry 或 vendor model。接口集中表达 `openDataCenter`、`pickSymbol`、`confirmAction`、`dispose`；选择返回品种身份，打开图表仍走原来的主机命令。

以本轮 `version()` internal id 和实际资源 manifest 固定适配版本。完整实现要在冷启动时显式加载所需 JS/CSS chunk；本轮研究先打开原生窗口再探查，**尚未验证不预打开设置/搜索时的独立冷加载**，不能把“先偷偷打开原生窗口再隐藏”作为正式初始化方案。

版本校验或组件加载失败时清理未完成的弹层/监听，降级到可用的原业务管理窗口并记录原因，避免半个弹窗挡住图表。库升级单独跑适配验证；不修改许可 bundle，不把许可源码复制进仓库，不以全局 CSS 修补所有原生弹窗。

## 实施顺序、验收门槛与剩余不确定项

| 阶段 | 具体交付 | 通过条件 |
|---|---|---|
| 已完成：组件与接口调查 | 公开/内部能力矩阵、独立弹窗/侧栏/搜索输入、只返回品种验证 | 本报告与 runtime 证据 |
| 1：版本适配与纯内容容器 | 冷加载 adapter、原生壳/五分区/搜索＋content-only iframe | 不预打开其他原生窗口也可启动；无重复头部；跨 iframe 键盘、焦点、主题、弹层通过 |
| 2：真实管理业务整合 | 来源/类型/分页、各分区、创建/组合表单、只选品种 | Yahoo/Binance 有真实可查品种；改筛选不加载图表；迟到查询不能覆盖新结果；错误/空状态可区分并重试 |
| 3：统一原生主搜索 | 全类别与分页接入，删除重复“行情搜索”入口 | 原生搜索能检索并打开平台、自建、组合；比较/指标输入/watchlist 的搜索上下文分别回归 |
| 4：Ubuntu 验收交付 | 原生交互回归、管理行为回归、截图与实际部署说明 | 全部关键行为通过后才更新验收实例；构建遵循 `mw-docker`，保持任务进行中 |

验收至少覆盖：暗/亮及刷新主题；常用与窄屏尺寸、浏览器缩放；拖动/居中/长列表滚动；Tab/Shift+Tab/Esc/Enter/中文输入法/关闭后回焦；无焦点泄漏到图表快捷键；未保存修改的关闭与切页保护；重复开关的监听/请求销毁；后台任务关闭后继续；仅目标行的打开反馈与立即关闭；目标图格/工作区切换时旧命令无效；删除引用保护和原有后端权限；原生设置的确定/取消/重置、主搜索、比较、指标输入与 watchlist 不受影响。

目前主要不确定项是**冷 chunk 加载、跨 iframe 焦点和菜单、真实后台的分页/类型筛选、低层 picker 的真实数据源及取消**，不是基础组件是否存在。研究中原生独立组合和纯选择路径已通过；完整业务页、响应式和兼容性还需上述阶段验收。

本轮没有发布新 UI。建议按上述阶段实施；当前验收网址、密码和部署保持既有版本，研究页面由浏览器临时路由生成，不是新增可访问的数据中心实例。


## 2026-10-09 平台行情布局实施更新

用户确认平台分区按商品代码搜索布局呈现，并取消底部分页。专项探针验证 `SymbolSearchItemsDialog` 可以作为数据中心内嵌内容，提供实际原生搜索输入、圆角类别标签、表头来源筛选、来源选择界面、结果行和触底观察器；`contentItem` 的 actions 插槽承载打开图表与详情。因此，本分区采用整套原生搜索内容；此前“管理页面只用 DialogSearch”的建议仍适用于其他管理分区，平台行情作为已验证的实现扩展。

复用边界保持：平台独立的类别设置键与来源状态，不写入主商品搜索筛选；后台身份、数据读取、认证与图格应用由已有业务控制器处理。列表每批 50 条连续加载，保留每行来源、唯一 ticker、详情中的维护入口和管理返回位置；不复用图表设置保存事务。版本失配仍由兼容窗口接管。没有复制或修改许可源码。

部署后的 Ubuntu 隔离 Docker 已通过 8 套件 46 组检查和 4 组补充检查，暗亮主题、窄屏、真实 200% 缩放、主商品搜索/比较/自选表/指标联动和平台维护入口通过。实施证据、复验命令、运行地址与启停方式见 [平台行情验收记录](../verification/platform-market-search-20261009/README.md)。


## 2026-10-09 自建与组合管理布局实施更新

用户要求自建行情、组合行情沿用平台行情的界面思路。两页采用可见标题、整行原生 DialogSearch、圆角业务标签、表头筛选和连续管理列表；实际原生 Select 复用到来源、类别、日界。状态、维护、删除及组合建立的业务语义继续由管理组件负责，未使用平台行情的整套商品搜索 renderer。历史／接续事实折叠展示，完整详情及保护流程保留，页码替换为每批 25 条触底读取与失败重试。部署后 10 套件 68 组检查通过，详见 [两页验收记录](../verification/management-market-search-20261009/README.md)。

补充业务与控件规则：自建列表和组合候选共用“已保存历史维护配置”的 SQL 范围，在总数统计和分页前排除仅注册的目录／映射身份；准备中、暂停与错误配置仍保留，归档通过自建归档标签访问。平台表头来源控件也改为 `Select`，与自建表头相同；通过原生 SearchContext 保留隔离来源状态、在原生表头单元格 portal 渲染，保留商品代码搜索、类别标签与原生结果。45 项后端单元、5 项隔离 PostgreSQL、真实注册／配置计数与逐页 API 核对均通过。
