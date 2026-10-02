# TV v31.1.0 包的警报能力与当前原生图表接入评估

核查日期：2026-10-02。对象：`/home/quant/repos/research/TV_v31.1.0_0430.zip` 与当前本地仓库。采用 ZIP 原始条目、随包类型声明及项目源码作为第一手证据；仅静态核查，未改动实现、未做浏览器接入或告警投递测试。

项目对照基线：`v1.5.0`（`37cf4048ca10f3206963c1aec67f49b38140f5a8`）。本文随 v1.5.1 文档修订整理；功能现状按该固定源码核查，不表示运行环境已升级。

当前入口 `charting_library.js:1` 实际加载 `runtime.d6871abde1090b0329fe.js` 和 `library.e2f8b3a016c9e1a0b7a5.js`。ZIP 内另有旧版 bundle；本文以实际加载版本为主要实现证据，旧版只作交叉参考。

## 结论

**包中有警报文案、图标与内部代码残留，但未发现可直接使用的完整警报模块或公开警报 API。当前原生图表使用的正是这个包的图表库，因此替换为这个 ZIP 或开启隐藏开关不会新增完整警报功能。可以利用公开图表扩展 API，把项目自己的预警接进图表。** [S1][S2][S3][S4]

这里的“接入”指图表上增加“新建预警”按钮/右键入口，复用 market-watch 后台监控与通知，并可画出对应水平线；不是复原 TradingView 官网的整套原生警报窗口与服务。依据是公开扩展 API、项目现有预警 API 与随包明确的空实现。[S3][S4][S5][S6]

## 包中实际提供了什么

| 检查项 | 第一手证据 | 判断 |
|---|---|---|
| 与当前库的关系 | ZIP SHA-256 为 `e4eabc20e156000b2a8fda7747044fd82b95c714526c7ab7f34bcfe62abaf9ee`，与仓库 manifest 相同；逐一检查 manifest 的 2928 个条目，全部匹配、无缺失 | 当前仓库已经采用此 ZIP 库基线；不代表已核实远端部署文件 [S1] |
| 包身份 | `package.json:3` 自称 `TT v31.1.0`；`trading.html:6` 为 Trading Platform demo；`broker-api.d.ts:2` 为 Trading Platform 的 Broker API | 包含 Trading Platform 交易接口与示例，不能据此推导具有官网警报服务 [S2] |
| 警报文字与界面标识 | 英文 bundle 有 `Add alert`、`Add alert on {drawing}`；工具栏有 `header-toolbar-alerts` | 有名称与翻译不等于可用模块 [S3] |
| 图上新建警报 | `_createAlertButton(){}`；`_createAlertMenuItems(e){return Promise.resolve([])}` | 相关入口是空实现 [S3] |
| 右侧警报面板 | 默认配置的 `ctor:null` 本身不足以证明缺件；实际模块注入没有提供 `AlertsWidget`，并且创建菜单和服务路径分别为空列表与 null | 未找到可用警报面板；结合实际调用路径判断 [S3] |
| 警报内部服务 | 实际加载 bundle 的 `_alertService=null`；旧版 bundle 另有 `new undefined(...)` 或 `Not implemented` 分支 | 不能将内部占位当作稳定接入点 [S3] |
| 公开警报契约 | 三份 `.d.ts` 中不区分大小写搜索 `alert`，仅 `charting_library.d.ts` 的 5 处 JavaScript `alert()` 示例；没有警报 CRUD、订阅、适配器或 feature 类型 | 未提供可支持的公开警报集成 API；示例 `alert()` 是浏览器弹窗 [S4] |

没有从包中建立“独立警报判定后台、持久化服务、手机通知服务”的存在证据；交易 Broker API 也不能代替这些功能。对“开启 `alerts` 即可获得完整能力”的说法，当前空实现证据不支持。[S2][S3][S4]

## 可行的接入方式

1. **先做自建行情的价格预警。** 使用 `widget.createButton()` 加“新建预警”，或 `widget.onContextMenu()` 加“在此价位创建预警”。后者回调直接给出时间与价格；也可使用价格轴 `onPlusClick` 事件，其参数含 symbol 与 price。[S5]
2. **通过既有 iframe 通信桥打开项目表单。** 图表域向可信父页面发送经过校验的请求，由父页面承担鉴权、显示预警参数并调用 `POST /api/watches`。现有桥明确规定鉴权工作在父页面；需要新增消息类型与表单衔接，目前没有直接的警报消息处理。[S6]
3. **继续由后台监控与通知。** 当前创建接口支持四类规则，触发时写入 Signal、Notification 与 Outbox；通知投递还要求启用 delivery 且配置 ntfy topic。图表按钮只提供入口，不能保证未配置的通知自动送达。[S7]
4. **需要图上标识时使用公开 Drawings API。** `createShape()` 支持 `horizontal_line`，`drawing_event` 可监听移动/删除。警报应保存在监控后台，并建立警报 ID 与图形 ID 的关联；拖动/删除图形是否修改/取消监控需要明确实现，画线本身不会执行预警。[S5][S7]

这种方案复用已有图表与监控系统，具备静态可行性；实际右键行为、价格轴按钮显示、多图状态同步、刷新后图形恢复和真实通知仍需要实现后验证。

## 需要保留的语义边界

