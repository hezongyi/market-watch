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

### 原生周期菜单真实点击验收

- advanced-monthly-live.browser.cjs新增MARKET_WATCH_NATIVE_PERIOD_CLICK=1，通过供应库内层iframe的可访问按钮“5 分钟”打开周期菜单，点击“1 月/1 周”；不调用setResolution代替用户切换。
- 原生月线菜单点击后最新K线可见，公开undo实际逐步撤销到切换前水平线消失，无页面异常，/tmp/mw-native-period-undo.log退出0。
- 原生周线菜单点击后最新K线可见，画线保留、保存刷新时间视区严格一致，无页面异常，/tmp/mw-native-week-restore.log退出0。
- 最初定位探针因iframe URL假设和按钮文字/可访问名称不同失败，按实际DOM修正；最终使用角色及准确可访问名称，无坐标硬编码，临时DOM输出已删除。
- 连续快速切换、显式日期范围、冷加载和同步操作撤销污染仍需独立收口。本次只扩大原生菜单实际操作覆盖范围，不宣称整个模块交付完成。

### 单图撤销污染修复与八图未通过记录

- rangeSyncLoadingGuard避免写入相同同步值，并仅在存在多个图表时临时关闭同步；单图仍跟踪加载就绪，保留自动保存保护。
- 新增原生setter调用计数测试，改前初始化重复写入断言失败，改后通过。仅去重不足以消除实际undo污染；跳过单图同步开关后，/tmp/mw-single-undo-clean.log退出0：首次undo恢复M5，第二次undo删除水平线，只有change resolution/create LineToolHorzLine两个操作。
- 浏览器用例新增单图originalUndoText必须为change resolution断言，避免以后退化为仅enableUndo=true的弱验证。
- 八图鼠标回归/tmp/mw-sync-guard-eight-regression.log退出1，尚未进入全部鼠标/保存阶段：目标视区1790619900..1790630700，黄金M5右边界1790632800（相差2100秒），黄金M15亦延长，其他品种在周期容差内。需要对照原版本及交易时段，不能宣称多图回归通过。当前候选修复未部署。

### 黄金休市边界对照定位

- mixed-viewport验收增加MARKET_WATCH_VIEWPORT_END固定UTC秒时间与MARKET_WATCH_RANGE_GUARD_SOURCE测试侧脚本替换，避免随当前行情漂移而比较不同时间窗口；不修改产品供应库。
- 使用585178c的旧range-sync（/tmp/mw-range-sync-before-single-fix.js），固定1790619900..1790630700重现同一失败（/tmp/mw-gold-gap-baseline.log退出1）：XAUUSD M5/M15右端1790632800。新旧逻辑结果完全相同，排除本次单图撤销改动为该边界偏移的原因。
- 目标结束2026-09-28 21:25 UTC=纽约17:25，黄金实际右端22:00 UTC=纽约18:00；后台scheduled_open明确排除黄金纽约17点整小时。前端resolveSymbol当前所有NY17品种均声明1700-1700:23456，尚未表达黄金休市，这是待验证的日历元数据缺口，不能直接断言改session即解决。
- 固定共同交易窗口2026-09-28 16:00..19:00 UTC，现产品八图鼠标十字线、缩放、拖动、关闭同步、自动保存及刷新恢复整轮通过（MARKET_WATCH_MOUSE_CHECK=1，/tmp/mw-fixed-open-eight.log退出0）。未放宽原边界断言，休市范围仍保留失败用例。
- 跨休市段同步语义及前端session与后台分桶一致性仍开放，不能以共同开市时段通过替代休市边界验收。

### 黄金显式休市session对照

- 测试侧MARKET_WATCH_GOLD_SESSION_PROBE=1仅包装resolveSymbol，将黄金session声明改为1800-1700:23456，其他路径保持原样，不修改产品或供应库。
- 固定休市窗口对照/tmp/mw-gold-session-probe.log退出1，右边界同步断言仍失败。显式声明休市不能直接解决该时间端点落在无交易区间时的同步表现；不将其接入产品作为已完成修复。
- 还必须核对session改变对后台NY17锚定H4的影响：实际黄金交易从18点恢复，而后台H4以17点起桶，不能无验证地以交易开始替代分桶锚点。后续应结合绘制坐标、相邻有效K线和H4/D1时间定位验证，不伪造休市K线，也不放宽所有时间范围断言。

