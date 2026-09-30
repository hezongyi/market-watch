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

### 修正同步保护的固定超时（2026-09-30）

- 审查确认此前“2.5秒空边界收尾”的描述不准确：计时器实际作用于全部加载。新增受控计时器回归，在数据尚未就绪时运行计时器，旧代码失败（busy错误变为false）。
- 删除固定超时；正常非空请求等待原生dataReady。Datafeed请求开始时捕获匹配品种/周期的加载token，明确返回空边界后延至下一事件循环收尾；旧周期、旧工作区和已销毁guard的结果不能解除新加载保护。
- range-sync回归覆盖慢加载、单图空结果不释放另一加载图、旧结果、移除图表和销毁；monthly-cache实际bridge回归覆盖空结果收尾及非空结果继续等待。周线错误与过时请求取消专项亦通过。
- 本项尚待真实浏览器重新验证；不沿用固定超时版本的连续周/月切换通过结论。八图session69680仍运行且持续pending，未重启或计为通过。周线错误返回noData及错误提示仍是独立待处理问题。

### 持续pending的运行证据与错误提示修正

- session69680经再次轮询仍运行，历史响应持续pending，未重新启动测试。开发库查询确认chart worker有有效running租约，37条左右待处理任务；运行日志OANDA连续46.506秒结束且ingest未开始，Binance请求和入库正常。
- 相同开发目录配置通过192.168.7.33:7890访问OANDA返回200（约0.59秒）；直接连接ConnectError。调用实际fetch_oanda读取worker涉及的2026-09-30 03:47–03:48 UTC EUR_USD区间，1根、0.62秒。此证据指向运行worker与新调用之间的配置/连接状态差异，尚未确认具体根因，不能宣称上游整体慢或重启已解决。
- 发现空消息httpx异常被存成空字符串，新增ReadTimeout回归先失败后修复：空消息保留异常类名，不改变游标和退避。行情专项21 passed（/tmp/mw-history-error-regression.log）。
- 周线失败提示改为明确失败及可重试，不再声称已排队；对应前端回归先失败后通过，历史重载专项也通过。此改动不代表周线noData缓存及真实重试闭环已验收。

### 周/月切换与原生错误回调对照

- 主动结束session69680（exit130），原因是已确认worker OANDA失败持续阻碍八图功能验收，不计为八图通过。未清除数据库任务。
- 移除固定超时后的真实周/月连续切换验收session43781退出0：/tmp/mw-monthly-explicit-completion.log记录7次请求、最终月线有效视区、1条画线、errors为空；所有月线响应local_only且无任务。
- 单独对照仅将周线失败的空结果改为原生error回调；session95942退出1，最终月线dataReady=false/range0/guard=true，周线error后没有新月线HTTP。日志/tmp/mw-monthly-weekly-native-error.log。因此撤回该候选，保留经过验证的兼容空结果。
- 新周线专项实际运行bridge的失败、确认重试、pendingHistory完成和reloadHistory路径，验证重试后先清匹配缓存、再重载对应图表。此为适配层回归，尚不替代真实UI重试与原生缓存验收。
- 当前配置使用实际import_once执行三个有限开发补数页面，分别0.72/0.64/0.84秒完成；进程退出并释放连接，没有启动另一常驻worker。既有worker的配置/连接差异仍待定位。

### 常驻worker诊断可观测性

- 核对原启动记录：旧chart worker由后台Popen启动并写/tmp/mw-advanced-chart-worker.log，非当前可轮询的exec session；当前进程命名空间无法读取该后台进程信息。本轮未凭日志停止增长推断退出，也未重复启动常驻worker。
- 增加启动日志：实际模块路径、OANDA/Binance是否启用代理（布尔值）；失败日志记录source/symbol/异常类/attempt/status，不输出异常文本、账户URL或凭据。用于下次正常加载新代码时区分配置与连接故障。
- 新失败日志回归先失败后通过，行情专项21 passed（/tmp/mw-worker-diagnostics-tests.log）。旧worker尚未加载本轮改动，不能声称运行问题已解决。

### 固定历史八图回归开始

- 八图脚本增加显式MARKET_WATCH_HISTORY_BEFORE，仅测试请求固定before上界，仍通过真实API读取数据库；不会模拟行情响应。该模式不能证明实时或冷补数性能。初始品种统一EURUSD，保留第八图NZDUSD。
- session70373退出1：四品种八图均ready，初次历史请求不再pending；目标右端恰好位于固定数据截止点时，同步后其他图右端保留不同周期的未来留白，严格右边界断言失败（/tmp/mw-eight-fixed-history.log）。尚不能判为所有历史位置同步失败。
- 对照session89120将目标视区移到数据截止前4小时，其余配置不变，日志/tmp/mw-eight-fixed-interior.log；仍在运行，未计为通过。末端留白问题保持待处理。

### 数据内部八图严格验收通过

- session89120退出0（/tmp/mw-eight-fixed-interior.log）：真实历史上四品种八图M5/M15/M30就绪；三小时内部视区边界同步、鼠标十字线/滚轮/拖动、关闭同步保持其他七图不动全部通过。
- 脚本实际等待服务器保存八个_mwViewports与操作后范围逐一相等，再刷新并断言八图范围严格一致、同步关闭状态保持、errors为空。该结论仅覆盖固定历史区间，未覆盖实时补数及数据末端留白。
- 针对末端增加仅测试诊断开关MARKET_WATCH_EDGE_RANGE_PROBE：关闭两种同步后逐图通过公开setVisibleRange应用相同区间，输出实际范围/offset，区分原生同步行为与单图范围能力。session23943运行中，日志/tmp/mw-edge-direct-range.log；诊断输出不视为验收通过。

### 数据末端右侧留白对照结果

- session23943及69237均退出0。关闭原生同步后，逐图公开setVisibleRange得到八图相同边界与rightOffset=1；重新打开dateRangeSync/timeSync后仍保持相同边界。日志/tmp/mw-edge-direct-range.log、/tmp/mw-edge-sync-restore.log。证明单图公开接口支持该目标，差异出现在原生联动路径。
- 新增仅测试开关MARKET_WATCH_EDGE_SYNC_PROTOTYPE，监听活动图范围变化，仅对右侧有留白且偏差超过目标周期一根K线的图进行公开范围设置；session91208运行中（/tmp/mw-edge-sync-prototype.log）。候选尚未接入产品，尚需生命周期、用户关闭同步、保存及加载期间取消等验证，不能直接作为修复交付。

### 末端同步适配实施中

- session91208原型退出0：末端八图范围、鼠标十字线/缩放/拖动、关闭同步及自动保存刷新恢复通过（/tmp/mw-edge-sync-prototype.log）。已删除测试内嵌原型，保留诊断开关。
- 正式候选edgeRangeSync放入viewports.js，使用公开范围API；增加加载保护、工作区/布局生命周期、用户开关变更取消、错误提示及保存期间busy保护。新advanced-edge-sync.cjs验证对齐、加载跳过、用户关闭、销毁取消；既有range-sync/monthly-cache/autosave/viewports专项通过。
- 正式浏览器session58522已退出1（/tmp/mw-edge-product.log），initial-load已记录原生_getActive undefined iterable异常，不能算通过。尚未证明与新适配因果关系，保持页面错误断言。此候选尚未完成交付验证。

### 末端对齐加载取消回归

- 审查候选发现：异步对齐第一图期间切换品种/周期，若快速完成加载，后续图仍可能应用旧视区。新增回归先失败（cWrites=1），再订阅品种/周期变化使当前对齐generation失效，修复后通过；销毁和布局重新绑定清理全部订阅。
- edge-sync/viewports/range-sync/autosave/weekly-error/monthly-cache六项专项通过，源文件格式化并通过diff检查。
- session58522上一轮末端范围/鼠标/保存刷新断言执行到末尾，最终因initial-load原生undefined iterable异常失败，不能宣称整轮通过。新session45217运行同一末端场景，日志/tmp/mw-edge-product-recheck.log；初始化异常仍保留为待核实项，没有过滤。

### 初始化异常与末端适配对照

- session45217已退出1：范围、鼠标、自动保存刷新断言执行到最后，仍因initial-load原生_getActive异常失败（/tmp/mw-edge-product-recheck.log）。
- 增加仅测试MARKET_WATCH_DISABLE_EDGE_PROBE，将edgeRangeSync替换为空适配器；session53466正在运行内部历史区间，已同样记录initial-load undefined iterable。证据表明新增末端对齐函数不是该异常的必要条件；尚不能据此断定真正根因。没有过滤异常或将此轮计为通过。
- 为查旧worker，核对Ubuntu SSH主机公钥与本地/etc/ssh公钥一致后尝试本机SSH，认证返回Permission denied(publickey)。未绕过主机验证或修改授权；仍无法读取旧worker的宿主进程环境，未创建第二个常驻worker。

### 初始化异常定位至自选列表恢复空窗

- 关闭末端适配session53466最终退出1；headerReady等待单变量对照session6126也退出1，均保留原_getActive异常，等待工具栏不能解决。headerReady诊断分支已移除。
- 只读检查原生堆栈：_getActive直接解构Object.entries(this._lists)[0]；自有watchlists恢复先delete全部、await，再save列表，制造空集合。新增真实适配器回归在delete时模拟原生读者，旧代码失败。
- 改为先保存目标列表、激活有效目标，再移除过时列表。已保存空集合恢复为一个零品种原生容器，不注入默认品种；手机readonly仍不注册保存事件。自选回归通过。
- session40738正在运行正式八图末端/鼠标/自动保存刷新验收，日志/tmp/mw-watchlist-restore-eight.log；尚无最终结论，不能仅凭单测关闭初始化异常。

