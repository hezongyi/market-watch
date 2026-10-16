# 专业图表自选列表首屏与报价体验计划

状态：已获用户批准，**真实数据复验已通过；已撤销早期 fixture 验收结论，未执行生产部署**
日期：2026-10-16
项目：market-watch
基线工作树：`/home/quant/repos/market-watch-rest-native-fix-20261015`
基线分支：`release/v1.25.8-20261016`
代码基线提交：`b53d2973cd70e8610154bc46a9d516e62ccdadd7`
计划文档提交：当前 docs-only 提交（仅新增本文件）
生产地址：`https://trade.kookvv.com:8443`

## 目标

专业图表进入后应尽快显示自选列表，立即接收行情更新，并直接显示最终商品代码。组合行情在自选列表中必须显示最新价、涨跌和涨跌幅，并随实时/REST Batch 观测更新。右侧自选列表的品种详情恢复原始原生版本。自选列表列标题前的三点控制移到右上角 `+` 左侧，并显示为横向三点，原菜单行为保持不变。最新价列的最后一位数字使用上标视觉效果，同时保留原始数值、复制、排序和无障碍语义。

## 已确认事实

- 生产表现属于 v1.25.8 代，远端 `origin/main` 与当前基线一致。
- 生产 REST Batch 已启用；live status 返回 `acquisition_mode: rest_batch`、`connection: connected`。
- 生产基础接口不是主要瓶颈：一次只读测量中，工作区约 73 ms、图表 catalog 约 29 ms、history capabilities 约 80 ms。
- 当前工作区的自选列表包含内部标识，例如 `MWP:OANDA:USD_CAD` 和 `MWC:<64位组合ID>`。
- 组合行情解析曾测得约 2 秒；组合行情 chart data 约 0.56 秒。实际浏览器首屏仍需完整 Chromium 重新测量。
- [AdvancedWorkspace.tsx](../web/src/advanced/AdvancedWorkspace.tsx) 的 `loaded` 处理会等待偏好迁移、指标 catalog、偏好和 history capabilities 后才发送 `init`。
- [bridge.js](../advanced-host/bridge.js) 的 `getQuotes()` 当前等待 `initialHistoryGate`；该 gate 在首个 `getBars()` 收尾时才释放。
- [bridge.js](../advanced-host/bridge.js) 的 `resolveSymbol()` 当前异步调用 `/market-data/resolve`，所以原生控件可能先显示内部 ticker，再换成 `display_symbol`。
- [market_data.py](../backend/alerts/market_data.py) 的平台与组合行情分支均返回一致的 `lp/ch/chp/prev_close_price` 字段；组合变化基于同 revision 的 NY17 前一根已确认 D1 收盘。
- [market_stream_worker.py](../backend/alerts/market_stream_worker.py) 的 quote stream 复用 `quote_snapshot()`，因此组合报价字段应在后端统一修复。
- [native-ui.js](../advanced-host/native-ui.js) 从提交 `3f14266` 起向原生详情框插入交易时段和观察时间扩展；用户已批准恢复原生详情框。
- [chart-menu.js](../advanced-host/chart-menu.js) 当前只将 `商品代码` 改名为 `商品`，尚未移动三点控制。
- [price-format.js](../advanced-host/price-format.js) 使用公共 formatter 返回普通字符串；公共接口不能直接返回只包裹末位数字的 HTML。
- 当前环境的 Chromium 可视化启动缺少 `libatk-1.0.so.0`，所以三点按钮真实 DOM、详情 DOM 和上标 DOM 尚未完成浏览器确认。

## 已批准的产品决定

1. 组合行情涨跌基准采用同一 NY17 交易日的上一根已确认日收盘价，不采用上一根 M1 收盘价。
2. 末位上标只作用于自选列表的最新价列；图表价格轴、图表顶部价格和详情框保持普通数字。
3. 详情框移除当前新增状态/时间扩展，恢复 TradingView 原生详情框。
4. 三点控制在桌面和移动窄屏都移动到 `+` 左侧，保留原生菜单、事件、键盘行为和权限行为。
5. 首屏优先显示自选报价；历史 K 线可以并行继续加载。