### 黄金直接设置与同步设置的差异证据

- 增加MARKET_WATCH_GOLD_DIRECT_RANGE_PROBE：先从EURUSD同步目标范围，再关闭同步，对黄金M5直接调用setVisibleRange同一目标，比较结果。
- 首次固定15秒等待未满足8图就绪，NZDUSD仍为0/0；测试改为等待所有图dataReady、有效视区且rangeGuard空闲（180秒上限），不以加固定sleep替代就绪信号。
- exportData辅助读取触发供应包缺失zh.20866.faac5bd68021c0ca72d1.js/export-data.bb1bdc415916b47fed24.js，/tmp/mw-gold-direct-ready.log退出1；从该范围对照中移除导出依赖，导出缺口保持开放。
- /tmp/mw-gold-direct-only.log退出1，直接范围为1790619900..1790628900（纽约16:55），同步范围为1790619900..1790632800（纽约18:00），目标右端纽约17:25。两路径选择了休市段两侧不同的有效K线，不能以“原生都一样”关闭问题。
- 下一步应统一休市边界定位语义并验证鼠标/同品种跨周期/不同品种场景；失败断言保留，不扩大容差掩盖差异。

### 黄金范围稳定性与导出原包核对

- /tmp/mw-gold-range-settled.log退出1（保留同步/直接一致性的失败断言）：直接设置立即范围与等待2秒范围完全相同，均为1790619900..1790628900；恢复dateRangeSync=true并再等2秒仍相同。排除立即读值尚未绘制这一解释。
- 这仅证明公开直接设置能稳定保留休市前边界，并不证明可直接加入自动修正；仍须验证活动图、连续鼠标拖动及反馈循环，再决定统一定位实现。
- 原始/home/quant/repos/research/TV_v31.1.0_0430.zip只含export-data.08f805e72958605fab59.js和export-data.48adcc30df9b6625a837.js，不含当前运行runtime引用的export-data.bb1bdc415916b47fed24.js，也无20866模块文件。不能把其他hash重命名冒充兼容模块。
- 已异步请求用户向分发方索取当前版本匹配完整包，列明两个缺失文件；未因该资源缺口停止其他工作，未改供应代码。

### 同步开关组合与原生日线回归

- MARKET_WATCH_RANGE_SYNC_ONLY=1在固定休市窗口关闭timeSync，保留dateRangeSync；/tmp/mw-range-only-gap.log退出1，同步右端18:00、直接设置16:55的差异不变，排除双同步开关叠加为根因。
- 已异步请求用户明确休市段口径：保留原生相邻有效K线边界，或要求所有图精确同一时钟范围。未收到答复前不按默认选项视为批准，不关闭休市边界缺口；其他工作继续。
- 原生M5→1日菜单点击、最新日K可见、画线保留及保存刷新视区严格一致，通过（/tmp/mw-native-day-final.log退出0）。
- 核对deploy/backup-and-restore.md与实际文件，发现/home/quant/.local/libexec/trading-alerts-pg提供PG14客户端包装器。此前因未找到工具而保留的备份恢复测试应重新核查执行条件，不能继续当作工具缺失阻塞。

### 无供应包补件的替代导出实施起点

- 用户明确两个缺失文件无法补齐。开始独立CSV导出实现，不修改供应代码、不隐藏现有原生入口，不将其他hash重命名冒充兼容资源。
- backend/alerts/chart_export.py实现行情页+Python指标结果编码：UTC原始起止时间与毫秒值、价格口径、日历、OHLC原始精度、可用volume、complete/revision，指标按K线时间对齐，预热空值及缺失volume留空。输出UTF-8 BOM；拒绝重复/乱序行情，避免电子表格解释用户文本为公式。
- backend/tests/test_chart_export.py通过，ruff检查通过。当前仅完成编码层，尚未API/界面接入；不把可用缓存等同指定区间完整数据。接入前必须复用历史覆盖检查/补数流程、限制导出范围和处理失败。
- 原生内置指标导出限制尚未由用户确认接受，仍保留缺口；Python结果通路可复用现有计算，不重写指标算法。

