# Advanced Charts 交付缺口核对

更新：2026-09-30。此文件是剩余实施清单，不是完成声明。生产未部署，远端未push。

## 已有直接证据

- 原生新建、复制、重命名、切换、删除活动工作区后继续保存、空列表恢复：浏览器专项通过。
- 保存409冲突后的草稿恢复：真实前端+注入冲突通过，独立副本保留文档。
- 手机临时周期/视区操作不产生advanced-charts写入，桌面草稿不被删除：浏览器通过。
- EURUSD M1、XAUUSD M5、BTCUSDT M5指定历史日期跳转完成后视区稳定；单次缓存速度约5.1秒/未单测/1.24秒。冷加载速度不保证，BTC一次补齐117.6秒。
- Python SMA/MACD/STOCH/BBANDS参数保存恢复及后端序列，内置八类指标创建，九类画线持久化已有专项证据。
- 最新后端全套146 passed、5 skipped；另在独立PostgreSQL测试库补跑4 passed，累计150项通过。备份恢复专项仍未执行，详见末尾运行环境记录。

## 本轮补充证据（2026-09-30）

- 手机412×915竖屏验收已通过：8图加载、临时操作后写入请求为空、页面异常为空。截图已人工检查，完成状态未遮挡工具栏；8图在窄屏中每格较窄，单图最大化阅读仍需检查。
- 手机此前无法找到图表iframe的直接原因是开发静态源5187停止；恢复该服务后通过。不能把此前失败归因为已确认的登录/会话问题。
- 月线真实加载及保存恢复已有两轮通过，恢复前后视区一致；首次高周期请求数量限制已验证为D1=91、W1=13、MN=3。这不覆盖周期切换、历史拖动和所有冷加载场景。
- 混合8图保存恢复最近一轮通过。三小时窄视区最新实测通过：8图M5/M15/M30左右边界完全一致；关闭同步后仅被操作图表移动，其他7图视区不变，页面异常为空（/tmp/mw-narrow-viewport-current.log）。随后真实鼠标验收通过：8图crossHairMoved事件时间位于对应周期的一根K线以内；滚轮缩放、按住拖动的左右视区误差不超过对应周期一根K线，关闭同步后保持独立，无页面异常（/tmp/mw-mouse-drag-viewport.log）。截图确认异品种没有显示EURUSD水平价格线（/tmp/mw-mouse-crosshair.png）。

## 依次收口

1. **高周期首次加载预算**：当前getBars完整满足countBack，新工作区已有3个月初始视区约束；仍须检查周期切换和已保存布局是否发起过大的历史请求，并提供渐进显示/明确加载范围，不能退回错误截断造成时间轴缺口；验证D1/W1/MN真实冷加载、向左拖动、取消。现有聚合单测不证明体验。
2. **多图稳定性**：混合8图、窄时间范围及真实鼠标十字线/滚轮/拖动已验证；仍需检查加载中切换同步及错误恢复；首次原生布局绑定已改为等待dataReady，之后月线及8图通过；其他路径仍保留异常断言。
3. **绘图与指标体验**：水平线跨工作区/品种隔离已验证；盈亏比显示数值及趋势线鼠标绘制已有专项证据；仍需其余工具交互、Python长历史数值/预热验证。对象API创建通过不等于这些全部通过。
4. **原生界面视觉检查**：去掉外层工具栏后桌面深浅主题截图、手机阅读、底部状态提示遮挡、未接入入口说明；已有功能清单旧表必须结合状态校正阅读。
5. **运行及交付**：开发API已重启加载5ee44d6覆盖等待修正；生产静态镜像运行/跨来源TLS与compose、备份迁移回退验证未完成。缺失CSV导出和hammer资源仍需明确处理。
6. **原功能回归与交付包**：预警/演练/ntfy原有行为按实际改动面核验；整理版本、验收与已知限制，不把pytest跳过项计入完成。

用户接受慢请求显示加载状态，不要求一次十年M1；不能把内部测试60秒超时当成用户硬性SLA，也不能以延长测试超时替代可用的加载反馈和取消。

- 本轮日线和周线真实历史加载、原生保存、刷新恢复通过；恢复前后视区严格一致，页面异常为空（/tmp/mw-daily-real-restore.log、/tmp/mw-weekly-real-restore.log）。缓存已有历史，此结果不代表冷加载性能。

## 失败恢复与新发现（2026-09-30）

