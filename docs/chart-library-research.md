# 专业图表工作区：开源组件调研

调研日期：2026-09-29。范围是个人使用的图表、布局和画线选型；未修改产品代码、安装依赖或部署。

## 初步判断

有限范围的专业图表工作区可行，主要难度在画线的编辑与持久化、切周期/历史分页后的坐标准确性、多图联动和交互打磨。不是只放一个 K 线组件，也无需实现整个 TradingView。

建议比较两个小型原型后定选型：

1. 继续现有 Lightweight Charts 5.2.1，接社区 v5 画线插件，保留现有数据接入与组件经验。
2. 新图表模块使用 KLineChart 核心，复用内置画线与指标，借鉴 Pro 的工具栏。对大量常见画线需求，此路应优先验证。

上述为工程判断，不是经过本项目运行验证的结论。固定 1/2/4 图布局可以使用 CSS Grid；需要拖动停靠与标签组时再引入布局库。

## KLineChart 核心

- 官方仓库 README 声明 TypeScript、Canvas、无第三方运行依赖、移动端支持、内置指标和画线模型，许可证 Apache-2.0。[README](https://github.com/klinecharts/KLineChart/blob/main/README.md)
- 内置 overlay 源码包括水平线、射线、线段、平行线、价格通道、斐波那契线、简易注释和画笔等；不应把所有 TradingView 画线工具视为已支持。[源码目录](https://github.com/klinecharts/KLineChart/tree/main/src/extension/overlay)
- 官方提供 React `useEffect` 中 `init`、卸载时 `dispose` 的集成示例；这是可在 React 集成的命令式库，不是整套 React 工作台。[示例](https://github.com/klinecharts/KLineChart/blob/main/docs/@views/quick-start/create-chart/react.md)
- `getOverlays` 可取得绘图；`createOverlay` 支持 timestamp、value、样式、id、groupId、paneId、锁定和事件。可构建自己的 JSON 数据模型并恢复；不要直接序列化带回调函数的运行时对象。[读取 API](https://github.com/klinecharts/KLineChart/blob/main/docs/@views/api/references/instance/getOverlays.md)、[创建 API](https://github.com/klinecharts/KLineChart/blob/main/docs/@views/api/references/instance/createOverlay.md)
- pane 是同图指标副图，不能等同于多个独立品种图的工作区。多图布局、联动、工作区名称、自动保存、冲突处理仍需应用实现。
- GitHub API 本次观测约 4,176 stars，未归档，pushed_at 为 2026-09-18；最新正式 release 为 **v10.0.3，2026-08-27**。不是把 v10 当预发布。版本变化仍需锁定与验证。[仓库 API](https://api.github.com/repos/klinecharts/KLineChart)、[最新版本 API](https://api.github.com/repos/klinecharts/KLineChart/releases/latest)
- 本次 main commit：`044773a57fbbb8fa70f8bb00661a87f9089b5d29`。以上源码链接随 main 变化，落地时应固定版本复核。

## KLineChart Pro

- 官方开源、Apache-2.0；名字 Pro 不代表这里是闭源收费产品。[README](https://github.com/klinecharts/pro/blob/main/README.md)
- 提供完整图表外壳，包括绘图工具栏、品种、周期、主题、时区、主副图指标和 datafeed 配置。[API](https://github.com/klinecharts/pro/blob/main/docs/en-US/api.md)
- 默认示例是 Polygon datafeed，**不会自动接本项目 OANDA/Binance 或继承 NY17 分桶**，必须实现自己的数据适配。[开始使用](https://github.com/klinecharts/pro/blob/main/docs/en-US/getting-started.md)
- 实现使用 Solid；可通过 DOM 容器构造实例，不能称作原生 React 组件包。[package.json](https://github.com/klinecharts/pro/blob/main/package.json)
- 已查公开 API 只列 theme/styles/locale/timezone/symbol/period 等，未找到开箱即用的完整工作区/画线保存接口。不能直接承诺“接上 Pro 就能自动保存”；需核对底层实例访问、扩展方式或维护小型 fork。
- 本次 API 约 341 stars，未归档，pushed_at 为 2026-07-26，但 **最新 release v0.1.1 发布于 2023-03-23**，源码版本也是 0.1.1。最近 push 不等于最近稳定发布。peer `klinecharts >=9.0.0` 不能替代与 v10 的实际兼容测试。[仓库 API](https://api.github.com/repos/klinecharts/pro)、[版本 API](https://api.github.com/repos/klinecharts/pro/releases/latest)、[依赖定义](https://github.com/klinecharts/pro/blob/main/package.json)
- 本次 main commit：`4234b79f0bcfc26734d0a721c38cbd6d23aa38f5`。

因此更适合作为候选加速器和实现参考，不宜未经原型测试就当作成熟完整工作台。

## Lightweight Charts 社区画线插件

以下由主代理核对官方项目源码并汇总：

- 旧 `difurious/lightweight-charts-line-tools` 已标记弃用并指向新 v5 插件。[旧仓库](https://github.com/difurious/lightweight-charts-line-tools)
- 新 `lightweight-charts-line-tools-core` README 提供 21 种工具的插件体系，含线、斐波那契、通道、矩形、文字、多空仓位示意等，并提供 `exportLineTools` / `importLineTools` 和编辑事件。[README](https://github.com/difurious/lightweight-charts-line-tools-core)
- 当前 package 1.1.2，peer Lightweight Charts `^5.2.0`，与本项目锁定 5.2.1 版本范围相符；许可证 MPL-2.0，应保留相应许可并复核修改/分发义务。[package](https://github.com/difurious/lightweight-charts-line-tools-core/blob/main/package.json)、[许可](https://github.com/difurious/lightweight-charts-line-tools-core/blob/main/LICENSE)
- 本次约 87 stars、pushed_at 2026-07-16。README 提及迁移采用 vibe coding/人工测试，package test 为占位退出失败。不是据此判定不能用，而是不能把它与成熟官方内置功能等同。
- README 时间插值涉及周末/10 根 bar 推断，不能假定准确覆盖 OANDA 的 DST、维护窗口、交易休市和缺失数据；需重点验证未来延长线、切周期、历史加载后锚点不漂移。

## 布局组件

- [FlexLayout](https://github.com/caplin/FlexLayout)：MIT，React 布局组件，支持停靠、多标签、调整大小、`Model.fromJson/toJson`；主代理核对当前 package 0.11.1、peer React 18/19。保存的是布局树，画线和图表业务状态仍由本应用保存。
- [React Grid Layout](https://github.com/react-grid-layout/react-grid-layout)：可拖动、调整大小和响应式网格；更偏仪表盘布局。
- 固定 1/2/4 分屏不必引入复杂库。两类布局不是同一需求，先确认用户所需。

## TradingView 产品的区别

- [Lightweight Charts 官方](https://github.com/tradingview/lightweight-charts) 是开源基础图表库；不等于 TradingView 网站完整产品，画线工具栏、工作区保存等需扩展。落地应遵守该库 LICENSE/NOTICE 的署名要求。
- [Advanced Charts 官方文档](https://www.tradingview.com/charting-library-docs/latest/getting_started/) 和[产品页](https://www.tradingview.com/free-charting-libraries/) 是另一个授权产品，不能把免费申请等同于 Apache 开源，也不能将官网会员订阅视为嵌入授权。
- 本轮官方产品页网络读取受限、文档请求曾失败；**私人个人项目是否符合当下 Advanced Charts 申请条件尚待官方条款复核**。因此本项目选型不依赖获得它的授权。不能使用第三方泄露包代替正式授权。
- 嵌入官方 widget 与接入自己的图表引擎不同；用户要求自己的行情和 NY17 分桶，须优先选择接受本项目 OHLC 的组件。

## 原型验证重点与难度

建议仅用开发数据验证：画水平线/趋势线/矩形，刷新恢复；切 M5/H4/D1、向左加载历史、NY DST、周末及黄金日休后锚点保持；双图尺寸变化和联动；缺失行情仍明确显示；未收盘 K 线展示不改变已收盘触发策略。

- 单图 + 基础工具 + 保存：中等。
- 固定 2/4 图 + 品种/周期分组 + 基础联动：中等，需明确定义联动规则。
- 自由停靠 + 撤销重做 + 跨周期共享画线 + 多窗口同步：中高。
- 趋势线/区域直接创建后台提醒：增加策略语义、版本和一致性成本，独立迭代。
- TradingView 全量绘图、脚本生态和体验复刻：高，不适合作为当前个人工具的默认目标。

保留现有后端统一 NY17 / BTC UTC0 分桶与行情语义；前端库负责显示，避免另算一套 OHLC。

## 后续核实：Advanced Charts（2026-09-29）

官方[产品比较页 FAQ](https://www.tradingview.com/free-charting-libraries/)现已通过代理读取：当前不向个人自用、爱好、学习或测试项目提供 Advanced Charts / Trading Platform 常规许可，面向公司的公开网站/应用；除 Lightweight Charts 外不提供图表引擎源代码。具体合同另行核实。前文“资格尚未核实”为上一轮调研状态，现由此结果更新。用户所述 v31.1.1 文件尚未收到，版本真实性与授权范围均未检查。完整功能差异见后续 `advanced-charts-assessment.md`。