## 实施边界

### 包含

- 自选列表报价与首屏初始化的等待链优化。
- 自选列表内部 ticker 到最终显示代码的元数据预热。
- 组合行情报价的涨跌字段和实时传播。
- 原生详情框恢复。
- 原生三点按钮的位置和方向适配。
- 自选列表最新价末位上标的可访问 DOM 适配。
- 单元测试、API 测试、浏览器回归和只读生产验证。

### 不包含

- 不改变生产 REST Batch 开关、供应商账户或采集策略。
- 不改变组合行情的价格、历史、修订、拼接或告警计算语义。
- 不修改 TradingView 许可库源码。
- 不把内部 ticker 持久化改成显示 ticker；内部身份仍是唯一行情身份。
- 不在本计划内部署生产、创建正式 tag、切换 Unraid 实例或删除生产资源。

## 分阶段任务

### W0：浏览器基线和请求追踪

**目的**：先得到可复核的首屏时间线，避免只凭代码推测性能。

**工作**：

- 在 Ubuntu 隔离环境补齐 Chromium 依赖，使用 Playwright 登录测试账户。
- 记录以下事件：工作区响应、iframe `loaded`、父级 `init`、widget ready、watchlist 首次解析、最终显示代码、首个 quote callback、首个 stream quote、首个 chart data、首个 `dataReady`。
- 分别测冷启动、同会话热启动、已有组合行情、仅平台行情、混合 watchlist。
- 保存去除凭据和完整浏览器状态的结构化 JSON 证据。

**依赖**：无。
**交付物**：首屏基线报告、请求瀑布和可复现命令。
**完成条件**：能区分父级初始化、符号解析、报价 gate、历史加载和 DOM 渲染各自耗时。

### W1：组合行情报价字段

状态：已完成（`8875731`）。

**目标**：组合行情和平台行情在 watchlist 中具有一致的涨跌字段。

**建议实现位置**：

- `backend/alerts/market_data.py`
- 必要时新增 `backend/alerts/composite_quotes.py` 或共享 quote presentation helper
- `backend/alerts/market_stream_worker.py` 只做复用确认，不复制计算逻辑

**实现要点**：

- 读取当前组合有效修订的最新价。
- 读取同一组合修订、同一 NY17 会话的上一根已确认 D1 close。
- 只有 previous close 有效且非零时返回 `ch`、`chp`、`prev_close_price`；没有有效基准时保留最新价并省略涨跌字段。
- 确认 sampled candle、sampled bid、stored confirmed M1 三种状态都不混淆价格时钟和涨跌基准。
- 确认 HTTP quote 与 stream quote 的 `n`、修订、snapshot 和数值字段一致。

**测试**：

- 同价、上涨、下跌、无 previous close、跨 NY17、组合修订切换。
- `quote_snapshot()` API 断言 `lp/ch/chp/prev_close_price`。
- stream worker 断言首次事件和后续变化事件均携带同样的报价字段。

### W2：watchlist 首屏并发与显示代码预热

状态：已完成（`3064b02`）。

**目标**：自选报价不再等待首个历史请求，原生列表直接显示最终代码。

**建议实现位置**：

- `web/src/advanced/AdvancedWorkspace.tsx`
- `advanced-host/bridge.js`
- 必要时 `advanced-host/series.js` 增加受控的 ticker 解码辅助，但不改变身份编码。

**实现要点**：