- `MARKET_WATCH_HISTORY_FAILURE=1 MARKET_WATCH_TEST_RESOLUTION=1D`运行`advanced-monthly-live.browser.cjs`：真实前端M30规划响应注入error后，切回D1、同步状态恢复、保存及刷新成功，视区严格一致，无页面异常（/tmp/mw-history-failure-without-range.log）。仅覆盖错误响应和切周期恢复，不覆盖任务重试按钮。
- **当时发现：D1指定视区后保存恢复偏移（后续修复及证据见下文）**。在上述用例额外设置`MARKET_WATCH_REAPPLY_RANGE=1`，调用公开setVisibleRange后保存，刷新左右边界发生变化（/tmp/mw-history-failure-stable.log）。保存前等待2秒也复现；去掉setVisibleRange操作后通过。因此不能把此问题归因为失败恢复卡死，也不能把日线任意视区保存声明为已通过。下一步独立复现正常日线setVisibleRange/鼠标缩放保存，检查原生barSpacing/rightOffset及保存状态。

### 日线视区偏移定位结果

- 无需模拟行情失败，单独`MARKET_WATCH_REAPPLY_RANGE=1 MARKET_WATCH_TEST_RESOLUTION=1D`也能复现；测试参数已移到失败分支之外。
- 保存前barSpacing=14.7012987012987、rightOffset=9、width=1132；恢复后间距和宽度相同，rightOffset=10。原生widget.save返回timeScale.m_rightOffset=10。
- 只读检查供应包发现普通state保存defaultRightOffset，而非实时rightOffset。临时通过公开API把默认偏移设为9后，刷新视区完全一致（/tmp/mw-daily-default-offset-probe.log）。该探针已删除，没有修改供应包或将改变用户默认留白的处理写入产品。
- 当时确定的修复方向是适配层保存当前视区并用公开API恢复，避免更改默认留白。后续实施及验证见下一节。

### 视区修复实施与当前证据

- 新增`advanced-host/viewports.js`：通过公开API记录各图symbol/resolution、视区及实际barSpacing/rightOffset，作为自有`_mwViewports`字段随原生保存内容持久化；交给供应库加载前移除该字段。
- 最新行情附近恢复实际间距/留白，不改默认留白偏好；历史位置按绝对时间恢复。无此字段的旧工作区继续使用原生加载。
- 原始D1指定视区复现已通过：rightOffset保存/刷新均为9，视区严格一致（/tmp/mw-daily-viewport-envelope.log）。向前30天历史位置也通过：offset=-12，刷新视区严格一致（/tmp/mw-daily-historical-viewport.log）。
- 8图原有保存刷新、混合周期及关闭同步回归已通过（/tmp/mw-eight-viewports-regression.log）；另外增加逐图保存前后视区严格比较，正在验收。
- 单测覆盖不改变默认偏好、错误恢复同步、旧工作区取消和品种不匹配不应用；原分页/同步保护单测通过。供应包未修改。
- 尚需继续核验原生工作区菜单切换、手机不同屏宽、历史跨缺口与供应数据推进时的行为，不能据单图通过宣布全部视区场景完成。

- 8图逐图视区严格比较通过，但首轮捕获3次undefined异常（/tmp/mw-eight-viewports-exact.log），该轮不算通过。随后在dataReady后延迟至下一事件循环再修改视区，重跑逐图比较、开关同步及保存恢复通过，无页面异常（/tmp/mw-eight-viewports-deferred.log）。单轮通过不证明所有间歇异常已根治，继续保留原异常断言。

### 原生切换严格验收补充

- 普通原生工作区切换回归通过（/tmp/mw-viewport-native-switch.log）。但增加A/B不同rightOffset并逐一比较后未通过（/tmp/mw-viewport-native-active.log）。已等待loading/nativeSaving/rangeGuard就绪，并以父页面iframe绑定的实际workspace id读取A，排除了仅按列表首项读取的错误。
- 调试发现加载适配器能够接收并调用视区恢复，但被加载记录中的offset仍为10；需继续核对原生保存捕获时点与手动保存/自动保存的相互影响。尚未证明是恢复逻辑本身或保存内容被后续覆盖，不能宣称菜单切换视区完成。
- 调试日志已从产品移除；新增严格复现保留。手机视区恢复验收仍待执行。

### 原生切换视区缺口修复

