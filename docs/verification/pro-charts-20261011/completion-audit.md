# 2026-10-12 逐项合同审计

本表按原始方案的验收条件核对；报告中的检查数量不是完成判据。
真实运行环境是 Ubuntu `quant-server` 的独立 Docker project `mw-pro-charts-20261011`。
许可图表引擎、应用 API、PostgreSQL 均实际运行；供源 I/O 是该实例的合成 fixture。

| 合同 | 直接证据 | 状态与适用边界 |
| --- | --- | --- |
| F1 原完整五图→单图→BTCUSDT→XAUUSD→Yahoo AAPL→组合→五图 | `browser-full-stack.json` | 已通过，每格身份/周期/非零范围 |
| F1 同系列多格、比较消费者、更多布局、品种与周期同步开关 | `browser-consumers.json`、`browser-revision-consumers.json` | 已通过2v/3r/4及隐藏往返；原生共享订阅和四个实际图格分别核对 |
| F1 真正旧消费者与工作区世代取消 | `browser-lifecycle.json`、`fixed-lifetime-green.txt` | 已通过真实工作区连续加载；延期HTTP是标明的受控屏障 |
| F1 组合活动修订实际改变 | `browser-revision-consumers.json` | 实际POST201准备、POST200启用、真实stream reset及原生重载；未以snapshot模拟替代 |
| F2 统一锁序和所有cancelled/realtime分支、回收保护 | `publication-green.txt` | 真实PG，39项分支与锁等待检查 |
| F2 完整事务重试、worker轮次恢复、导入/发布交错 | `history-recovery-green.txt`、`import-publication-green.txt` | 仅40P01/40001有限重试；真实独立PG连接和屏障；32+6项 |
| 首次需求登记相同key、续租不倒退与真实提交边界 | `demand-green.txt` | 55项真实PG/data_sync检查；引用保护保留 |
| DC1 三个必填下拉框及公共控件合同 | `select-green.txt`、`browser-data-center.json` | 鼠标命中、键盘、首个invalid焦点、disabled和未保存保护；真实映射/修订写入 |
| F3/U8 告警可读身份、发起格格式、人工价格和原告警合同 | `browser-alerts.json`、`alert-final-regression.txt` | 组合、EURUSD/JPY/黄金/加密/Yahoo菜单；人工18位小数提交刷新；Yahoo独立股票日历不扩展计算 |
| F3 通知与事件精确Decimal、旧非chart标题 | `notification-runtime.json`、`browser-notifications.json`、`notification-title-final.txt` | 真实PG提交重读和事件API/UI；新事件JSON证据保留精度，旧事件fallback；外部投递关闭 |
| F4 公平有界派生、输入缓存与持久检查点 | `derive-eta-green.txt`、`derive-recovery-green.txt` | 两任务/两周期5000观测轮转，64MiB有界LRU；真实PG暂停/取消/进程退出回滚与恢复 |
| F4 近期吞吐ETA、等待及暂停/恢复不误导 | `derive-eta-red.txt`、`derive-eta-green.txt`、`derive-eta-recovery-pg.txt` | 使用每周期最近64个已提交批次，60秒窗口；以墙钟含排队时间估计，过期或恢复尚无新批次时为空 |
| F4 真实任务详情、暂停/恢复和完成页面 | `browser-derive-progress.json`、`derive-progress-runtime.py` | 3项真实PG/API/UI检查；24,002累计观测、2个周期；页面暂停和恢复尚无新批次时ETA为空，新提交后恢复估算，完成显示2/2且不再显示旧ETA |
| F4 约215万真实形状九周期分段/内存/逐桶一致性 | `derive-contract-benchmark.py`、`derive-contract-2147763.json` | 2,147,763观测，457.87秒/派生峰值411.83MiB；2,841,385桶与固定基线全部字段一致；真实PG读写/提交，临时schema已删除 |
| F4 pandas/Polars有界原型及Decimal/日历合同 | `derive-batch-equivalence.json` | 60,000分钟有界输入（实际59,390观测），NY17/UTC0×春秋DST×九周期共36场景，两引擎全字段等价；该语料的价格/量分别缩放且Int64范围验证；原型峰值458.55MiB，保留现有Decimal运行时 |
| F5/U1 日历可区分身份、真实审核时间和布局 | `calendar-green.txt`、`browser-presentation.json` | 真实审核audit/CLI；两主题1600/768/375px搜索筛选/展开，无水平溢出 |
| F6 八Python指标正确分类、收藏、添加和保存恢复 | `browser-indicators.json`、`indicator-green.txt` | 稳定native ID优先；真实server工作区保存/刷新 |
| U2 入口盒、图形居中、开关/选中/焦点/主题/缩放 | `browser-native-zoom.json`、`browser-presentation.json`、`browser-operation-hints.json` | 两主题实际Chromium原生100/125/150%页面缩放，6项；44CSS px盒与22/22中心，键盘开关/选中/原生::before焦点框；原等效视口/DPR模拟作为补充 |
| U3/U4 侧栏高度稳定、详情独立时间行 | `browser-presentation.json` | 两主题、8次开关；四时区真实来源观察时间；rare状态明确标注snapshot回放 |
| U5 真原生提示、分区提示切换、窄屏、末行和错误/焦点 | `browser-operation-hints.json`、`browser-presentation.json` | 实际SymbolSearchDialogFooter挂载；分区短提示，实际API重试；503注入只用于错误路径 |
| U6 三类×M1/M5/H1/D1冷暖/拖动/边界/大需求 | `browser-reserve.json`、`browser-lifecycle.json` | 12组真实拖动/储备/柱宽，原生24120根单次交付；实际拼接与缩放；unknown受控输入不当EOD |
| U6 储备就绪耗时、缓存内响应与帧耗时基线 | `browser-reserve-performance.json` | 三类×四周期12项；每项30个idle/60个原生缓存拖动帧，预算由实测idle基线推导；背景读取明确延迟900ms，缓存偏移立即生效；短固定历史在确认起点单独核对 |
| U6 指标预热与修订、输入、消费者世代防旧响应 | `browser-reserve-indicator.json`、`browser-reserve-fencing.json`、`fixed-lifetime-green.txt` | 真Python SMA200与运输；900ms延迟/世代变化明确为受控seam；21001根11页及预算耗尽 |
| U7 九独立位、同步绘图、复制、undo/redo、存档、旧范围 | `drawing-visibility-final.txt`、`browser-drawings.json` | 许可引擎实际九周期求值，单对象/多选；原生undo宏和工作区属性持久化 |
| U7 mixed多选、旧范围明确迁移、手工/组隐藏、告警association | `browser-drawing-association.json` | 真实多选/cancel/undo；真实绘图告警POST201；仅改周期不改告警版本 |
| F7 手机入口说明和只读限制 | `browser-mobile.json` | Chromium竖横屏触摸模拟通过；单图、返回、无写入、桌面工作区hash保持 |
| F7 Android/iOS实机竖横屏/软键盘/触摸/返回 | `acceptance-decision.md`、`mobile-device-availability.json`、`mobile-physical-acceptance.md` | **用户负责后续实机验收，尚未验收**。用户明确不作为开发硬性阻塞；手机触摸模拟已通过，实机步骤和记录矩阵已准备 |