### 替代导出API与覆盖门槛

- 新增认证POST /api/charts/export，指定instrument/timeframe/start/end和Python指标；时间范围按K线start落入半开区间筛选。使用现有品种resolve、queue_history/covers_interval，向完整桶边界规划原始历史覆盖，末端不超过已可获取分钟。
- 覆盖不足返回202 pending及任务ID，失败返回409及失败任务ID；不会返回CSV伪装完整下载。覆盖完成后复用charts data指标计算结果并CSV编码，no-store及attachment响应。
- 初始单次2000根/366天界限明确返回413/422，不静默截断。跨页大导出和下载界面仍需接入/完善；CSV模块没有供应库依赖。
- 新增认证、已有K线但覆盖不足、覆盖完成CSV内容、非法范围验收；test_chart_export.py与test_chart_workspace.py合计21 passed（/tmp/mw-export-api-tests.log），ruff检查通过。测试覆盖门槛使用可控覆盖返回，真实补数到下载的浏览器整链路尚未验证。

### 替代导出网页入口与受控交互验收

- 原生header扩展按钮“导出CSV”发送当前活动图品种/周期/主题与Python研究参数；保留原生供应库菜单，不修改供应代码。Python研究通过公开getAllStudies/getInputValues提取，与现有catalog匹配，不误把内部合成symbol当公开输入。
- 新增ExportDialog原生dialog：UTC起止选择、Python指标复选框、覆盖pending轮询、下载、失败提示、关闭/Escape取消前端等待；凭据仍由同源apiResponse持有。说明当前不含原生内置指标、未收盘数据可能变化、2000根及366天限制。
- /tmp/mw-export-ui-python.log退出0：真实按钮点击、选择日期、Python EMA规格传递、受控202后200响应、下载字节校验、关闭后重开及Escape关闭通过。前端构建通过（/tmp/mw-export-ui-build2.log）。响应在测试中拦截，不等于真实补数到CSV整链路已通过；运行API仍需加载新代码。
- 明暗主题使用widget.getTheme，浅色截图/tmp/mw-export-dialog.png已检查并修正说明文字对比度、全局checkbox尺寸污染。暗色与手机视图仍需进一步检查。
- 仍需失败任务重试入口、真实后端下载、指标参数和数值一致性、取消后无额外下载验收。原生指标导出限制未获得用户确认，不关闭该缺口。

### 导出失败重试、关闭取消与真实API

- ExportDialog根据409中的合法UUID任务显示“重试历史补数”，复用market-data/retry后继续导出；错误时清除旧加载提示，非CSV成功响应拒绝下载。读取blob后再次检查abort，防止关闭窗口后下载。
- /tmp/mw-export-retry-cancel.log退出0：受控失败→点击重试→pending→CSV下载；再次pending时Escape关闭，跨过轮询间隔后请求数不增加、下载总数仍为1。前端构建通过（/tmp/mw-export-retry-build.log）。
- 开发API原PID2212692使用.env配置；先由同环境Settings确认数据库trading_alerts_dev且delivery_enabled=false，再有序重启为PID2496024加载导出接口。未改生产环境。
- 真实认证HTTP导出EURUSD M5 2026-09-28 12:00..13:00 UTC返回200，CSV12行、时间半开边界及EMA(20)非空值检查通过，文件/tmp/mw-real-export.csv。该区间已有覆盖，仅证明真实缓存命中API链路，不代表冷加载补数/指标独立数值对照已完成。

### 真实冷历史到CSV验收

- 在trading_alerts_dev只读检查stored_coverage：EURUSD 2025-06-03 12:00..13:00 UTC无覆盖，未删除或篡改既有数据来制造冷缓存。开发chart_history_worker PID1985819实际运行。
- 真实认证POST /api/charts/export请求该小时M1，不拦截接口：首次202，2.0秒后200（/tmp/mw-export-cold-live.log退出0）。worker拉取后的CSV严格60行，start_ms为请求小时每分钟连续序列，全部complete=true，文件/tmp/mw-cold-export.csv。
- 新增scripts/verify_csv_export.py：固定本地开发API，密码从环境指定的凭据文件读取；--require-pending要求观察真实pending，普通模式验证缓存命中。已缓存区间复测退出0（/tmp/mw-export-script-warm.log），ruff通过。用户选择的日期应为完整交易小时；休市不应期待60根。
- 该证据关闭小范围真实补数→覆盖完成→CSV响应链路的不确定性；网页到真实接口的下载、多个周期/指标参数及大范围性能仍独立验收，不能把M1一小时推广为全部导出场景。