- 根因已通过请求抓取和供应包只读逻辑确认：仅平移改变当前rightOffset时，原生序列化结果仍是默认留白，因此保存去重直接成功返回，不调用save_load_adapter；适配器附加的视区状态没有机会更新。不是PostgreSQL漏存，也不是读取了错误workspace id。
- 增加公开onVisibleRangeChanged订阅、400ms合并保存，沿用既有原生保存适配器及revision队列；快照使用公开widget.save，包含当前完整图表状态。原生切换前等待视区保存；恢复过程中不自动保存，手机不订阅写入。
- A/B不同留白真实测试通过：A=4、B=14的服务器记录正确，复制B恢复A视区、切回A恢复原边界，版本递增及删除隔离通过，无页面异常（/tmp/mw-viewport-independent-save.log）。
- 手机竖屏临时切周期/移动视区通过，MOBILE_WRITES为空、桌面草稿保留、页面异常为空（/tmp/mw-mobile-viewport-autosave.log）。
- 此变更新增保存触发路径，后续需回归保存冲突/草稿恢复和多图连续拖动，不能只用上述成功场景代替冲突验证。

### 视区自动保存冲突专项

- 新增`MARKET_WATCH_VIEWPORT_CONFLICT=1`运行`advanced-draft-recovery.browser.cjs`，通过真实公开API平移图表触发新增自动保存路径，并在HTTP层注入409；不以直接RPC保存替代该路径。
- 断言冲突草稿包含rightOffset=4、原草稿在另存后仍保留、刷新后可复制恢复、工作区元数据保留、恢复副本内容等于冲突草稿。
- 首轮上述内容断言通过，但捕获`undefined is not iterable`，整轮失败（/tmp/mw-viewport-conflict-recovery.log）。加入阶段及堆栈日志后连续两轮通过（/tmp/mw-viewport-conflict-stack.log、/tmp/mw-viewport-conflict-repeat.log），未复现异常；没有修改产品代码或屏蔽异常。
- 冲突恢复的功能路径已有证据，间歇异常原因仍未确定，保留页面异常断言及诊断，不能声明此异常已经修复。后续结合多图/恢复压力场景继续定位。

### 开发运行环境及完整回归更新

- 2026-09-30开发API已从PID1945819重启为2212692，使用原进程环境和同一代码目录；启动前以实际Settings确认数据库为trading_alerts_dev、delivery_enabled=false。/healthz返回200。没有重启Unraid服务或部署生产。
- 当前完整后端回归146 passed、5 skipped（/tmp/mw-backend-final-regression.log），前端TypeScript/Vite生产构建成功（/tmp/mw-web-final-build.log）。
- 补跑独立trading_alerts_test库的PostgreSQL专项：test_postgres.py及test_database_transfer.py共4 passed（/tmp/mw-postgres-final-regression.log），覆盖并发触发/outbox租约、覆盖区间处理、失败迁移回滚；每项使用自建临时schema并清理。
- 因此此次累计150项后端用例通过；剩余未执行的是要求匹配pg_dump/pg_restore工具和隔离服务的备份恢复专项，仍不得计为通过。镜像部署/TLS及间歇原生异常依旧未收口。

### 多图鼠标操作后的自动保存与刷新

- 新自动保存通路启用后，真实鼠标8图十字线/滚轮/拖动回归通过（/tmp/mw-mouse-autosave-regression.log）。
- 扩展同一浏览器验收：操作后不调用手动保存，等待服务器工作区中8个_mwViewports与最终各图视区严格一致；随后直接刷新，等待恢复完成，逐图时间边界严格一致，关闭同步的状态保持，无页面异常（/tmp/mw-mouse-autosave-restore.log）。
- 脚本为web/tests/advanced-mixed-viewport.browser.cjs，环境MARKET_WATCH_MOUSE_CHECK=1、MARKET_WATCH_VIEWPORT_HOURS=3。证据覆盖本次混合M5/M15/M30和对应历史范围，不推广为全部行情故障与加载竞态均通过。

### 画线共享与隔离专项

- 扩展advanced-drawing-sync.browser.cjs：NZDUSD的M5/M15同工作区水平线新增、修改、删除同步；切换其中一图到XAUUSD后该画线不可见，切回NZDUSD恢复对应价格，通过（/tmp/mw-drawing-symbol-isolation.log）。
- 创建并保存原工作区水平线0.569后，通过原生顶栏按钮新建B，B切到相同NZDUSD仍无画线；通过原生加载接口切回原工作区，两图均恢复0.569水平线，页面异常为空（/tmp/mw-drawing-workspace-isolation.log）。
- 该证据使用公开绘图API创建对象，证明共享/隔离/持久化，不代替工具栏鼠标实际绘制或所有绘图工具的数值验证。