### 自选恢复修正后末端八图整轮通过

- session40738退出0（/tmp/mw-watchlist-restore-eight.log），使用正式末端同步适配且无测试原型替换。四品种八图末端三小时视区、十字线、滚轮/拖动、关闭同步、服务器自动保存、刷新逐图严格恢复全部通过，最终errors=[]。
- 此轮首次完整消除先前连续出现的_getActive异常，支持自选列表恢复空窗这一原因；不外推为所有原生菜单路径已经验收。
- 主题/手机脚本增加开发URL与固定历史上界参数；主题脚本补页面异常断言及按主题独立截图（此前仅打印errors不足以判定通过）。浅色主题session5115运行中，日志/tmp/mw-theme-light-current.log，尚未记为通过。

### 深浅主题保存恢复及视觉复核

- 浅色session5115、深色session60745均退出0；/tmp/mw-theme-light-current.log及/tmp/mw-theme-dark-current.log记录刷新主题正确、errors=[]。测试使用真实数据固定历史上界，不证明实时更新。
- 已人工查看/tmp/mw-theme-light.png、/tmp/mw-theme-dark.png：单图、原生上下左右工具栏、自选/详情在两主题正常显示，完成状态未覆盖底部按钮。截图行情与右侧报价时间不同，属于固定历史测试与当前报价并存；不作为报价实时性通过证据。
- 手机竖屏只读session70924运行中（/tmp/mw-mobile-current-portrait.log）；当前最新工作区为主题测试单图，本轮不宣称覆盖八图最大化阅读。

- 手机session70924退出1：日志出现5190反复ERR_CONNECTION_REFUSED，之后尚未就绪的图表setVisibleRange抛Value is null。当前不能计手机验收通过，需恢复/核对开发服务再验证，不直接归因于手机功能。
- 当前前端构建通过（/tmp/mw-current-web-build.log）。

### 恢复开发服务后手机竖屏通过

- 已核对旧API8004 session60593和Vite5190 session1730均exit143，随后恢复同端口开发服务：API session84407、Vite session16809；静态5187始终返回200。未操作生产服务。
- session14528退出0（/tmp/mw-mobile-restored-portrait.log）：手机竖屏单图切周期/视区后MOBILE_WRITES=[]、nativeReadonly=true、桌面草稿保留、errors=[]。该轮使用固定真实历史，不替代实时补数验收。
- 手机脚本进一步将切周期后的固定等待改成明确dataReady/有效范围等待，后续避免数据未就绪即设置范围；这一等待改动在上述运行启动之后完成，需后续用新脚本复验。

### 图表补数429限流退避修正

- 实际import_once回归证明：EURUSD返回429后，下一XAUUSD任务仍向同一OANDA源发请求。旧代码回归失败，说明原market实时轮询退避未覆盖图表任务失败。
- 图表/历史任务收到明确HTTP429时写入既有market_backoff源级记录，后续同源任务延后且游标保持；采用至少300秒退避，尊重更长Retry-After秒数/HTTP日期及已有退避，不通过异常字符串判断429。
- 新回归覆盖秒数、日期、无header回退，行情专项24 passed（/tmp/mw-rate-limit-tests.log）。未修改供应商包或生产服务。旧常驻worker尚未加载此改动。
- 通过异步问题请求用户停止Ubuntu宿主上的旧开发chart_history_worker；当前受限终端无法读取其进程，已核对主机身份的SSH仍publickey认证失败。等待协助期间其他实施继续，不标记整个目标blocked。

### 数据源退避隔离及周线让位验证

- 新回归创建20个处于源级退避的OANDA任务和一个可执行其他源任务，旧import_once只推迟第一条并返回false，回归失败。任务选择现整体排除退避源，仍保留领取后的退避复查，避免逐个任务消耗worker循环。
- 另以实际import_once验证较新的priority100前台任务优先于更早priority200周线任务；周线游标及attempts不变。此为调度执行测试，不仅检查数据库priority字段。
- 行情及导入专项27 passed（/tmp/mw-source-isolation.log）。运行worker尚未加载新代码，实时调度表现仍待验证；用户停止旧开发worker的协助请求仍待答复。

### 当前后端完整回归与PostgreSQL专项

- session77921退出0：当前完整backend/tests为164 passed、5 skipped（/tmp/mw-backend-current-full.log）。覆盖本轮源级退避、导入调度及既有预警/通知逻辑；不发送真实ntfy通知。
- session52421退出0：独立trading_alerts_test库内临时schema执行并清理，PostgreSQL并发触发/outbox租约及数据库迁移回滚专项4 passed（/tmp/mw-current-postgres-tests.log）。剩余备份恢复专项本轮未重跑，沿用此前单独隔离PG14恢复证据，不能称本轮全套无跳过。
- 能力盘点新增当前验收摘要，避免早期“外层工具栏待移除”等描述被误读为现状；完整原生工具菜单、周线后台持续补数、常驻worker及部署验证仍待完成。

### 手机八图最大化阅读验收启动

- 手机脚本MARKET_WATCH_MOBILE_EIGHT从真实已保存工作区中选择八图（仅测试GET列表排序，不改后端文档），验证活动图maximizeChart/restoreChart，然后临时切周期/视区并检查零写入和桌面草稿。
- session71924退出1，最大化/恢复断言通过，后续setVisibleRange Value is null。审查发现测试最大化activeChart却后续操作chart(0)，可能操作了隐藏图；已统一使用activeChart，未修改产品。
- session30516正在复验，日志/tmp/mw-mobile-eight-active.log；尚未计八图手机完整通过。

### 手机最大化后切周期问题继续复现

- session30516活动图修正后仍退出1，不能将先前问题归结为隐藏chart(0)。session35239关闭同步对照也退出1；错误前active EURUSD/M15、dataReady=true、width350、max=true，rangeGuard=false，其他图已就绪。
- 原生堆栈在setVisibleTimeRange读取series interval/symbolInfo的ensureNotNull失败；尚不确定原生周期完成Promise与内部系列状态时序，未改供应商包或过滤异常。
- session3384已退出1；增加第二次最大化后尺寸就绪等待、setResolution后让出事件循环，再复验原始流程（/tmp/mw-mobile-eight-layout-ready.log）。仍出现同一Value is null，不能关闭手机多图阅读验收。

### 手机八图不切周期对照通过

- session41027退出0（/tmp/mw-mobile-eight-no-period.log），只跳过切周期，保留八图最大化/恢复、视区移动、零写入及桌面草稿断言，errors=[]。证据将失败缩小到最大化后周期切换路径，不是最大化或八图阅读本身全部不可用。
- 新周期切换等待对照，新增仅诊断切周期后2秒等待，日志/tmp/mw-mobile-eight-settle.log；不把延时视为产品修复，不放宽异常断言。

### 用户更新手机范围：默认单图

- 用户明确手机不要求八图，默认单图即可。bridge在初始恢复及工作区加载后，通过公开setLayout('s')将手机只读实例设为单图，不写回桌面工作区。
- 手机脚本仍选真实八图保存文档作为输入，改为断言渲染只有一图，随后测试临时周期/视区与零写入。session51168退出1：单图断言通过，但周期后setVisibleRange仍Value is null（/tmp/mw-mobile-single-from-eight.log）。这一遗留桌面布局读取场景仍属必需修复，不因手机八图要求取消而豁免。
- 用户授权停止旧开发worker后，已在Ubuntu核对PID1985819工作目录/命令，发送SIGTERM并确认退出；未操作unraid生产。当前尚未启动新常驻worker。

### 当前开发worker恢复执行

- 在用户授权停止旧Ubuntu开发worker并确认PID1985819退出后，启动当前代码常驻worker session1714，日志/tmp/mw-current-chart-worker.log，application_name=market-watch-chart-dev。
- 启动日志确认模块来自advanced仓库且oanda_proxy=True；NZD_USD/XAU_USD/EUR_USD多个页面真实下载及入库成功，下载约0.439–1.646秒，旧46秒超时未在该观察窗口复现。证明当前连接恢复，尚不证明全部失败任务已恢复或长时间稳定性。
- 手机单图候选调整为先setLayout('s')再restoreViewports；正式八图文档输入、切周期及零写入复验session97671运行中（/tmp/mw-mobile-single-layout-first.log）。前一运行错误地使用跳过周期诊断参数，不作为通过证据。

- session97671已退出1，先布局后视区候选仍出现Value is null，已撤回该无效时序改动。

### 手机周期切换轮询对照

- session49635关闭poll并替换tick为空函数后仍退出1（/tmp/mw-mobile-no-poll.log），相同setVisibleRange Value is null；本轮证据不支持实时轮询触发此异常。临时no-poll诊断开关已删除。
- 当前worker日志继续记录OANDA真实下载/入库成功，约0.4–1.3秒，未再次观察到旧进程持续46秒超时。

### 手机激活对照与运行队列恢复

- session39520仅使用setResolution的doNotActivateChart选项仍退出1（/tmp/mw-mobile-no-activate.log），不能用该选项修复手机周期后Value is null。诊断参数已撤回。
- 开发数据库当前队列观察1432 complete、20 failed，无pending/running；说明新worker已排空待执行任务，但不代表旧失败任务全部恢复。
- 仅重新排队旧空异常的一分钟EURUSD开发任务fe96ecdb-3115-4753-b3f4-b241998d1309，保留历史游标，验证当前worker重试链路；未批量重试多年历史或操作生产。

