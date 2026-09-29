# Advanced Charts 交付缺口核对

更新：2026-09-30。此文件是剩余实施清单，不是完成声明。生产未部署，远端未push。

## 已有直接证据

- 原生新建、复制、重命名、切换、删除活动工作区后继续保存、空列表恢复：浏览器专项通过。
- 保存409冲突后的草稿恢复：真实前端+注入冲突通过，独立副本保留文档。
- 手机临时周期/视区操作不产生advanced-charts写入，桌面草稿不被删除：浏览器通过。
- EURUSD M1、XAUUSD M5、BTCUSDT M5指定历史日期跳转完成后视区稳定；单次缓存速度约5.1秒/未单测/1.24秒。冷加载速度不保证，BTC一次补齐117.6秒。
- Python SMA/MACD/STOCH/BBANDS参数保存恢复及后端序列，内置八类指标创建，九类画线持久化已有专项证据。
- 后端全套：/tmp/mw-backend-regression.log，146 passed、5 skipped；跳过项不算通过。

## 本轮补充证据（2026-09-30）

- 手机412×915竖屏验收已通过：8图加载、临时操作后写入请求为空、页面异常为空。截图已人工检查，完成状态未遮挡工具栏；8图在窄屏中每格较窄，单图最大化阅读仍需检查。
- 手机此前无法找到图表iframe的直接原因是开发静态源5187停止；恢复该服务后通过。不能把此前失败归因为已确认的登录/会话问题。
- 月线真实加载及保存恢复已有两轮通过，恢复前后视区一致；首次高周期请求数量限制已验证为D1=91、W1=13、MN=3。这不覆盖周期切换、历史拖动和所有冷加载场景。
- 混合8图保存恢复最近一轮通过。三小时窄视区最新实测通过：8图M5/M15/M30左右边界完全一致；关闭同步后仅被操作图表移动，其他7图视区不变，页面异常为空（/tmp/mw-narrow-viewport-current.log）。随后真实鼠标验收通过：8图crossHairMoved事件时间位于对应周期的一根K线以内；滚轮缩放、按住拖动的左右视区误差不超过对应周期一根K线，关闭同步后保持独立，无页面异常（/tmp/mw-mouse-drag-viewport.log）。截图确认异品种没有显示EURUSD水平价格线（/tmp/mw-mouse-crosshair.png）。

## 依次收口

1. **高周期首次加载预算**：当前getBars完整满足countBack，新工作区已有3个月初始视区约束；仍须检查周期切换和已保存布局是否发起过大的历史请求，并提供渐进显示/明确加载范围，不能退回错误截断造成时间轴缺口；验证D1/W1/MN真实冷加载、向左拖动、取消。现有聚合单测不证明体验。
2. **多图稳定性**：混合8图、窄时间范围及真实鼠标十字线/滚轮/拖动已验证；仍需检查加载中切换同步及错误恢复；首次原生布局绑定已改为等待dataReady，之后月线及8图通过；其他路径仍保留异常断言。
3. **绘图与指标体验**：跨工作区/品种隔离，盈亏比显示数值，鼠标实际绘制，Python长历史数值/预热验证。对象API创建通过不等于这些全部通过。
4. **原生界面视觉检查**：去掉外层工具栏后桌面深浅主题截图、手机阅读、底部状态提示遮挡、未接入入口说明；已有功能清单旧表必须结合状态校正阅读。
5. **运行及交付**：开发API需加载5ee44d6覆盖等待修正；生产静态镜像运行/跨来源TLS与compose、备份迁移回退验证未完成。缺失CSV导出和hammer资源仍需明确处理。
6. **原功能回归与交付包**：预警/演练/ntfy原有行为按实际改动面核验；整理版本、验收与已知限制，不把pytest跳过项计入完成。

用户接受慢请求显示加载状态，不要求一次十年M1；不能把内部测试60秒超时当成用户硬性SLA，也不能以延长测试超时替代可用的加载反馈和取消。

- 本轮日线和周线真实历史加载、原生保存、刷新恢复通过；恢复前后视区严格一致，页面异常为空（/tmp/mw-daily-real-restore.log、/tmp/mw-weekly-real-restore.log）。缓存已有历史，此结果不代表冷加载性能。

## 失败恢复与新发现（2026-09-30）

- `MARKET_WATCH_HISTORY_FAILURE=1 MARKET_WATCH_TEST_RESOLUTION=1D`运行`advanced-monthly-live.browser.cjs`：真实前端M30规划响应注入error后，切回D1、同步状态恢复、保存及刷新成功，视区严格一致，无页面异常（/tmp/mw-history-failure-without-range.log）。仅覆盖错误响应和切周期恢复，不覆盖任务重试按钮。
- **未解决：D1指定视区后保存恢复偏移**。在上述用例额外设置`MARKET_WATCH_REAPPLY_RANGE=1`，调用公开setVisibleRange后保存，刷新左右边界发生变化（/tmp/mw-history-failure-stable.log）。保存前等待2秒也复现；去掉setVisibleRange操作后通过。因此不能把此问题归因为失败恢复卡死，也不能把日线任意视区保存声明为已通过。下一步独立复现正常日线setVisibleRange/鼠标缩放保存，检查原生barSpacing/rightOffset及保存状态。

### 日线视区偏移定位结果

- 无需模拟行情失败，单独`MARKET_WATCH_REAPPLY_RANGE=1 MARKET_WATCH_TEST_RESOLUTION=1D`也能复现；测试参数已移到失败分支之外。
- 保存前barSpacing=14.7012987012987、rightOffset=9、width=1132；恢复后间距和宽度相同，rightOffset=10。原生widget.save返回timeScale.m_rightOffset=10。
- 只读检查供应包发现普通state保存defaultRightOffset，而非实时rightOffset。临时通过公开API把默认偏移设为9后，刷新视区完全一致（/tmp/mw-daily-default-offset-probe.log）。该探针已删除，没有修改供应包或将改变用户默认留白的处理写入产品。
- 下一步应在适配层保存当前视区并用公开API恢复，覆盖原生加载、刷新、8图以及历史位置；不能把更改默认留白当成完整修复。复现仍保留失败，交付缺口仍开放。

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