- **平台行情不能静默转成自建行情预警。** 当前说明明确预警/演练仅用自建行情；API 只接受 `EURUSD/XAUUSD/BTCUSD/BTCUSDT`，不接受平台 ticker。第一版应明确限制自建系列；支持平台警报需新增该系列的后台监控与身份模型。[S8]
- **图表周期不等于策略周期。** 图表桥支持 M30/W1/MN 等九周期，策略仅支持 M1/M5/M15/H1/H4/D1，另允许价格规则的 `tick`。预填当前图表周期前必须验证；不能直接提交所有原生周期。[S9]
- **右键坐标不总是原始价格。** 比较品种、指标副图及平均 K 线等变换图表需要确认对应系列与价格含义；原生使用说明已说明变换后的价格不等于原 OHLC。[S5][S10]
- **原生指标不自动成为预警规则。** 当前表单的指标预警是 SMA 双均线交叉；任意原生指标、Pine、趋势线或通道突破都需另建后台计算与规则支持，不能因为图表画得出来就宣称可以报警。[S7][S10]
- **逐笔价格与图表更新口径需明确。** 后台存在独立 `evaluate_quote` 报价判定；图表说明为 M1 行情更新。接入时应展示价格规则的判定口径，避免用户将图上最后价等同于每笔报价。[S7][S10]

## 未核实事项

本次访问 TradingView 官方 FAQ 与产品说明页面时连接被重置，因此不引用未读取的官网内容，也不扩大结论为“TradingView 所有版本永远不支持警报”。结论仅针对该 ZIP、随包公开 API 与当前仓库。其他授权版本是否提供新的警报产品或服务，应另向 TradingView 核实；本次也未检查授权账户或生产部署。

## 证据索引

ZIP 引用使用原始成员路径和原始换行行号，不以格式化后的压缩 JS 行号作为证据。下文 `Z/` 代表 ZIP 内 `TV_v31.1.0_0430/static/`，可用 Python `zipfile` 直接读取复核。

- **[S1]** [advanced-host/library-manifest.json](../advanced-host/library-manifest.json#L2)，`archive_sha256` 与 `files` 清单；核查逐条 SHA-256，共 2928 条、0 不匹配。
- **[S2]** `Z/charting_library/package.json:3`；`Z/trading.html:6`；`Z/charting_library/broker-api.d.ts:2`；`Z/charting_library/charting_library.d.ts:28040–28050`（`broker_factory` 返回 Broker API 实现）。
- **[S3]** `Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:628`（创建警报菜单返回空列表）、`:789`（`_alertService=null`）、`:858`（注入 NewsWidget/Details/DataWindow，未提供 AlertsWidget）；`Z/charting_library/bundles/widgetbar.c6e39002f99475679d03.js:5/17`（默认面板配置及最终构造器注入）。实际 runtime 的 chunk 19722 对应 `floating-toolbars.47df2a0632b65c8dff7b.js:37`（`_createAlertButton(){}`），chunk 75439 对应 `general-property-page.6c3a63757d2aff8fce25.js:18`（`_createAlertsPropertyPage(){return null}`）。旧版 `library.0dbcc224ae24ceb827f2.js:614/773` 的空菜单和 null 服务仅作交叉证据。
- **[S4]** 全文检查 `Z/charting_library/charting_library.d.ts`、`datafeed-api.d.ts`、`broker-api.d.ts`；5 处 `alert` 命中位于 `charting_library.d.ts:5638/11868/11875/11879/11897`，均是浏览器弹窗示例。
- **[S5]** `Z/charting_library/charting_library.d.ts:5620–5650`（context_menu 扩展）；`:11859–11888`（onContextMenu 时间/价格）；`:11890–11913`（createButton）；`:27194–27198` 与 `:18746–18750`（onPlusClick）；`:11158–11173`（createShape）、`:5851–5855`（horizontal_line）、`:27234–27239`（drawing_event）。
- **[S6]** [advanced-host/bridge.js](../advanced-host/bridge.js#L1)（可信父页面鉴权与 channel）；[web/src/advanced/AdvancedWorkspace.tsx](../web/src/advanced/AdvancedWorkspace.tsx#L159)（消息处理）。
- **[S7]** [backend/alerts/api.py](../backend/alerts/api.py#L196)（规则输入）、[创建接口](../backend/alerts/api.py#L347)；[web/src/main.tsx](../web/src/main.tsx#L681)（四种规则）；[backend/alerts/service.py](../backend/alerts/service.py#L361)（Signal/Notification/Outbox）、[evaluate_quote](../backend/alerts/service.py#L389)；[backend/alerts/notify.py](../backend/alerts/notify.py#L57)（投递配置门槛）。
- **[S8]** [docs/chart-dual-dataset-user-guide.md](chart-dual-dataset-user-guide.md#L9)；[backend/alerts/api.py](../backend/alerts/api.py#L197)。
- **[S9]** [advanced-host/bridge.js](../advanced-host/bridge.js#L48)；[backend/alerts/domain.py](../backend/alerts/domain.py#L18)、[周期验证](../backend/alerts/domain.py#L196)；[web/src/main.tsx](../web/src/main.tsx#L55)。
- **[S10]** [docs/advanced-charts-user-guide.md](advanced-charts-user-guide.md#L25)（M1 更新）、[变换图表说明](advanced-charts-user-guide.md#L32)、[指标/预警边界](advanced-charts-user-guide.md#L62)。