### 手机系列异常调试器直接证据

- session52222退出1（/tmp/mw-mobile-series-debug.log）。仅测试CDP在异常处读取原生setVisibleTimeRange调用状态：series=sds_8、interval=15、symbolResolved=false；外部dataReady仍true。因此不能将dataReady视为该异常下完整系列就绪证据。
- 调试器不修改供应商代码，读取字段不含账户/凭据。下一步仅测试公开resetData重建系列能否恢复，日志/tmp/mw-mobile-reset-probe.log，尚未产品化。
- 上一轮单分钟EURUSD失败任务重排后已验证complete、cursor=end、attempts=0，当前worker重试恢复成立；不代表其余失败任务已自动恢复。

### 手机公开resetData恢复候选

- session20943退出0（/tmp/mw-mobile-reset-probe.log）：切周期后公开resetData，再操作视区，手机单图、零写入、草稿和errors=[]断言通过。该原型包含诊断等待，不直接作为产品方案。
- 手机只读recordPeriodChange下一事件循环立即resetData候选session36319退出1，说明调用时点仍过早。改为一次onDataLoaded后再调用公开resetData，使用workspace epoch、每图token、当前图成员及周期核对取消旧操作。
- session97087运行中（/tmp/mw-mobile-data-loaded-recovery.log），候选尚未确认，产品改动暂未提交。桌面路径未应用该候选。

- session97087最终退出1，onDataLoaded候选仍未消除异常，已撤回候选产品改动。保留公开resetData原型成功这一有限证据，需进一步核对有效调用时点。

### 手机系列事件轨迹与单图重建候选

- session89992退出1：onIntervalChanged在M15/dataReady=true状态发出，约58ms后onDataLoaded，随后视区API仍取不到symbolInfo（/tmp/mw-mobile-event-trace.log）。该事件序列不足以证明系列可操作。
- 新候选仅手机首次从多图转单图后，通过公开widget.save/load在内存重建单图实例状态，不修改原始服务器布局；session19598运行中（/tmp/mw-mobile-single-reload.log）。产品候选暂未提交，需同时验证保存隔离、画线指标保留及工作区后续切换。

### 手机默认单图重建与工作区切换（2026-09-30）

- 用户明确手机默认单图，不要求八图；桌面最多八图及手机只读隔离仍保留，D08已更新。
- 通过公开setLayout/save/load在内存重建单图，首次加载和后续chart_loaded均使用同一流程；以workspaceEpoch取消过期恢复，最终单图事件负责绑定视区守卫。供应商文件未修改，服务器原始多图文档未转换。
- /tmp/mw-mobile-single-confirm.log退出0，证明真实八图工作区输入可在手机单图切周期/平移，无页面异常。
- 扩展测试先通过原生适配器切换不同工作区再切回，再加载含水平线、趋势线和原生Moving Average的内存多图文档；/tmp/mw-mobile-workspace-switch-final.log退出0：保持一图、水平线价格保留、趋势线两个时间/价格端点完全一致、指标输入参数一致、周期切换及平移成功、errors=[]。
- 水平线附带时间坐标会被原生重载重定位；该工具检查有效价格位置，趋势线严格检查时间及价格，不用水平线时间变化推断所有画线均丢失或均正确。
- 测试同时直接比较操作前后服务器工作区列表完整JSON相等、桌面草稿保留、advanced-charts POST请求为空；测试创建的分析对象仅在内存，不修改保存文档。
- native workspace adapter及edge range synchronization专项退出0。此项不代替其余绘图工具交互、周线持久补数生命周期、部署演练与整体验收。

### 周线排队释放前端与持久需求候选

- 周线pending立即完成原生回调并登记pendingHistory；tick在仍查看时检查完成并清缓存重载，离开时停止前端轮询。普通周期等待和月线只读缓存策略保持。
- 新增advanced-weekly-background.cjs验证立即回调、守卫释放、完成重载及离开取消轮询；历史分页和重载专项均通过。
- 原生浏览器注入W1 pending后切回真实M5、移动视区通过，errors=[]、零工作区写入（/tmp/mw-weekly-background-switch.log）。这是原生切换兼容证据，不是实际长周线下载完成证据。
- 后端抽取plan_history共用规划逻辑，新增weekly_history_requests持久保存请求范围、剩余根数和游标；worker每轮维护推进一个到期需求，底层ImportJob仍为200优先级，失败导入不自动重试。完整需求不依赖网页继续请求。
- 隔离SQLite专项28 passed（/tmp/mw-weekly-durable-tests.log），覆盖无浏览器三页推进、重复需求去重、完成停止及真实规划后台优先级。当前代码尚未重启开发API/worker或应用到生产；PostgreSQL并发/实际多窗口持续推进、完成自动重载和空历史范围边界仍待验收。
- 本轮完整后端回归166 passed、5 skipped（/tmp/mw-weekly-full-tests.log）；跳过项不计为通过。新增表的开发运行环境验证尚未完成。

### 周线 PostgreSQL 与开发常驻流程验收

- /tmp/mw-weekly-postgres.log：4 passed。新增隔离schema验收覆盖两个客户端并发记录同一需求只生成一行、首worker规划期间第二worker不能重复领取、随后新Session从持久游标继续至complete；最终游标更新增加行锁，防止过期领取结果并发覆盖。测试schema已清理。
- 仅对trading_alerts_dev执行bootstrap，确认delivery_enabled=false；核对/proc命令与cwd后重启Ubuntu开发API（session48487，8004）和worker（session7353）。没有重启Unraid服务。新增表只在开发库与隔离测试schema初始化。
- 开发库独立登记EURUSD、before=1790622000000、13根周线需求10774894514f7a5d60e25c1341a9afbb3a9864de，浏览器未续发该请求；常驻worker观察pending/remaining=2，随后complete/remaining=0。已有缓存参与，不能据此宣称13周全部冷下载速度。
- /tmp/mw-weekly-real-reload-confirm.log退出0：注入一次W1 pending后恢复真实后端，tick触发原生缓存失效及重载，firstHistory记录形成，再切回M5并平移，errors=[]、零工作区写入。此前同名不带confirm的运行未执行新增分支，不作为自动完成证据。
- worker启动目录刷新曾出现一次HTTPStatusError；随后直接fetch_oanda_catalog成功返回127项，历史EURUSD下载正常。异常状态码未在首次日志保留，根因未确认，不声明已修复。
- 仍需空历史/上市起点导致持久需求无限向前扩张的边界策略、需求状态展示，以及总体工具验收/部署演练；不能将本轮成功等同整体验收。

### 周线空区间边界与需求状态

- 持久请求的完整规划区间（含有限扩展）查询完成但没有可用周线时，置needs_review并保留游标/剩余根数，不再自动领取；不将其宣称为上游历史起点。pending/失败导入不触发此空区间判断。
- /imports-summary附加最多30条周线需求，待核查优先；工作台显示截止日期、剩余根数、状态及空历史说明。原导入任务priority100/200标注分别修正为图表历史/周线后台。
- /tmp/mw-weekly-boundary-status-tests.log：31 passed，包含ready但无可用条目、empty_interval两种停止条件及需求状态响应；/tmp/mw-weekly-status-web-build.log生产构建通过。
- 当前修改尚未重启开发API/worker加载，页面实际渲染及空区间运行态仍待验证；不把构建通过视为页面验收完成。

### 周线状态页面与迁移补齐

- 已重启Ubuntu开发API（session95267）及worker（session12863）加载空历史边界，未操作生产服务。
- 新增weekly-demand-status.browser.cjs，真实工作台/replay读取开发库complete需求，随后仅HTTP响应注入needs_review，验证剩余13根及尚未确认历史起点文案；/tmp/mw-weekly-status-browser.log退出0、无页面异常。
- /tmp/mw-weekly-status-review.png已查看，状态和原因文字完整显示，无遮挡。注入只作用于浏览器响应，不写入数据库。
- 部署核对发现新增需求表缺少Alembic迁移，已补i10_weekly_history_requests（父版本h9）；临时SQLite完整upgrade head、downgrade h9、再upgrade head均成功，逐步断言表存在/不存在。日志/tmp/mw-weekly-migration.log。PostgreSQL正式迁移专项仍待验证。
- 当前Ubuntu没有docker/podman/nginx命令，镜像运行与TLS隔离演练仍未完成，不以配置静态核对代替发布验收。

### PostgreSQL 迁移与原生布局矩阵

- 新增test_postgres_weekly_migration_roundtrip：实际Alembic从空独立schema升级head、回退h9、再升级head；逐步检查表存在性，并比较ORM字段集、nullable与索引。/tmp/mw-weekly-pg-migration.log：1 passed，4 deselected。测试schema清理完成，不使用bootstrap替代迁移。
- 新增advanced-layout-matrix.browser.cjs，读取供应商d.ts的MultipleChartsLayoutType，加单图共42种布局逐项setLayout，等待各图dataReady且宽度>0，检查1–8图，多图maximize/restore，最终8v原生保存刷新恢复；/tmp/mw-layout-matrix.log退出0，LAYOUT_MATRIX_PASSED 42，页面异常为空。
- 此矩阵证明公开API布局切换和最大化链路，不证明全部菜单鼠标路径、拖动分隔线或每一种布局单独保存恢复。只最后8v在本轮执行保存刷新，既有其他布局证据另见对应专项。
- Ubuntu无需sudo即可创建用户namespace，但没有Docker/Podman及newuidmap等rootless工具；当前仍无实际镜像运行证据。