### 实际鼠标绘制趋势线

- advanced-drawings.browser.cjs增加MARKET_WATCH_MOUSE_DRAWING=1：通过公开selectLineTool选择原生趋势线工具，然后真实鼠标点击两个不同位置创建线段；未调用createShape/createMultipointShape来替代鼠标定位。
- 截图/tmp/mw-mouse-trendline.png已人工检查，端点及线段正常显示。刷新后两端点时间/价格完全一致，M5→M15按对应K线时间定位，切回M5还原原始端点。
- 首轮断言日志完成但进程exit143，未计为完整通过；复跑/tmp/mw-mouse-drawing-confirmed.log退出0，页面异常为空，整轮通过。
- 该证据覆盖趋势线鼠标落点、保存及跨周期恢复；工具选择本身调用公开API，尚不证明所有原生工具菜单点击路径。盈亏比数值和其余工具交互继续独立验收。

### 多空仓位盈亏比工具

- 新增advanced-risk-tools.browser.cjs：真实行情上分别创建long_position/short_position，入场0.565、stopLevel=100、profitLevel=250，并显示原生统计信息。
- 通过测试侧拦截canvas.fillText读取实际渲染文本（不改产品或供应库）：风险/回报比2.5、停止距离0.00100/0.177%、目标距离0.00250/0.442%均与独立算式一致；截图/tmp/mw-risk-tools.png人工确认多空方向及入场/止盈/止损价格位置正确。
- 保存刷新后两类工具均保留入场0.565、stopLevel100、profitLevel250、alwaysShowStats=true，页面异常为空；/tmp/mw-risk-tools-asserted.log退出0。
- 这是图表分析工具验收，不代表接入了下单、账户持仓或真实交易收益计算。鼠标拖动止损/止盈手柄及其他品种精度仍可在后续交互验收中覆盖。

### Python长历史指标数值与分页

- 新增长历史API测试test_long_history_indicator_warmup_and_future_append：6000根连续M1输入，EMA(500)/RSI(14)与独立递推公式逐点比较（绝对误差1e-9），每页1200根且300根重叠区间严格一致。
- 再追加200根后续K线，过去页面全部指标值保持不变；EMA前499根明确返回null，第500根种子值正确。测试不复用被测calculate/TA-Lib生成期望值。
- 初次测试原始浮点输入超出数据库Numeric(24,10)精度，导致RSI误差略超阈值；改用8位小数可持久化输入后通过，没有放宽数值阈值或修改产品算法。
- test_chart_workspace.py共19 passed，ruff检查通过（/tmp/mw-indicator-long-history.log）。该证据覆盖两类递归指标，不等于十年M1全部指标性能已达标；自定义插件仍需其作者提供对应数值测试。

### 高周期切换请求预算：未解决

- 扩展advanced-high-period-request.browser.cjs，MARKET_WATCH_SWITCH_PERIOD=1先真实加载M5，再切目标高周期；高周期history请求在浏览器拦截，避免验证本身启动十多年M1补数。
- 切MN首个请求limit=188（/tmp/mw-switch-month-request.log），新建月线工作区3个月初始范围并未覆盖周期切换路径。
- 尝试公开onIntervalChanged的timeframe参数：time-range（切换前日期范围扩为90天）仍请求195根；period-back=3M仍188根（/tmp/mw-switch-periodback.log）。已移除这两种无效候选和全部临时产品日志，保留原稳定实现。
- 下一步必须解决首个请求预算或明确采用可渐进展示的加载方式，保持数据完整性；不能截断countBack、伪造noData，或把扩大测试超时当作解决。此验收用例目前预期失败，交付缺口保持开放。

### 高周期切换进一步定位

- 只读检查供应包：determine_first_data_request_size_using_visible_range在模型初始化时计算初始请求；普通周期切换没有重走这段初始化逻辑。未修改供应包。
- 三个独立公开API对照均未解决：周期事件内setBarSpacing、widget.setTimeFrame({val:"3M",res:"1M"})、切换前先设置barSpacing并等待100ms，首个MN请求仍为195根（/tmp/mw-switch-spacing-probe.log、/tmp/mw-switch-settimeframe.log、/tmp/mw-switch-spacing-before.log）。
- 所有临时探针已移除，产品及正式失败用例恢复到此前状态。下一步需要验证原生重新加载图表状态是否重建请求预算，或采用经过真实渲染验证的渐进加载；重复调timeframe参数无证据支持继续尝试。

### 请求预算重建对照与未通过的接入