### 网页真实CSV下载与隔离恢复执行结果

- MARKET_WATCH_EXPORT_LIVE_CHECK=1通过真实原生header按钮打开表单、选择UTC小时、包含Python EMA，不拦截任何下载响应。/tmp/mw-export-browser-real.log退出0：实际浏览器下载12行EURUSD M5，每行时间戳精确匹配指定小时、EMA列存在且有数值、页面异常为空。此例使用已有覆盖；真实冷补数另见前节。
- 使用已有remote-postgres-test凭据且断言dbname=trading_alerts_test，匹配PG14包装器执行test_postgres_dump_restore_of_signal_and_outbox。/tmp/mw-backup-isolated-restore.log为1 failed：测试账号CREATE DATABASE权限不足，创建backup_source_<uuid>时即失败，尚未执行dump/restore。
- 不再将恢复专项描述为客户端缺失；当前限制是隔离数据库创建权限。未提升权限、未修改生产库、未创建临时库成功。下一步寻找独立临时PG实例或已有获授权隔离恢复通路，不把权限失败计为通过。

### PostgreSQL真实隔离恢复通过

- Ubuntu官方PG14.24包仅下载并解压到/tmp/mw-pg-restore-tools，不安装系统服务，匹配已有PG14.24客户端。
- 使用mkdtemp创建独立临时PG集群。首轮Unix socket URL被备份工具的连接选项白名单拒绝（/tmp/mw-pg-local-restore-test.log），未调整产品接口或共享PG权限；改为仅127.0.0.1:55439监听后重测。
- test_postgres_dump_restore_of_signal_and_outbox真实执行通过，1 passed in 1.06s（/tmp/mw-pg-local-restore-test2.log）：临时源库内生成信号/通知outbox，pg_dump归档、pg_restore到独立随机恢复库、所有业务表记录数核对以及临时恢复库删除验证。
- 测试后pg_ctl正常停止，确认postmaster.pid不存在并删除本次mkdtemp数据目录；原共享数据库权限和生产服务未变更。
- 此结果关闭备份工具本地PG14恢复专项，不等同已演练生产整站容器/TLS/配置恢复，后者仍按交付清单继续。

### 导出2000根边界误判修复

- 新增test_export_exact_limit_after_empty_leading_interval，在已覆盖但起点无K线的范围内构造恰好2000根，原接口误报413（/tmp/mw-export-limit-before.log，1 failed/2 passed）。
- 修复为复用数据接口查一根前驱K线，仅前驱仍位于导出范围时判定超过2000；空白时间和休市不能当作额外K线。超过2000仍明确拒绝，不截断文件。
- 新测试同时验证2000根返回200且CSV行数正确、2001根返回413。导出与图表工作区相关22项通过（/tmp/mw-export-limit-after.log），ruff通过。

### 当前完整后端与适配脚本回归

- 当前后端完整运行150 passed/5 skipped（/tmp/mw-backend-current-regression.log）。其中四项PG专项使用trading_alerts_test补跑4 passed（/tmp/mw-postgres-current-regression.log）；剩余备份恢复专项已于上一节独立PG14实例通过。不同执行环境的证据分别保留，不宣称单次全绿。
- Advanced Charts非浏览器JS专项共11个全部通过（/tmp/mw-advanced-js-regression.log），覆盖时间转换、工作区、偏好、自选、自动保存、历史分页/去重/重置、同步保护及视区恢复。
- 发现advanced-time测试VM遗漏crypto，全文件初始化即报ReferenceError；补入Node webcrypto后原时间转换断言正常执行通过，未修改产品时间算法。初次批量选择误包含advanced-browser.cjs，随后明确排除所有browser脚本；上述11个通过不包含浏览器验收。
- 部署配置检查确认Dockerfile/.dockerignore包含所有当前适配脚本；镜像构建运行、HTTPS反向代理与生产切换仍未执行，此静态检查不替代部署验收。