### 原生分隔线鼠标拖动

- advanced-layout-resize.browser.cjs通过实际鼠标在原生分隔线拖动120px；2h两图时间轴宽度从均分改变为654/414，原生保存刷新后仍为654/414。/tmp/mw-resizer-restore-detail.log退出0，无页面异常。
- 首轮立即手动保存返回原生错误对象；第二轮等待1500ms及保存/视区守卫空闲后成功。未修改产品代码，不将首轮错误宣称为已确定根因或已修复。
- 已查看/tmp/mw-layout-resized.png，布局尺寸恢复正确；同时可见两图左右时间范围不同，需读取同步开关/实际视区进一步判定是否为同步缺口。已增加RESIZED_SYNC_STATE日志，尚未执行新增诊断分支。不据此宣布全部布局行为完成。

### 分隔线同步疑点核对结论

- /tmp/mw-resizer-sync-state.log退出0：timeSync=true、rangeSync=true，两图实际视区均from=1790592300、to=1790624700。此前截图标签密度不同不足以证明范围失步，未复现该推测，不修改同步产品逻辑。
- 将鼠标拖动后（保存前）及刷新后的两侧边界差不超过一根M5纳入断言；/tmp/mw-resizer-sync-asserted.log退出0，宽度654/414恢复、视区边界完全一致、页面异常为空。
- 该结论覆盖此次2h双图同品种M5分隔线操作；不扩张为黄金跨session、多品种各周期、所有复杂布局分隔线均已验收。

### 绘图分组与黄金休市复现

- advanced-drawing-groups.browser.cjs验证水平线+趋势线分组，组名/成员/Locked/Invisible原生保存刷新完全一致；解锁显示，点击原生对象树看到分组，删除趋势线后undo恢复同组成员、redo删除、再次undo恢复。/tmp/mw-drawing-group-undo-fixed.log退出0、无页面异常；对象树截图已查看。若面板已打开不重复切换关闭，修复的是测试前置状态。
- 黄金休市真实历史对照：target=1790274600..1790285400（2026-09-24 18:30..21:30 UTC），八图同步后XAU M5/M15右边界1790287200（22:00），单独公开setVisibleRange后XAU M5右边界1790283300（20:55），/tmp/mw-gold-session-direct.log退出1。证明同步与单独设置不同，不以休市为由直接豁免。
- 假设按顺序：原生同步缺口取整、session描述、现有edgeRangeSync仅覆盖正rightOffset。已启动仅session覆盖对照/tmp/mw-gold-session-override.log（session84330），尚未有结果，不修改产品。
- session84330退出1，显式黄金session覆盖仍是同样22:00对20:55差异；该对照不支持仅修改session就能修复。下一步验证历史休市空档是否需要公开范围校正，仍不得伪造休市K线。

### 黄金历史空档校正候选（未收口）

- 去掉peer正rightOffset限制，增加历史视区单测：旧HEAD失败3700!=1000，候选通过。但仅此修改真实黄金仍失败（/tmp/mw-gold-historical-confirm.log）。
- 临时事件追踪/tmp/mw-gold-sync-events.log显示活动图先更新、其他图异步完成native范围更新；只监听活动图导致错过最终同伴范围。诊断代码已删除。
- 候选改为任何图范围事件安排检查，以当前activeChart为唯一目标；/tmp/mw-gold-peer-settled.log退出0，黄金同步与直接setVisibleRange都落到20:55真实末根，未伪造休市数据。新增late peer单测通过。
- 正常八图鼠标回归/tmp/mw-gap-normal-mouse-regression.log退出1，setVisibleRange抛Invalid visible range，尚未确定与候选是否因果相关；当前产品改动保持未提交，不能宣布黄金修复完成。后续先固定非休市目标范围并对照旧版，检查加载/校正竞态。

### 黄金空档校正收口与回归归因

- /tmp/mw-gap-normal-mouse-regression.log失败请求经读取MIXED_PANES还原为2026-09-27 16:45–19:45 UTC，全部在周日外汇开盘前。不是普通交易时段样例。
- 新增仅测试侧MARKET_WATCH_VIEWPORT_SOURCE，用原HEAD公开适配脚本对照相同请求，/tmp/mw-gap-baseline-weekend.log退出1，同样Invalid visible range。证明此拒绝行为原先存在，不能将它归因为候选引入的回归；也不将其称为已修复。
- 固定2026-09-24 15:00–18:00 UTC交易时段运行候选，/tmp/mw-gap-fixed-open.log退出0，八图鼠标十字线/滚轮/拖动、关闭同步独立操作、自动保存及刷新恢复通过。
- 保留黄金修复：peer范围变化也安排检查，目标始终为activeChart；历史负rightOffset不再被排除。单测覆盖历史视区及迟到peer，原版失败/候选通过；真实黄金同步与单独设置等价证据见/tmp/mw-gold-peer-settled.log。
- 未修改供应商包，未造休市K线；全休市窗口直接调用原生setVisibleRange会拒绝，后续日期定位体验应避免把该底层调用失败描述为行情丢失。

### Ubuntu 用户态容器实测与环境依赖

- 通过apt-get download从Ubuntu源下载Podman3.4.4/conmon/crun和依赖，在/tmp/mw-container-tools解包；未安装系统服务。普通rootless因缺少newuidmap失败。
- unshare -Ur可启动Podman，配置vfs、独立/tmp存储、禁用事件日志；通过授权代理成功拉取docker.io/library/nginx:1.28-alpine，镜像ID dc73b49f5124cf2ee538dfbdfbd121f0b4ccdcb20fea30f3a81bd477c02e2bb5。
- 镜像实际build执行FROM及所有COPY成功；RUN步骤OCI运行时失败devpts Invalid argument（/tmp/mw-chart-image-build.log）。改为chroot隔离后失败supplemental groups operation not permitted（/tmp/mw-chart-image-build-chroot.log）。不是完成镜像构建/运行证据，不修改Dockerfile绕过RUN校验。
- sudo -n确认需要密码；已异步请求用户在Ubuntu准备Docker Engine+Compose及quant访问权限，或提供独立测试机。不使用Unraid生产服务进行演练；其余功能验收仍可推进，整体目标未阻塞终止。

### 原功能回归、图表类型与 Docker 环境推进

- /tmp/mw-latest-full-regression.log：169 passed、7 skipped；包括预警/演练/通知处理的既有后端用例，未重新发送外部手机通知。跳过的独立环境项不计为通过。
- advanced-chart-types.browser.cjs读取供应商ChartStyle枚举：除缺少实际volume输入的VolCandle外，17种类型切换及dataReady通过，最终HLCBars保存刷新恢复；/tmp/mw-chart-types.log退出0，无页面异常。不替代每种合成类型数值算法审计。
- 用户已安装本机Docker29.1.3/Compose2.40.3并授权quant组访问；当前执行会话通过sg docker使用，无需sudo。DockerHub直连超时，用已授权代理下载基础镜像并通过docker load导入，无全局Docker配置修改。
- 图表静态镜像market-watch-chart-origin:acceptance-412703c构建成功，容器mw-chart-origin-acceptance绑定127.0.0.1:15187；首页/bridge/viewports/vendor主脚本200、缺失资源404，CSP connect-src none/nosniff/no-store均确认。
- 主站镜像构建成功，隔离图表构建地址https://127.0.0.1:15444；Compose外置库+advanced覆盖config --quiet通过。API镜像仍在构建（session33123，/tmp/mw-docker-api-build.log），尚未形成完整容器HTTPS验收。

### 本机 Docker HTTPS 联调通过

- 图表、主站、API镜像均通过原Dockerfile构建；API日志/tmp/mw-docker-api-build.log完成，主站隔离地址最终为https://127.0.0.1:15444。未修改Docker守护进程代理，基础镜像通过skopeo代理下载、docker load导入。
- 独立网络mw-acceptance及mw-api-acceptance/mw-web-acceptance/mw-chart-origin-acceptance/mw-tls-acceptance，仅TLS15443/15444与静态15187绑定127.0.0.1；TLS仅挂载证书/密钥文件。API使用权限600的临时env连接trading_alerts_dev，delivery_enabled=false。
- 首轮因并行旧开发API触及dev角色8连接限制而超时；已核对PID/cwd停止Ubuntu8004旧API3055378，日志确认正常退出。不调高数据库权限、不重启Unraid。当前Vite5190的8004后端暂未恢复，容器验收入口为https://localhost:15443。
- /tmp/mw-container-browser-retry.log退出0：实际Docker主站+API+静态库+TLS，登录、创建开发验收工作区、图表加载、M15切换、原生保存成功；errors=[]，图表来源未观察到Cookie/Authorization。截图/tmp/mw-container-https.png已生成。测试忽略本机自签证书错误，不代表公网证书链验证完成。
- 尚未执行容器版本回退、完整Compose启动/worker以及公网正式地址配置；单次联调通过不等于生产已发布。

### 独立 Compose、容器worker与静态版本回退