- 从偏好中提取当前 active watchlist，忽略 `###PROVIDER`、`###COMPOSITE` 等分组行。
- 对 `MWP:`, `MWC:`, `MWH:` 和兼容的 managed ticker 生成 `{ticker, instrument, series_kind}` 请求。
- 将 watchlist 元数据预热与现有 catalog/preferences/capabilities 初始化并发；使用有界并发和 `Promise.allSettled`，单个失败不能阻塞整张图。
- 将成功的元数据映射随 `init` 传给 bridge，并写入内存缓存。
- `resolveSymbol()` 对 watchlist ticker 优先使用缓存；缓存缺失时仍走原有后端 fallback。
- 保留一次性 `initial_symbol` 逻辑，避免工作区主图初始 metadata 与 watchlist metadata 相互消费。
- 移除 `getQuotes()` 对 `initialHistoryGate` 的强制等待，让报价与首个历史请求并发；保留 epoch、取消和 stale-response 保护。
- 报价请求需要单独的有界并发，避免解除 gate 后挤满父级 bridge 或供应商资源。

**测试**：

- 无历史响应或人为延迟历史响应时，watchlist 仍能显示最终代码和报价。
- 组合 ticker、平台 ticker、managed ticker、Yahoo ticker 和无效 ticker 混合。
- 旧布局、空布局、切换工作区、恢复布局和刷新页面。
- 断言可见 watchlist 文本不出现 `MWP:`、`MWC:`、`MWH:` 原始前缀；失败项显示安全的 fallback 文本。

### W3：原生详情框恢复

状态：已完成（`3064b02`）。

**建议实现位置**：

- `advanced-host/native-ui.js`
- `advanced-host/bridge.js`

**实现要点**：

- 移除 `chartNativeQuoteDetails()` 的 DOM 注入、MutationObserver 和销毁逻辑。
- 删除 bridge 中 `quoteDetails` 的创建、刷新和销毁调用。
- 保留 `widgetbar.details: true`、quote snapshot、原生价格和涨跌字段。
- 不删除后端的 session/time metadata；它们仍可被其他业务逻辑使用，但不再插入原生详情 DOM。

**测试**：

- 详情框只包含原生字段。
- 品种切换、主题切换、布局重建、窄屏隐藏/恢复详情栏。
- 无遗留 `mw-quote-details-time` 节点和 observer。

### W4：三点按钮位置和方向

状态：已完成（`3064b02`）。

**建议实现位置**：

- 优先新增 `advanced-host/watchlist-layout.js`，由 `advanced-host/index.html` 在 `chart-menu.js` 前加载；或在 `chart-menu.js` 中保持同等隔离。
- `advanced-host/chart-menu.js` 只负责调用适配器和生命周期清理。

**实现要点**：

- 以 TradingView 固定版本 hash 和语义属性为前提探测 watchlist、商品列标题、`+` 按钮及三点按钮。
- 移动已有按钮节点，不克隆、不替换、不重绑菜单事件。
- 将按钮插入 `+` 按钮前方。
- 对竖向 SVG 应用 90 度旋转，保留 focus ring、aria-label、disabled 和点击行为。
- MutationObserver 只在节点出现、列表重建或布局切换时重新应用；必须幂等，不能重复插入。
- 选择器失效时安全跳过并上报诊断，不阻塞图表。

**测试**：

- 桌面、窄屏、明暗主题、watchlist 开关、列表切换和布局重建。
- 鼠标点击、Enter、Space、Escape、Tab 顺序。
- 原生菜单项目和保存 watchlist 行为不变。
- 版本 hash 不匹配时适配器不执行破坏性 DOM 操作。

### W5：最新价末位上标

状态：已完成（`3064b02`）。

**建议实现位置**：

- 新增 `advanced-host/watchlist-layout.js` 中的价格呈现部分，或拆为 `advanced-host/watchlist-price.js`。
- 不修改 `price-format.js` 的数值格式合同。

**实现要点**：