追加审计发现并修复的实际遗漏是累计速度ETA，以及未随分区变化的数据中心提示。
活动修订验收另发现验收Compose缺少独立stream计算角色；补上真实worker后验证实际修订变化。
这些是本机验收变化，没有生产切换、unraid实例、外部投递或仓库凭据/许可资源。

最终逐份核对20份浏览器报告：合计119组cases/checks，全部`passed=true`、`errors=[]`，没有失败case。
完整F1序列最后一轮进程退出0；报告记录6次`net::ERR_ABORTED`（stream与quote请求），无HTTP错误响应。
这些请求取消记录保留在报告中；五格最终均具有正确身份、周期和非零范围。
42个运行时源文件哈希与`source-manifest.json`一致；7个服务运行，API与PG健康。
各证据的哈希及最终环境核对见`final-verification.json`；Android/iOS实机项继续保留为未验收。
2026-10-12先前因缺少设备连接将goal标记blocked；随后用户明确移动端实机验收由其负责，不作为硬性阻塞。
当前收口条件以`acceptance-decision.md`记录的用户决定为准；实机结果保留未验收事实，作为用户后续反馈项。
原生缩放、36场景批量原型和12项储备帧耗时补验均通过；本轮开发要求已满足，开发goal已标记complete。
Docker生命周期task/project保持进行中，7个服务及任务数据卷保留，不finish/retire。
两条前期合成AUDUSD调试任务按明确version和dataset核对后处理：错误v1已取消，旧v2实际派生完成2/2。
记录与数据均保留，结果见`debug-progress-tasks.json`；Docker任务/project继续进行中，实例和数据卷保留。