- 新增compose.acceptance.yaml与deploy/local-container-acceptance.md，可复现本机新增图表栈。API/worker各1连接、通知强制关闭、env_file raw、TLS仅挂证书文件，端口只绑定127.0.0.1。
- 停止已核对的Ubuntu旧chart_history_worker PID3055418及四个手动验收容器，再启动独立Compose，/tmp/mw-compose-up.log完成；/tmp/mw-compose-browser.log退出0，HTTPS联调通过。
- 容器worker日志实际记录XAU_USD两分钟2行下载2.075秒、总入库2.475秒；证明容器内供应商连接与入库链路，不将仅进程Running当作功能通过。
- 从git2e35aa7静态适配文件+原授权包构建独立回退镜像，Compose替换chart-origin并重启TLS，HTTP返回viewports.js与2e35aa7逐字节一致；/tmp/mw-container-rollback-browser.log退出0。
- 再恢复412703c镜像，HTTP脚本与当前代码逐字节一致；/tmp/mw-container-forward-browser.log退出0。两轮登录、图表加载、M15切换/保存、无页面异常及无跨来源凭据断言通过。
- 演练限图表静态版本切换，未回退开发数据库；原行情/通知worker不在此Compose，不能宣称整个生产服务栈已部署验收。原生产Compose仅config合并验证，生产域名/证书配置仍待发布阶段。

### 原生指标模板跨工作区与刷新验收

- 新增 `web/tests/advanced-native-study-template.browser.cjs`，在本机 Compose HTTPS 环境使用真实开发 API；创建独立工作区，通过公开 API 创建 MA(21)，随后真实点击原生“指标模板 → 保存指标模板”并提交名称。
- 读取服务器 preferences 确认 study 模板内容为库原生字符串；另建工作区并刷新，断言工作区 ID 不同且没有指标，再从原生模板菜单选择刚保存的模板。
- 应用后 MA 参数为 length=21/source=close/offset=0，原生保存工作区、刷新后完整输入参数相等；页面异常为空。`/tmp/mw-native-study-template-reload.log` 退出0。
- 此测试证明指标模板原生保存、跨工作区读取/应用和应用结果刷新恢复；尚不证明模板覆盖/删除、绘图样式模板和图表样式模板的完整生命周期。测试使用现有历史数据截点，不作为实时性能验收。
- 已更新能力盘点首段，清除“worker未恢复、容器未验收、手机八图待验”等过期摘要。原始能力表仍明确标记为历史盘点，不将其当作当前完成清单。

### 缺失组件处理方向校正（用户再次确认）

- 已核实先前决策：供应包缺失导出组件无法补齐，采用独立开发替代；已有 chart_export.py、ExportDialog.tsx 和原生扩展导出入口，且有真实冷历史导出验收记录。不得再把补包作为该项交付前提。
- 本次新发现的是图表样式模板保存弹窗：启用公开 chart_template_storage 后出现“保存为…”，实际请求 show-theme-save-dialog.40f9c769b2c617234f2b.js 与 zh.53789.e5ad985078122ebd1205.js 均404；原始ZIP无这两个文件。与之前的导出缺失是不同组件，不代表自研导出失效。
- 用户提醒沿用自行开发方向：本轮按独立适配/替代入口补齐图表样式模板管理，复用已有用户级preferences存储及公开样式应用接口；无需等待分发方补件。此前索取补包的异步问题不再作为待用户协助项。
- 样式替代实现仍须验证只应用显示样式、不覆盖品种/周期/画线/指标，支持跨工作区保存应用，手机不写回。保持授权库文件不改动，原生入口按既定要求保留并记录能力限制。
- 绘图模板原生“保存为”已实测保存 LineToolHorzLine 的颜色 #ff1234/线宽3 到真实preferences；/tmp/mw-drawing-template-save.log退出0。其跨工作区应用/刷新/删除仍需补验，不能视为完整验收。

### 自研图表样式保存入口与原生应用

- 新增自有 chart-style.js，从公开 widget.save 快照提取白名单显示样式；不保存品种、周期、时间范围、交易数据调整、指标或画线。深拷贝避免修改原工作区快照。
- 桌面原生header扩展“保存样式”，可信父页面收集名称，经现有preferences保存chart模板，支持同名覆盖及revision检查；手机不提供入口，父页面拒绝手机命名写入。启用公开chart_template_storage，保存的模板可由原生图表设置模板菜单读取。
- 当前替代入口绕过缺失保存弹窗；原生“保存为”仍受供应文件缺失限制，没有宣称修复黑盒弹窗。后续需补用户可见说明、原生菜单应用/删除与覆盖/跨工作区及手机验收。
- 本机web/静态库原Dockerfile构建成功，验收Compose更新至acceptance-style-fallback；未改API镜像或生产服务。前端tsc/Vite构建及模板适配、样式提取测试通过。
- advanced-native-chart-template.browser.cjs真实点击替代保存入口、实际服务器存储、刷新后通过公开loadChartTemplate应用成功；背景恢复#123456，原有symbol/resolution/study IDs/drawing IDs保持一致，errors=[]。/tmp/mw-style-fallback.log退出0。此轮同工作区刷新，不冒充跨工作区完整生命周期证据。

### 样式模板跨工作区原生应用与删除

- advanced-native-chart-template.browser.cjs扩展：保存独立样式模板后另建工作区，断言workspace ID不同；在新工作区加入MA(21)及水平线，修改背景为对照色，通过真实原生“设置 → 模板 → 模板名 → 确认”应用。
- 背景恢复#123456；品种、周期、指标ID、画线ID均与应用前一致。再打开原生模板菜单，悬停测试模板并点击“移除”，确认后真实preferences API不再返回该模板。/tmp/mw-style-delete.log退出0，errors=[]。
- 首轮定位“设置”同时匹配图表/指标按钮，已限定header-toolbar-properties；属于测试定位修正，不宣称产品缺陷修复。
- 此证据补齐跨工作区及原生应用/删除；同名覆盖、删除后的重新会话列表和手机只读仍需补验。原生“保存为”缺件仍使用独立“保存样式”入口替代。

### 样式模板同名覆盖与删除刷新

- 同一浏览器真实点击“保存样式”两次，同名模板背景从#123456改为#234567；服务器仅有一行、ID不变、revision恰好加1，验证实际覆盖而非生成同名副本。
- 另一工作区通过原生模板菜单应用覆盖后的#234567，品种/周期/指标/画线ID保持一致。原生删除后重新加载页面，再打开模板菜单，模板名不存在。
- /tmp/mw-style-overwrite.log退出0，errors=[]；验收脚本已固化上述断言。尚未将此证据扩张为手机或所有模板类型的生命周期验收。

### 手机模板只读回归暴露原生加载异常（未解决）

- 手机回归脚本支持本机HTTPS来源，新增preferences前后完整相等及无“保存样式”按钮断言。
- /tmp/mw-mobile-style-readonly.log退出1，尚未走到新增只读断言；切换第二工作区时供应库JSON.parse(undefined)，最终“Second workspace did not settle to one chart”。本轮不能记作手机通过，也未证明由样式改动引入。
- 下一步从实际native-charts/load返回的state包装格式定位；脚本增加仅输出ID/名称/结构键的诊断，不输出完整用户数据。需核对空白、raw snapshot和native content包装的兼容加载，不跳过异常工作区冒充通过。

### 原始快照的原生加载兼容修复及手机回归

- 实际服务器内容证明：最新工作区含content包装，第二个工作区则为widget.save原始charts/layout快照。供应库loadChartFromServer读取e.content并JSON.parse；此前切换路径直接返回raw，触发JSON.parse(undefined)。初始saved_data路径支持raw，因此首次打开成功不足以证明切换正常。
- 新增nativeLayoutContent：仅对含charts数组的原始快照加原生content及工作区元信息包装；已有包装保持原样，不修改数据库原数据。getChartContent保留视区提取后执行规范化。单测覆盖raw、保留原对象、已有包装不重复包裹。
- 本机chart-origin镜像acceptance-layout-envelope构建并更新成功；/tmp/mw-mobile-envelope-fixed.log退出0：同一组工作区A→B→A、单图恢复、切周期/视区、保留画线指标测试通过；MOBILE_WRITES=[]、nativeReadonly=true、工作区与preferences前后完全相同、桌面草稿未改、无保存样式按钮、errors=[]。
- 浏览器控制台记录库尝试加载analytics.js被现有CSP阻止，未开放外连。未改供应库或unraid生产服务。
- 此修复覆盖raw和native包装，空state工作区切换及其他模板验收仍需独立核对，不将本轮手机通过等同完整交付。

### 绘图模板原生保存、跨工作区应用及刷新

- 新增advanced-native-drawing-template.browser.cjs：公开API创建4300水平线并设红色#ff1234/线宽3，通过真实原生属性窗口“模板 → 保存为”保存到服务器drawing模板。
- 另建工作区并断言ID不同、画线数为0；新增价格4200的蓝色细线，经原生属性模板菜单应用已存样式。颜色/线宽变成#ff1234/3，价格保持4200，仍仅一根线，证明样式复用而非复制原实际画线。
- 原生保存工作区、刷新，断言线条数量、颜色、线宽、价格全部保留。/tmp/mw-drawing-template-refresh.log退出0，errors=[]。
- 此证据覆盖水平线的模板保存/读取/应用及持久化；绘图模板覆盖/删除和其他工具命名空间仍需核对，不能据此宣称全部绘图工具均已验收。

### 原生绘图模板删除不影响实际画线

- 扩展绘图模板浏览器验收：刷新后的水平线属性窗口打开模板菜单，悬停本轮创建模板并点击原生remove-button，真实preferences中该drawing记录消失。
- 删除后画线仍仅一根，价格4200、颜色#ff1234、线宽3保持不变，证明删除模板没有连带删除或重置已应用样式的对象。/tmp/mw-drawing-delete-final.log退出0，errors=[]。
- 原生绘图模板删除控件为role=img的可点击span，且直接删除，无图表样式模板的确认对话框；首轮按钮定位超时已按实际界面修正，未改产品或供应库DOM。