- 只处理 watchlist 最新价列，不处理涨跌、涨跌幅、图表价格轴或详情框。
- 从原生单元格文本识别最后一个数字字符，将其包在 `<sup>` 或等价视觉节点中。
- 保存完整原始文本到 `aria-label`、`data-mw-raw-price` 或等价可访问属性。
- 不将上标 Unicode 字符写回数据模型，避免复制、排序和比较值改变。
- 价格更新或 React 重绘后重新应用；重复应用必须可识别并清理旧包装。
- DOM 结构或价格格式无法确认时回退普通文本，不阻塞报价。

**测试**：

- 正数、负数、零、不同精度、千位分隔、小数不足、无报价和错误报价。
- 价格更新、切换品种、列表滚动、列表切换、主题切换和布局重建。
- 键盘复制、屏幕阅读器文本、排序值和 native quote callback 保持原始数值。

### W6：综合回归和只读生产验证

**工作**：

- 运行后端单元/API 测试和 web 静态/模块测试。
- 在 Ubuntu 独立 Compose project 中运行最小 R1 smoke；服务、网络、volume、端口和数据库必须独立。
- 重新执行 W0 浏览器时间线，比较冷/热启动和组合行情更新。
- 生产只读验证 REST Batch、组合 quote payload、stream subscribe ack 和最终显示 metadata；不写入生产偏好，不创建告警，不切换工作区。

**交付物**：测试报告、浏览器 JSON、生产只读检查摘要、风险和未覆盖项。

## 验收标准

### 性能和时序

- watchlist 报价请求不依赖首个 chart history gate。
- 首屏先出现最终显示代码和报价，历史 K 线可并行继续加载。
- 生产或隔离环境中记录每个阶段的耗时，不以单一总耗时掩盖请求瀑布。

### 数据正确性

- 组合行情返回最新价、涨跌、涨跌幅时，三者使用同一组合修订和正确 NY17 previous close。
- REST 初始报价和 stream 更新的字段、ticker、修订和快照身份一致。
- 无有效 previous close 时不伪造涨跌数值。

### UI 行为

- 可见列表直接使用最终显示代码。
- 详情框恢复原生结构。
- 三点按钮位于 `+` 左侧，显示横向三点，菜单功能完全保留。
- 末位上标只改变视觉，不改变原始数值、复制、排序和无障碍文本。

## 风险与控制

- **TradingView 私有 DOM 变化**：所有菜单/上标适配均使用版本 hash、语义属性、幂等探测和安全 fallback；浏览器测试必须在实现前先取得 DOM 快照。
- **组合 previous close 查询成本**：优先复用已有索引和 chart/composite 访问逻辑，避免每次报价扫描长历史；测量 quote p95 和数据库查询数。
- **解除报价 gate 后资源竞争**：使用独立并发上限，观察 bridge pending、API 503、供应商请求数和首个 chart data 时间。
- **元数据预热拖慢 iframe 初始化**：预热必须有界并发；单项失败不阻塞；比较“等待预热后创建 widget”和“widget 后异步显示”的首屏结果。
- **上标造成重绘循环**：适配器必须标记自身节点并在 MutationObserver 中忽略自身更新。
- **生产误操作**：生产阶段只允许 GET、只读 POST 查询和明确的 subscribe/unsubscribe 测试；禁止修改偏好、工作区、告警或部署资源。

## 回滚点

- W1 为加法字段；若组合涨跌计算异常，可回退 quote presentation helper，不改变已有 `lp`。
- W2 可通过 feature flag 或单次 revert 恢复原 gate 和异步 resolve fallback。
- W3 删除自定义详情扩展即可恢复原生实现。
- W4/W5 适配器必须可独立禁用；DOM 适配失败时自动保持原生布局和普通价格文本。
- 在任何生产部署前保留旧镜像、旧配置和本次候选的固定引用；生产切换需单独取得明确授权。

## 后续代理接手清单

接手代理应按以下顺序继续：