### 连续日内周期切换验收

- advanced-monthly-live增加MARKET_WATCH_RAPID_PERIOD_CHECK：真实EURUSD从M5经M15/M30/H1/M5/M15/M5，每次间隔100ms，不等待前次加载完成；预先创建水平线。
- /tmp/mw-rapid-period-live.log退出0，最后M5数据就绪且rangeGuard无待处理状态，等待额外3秒后周期仍为M5、工作区epoch不变、画线1条、视区有效且页面异常为空。
- 该用例覆盖日内周期快速替换，尚不覆盖高周期与日期范围同时切换、冷数据量性能或全部原生菜单鼠标操作，继续保持对应边界待验收。

### 高周期快速切换预算缺口

- 请求预算测试新增MARKET_WATCH_RAPID_HIGH_PERIOD=1：M5加载后以100ms间隔切D1/W1/MN/D1/MN，高周期HTTP全部拦截，避免验证触发多年M1下载。
- /tmp/mw-rapid-high-budget.log退出1，捕获D1=90、W1=90、MN=90；后一周期数据尚未就绪时沿用前次90根预算，超出周/月初始目标。现有recordPeriodChange在!chart.dataReady时跳过，单次切换通过不足以证明快速切换通过。
- 保留失败用例，下一步需要实现加载中周期切换的请求预算处理，且继续保证撤销历史、最终周期、画线与明确日期范围意图。不通过扩大预算阈值或忽略中间请求关闭该问题。

### 加载中放开预算重置条件的否定验证

- advanced-high-period-request新增仅测试使用的MARKET_WATCH_LOADING_BUDGET_PROBE路由替换：只去除recordPeriodChange的!chart.dataReady条件，不改供应库或产品脚本；仍拦截全部高周期历史HTTP。
- /tmp/mw-loading-budget-probe.log退出1：快速D1/W1/MN/D1/MN捕获请求量90/91/90/90/90。说明简单允许加载中setBarSpacing+resetData不能重建请求预算，不能将删除保护条件作为修复提交。
- 下一步需要验证加载期间原生时间轴保留旧可见柱范围的行为，以及公开API对切换请求串行化/时机控制的支持；保留撤销、绘图、最终周期和显式日期范围不变的要求。

### 快速切换期间公开日期范围与延迟重置对照

- 快速切换场景仅测试替换recordPeriodChange，通过onIntervalChanged parameters.timeframe指定time-range；/tmp/mw-interval-range-probe.log退出1，D1/W1/MN均请求195根。与此前单次切换的无效timeframe实验一致，不再将该方向当作未经验证的新候选。
- 另一独立对照：同步reset后下一animation frame再次reset，且只处理仍为该周期的图；/tmp/mw-deferred-reset-probe.log退出1，请求90/100/100/90/90。延迟一次绘制仍不能获得正确周/月预算。
- 只读检查分发库：force reset的根数来源为timeScale.visibleBarsStrictRange().count()，不是公开barSpacing的直接倒数；加载中旧范围/空范围可使间距调整不能生效。未修改供应库，也未访问内部对象实施修复。
- 两个临时路由探针已从测试脚本移除，保留现有失败回归与日志。下一步应验证原生加载期间是否可通过公开交互时序避免继承旧范围；若做不到，需要明确产品级请求调度方案，不应继续重复间距/timeframe变体，也不能静默截断countBack或用noData掩盖。

### CSV冷历史导出按窗口补数，提前拒绝已知超限

