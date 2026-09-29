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