1. 阅读本文件和仓库 `AGENTS.md`。
2. 确认业务代码仍以 `b53d2973` 为基线（当前 HEAD 可包含本计划的 docs-only 提交），确认 `git status` 干净。
3. 先完成 W0，不要先改业务代码。
4. 在浏览器 DOM 证据齐全后，按 W1 → W2 → W3 → W4 → W5 顺序实现；每阶段保持小提交和独立测试。
5. 每阶段更新本文件的状态、证据路径和已知风险；不要把临时凭据、完整浏览器状态或生产响应原文提交仓库。
6. 完成 W6 后只提交验证摘要和候选清单；合并、正式 tag、生产镜像和 Unraid 切换仍分别遵守仓库人工检查点。

## 当前状态

- 计划：已批准。风险分类 F0：兼容的 UI/报价适配，无 schema 或持久格式变更；执行独立 Ubuntu R1 并追加真实 OANDA REST Batch 浏览器验收。
- 真实数据验收：通过，见 [报告](verification/pro-chart-watchlist-20261016/real-acceptance.md) 和 [脱敏 JSON](verification/pro-chart-watchlist-20261016/real-acceptance.json)。
- Ubuntu 主机：`quant-server`；独立 project `mw-issue73-real-20261016`；页面 `https://192.168.7.232:18483/advanced-charts`；图表来源 `https://192.168.7.232:17483`。
- 真实来源：OANDA Practice；平台 EURUSD/XAUUSD 与真实 EURUSD 历史接续组合。没有生成或注入行情 fixture。
- 修复：上标自身 DOM 变更引发无限 MutationObserver 循环；原生涨跌闪烁 span 中的上标重复嵌套；三点按钮跨 React root 重挂后菜单事件丢失；原生严格包含导致工具栏按钮偏移/裁剪。业务修复止于 `d90e90d`。
- 已通过：真实 K 线 `dataReady=true`；三行最新价/涨跌/涨跌幅；组合 previous close 数值校验；REST Batch 当前未闭合 M1 收盘采样通过 SSE 继续更新（10 秒内组合序号 28 → 33）；原生菜单实际展开；黄金/组合切换；780px 窄屏菜单；刷新后数据恢复；pageErrors 为空。
- 已逐张人工打开查看 7 张真实页面截图。真实组合基线限近三天，故 H4 仅有有限根数；不把这解释为缺失平台历史或完整生产规模验收。
- 永久回归：真实 Chromium DOM 测试覆盖自触发循环、嵌套涨跌 span、尾零/无障碍文本、原生事件委托、严格绘制包含和窗口缩放；startup metadata、market stream、watchlist restore 模块测试通过。
- 撤销早期结论：旧 `mw-issue73-20261016` 的 D1 fixture 仅证明部分 DOM，实际 `dataReady=false`、持续 loading 和 resolve 422，不属于真实数据验收。旧证据已标记 superseded，不继续作为通过依据。
- 未覆盖：物理触屏手机、生产全量数据、长期稳定性观察；当前报告不声称这些已通过。
- 生产部署：未进行；验收实例保留供用户人工验收，凭据只保存在任务私有目录。

### 加载期间 ticker 闪现补验

- 用户反馈后已确认：组合、固定历史和 Dukascopy 都会先显示内部标识；此前稳定截图未覆盖这一阶段。
- `d14ec34` 统一全部来源/类型的首帧名称保护及元数据回调。真实四源（OANDA/Dukascopy/Binance/Yahoo）和平台/固定历史/组合/旧 managed 代表样本通过，102 次可绘制行状态变化中无内部 ticker；九条真实身份名称正确。
- 逐张检查加载与稳定截图，详见 [专项报告及边界](verification/pro-chart-watchlist-20261016/ticker-flash.md)。Yahoo 已在本任务隔离实例开启；原人工验收网址和密码保留。
- 此补验取代“稳定状态直接显示代码就足以证明加载无闪现”的推断。其他来源没有发布历史样本的组合未冒称真实通过；生产未发布。