- 新回归实际触发export接口：一年M1冷数据旧实现将整年交给queue_history，/tmp/mw-export-preflight-before.log为1 failed/3 passed。
- export在补数前查询最多2001根实际目标周期K线，已知超过2000立即413，不创建缺口任务；不以自然时间长度判定休市区间超限。
- 冷数据只规划最新缺口的一个有界窗口：至少4000分钟，按周期需求扩大但最多31天；下一次轮询重新检查根数后再向前规划。复用覆盖记录与任务去重，避免无效一年M1导出一次排满队列。用户关闭导出后已排入的当前窗口仍可继续，不再自动排入整个剩余导出范围。
- 新增三个窗口连续覆盖、空区间不误拒绝、完成后不重复排队验收；保留恰好2000/2001边界、鉴权和CSV字段验收。/tmp/mw-export-staged-tests.log：24 passed，ruff通过。
- 此轮为接口集成与受控覆盖测试，开发运行API尚未重启加载该改动，真实worker分阶段大范围补数仍需验收；快速高周期切换缺口未关闭。

### 分段导出真实任务规划去重及失败边界

- 新增export接口测试，不替换queue_history或stored_coverage，使用隔离SQLite业务表真实执行任务规划。
- 一年M1连续两次导出请求均202，返回同一任务ID，数据库仅1条4000分钟任务；将该任务置为failed模拟上游失败后，第三次请求409并返回准确failed_task_ids，不继续创建更早窗口任务。
- /tmp/mw-export-real-queue-tests.log：6 passed，ruff通过。此证据覆盖实际任务规划代码的重复轮询和失败边界；不替代远程行情worker及PostgreSQL并发验收。

### 前端队列发送前取消过时历史请求

- 请求等待四路桥接并发空位时，周期/品种/工作区可能已变化。drain现在发送前重新核对历史请求的工作区epoch与仍使用对应symbol/resolution的图表；过时请求返回HISTORY_CANCELLED，不发往后台创建补数任务。
- historyQuery去重键包含workspaceEpoch，避免新工作区的相同查询复用待取消旧请求；同一工作区当前图表和比较指标的共享需求继续复用。
- advanced-request-cancellation实际运行bridge队列，覆盖旧周期取消、新工作区相同查询重新发送和当前查询正常完成；history-dedup/pagination/reload相关专项全部通过。
- /tmp/mw-rapid-high-current.log本轮未到达切换断言：NZD_USD的M5首次历史响应持续pending，data-ready等待超时。只读数据库观察到chart worker仍有有效租约的running任务；未据此重启或另起worker。该结果不作为高周期预算通过/失败证据，也不关闭最终周期继承旧预算问题。

### 快速高周期切换的缓存恢复调度候选

- 请求量验收脚本支持指定品种及M5缓存截止点，用实际本地EURUSD M5数据规避实时未完成覆盖；高周期请求始终拦截。/tmp/mw-rapid-eur-frozen.log复现D1/W1/MN均90根，确认失败来自连续切换而非NZD_USD冷数据等待。
- 独立测试路由替换候选：加载中再切周期时，通过公开setResolution恢复已知缓存M5，再切用户最后选中周期。没有widget.load，也没有截断countBack或修改供应库。
- /tmp/mw-period-scheduler-probe.log退出0，请求D1/W1/MN/D1/MN为91/13/3/90/3根，首次找到连续切换满足预算的候选。M5由真实缓存API供给，高周期响应为受控error；这只证明预算约束，不证明最终高周期数据就绪、撤销历史、多图、显式日期意图或原生菜单点击。
- 原型保留在/tmp/mw-period-scheduler-probe.js，固定M5恢复不能直接作为产品修复；临时产品路由已移除。下一步按各图最后就绪周期记录并处理工作区/品种取消，完成真实数据与撤销验收后才能接入产品。

### 用户调整周期策略：日线优先、周线后台、月线本地