- 公开API对照成功：先切月线（大请求仅拦截，不下载），设置barSpacing=width/3，再widget.save/widget.load，重新加载后的首个MN请求为4根（/tmp/mw-month-reload-budget.log，退出0）。以MARKET_WATCH_RELOAD_BUDGET_PROBE=1保留该诊断路径；此模式只验证重载后请求，不能视为完整切换验收。
- 尝试在onIntervalChanged安排重载，并在高周期getBars前让出事件循环/等待重载，仍会先发出188/195根旧请求，然后才是4根新请求（/tmp/mw-month-budget-all-gated.log）。因此没有把候选接入当成修复，产品bridge和range-sync已恢复原版本。
- 下一步需在datafeed入口、发给后端之前识别被周期切换替代的旧请求；同时验证重载不会丢失工作区身份、其他分屏、画线及撤销行为。只有后续小请求成功不足以证明旧的大补数已被阻止。

### Datafeed入口前移对照通过

- MARKET_WATCH_FEED_BUDGET_PROBE=1在浏览器测试内包装feed.getBars：拦住首次大MN请求，再通过公开缩放/save/load重建，明确向旧请求返回被替代错误，不将旧请求交给后端。
- 两轮均只捕获4根MN后端请求（/tmp/mw-feed-budget-probe.log、/tmp/mw-feed-budget-events.log）；后者增加页面异常断言，退出0、异常为空。捕获的旧请求firstDataRequest=true，countBack188/195，ready=true、loading=false。
- 事件记录确认onIntervalChanged先于该getBars，普通下拉切换的parameters为空；后续正式接入可记录明确timeframe意图，避免覆盖用户日期选择。
- 此代码仅为测试内诊断包装，尚未接入产品；下一步用显式“旧请求被替代”取消语义接入，不能仅等待workspaceEpoch变化（重载事件异步，旧请求可能在其之前继续发出）。必须继续验证实际数据、工作区身份、多图和撤销状态。

### 普通高周期切换预算正式接入（仍需多图边界验证）

- datafeed getBars入口记录普通高周期切换意图；仅首次、超出初始预算的请求重建原生状态，并明确取消被替代请求。显式timeframe及后续向左分页不走此分支；默认D1/W1/MN初始预算90/13/3（原生会多取边界K线）。供应库未修改。
- 正式路径请求拦截验收通过：M5→MN只向后端发4根请求，无旧188/195请求（/tmp/mw-budget-product.log）。
- 真实EURUSD M5→MN，水平线保留、最新月K可见、保存刷新视区严格一致，页面异常为空（/tmp/mw-budget-live-lifecycle.log）。已有缓存，非冷加载性能证明。
- 公开widget.load与菜单loadChartFromServer事件路径不同，重载显式推进workspaceEpoch，完成后恢复同步、范围订阅及保存状态；旧请求在重载完成前明确取消，避免等待循环。
- 尚需验证多图不同品种/周期的旁图状态、连续切换、显式日期范围、周/日切换与撤销栈影响。当前仅单图真实月线通过，不能据此关闭全部高周期缺口。

### 高周期双图旁图保留验证

- 日线请求预算测试进程确认退出0，首次D1请求91根（/tmp/mw-day-budget-current.log）；周线请求14根的预算测试已通过。
- 双图测试首次失败位于新增图表的setSymbol，原生模型尚未初始化（Value is null），发生在目标周期切换之前。测试增加公开chartsCount/dataReady就绪等待，未改产品逻辑。
- 真实EURUSD M5→MN及M5→W1双图验收分别退出0（/tmp/mw-high-period-neighbor-ready.log、/tmp/mw-week-neighbor-ready.log）：旁图XAUUSD/M15的品种、周期、时间范围严格保持，水平线保留、时间范围同步关闭状态保留；目标图水平线保留，保存刷新目标视区一致，无页面异常。
- 以上使用已有开发数据，尚不能关闭冷加载、连续切换、显式日期范围及撤销栈影响等缺口。周线可视区是否应自动靠近最新K线仍需单独检查；目前最新K线可见断言仅覆盖月线。

### 高周期原生撤销能力：实际操作验收失败