### 缺件功能替代入口说明

- 原生header扩展“使用说明”，通过公开showNoticeDialog展示：顶部保存样式及同名覆盖、原生设置模板应用/删除、原生保存为缺件；CSV包含行情/Python但不含内置指标；手机只读、M1报价口径及未接入的额外服务。保留原生入口，不注入供应库DOM。
- Ubuntu静态镜像acceptance-help构建运行，advanced-container-https.browser.cjs真实点击说明入口并断言两项缺件/替代文案，关闭后M15切换及原生保存正常；/tmp/mw-help-browser.log退出0，errors=[]。
- 说明入口解决可见替代指引，不宣称拦截无公开接口的原生点击或修复缺失组件。

### 价格轴模式与显示时区保存恢复

- 新增advanced-display-settings.browser.cjs：通过公开价格轴API依次切换普通/对数/百分比/指数100，逐次读取模式一致；设置Asia/Singapore显示时区、对数及反转轴，经原生保存工作区并刷新，三项设置完整恢复，品种XAUUSD、周期240不变。
- /tmp/mw-display-settings.log退出0，errors=[]。此轮为公开API和持久化行为验收，不等同原生菜单鼠标操作、不同品种全部组合或后台OHLC数值对照；后台分桶不变仍需在数据对照中证明。

### 原生列表加载未保存的空白工作区

- 新增advanced-empty-native-load.browser.cjs：先在当前图创建均线及水平线并原生保存，再从原生getSavedCharts/loadChartFromServer加载刚创建、没有state的另一工作区。原版/tmp/mw-empty-native-load.log在30秒dataReady等待超时，证明不是初次打开空白列表的既有测试所覆盖。
- 父页面读取到缺失或空state的工作区时，使用现有select路径重新初始化独立widget，复用该工作区ID/配置；不构造供应商私有空快照、不复制当前图的指标或画线。已有state继续原生加载。
- 原web Dockerfile构建acceptance-empty-load并更新本机验收Compose；/tmp/mw-empty-native-fixed.log退出0，目标ID正确、图表dataReady、画线/指标均为0、errors=[]。
- 手机空白切换和返回旧工作区保存内容仍需补验；此次通过不覆盖它们。unraid未操作。

### 空白工作区往返及手机只读收口

- 桌面从含4300水平线与MA(21)的已存工作区进入空白，再原生加载回原工作区：ID、线条价格及MA参数全部保留，/tmp/mw-empty-return.log退出0。
- 同一专项新增独立手机context：已存分析→无state空白工作区，最终一图、零画线/指标；advanced-charts POST为空，服务器工作区完整列表前后相等，errors=[]。/tmp/mw-empty-mobile-isolated.log退出0。
- 首轮比较被尚开着的桌面页自动保存改变排序/版本干扰；手机POST记录仍为空。测试改为关闭桌面页再取服务器基线，不放宽相等断言，不修改产品。

### 原生收藏入口补齐与周期收藏持久化

- 核对供应库公开Favorites类型说明：用户添加/移除收藏需要items_favoriting开关。此前未启用，原生周期菜单无星标；仅启用该开关的浏览器对照出现“添加到收藏”。现已正式启用，自有settings_adapter保持不变。
- 新增advanced-favorites.browser.cjs：真实展开周期菜单、切换M15收藏状态，服务器setting键IntervalWidget.quicks存在，刷新后星标状态一致，再恢复原状态；/tmp/mw-favorites-final.log退出0，errors=[]。
- 开启收藏后header使用radio快捷项及“图表周期”展开按钮，测试使用公开可访问控件定位，不将快捷项误当展开按钮。首轮保存已发生但刷新后旧定位失败，后续按当前真实初始状态进行双向切换。
- 本机静态镜像acceptance-favorites已运行；未修改供应文件。指标/绘图收藏与跨工作区仍需分别核对，单一周期收藏不覆盖全部D06。

### 原生数据窗口显示验收起点

- 新增advanced-data-window.browser.cjs，标准蜡烛图下通过真实鼠标移动十字线，原生数据窗口显示开盘/最高/最低/收盘及选中历史时间，errors=[]；/tmp/mw-data-window-ohlc2.log退出0。
- 数据窗口展开状态为用户偏好，测试先检查aria-pressed，避免把已展开面板关闭；此前HLC类型本身无开盘显示，不能据此认定OHLC供数丢失。
- 当前仅证明字段出现与十字线历史时间有效；尚未做逐值后台对照、指标值及缺失值语义，不关闭A12完整验收项。

### 数据窗口OHLC与真实后台响应对照

- advanced-data-window.browser.cjs收集实际history/charts-data响应，以十字线公开事件选中时间精确匹配bar.start；按XAUUSD两位显示精度，分别断言原生数据窗口开盘/最高/最低/收盘等于后台对应字段。
- /tmp/mw-data-window-values.log退出0、errors=[]；未拦截伪造行情响应。该轮覆盖XAUUSD H4单根历史K线四字段，不代表三品种九周期、指标输出或空值都已对照。

### 当前改动面回归（c17af07）

- npm run build：TypeScript及Vite通过。PYTHONPATH=backend .venv/bin/pytest -q backend/tests/test_advanced_preferences.py backend/tests/test_advanced_workspace.py backend/tests/test_chart_export.py：12 passed；单条Starlette/httpx弃用提醒，不是运行失败。
- native-workspaces、preferences、chart-style、edge-sync四个JS专项通过，覆盖近期工作区包装/模板样式及同步守卫。
- 当前验收Compose运行advanced-container-https.browser.cjs，/tmp/mw-current-https.log退出0：使用说明、M15切换及原生保存正常，errors=[]，未观察到图表来源携带凭据。不是全量后端/所有浏览器功能重新验收。

### 指标模板删除不影响已应用指标

- advanced-native-study-template.browser.cjs扩展原生模板菜单：悬停MA(21)模板并点击remove-button，服务器study偏好记录消失；当前图表中已应用的MA(21)仍保留，输入参数完整一致。
- /tmp/mw-study-delete-final.log退出0，errors=[]。与绘图模板一样，供应库对该删除操作不弹二次确认；测试不假设不存在的确认按钮。

### 显示时区与OHLC不变性

- 数据窗口专项在同一根真实XAUUSD H4上切换Etc/UTC、Asia/Singapore、America/New_York，鼠标回到相同位置后十字线时间戳完全相同，四个OHLC显示值均继续与后台bar一致。
- 数据窗口“时间”逐一对照Intl.DateTimeFormat按选中时间戳及目标时区生成的HH:mm；三个时区均一致。/tmp/mw-timezone-ohlc.log退出0，errors=[]。
- 该证据证明此日内样例的显示时区转换不改价格/时间戳，不替代D/W/M交易日标签及夏令时边界专项。

### 数据窗口原生均线独立数值对照

- 数据窗口测试新增原生Moving Average(length=5, source=close)，按十字线选中时间从真实后台响应排序取当前及前四根close，独立求和除5并按两位显示精度对照窗口Plot。
- /tmp/mw-data-window-sma-verified.log退出0，MA显示4343.02与独立计算一致，原有OHLC/三个显示时区断言同时通过，errors=[]。未调用原生指标计算结果作为预期值。
- 此轮单品种H4/SMA(5)样例不能替代所有内置指标算法审计；缺失值/预热显示仍待针对性验证。

### 数据窗口预热不足显示

- 扩展advanced-data-window.browser.cjs：完成OHLC、三时区和SMA(5)独立数值对照后，移除指标并添加原生SMA(10000)，通过鼠标重新选中历史K线。窗口Plot显示∅，缺失结果未被显示为0。
- /tmp/mw-data-window-warmup.log退出0，errors=[]；本机Compose实测，未修改供应库、行情响应或生产环境。
- 本条证明原生均线的预热缺失展示；Python指标输出仍需单独对照，不将本测试扩大为所有指标的缺口验证。

### Python指标数据窗口端到端数值对照

- advanced-data-window.browser.cjs新增Python SMA(5)：真实/api/charts/data响应按时间取值，对照五根后台close独立平均；原生数据窗口value按适配器五位精度对照选中的实际K线。
- 首轮暴露测试的两个错误前提：主图dataReady不表示Python辅助序列完成；添加指标后同一鼠标坐标可能对应另一个时间。修正为等待实际显示值，并重新读取crossHairMoved时间，未改动产品算法或供应库。
- /tmp/mw-data-window-python-ready.log退出0，选中1789333200，独立预期及窗口均为4356.702；OHLC、三时区、原生SMA和预热∅断言同时通过，errors=[]。
- node tests/advanced-python-indicators.cjs通过：覆盖适配层的缺失值、真实零值、负值、输出键及时间映射；它不是Python缺失值的浏览器展示验收，不扩大证据范围。

### 原生指标模板同名覆盖闭环

- advanced-native-study-template.browser.cjs先保存MA(21)，修改为MA(34)后用同名在原生对话框点击保存。服务器只保留一条study记录，ID不变，revision由1变2，模板内容更新。
- 新建工作区应用该模板得到length=34；原生保存后刷新仍一致；删除模板后当前已应用MA(34)保持不变。/tmp/mw-study-overwrite-click.log退出0、errors=[]。
- 首轮使用Enter提交同名模板未触发保存，改为实际保存按钮后通过；未修改产品代码或供应库。使用明确的服务器版本轮询等待持久化，不把对话框关闭当作成功依据。
- 清除了临时窗口全文日志，保留版本、唯一性、内容变化和跨工作区结果断言。