- 用户明确授权：D1及以下优先；W1可后台低优先级补数；MN仅本地已有D1生成，避免误点月线产生大任务。此前快速高周期首屏90/13/3统一预算不再是需求门槛。未接入的period-switch.js候选已删除。
- queue_history支持后台priority=200；普通图表priority=100，同一缺口被普通图表需要时提升既有任务优先级，不重复建任务，后台请求不降级共享任务。原监控与恢复任务继续使用<100的独立worker。
- MN/history直接读取本地D1聚合结果，不调用queue_history；Datafeed显示现有月份并在本地边界返回noData，不冒充上游已无历史。空缓存提示暂无本地月线。月线CSV同样不触发补数，导出界面注明仅已有数据。
- W1接口返回background及5秒轮询建议，前端提示后台排队、暂无法估算耗时；其他周期保留前台路径。可靠耗时估算、周线长等待时对保存/同步的影响及整段后台需求持续性仍需进一步收口，不能将此基础优先级改动视为全部完成。
- /tmp/mw-tiered-history-export-tests.log：27 passed；新增monthly-cache JS覆盖空缓存、少量月份及超过单页上限的本地历史读取，原分页与请求取消测试通过；/tmp/mw-tiered-build.log前端构建通过，ruff检查通过。
- 真实浏览器脚本advanced-monthly-local.browser.cjs已准备。本次新开发API 8002启动失败：PostgreSQL开发账号连接数已达限制；浏览器未取得功能验收结论。未提高生产数据库限制或终止其他连接，未把连接失败算作功能通过。实际API未完成更新验收，生产未部署。

### 开发连接数耗尽定位与连接池预算

- 只读数据库观测确认开发角色连接上限8，8条连接均来自Ubuntu 192.168.7.232；其中5条idle且无事务超过1小时。仅终止预先核对的这5个开发库/开发角色/开发IP会话，并在执行时重新检查idle、无事务及空闲时间；未调整共享PostgreSQL限额或生产账号。
- 应用PostgreSQL连接池改为每进程默认2连接、overflow=0、等待15秒，启用pre_ping并设置application_name；通过环境变量可独立配置。SQLite原路径保留。新验收API8003 application_name=market-watch-dev-acceptance。
- 连接池实际耗尽/释放复用回归通过；与行情/导出测试合计28 passed（/tmp/mw-pool-tiered-regression.log）。运行数据库再次检查：旧进程3条idle，新验收API2条idle，总计5条，恢复余量。
- 通过Vite5189直接代理8003完成真实月线首次加载及绘图；快速W1/MN/W1/MN后月线dataReady=false且范围0/0，/tmp/mw-monthly-local-direct.log失败。月线请求返回local_only且无任务，周线响应error；最终月线未重新向后端发请求。需继续定位原生缓存/取消回调，不以月线接口无补数代替完整切换通过。
- 浏览器测试取消了route.fetch全API转发，改用真实Vite代理，避免SSE/events请求无法完成导致测试转发超时。当前留下最终月线等待失败断言及请求轨迹。

### 周线失败回调不再阻塞后续周期

- W1后台补数返回失败时，Datafeed原先调用原生error，导致原生周线模型保持失败/未完成状态；快速随后切MN时月线停在dataReady=false、range=0/0。现改为对W1完成空数据边界（noData=true），同时保留失败任务、重试入口和后台提示，允许后续周期继续切换。
- `advanced-weekly-error.cjs`、分页和请求取消专项通过。真实连续W1/MN浏览器场景仍在验证，上一轮缓存静态源记录的旧行为仍失败，需用最新桥接重跑。

### 连续周/月切换真实验收通过

- 原生库对空数据边界不会触发dataReady，range-sync因此会永久保留加载锁。新增2.5秒空边界收尾：正常dataReady会提前完成，明确无数据时也会恢复同步和后续操作；计时器在正常回调时清理。
- `advanced-monthly-local.browser.cjs`使用最新bridge、Vite5190和重启后的API8004真实运行，连续W1/MN/W1/MN后通过：`/tmp/mw-monthly-latest2.log`记录最终1M、有效视区、画线1条、无页面异常；7次月线请求均local_only且无任务。
- range-sync、周线错误、历史分页及请求取消专项通过。该证据覆盖用户确认的月线本地策略和快速切换空数据边界；仍需整体验收其他周期、多图及部署项。

### 最近一次全量专项回归

- 后端周期策略、连接池、导出及工作区相关测试：47 passed（/tmp/mw-tiered-final-backend.log）。
- 前端关键专项：range-sync、历史分页/去重/重载、请求取消、周线错误边界、月线本地缓存、自动保存、视区恢复共9项通过（/tmp/mw-tiered-final-js.log）。
- 月线真实浏览器连续切换已在上一节通过；工作树保持干净。八图和真实鼠标回归仍依赖既有专项证据，尚未在本轮连接池及周期策略变更后重跑。
