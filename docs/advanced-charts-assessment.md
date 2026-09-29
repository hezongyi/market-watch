# TradingView Advanced Charts 接入评估

日期：2026-09-29。仅研究与选型，不代表已取得授权、验证安装包或实施集成。

## 用户场景和待核实内容

项目是个人使用的 market-watch，行情采用自身 OANDA / Binance 数据及 NY17 / UTC0 分桶，已有后台预警。拟增加专业图表工作区，包含布局与画线。用户表示可能提供名为 Advanced Charts 的“源码 v31.1.1”。**本轮未取得该包，没有核实其版本、来源、授权或实际功能。** 官方 latest 文档已展示 v31，但不能由此证明该文件就是官方 v31.1.1。

本文将 1/2/4 图、跨图联动、跨周期画线及保存作为重点评估项；具体每一项最终需求仍以用户确认清单为准。

## 能省什么工作

有适用授权且安装包完整的 Advanced Charts，能明显减少 K 线交互、绘图工具、样式编辑、指标 UI 和图表状态序列化的开发量。它不是现成 market-watch 模块：自身数据接入、统一时间语义、数据库存储、工作区列表、跨实例协调和后台提醒仍需实现。

**最大容易误判处是多图：Advanced Charts 与 Trading Platform 不是同一功能包。** 不能根据公共 API 中出现方法名，承诺 Advanced Charts 自带原生 1/2/4 分屏与同步。

## 经官方文档核实的能力边界

| 能力 | 官方证据与判断 |
|---|---|
| 绘图工具栏、样式修改、收藏、绘图 API | Advanced Charts 文档明确支持；具体工具查 Drawings List，不保证未检查安装包含每一种工具。 |
| 绘图样式模板 Drawing Templates | Drawings 页明确写“only available in Trading Platform”。不要与普通画线保存、指标模板混淆。 |
| 原生多图布局、分隔条调整大小 | Trading Platform 的 Multiple-chart layout 文档描述最多 8 图；此数字是文档所述该产品能力，**不是用户 v31.1.1 包已验证能力**。 |
| `layout()` / `setLayout()` / `chartsCount()` | 多图文档在 Trading Platform 下演示 `setLayout('4')`。这些名称出现在共用接口文档，不能单独证明 Advanced Charts 原生多图可用。 |
| `symbolSync()` / `intervalSync()` | 接口说明均明确“Only available in Trading Platform”。 |
| `crosshairSync()` / `timeSync()` / `dateRangeSync()` | 接口说明均明确“Only available in Trading Platform”。 |
| `drawOnAllChartsEnabled()` | 接口说明为同一布局内相同 ticker 复制新画线；该段未独立标产品限制。结合原生多图的产品边界，不能把它当作多个独立 Advanced Charts widget 间自动同步的承诺。 |
| 图表保存与恢复 | 有保存/加载 API，数据库与业务逻辑需自己实现。官方默认将画线存于当前 layout。 |
| 按品种独立保存画线 | `saveload_separate_drawings_storage` 加适配器，或 `getLineToolsState()` / `applyLineToolsState()`；支持复用，但不等于多个页面自动实时同步。 |

来源：

1. [Drawings](https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/)
2. [Trading Platform — Multiple-chart layout](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/multiple-chart-layout/)
3. [IChartingLibraryWidget API](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartingLibraryWidget/)
4. [Featuresets](https://www.tradingview.com/charting-library-docs/latest/customization/Featuresets/)：`header_layouttoggle`、`support_multicharts`、`drawing_templates` 都在 Trading Platform 专属小节。
5. [Save drawings separately](https://www.tradingview.com/charting-library-docs/latest/saving_loading/saving_drawings_separately/)

## 若仅有 Advanced Charts：多图替代方案与剩余难度

可以在应用自己的 CSS Grid 中放多个独立 widget，分别保存状态；这与一个 Trading Platform widget 的原生多图不同。外层负责品种和周期切换、布局恢复、销毁未用实例、行情订阅去重和防止联动循环。

官方 IChartWidgetApi 提供 `onVisibleRangeChanged()` / `setVisibleRange()`，可用于开发自己的可见时间范围联动。`crossHairMoved()` 能读十字光标事件；本轮没有验证到等价可写十字光标 API，**不能仅凭读事件保证可跨独立 widget 完整同步十字光标**。需检查实际包 API 和小型原型后再承诺此体验。

来源：[IChartWidgetApi](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartWidgetApi/)

同品种跨周期共享画线需明确：全周期可见还是按创建周期过滤；同一工作区共享还是全局共享。官方独立存储文档描述 `NotShared`、`SharedInLayout`、`GloballyShared`，适配器必须正确路由；latest 新字段不能假定用户包一定支持。独立 widget 的即时同步、冲突、删除仍要应用验证与协调。

保存 API 有额外实现细节：sources/groups 使用 Map；null 是删除标记；需按 symbol、ownerSource 和 sharingMode 过滤；不要任意改写库内部 drawing state。否则可能重复恢复已删线或将指标副图画线错误放到主图。官方要求把 drawing state 当作黑盒。

## 授权与所谓“源码”

主代理从官方产品页核实 FAQ 原文：

> At this time, we don't provide the Advanced Charts and the Trading Platform libraries for personal use, hobbies, studies, or testing. These licenses are only available to companies for use in public web projects and/or applications.

同页源码 FAQ 表示只有 Lightweight Charts 开源，另外产品不提供源码。因此收到一份 JS、类型定义和静态资源包，不等于开源源码或获得使用权。个别与 TradingView 签订的专门协议可能另有约定，应以适用于此项目的实际许可为准。

来源：[TradingView Free Charting Libraries — FAQ](https://www.tradingview.com/free-charting-libraries/)

上述限制使当前纯个人私有项目不能直接按标准申请条件假定可用。可以先核对授权文件与包内容；仅拿到压缩包不足以做选型承诺。

## 推荐结论

- 若有明确覆盖本项目的有效授权：Advanced Charts 能大幅节省单图与画线体验工作，值得小型原型评估；但需要自行组织多 widget，不能承诺 Trading Platform 的原生布局、同步和模板功能。
- 若合法可用的是 Trading Platform：原生多图、同步与绘图模板进一步节约工作，但仍需数据适配、存储和已有预警集成；先核实具体版本和功能。
- 若无适用授权：继续此前 KLineChart 核心或 Lightweight Charts 加绘图插件的开源路线更稳妥。
- 不能在未看包、未测关键联动前承诺准确工期或节省百分比。原型应聚焦两图、趋势线、刷新恢复、跨周期与 NY DST/休市锚点，确认后再估算。

尚未进行源码包读取、功能运行测试、依赖安装、代码变更或生产部署。