### 绘图模板覆盖与工具隔离闭环

- advanced-native-drawing-template.browser.cjs：水平线模板红色/宽3覆盖为绿色#12ab34/宽4，同名仍一条、ID不变、revision加1。选择原生同名建议后点击保存，避免建议列表遮挡按钮。
- 垂直线菜单不显示水平线模板；垂直线可保存同名模板，后台形成两个不同tool记录，原水平线记录完全不变。通过原生确认框删除垂直线模板后，仅保留原水平线记录。
- 新工作区应用覆盖后的水平线样式：颜色/线宽正确，价格仍4200；保存刷新一致，删除模板后实际画线保留。/tmp/mw-drawing-tools-final.log退出0，errors=[]。
- 更正此前删除行为的概括：本轮删除垂直线模板出现“您真的要删除绘图模板”确认框，需点击“是”；后续水平线删除路径仍未出现确认。不能从单次操作推断供应库所有删除均无需确认。
- node tests/advanced-preferences.cjs通过队列写入、工具命名空间、刷新、冲突与只读检查。未修改产品代码及供应库。

### 原生指标收藏跨工作区

- 新增advanced-indicator-favorites.browser.cjs：通过原生指标目录悬停并点击星标，服务器chart.favoriteLibraryIndicators内容实际变化；新建工作区后刷新，工作区ID不同，原指标星标保持，再恢复初始收藏状态。
- /tmp/mw-indicator-favorites-cross.log退出0、errors=[]；前置同工作区刷新测试/tmp/mw-indicator-favorites-hover.log也通过。样例为52周高点/低点，此处验证收藏，不验证该指标计算。
- 复用已有settings_adapter，不修改供应库、不新增收藏存储。临时探查脚本已删除。绘图工具收藏仍需单独验收。

### 原生绘图收藏跨工作区

- advanced-drawing-favorites.browser.cjs真实展开左侧趋势线工具组，悬停水平线条目并点击星标。服务器chart.favoriteDrawings内容变化；新建工作区并刷新，工作区ID不同，水平线星标保持。最后恢复初始星标。
- /tmp/mw-drawing-favorites-final.log退出0、errors=[]。首轮失败为脚本假定两层父节点包含星标，改为定位最近包含收藏按钮的祖先条目；未改产品DOM或供应库。
- 该证据覆盖代表性绘图收藏的持久化与工作区共享，不代表已完成所有绘图工具交互。临时探查脚本已删除。

### 绘图周期可见范围与层级持久化

- 新增advanced-drawing-management.browser.cjs：原生水平线属性→可见范围中关闭小时，分钟/日仍开启；widget.save公开快照记录intervalsVisibilities.hours=false。
- 通过公开bringToFront/sendToBack操作，以快照zorder与另一条水平线比较，分别断言置顶与置底；保存到服务器并刷新后两条线仍在，相对层级及完整周期可见配置保持。再次打开原生属性，小时未勾选、分钟及日仍勾选。
- /tmp/mw-drawing-management-state.log退出0、errors=[]。getProperties默认结果不包含本例的intervalsVisibilities，测试改从公开保存快照读取，并以刷新后原生控件状态交叉核对；未修改产品代码或供应库。
- 本项证明周期设置/层级保存恢复，不把配置值直接当作所有周期渲染可见性的证明。复制粘贴、吸附等仍单列待验收。临时探查脚本已移除。

### 周期可见范围实际绘制验证

- 扩展advanced-drawing-management.browser.cjs：为目标水平线设置鲜明颜色与宽4，通过公开价格轴接口固定4200–4400范围，读取图表canvas像素作对照。原生属性里小时关闭→开启→关闭，目标颜色像素增加后回落；保持分钟开启切换M15，绘制像素再次增加。
- /tmp/mw-drawing-visibility-periods.log退出0，H4计数5109→10222→5109，M15为10537，errors=[]。这里使用增量断言，因为其他线可能继承相同默认色，背景计数不一定为0；前轮单独H4测试计数0→5113→0。
- 原有服务器保存、刷新恢复、层级相对顺序断言同时通过。未用配置字段冒充实际绘制证据，也未修改canvas或供应库。范围为同一XAUUSD水平线在H4/M15上的代表性交互。

### 原生截图四图/八图与双主题

- advanced-screenshot-matrix.browser.cjs在本机HTTPS容器中切换4、8布局，逐图dataReady后切换Light/Dark，通过原生生成快照→下载图片完成四次下载；验证PNG签名、尺寸及无pageerror，并恢复初始主题。
- /tmp/mw-screenshot-matrix-final.log退出0、errors=[]。逐张查看导出图片，四/八窗格均有K线、价格轴、时间轴；浅底深字/深底浅字正确，无空白窗格或整体裁切。八图窄窗格标题按原生省略显示。
- 图片留存docs/evidence/native-screenshots/{4,8}-{light,dark}.png。样例为XAUUSD H4，证据针对布局及主题的导出能力，不扩展为所有品种/指标截图验证。

### 用户使用说明与过时方案修正

- 新增advanced-charts-user-guide.md，按实际入口说明工作区、模板、收藏、截图、CSV、手机只读、分桶/显示时区、D/W/M历史策略及指标数据依赖。依据bridge.js公开适配及当前浏览器验收，不把接口存在等同于服务已接入。
- 明确原生导出/样式保存缺件的自研替代，CSV不含原生指标、无Pine运行环境、成交量/深度/新闻/交易等边界；记录交易账户/订单/经纪商入口的实际关闭配置。
- 修正原实施方案P3及第7节仍写“等待完整包”的过时内容；按用户已确认的自行开发决定执行，不再请求补包或把补包当作交付前置。
- 本轮为文档及边界核对，不改变运行服务，不以此宣称整体验收通过。

### 最新图表数据纳入真实PostgreSQL恢复演练

- 扩展backend/tests/test_backup.py既有真实pg_dump/pg_restore专项，源库加入advanced_chart_workspaces一条、advanced_chart_preferences四类各一条、weekly_history_requests一条。原有信号与outbox仍验证。
- 归档清单验证新增表非空；在restore_check真实恢复连接关闭前，额外断言工作区布局/版本、模板和设置JSON中文内容/版本/工具命名空间、周线cursor/remaining/status/next_at，不只比较记录数。
- Ubuntu临时PG14.24集群仅监听127.0.0.1随机端口，使用匹配14版客户端及UTF8编码。pytest -q backend/tests/test_backup.py：5 passed in 1.68s，ISOLATED_RESTORE_EXIT 0，ISOLATED_CLUSTER_REMOVED True。
- 初次尝试客户端libpq路径缺失；补齐LD_LIBRARY_PATH后发现无locale默认SQL_ASCII导致驱动返回bytes。明确initdb --encoding=UTF8后通过，两次失败的临时目录均清理。没有修改共享数据库、生产服务或产品备份实现。
- 本条关闭“新增表是否进入备份恢复”的疑问；不代表整站容器/TLS/配置恢复与版本回退已经验收。

### 八图轮询与短时资源采样

- 新增advanced-eight-chart-soak.browser.cjs，真实本机HTTPS容器、已有历史的XAUUSD H4八图，15秒采样一次共8次；观察实际/api/charts/data limit=3网络请求，不伪造响应。
- /tmp/mw-eight-chart-soak.log退出0：两分钟8次最新行情请求；每次1订阅/1分组，pending RPC及pendingHistory均0，errors=[]。切回单图后chartsCount=1且subscriptions<=1。
- Chromium图表帧performance.memory.usedJSHeapSize首样33073064字节，尾样33884371，途中约35MB后回落。此指标不是整个浏览器进程内存；无GC强制干预，不宣称两分钟证明长期无泄漏。
- 此轮证明同品种同周期八图未按八倍放大轮询，暖数据无明显积压；多品种/多指标、冷历史及更长运行仍不由此单一场景覆盖。

### 行情轮询失败恢复与重叠tick保护

- 扩展web/tests/advanced-history-reload.cjs：8个同品种/周期订阅使用一次分组查询；第一次query抛出临时上游异常时发送一个错误、polling最终复位且不丢订阅。下一次query成功后同一根bar更新全部8个订阅。
- 同一分组查询尚未完成时再次tick不会并发发起第二个请求；释放原请求后polling恢复false。原有历史修订、范围扩展、失败重试和比较品种重载断言同时通过。
- 在web目录运行node tests/advanced-history-reload.cjs：两条通过消息，退出0。此为bridge虚拟边界测试，不替代真实代理断线/行情源恢复测试；未修改产品实现。

### b875934后收口回归

- npm run build通过TypeScript/Vite构建。
- 五组JS单测advanced-history-reload、advanced-python-indicators、advanced-preferences、advanced-native-workspaces、advanced-chart-style全部通过，覆盖轮询故障恢复、指标缺失值、偏好命名空间、工作区并发/只读与样式白名单。
- 后端advanced_preferences、advanced_workspace、chart_export、backup组合16 passed、1 skipped。跳过项为未配置独立PG服务的真实恢复；此前隔离PG14完整backup测试5 passed仍有效，不把此次skip当作通过。单条Starlette/httpx弃用提醒。
- 更新当前清单的基线和下一步顺序，移除对已完成模板/收藏/新增表恢复重复验收的过时安排。没有修改生产服务或升级验收容器镜像。

### HTTPS离开保护与停止轮询