- 扩展advanced-monthly-live.browser.cjs，最新K线可见断言覆盖全部D1/W1/MN，真实M5→W1通过（/tmp/mw-period-undo.log，退出0）；日志记录公开undoRedoState，单凭enableUndo=true不能证明旧操作仍可撤销。
- MARKET_WATCH_EXERCISE_UNDO=1逐步调用公开executeActionById("undo")，要求能撤销切周期前创建的水平线。/tmp/mw-period-undo-actions.log退出1：切换前最后操作为创建水平线，切换后6个撤销项全部是date range lock，全部撤销后水平线仍存在。
- 这证明现有widget.load重建预算方案破坏旧撤销历史，恢复同步产生的新操作掩盖了问题。该问题是交付缺口，不能以按钮可用或画线保留代替通过；须调整高周期请求量控制方案或找到公开支持的状态保留路径。供应库不修改。
- 此测试分支故意保持失败并在实际绘图撤销成功前不宣称高周期收口。该分支不执行后续保存恢复验收，常规分支仍独立验证保存恢复。

### 保留模型的公开缓存重置对照

- 新增测试侧MARKET_WATCH_RESET_BUDGET_PROBE=1，禁用产品重载回调，仅拦截第一次过大的MN请求，设置3根视区间距，明确取消旧请求，再调用公开widget.resetCache/chart.resetData。后端历史HTTP始终被拦截，不下载大范围历史。
- /tmp/mw-reset-budget.log进程退出1，重置后的MN请求limit=100，超过4根预算；resetData无法直接代替widget.load满足近期首屏目标。此探针未接入产品。
- 只读供应库公开方法实现确认resetData调用mainSeries.rerequestData，按视区确定首次数量的featureset在模型创建路径执行；未修改供应代码。
- 下一步对照渐进返回完整覆盖的近期数据与原生后续请求行为，要求同时满足真实可见、完整历史可继续加载、撤销历史不丢失，不能伪造noData或以无声截断请求冒充完成。

### 部分返回与切换前重置对照

- MARKET_WATCH_PARTIAL_HISTORY_PROBE测试仅返回已完整覆盖的4根近期月线，meta仍noData=false，挂起后续请求以观察呈现。/tmp/mw-partial-history.log退出0仅代表探针完成：原生继续请求184根，dataReady=false、视区0/0；截图/tmp/mw-partial-history.png仍是旧M5画面。因此部分回调不能证明渐进月线显示，未接入产品。
- 公开featureset request_only_visible_range_on_reset和只读实现说明重置时可按当前可见根数重新请求。改变时序：M5仍有数据时设置3根间距，resetCache/resetData，等待M5就绪，再切MN。
- MARKET_WATCH_RESET_BEFORE_PERIOD_PROBE=1请求预算对照/tmp/mw-reset-before-period.log退出0：M5重置请求3根，后续MN请求3根；高周期HTTP拦截未下载远期历史。
- 同模式真实EURUSD月线+MARKET_WATCH_EXERCISE_UNDO=1验证/tmp/mw-reset-before-period-live.log退出0：最新月K可见，重置前及重置后创建的两条水平线均能通过公开undo实际撤销，未重载widget。同期同步guard产生多余date range lock撤销项，仍需处理。
- 尚未产品化：原生周期按钮不能假定会先执行预备重置，需验证公开事件时序或另一公开适配机制；不能把测试提前准备步骤当成原生操作已修复。当前产品原widget.load路径的撤销缺口仍开放。

### 公开周期事件内重置正式替代widget重载

- MARKET_WATCH_INTERVAL_RESET_PROBE对照确认onIntervalChanged触发时chart.dataReady=true，旧视区仍可用；同步设置间距后resetCache/resetData使首次MN请求3根（/tmp/mw-interval-reset.log退出0）。此前getBars阶段再重置已太晚。
- 产品recordPeriodChange使用上述公开API；去除widget.save/load重建预算、workspaceEpoch推进、异步恢复分支及对应临时状态。明确timeframe意图、正在加载或旧数据尚未就绪时不调整。供应库未修改。
- 正式请求量测试/tmp/mw-event-reset-budget.log退出0，仅MN 3根请求。真实M5→MN并逐步undo至画线消失通过（/tmp/mw-event-reset-undo.log退出0），workspaceEpoch不变；不会重载工作区清空撤销历史。
- 双图EURUSD M5→MN、XAUUSD M15旁图品种/周期/视区/画线保留及保存刷新通过（/tmp/mw-event-reset-neighbor.log退出0），无页面异常。
- 分页、range-sync和viewports专项均通过，前端build通过（/tmp/mw-event-reset-build.log）。同步guard额外产生date range lock撤销项仍存在；连续切换、明确日期范围、冷加载和实际原生按钮点击路径尚须验证，不能由公开setResolution测试扩张为全部完成。