原215万性能结果 `derive-end-to-end.json` 是总耗时和两项组合阶段测量，
其本身没有逐桶对照。新的合同脚本加载固定git基线的原始 `_pair/_add/_finish`，
按块流式逐字段比较全部九周期；分段计时包含探针开销，不能据此宣称生产加速倍数。
SQL分段包含实际执行及数据库等待，无逐页人为1秒等待。

完整测量的分段为排他墙钟秒，包含探针开销：

| 阶段 | 秒 |
| --- | ---: |
| SQL读取与数据库等待 | 57.64 |
| 来源内容访问 | 0.02 |
| gzip解码 | 0.36 |
| JSON解码 | 2.89 |
| 价格归一化 | 21.00 |
| 输入checksum、日历证据、缓存与物化 | 14.23 |
| 桶键 | 14.52 |
| Decimal聚合 | 65.76 |
| coverage与完整性判定 | 75.07 |
| JSON编码 | 24.88 |
| gzip编码 | 50.87 |
| SQL写入 | 15.17 |
| flush/commit及等待（扣除已计SQL） | 36.30 |
| 其他Python调度/物化和测量开销 | 79.15 |
| 九周期实际派生总计 | 457.87 |

3960个批次，最长1.98秒；输入归一化49次；LRU高水位60,270,506字节，小于64MiB。
逐桶基线比较另用834.44秒；包含基线比较的全进程峰值464.51MiB，不能当作worker派生峰值。
真实PG基准数据集具有周末、未知缺口、来源未确认和缺失量，跨越多年DST与W1/MN边界。
本次派生阶段同时有本任务浏览器验收和隔离stream worker活动；最终镜像重建仅在派生测量结束后进行，
其开销可能影响随后基线比较耗时。结果不包含供应商导入速度，也不是生产耗时承诺。

追加批量原型使用60,000分钟有界输入，缺口后实际59,390观测，覆盖NY17/UTC0与春秋DST共36场景。
pandas/Polars的OHLC、量、coverage、确认与日历字段全部等价；语料中价格5位、量2位独立缩放并验证Int64范围。
原型峰值458.55MiB包含基线与两引擎；没有将通用生产数据安全范围视为已证明。
各场景分组加最终化合计pandas14.27秒、Polars10.72秒，转换另17.31秒，原逐行路径41.21秒。
这些CPU对照复用基线桶键，不包含SQL、队列与恢复；运行时继续采用已通过完整PG合同的Decimal路径。

U6追加帧耗时使用真实原生缓存，以time-scale API每帧移动一根并反向；实际鼠标拖动另见原12组矩阵。
各项以自身idle基线推导帧预算（3倍中位数或2倍p95），同步调用预算为半帧或8ms。
12项帧间隔p95为16.7–16.8ms，原生偏移调用p95为0.4–1.5ms；储备就绪344–3890ms。
8次背景读取明确注入900ms延迟，拖动的原生偏移仍立即生效。
背景读取可处于pending；验收逐帧证明视口偏移即时生效、价格仍可用且柱宽不变。
短固定日线只有46根且已确认起点，不要求填满整个屏幕，也不向其他版本借历史。
这些无头Chromium结果仅描述本机运行环境，不作为实机/生产帧率承诺。

## 2026-10-12 网页逐屏截图与目视审视

已登录Ubuntu真实Docker网页，采集并逐屏审视70张交付截图，覆盖深浅主题、五图、品种详情、告警与日志展开、
价格菜单/弹窗、八Python指标/详情、九周期绘图设置、数据中心六分区、三个必填下拉框、真实任务进度/底部、
768/375px桌面窄屏及手机竖横屏触摸模拟。[截图索引](visual-acceptance/index.html)与
[逐屏结论](visual-acceptance/review.md)给出每张图的目视判断和适用范围。

此次目视验收发现并修复两项缺陷：长来源说明挤掉告警状态和日志时间，及浅色状态文字对比度不足。
修复后状态/时间溢出0px，浅色状态对比度最低5.003:1；失败与通过证据分别保留。
chart/web通过带task/project/purpose的mw-docker实际重建与部署；价格告警、展示回归及新增4组专项检查通过。
当前20份浏览器报告共119组检查通过，42份运行时源哈希核对一致，七个服务继续运行。
展示回归首次遇到请求队列拥挤，原失败记录保留；独立重跑及诊断重跑均通过，未将其归功于CSS修复。

目视结论是本轮桌面及窄屏UI达到验收预期，发现的视觉缺陷均已修复并重拍。
供源I/O仍为任务合成fixture，真实供应商链路尚未验收；手机实机由用户后续验收，不成为硬性阻塞。
截图不包含登录凭据、cookie或许可源码。实例保留，Docker生命周期任务仍active，不finish/retire。