- 更新advanced-unload.browser.cjs到当前HTTPS验收容器；暂停原生保存请求期间刷新触发beforeunload，取消离开后释放请求，实际服务器保存完成；再次刷新不出现未保存提示。
- 返回主站后额外观察17秒（超过15秒轮询周期），图表history/charts-data请求数不再增加，errors=[]。/tmp/mw-unload-fixed-history.log退出0。
- 首轮未限定日期触发最新历史error，主动停止该测试；随后固定已缓存截止时间验证离开行为，不改行情响应。该测试不证明任意未保存操作都会自动完成保存，也不替代冷补数故障验收。

### 最新历史错误定位与开发库重试恢复

- 不限定旧截止时间请求XAUUSD H4/200根，复现status=error，关联8个failed_task_ids；原错误文本为空。同期本机worker日志OANDA拉取/入库持续成功，排除把该状态直接归因于当前连接断开。
- 通过已鉴权/api/market-data/retry/{id}逐一重试这8个开发库任务，全部200；worker随后真实补回缺口。/tmp/mw-latest-history-after-retry.log显示失败列表清空，仅新一分钟待处理。
- 固定刚请求过的截止1790765100000再次检查：/tmp/mw-latest-history-ready.log为ready，pending/failed任务均空，覆盖2684700000/2684700000毫秒，error=null。此处固定的是本次当前请求边界，未回避旧失败区间。
- 只操作Ubuntu验收API和开发库任务，未操作Unraid生产服务。临时诊断脚本已删除；没有改供数算法。原生失败重试提示及供数服务可恢复，空错误文本的可读性仍可进一步改善。

### 失败任务空错误提示修复

- 最新历史诊断发现旧failed任务error为空。扩展test_failed_history_exposes_retryable_jobs覆盖具体文本、空字符串、None与纯空白；修复前3失败1通过，复现接口返回空错误。
- market_data.history归一化失败消息，缺少具体原因时返回“历史补数任务失败，未记录具体原因；请重试”；保留已有具体错误和failed_task_ids，不改变任务重试/覆盖判断。
- backend/tests/test_market_data.py全套34 passed，ruff与diff检查通过。当前只更新本地代码，验收容器仍用原API镜像，后续镜像更新需包含此修复；未操作生产。

### 空错误提示修复进入本机验收镜像

- 由当前Dockerfile构建market-watch-api:acceptance-2bc223f，镜像73edb117ea78；Ubuntu market-watch-acceptance API/历史worker已切换此镜像。API健康检查通过，5个服务运行。网页和TLS代理重启刷新容器地址；静态图表镜像未改。
- advanced-container-https.browser.cjs通过，/tmp/mw-https-api-2bc223f.log退出0，errors=[]，credentialsSentToChart=0；验证登录、独立来源、使用说明、周期切换及原生保存。
- 原API镜像保留可回退。未操作Unraid生产、未推送Git远端。上一节“本地代码尚未进入验收镜像”的状态由本记录更新。

### 绘图复制粘贴与原生默认样式

- advanced-drawing-copy.browser.cjs通过真实Ctrl+C/Ctrl+V复制选中水平线，新增独立ID，副本颜色/宽度保留；移动副本到4250后原线仍4300，errors=[]。
- 原生属性→样式里实际切换价格标签复选框并确认；新工作区最初没有旧画线，新建水平线自动沿用所选showPrice值。/tmp/mw-copy-native-default.log退出0。
- 初次仅用API setProperties再打开对话框确认，新工作区仍用旧默认色；这不是用户编辑默认样式的等价操作。改为真正触发原生样式控件后保存恢复通过。当前默认样式断言针对showPrice，不泛化为每个样式字段。
- 临时探查脚本已删除；未改产品代码和供应库。

### API/worker同结构回退及恢复

- Ubuntu验收API和历史worker从acceptance-2bc223f回退acceptance-412703c，保留开发数据库；健康检查及advanced-container-https浏览器通过，/tmp/mw-api-rollback-412703c.log退出0、errors=[]。
- 恢复acceptance-2bc223f并重启web/tls刷新地址，再次浏览器通过，/tmp/mw-api-forward-2bc223f.log退出0、errors=[]；5服务运行，API healthy。未操作Unraid。
- 更新local-container-acceptance.md实际镜像标签与同结构回退命令；backup-and-restore.md将固定16表表述改为当前模型全部表。此次没有数据库迁移，不能推论任意旧镜像与未来结构兼容，也不等于全新整站重建演练。

### 混合八图发现隐藏订阅继续保留

- advanced-eight-chart-soak.browser.cjs新增MARKET_WATCH_MIXED_SOAK=1：8图分配XAUUSD/EURUSD/BTCUSDT，每图原生MA21。两分钟运行3订阅/3分组、24次轮询、pending为0；但收尾切单图后订阅数量未降至1，测试失败，不能计为混合负载整体验收通过。
- /tmp/mw-mixed-soak-final.log记录30秒释放等待超时。缩短复现/tmp/mw-mixed-teardown-probe.log：layout=s、chartsCount=1、可见XAUUSD，subscriptions仍含XAUUSD/EURUSD/BTCUSDT。说明原生保留隐藏窗格订阅，当前轮询会继续处理它们。
- 已保留混合模式失败断言作为待修复回归；临时缩短探查脚本删除。后续应在公开可见图表/比较/Python需求范围内抑制无可见需求的轮询，同时避免破坏再展开布局。未把此缺陷隐去或降低单图验收要求。

### 隐藏轮询修复候选与即时请求计数诊断

- bridge按可见图表及比较品种判断轮询需求；隐藏订阅保留但暂停请求，再展开先reset缓存及图表以补齐暂停期间历史，再恢复最新三根轮询。候选镜像acceptance-visible-poll仅在Ubuntu验收运行。
- advanced-history-reload.cjs新增隐藏无查询、重新展开先重载再查询、可见比较品种继续查询断言，通过；移除候选修复的临时测试以“Hidden pane must not fetch latest bars”失败。
- 两次完整混合运行在切单图即时计数遇0而非1；缩短探查显示可见XAUUSD/H4已ready、订阅存在、polling=false，但最新查询缓存仅608ms，命中query的一秒合并缓存。此失败不证明可见图停止更新。
- 测试在两分钟自然轮询采样之后停止自动timer、等在途完成并等待1100ms过缓存窗口，再用真实tick统计网络请求；没有清空产品缓存。缩短探查/tmp/mw-hidden-probe-cache.log退出0：三组运行请求3次、单图1次、展开后3次，总7次，errors=[]；临时脚本已删除。
- 完整两分钟混合回归/tmp/mw-mixed-visible-final.log退出0：8次采样、运行24次请求，pending/pendingHistory均0；切单图1次、展开3次，总28次，errors=[]。此次证明代表性混合场景，不等于长期运行内存审计或整体交付。

### 原生强吸附实际鼠标验收

- advanced-magnet.browser.cjs通过公开magnetEnabled/magnetMode启用强吸附，使用实际鼠标绘制趋势线，再以后台返回的H4行情逐个核对端点时间与OHLC价格。/tmp/mw-magnet-away.log退出0、errors=[]；端点1788224400/4456.75及1789722000/4398.01均匹配实际K线。
- 初次测试第二落点在原生首次使用提示区域，Escape取消未完成线；记录发现第一点击已创建临时趋势线。测试关闭提示并使用未遮挡位置后完成，不属于产品绘图故障。selectLineTool公开Promise也等待就绪。
- 未改供应库；验证范围为强吸附代表性趋势线，不宣称弱吸附距离算法或全部绘图工具吸附审计。已移除临时点击状态与截图诊断。

### 本机图表栈整体容器重建

- 新增advanced-recreate-storage.browser.cjs：MW_SNAPSHOT_MODE=before通过认证API读取完整工作区document/revision及偏好，在/tmp仅保存SHA256和数量；正常模式比较。对象键及顶层记录排序，文档内部数组顺序保留，避免掩盖布局/绘图顺序变化。
- Ubuntu Compose down移除五容器及独立网络，再up -d --wait --wait-timeout 90全部重建；保留受限开发配置、开发数据库和已构建镜像。前后466工作区摘要ded7e42ab502269961c0a2f39771f88d199a4a6ebe83f946a49634b9e66c1473、48偏好摘要8d6d223a549cb13c0ff4aadd26ecbc23eaea264e1249b0bb38a39e0603e0a834一致，两次命令退出0。
- 重建后advanced-container-https.browser.cjs通过，/tmp/mw-recreate-https.log退出0，errors=[]、credentialsSentToChart=0；验证登录、图表加载、M15、说明入口及保存。
- 验证图表栈容器与网络可重建且保存数据不丢；不是从零安装主机，不包含原行情/通知worker整站发布。未操作Unraid、未推送远端。

### 忙碌期间手动保存提示与自动恢复

- 新增advanced-busy-save.browser.cjs，在真实HTTPS原生图表中控制视区busy条件，创建真实画线并点击“保存布局”。原实现Error被库回调序列化为{}，更改为字符串后回调可读，但原生菜单仍无原因提示。
- 适配层使用公开showNoticeDialog补充“图表正在切换，数据就绪后自动保存”，同一次忙碌阶段只提示一次；保留dirty，后续正常保存重置提示标志。不修改供应库。
- /tmp/mw-busy-save-notice.log退出0：菜单提示可见并确认关闭、公开回调保留中文、解除busy后无需手动重试就将新画线保存入服务器、errors=[]。advanced-autosave.cjs回归通过。
- 当前本机图表镜像acceptance-save-notice；API/worker和网页镜像未变化。忙碌条件为测试注入，验证适配与原生界面通路，不宣称模拟了所有上游时序。
