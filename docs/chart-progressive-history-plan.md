# 渐进历史加载与周期预热

状态：实施中，未交付。Ubuntu 本机验收，禁止操作 Unraid 生产服务。

## 已确认需求

1. 首次打开无数据品种也保持图表可操作；M1 至 D1 各周期渐进显示。
2. 当前视图首屏优先，其后当前周期三倍窗口，再预热相同柱间距下 D1 三倍窗口。
3. 依据实际交易日历计算目标区间；缩放/尺寸变化防抖，目标只向过去扩展。
4. 按品种合并持久化需求与缺口；分段下载、分段聚合，不等待整个范围完成。
5. 聚合优先级随当前周期/焦点变化；指标的前置历史需求合并处理。
6. 历史位置跳转先满足所看区间；最后一次周期选择优先，旧响应不能覆盖新视图。
7. 前端有容量上限的缓存预热；服务端快速读取与补数规划分离。
8. 历史不完整的 K 线不得冒充完整 K 线；当前未收盘 K 线正常更新。
9. 补入历史保持柱宽、查看位置、画线和多图同步；通过原生公开接口实现。
10. 实时 M1 维护/近期修复及预警最高优先；独立执行资源、限额和短事务，满负荷历史下验收延迟。
11. 关闭图表后继续完成固定目标，降到最低优先级；不追随当前时间无限扩展。重开提升优先级，重启继续。
12. 周线后台低优先级；月线仅本地聚合，不额外补数。
13. 后台任务可查看进度、失败和取消；失败退避，上游历史边界明确处理。
14. 进度在图表角落轻量显示，不使用阻塞遮罩；缓存命中切换目标 100–200ms，须实测。

## 实施顺序与验收证据（未勾选即未完成）

- [ ] 旧请求取消：复现四个慢请求占满后返回 M5；新请求不再排队等待旧请求。
- [ ] 原生公开接口验证部分数据渐进补入，空图、部分日线、已有历史视区均保持可操作。
- [ ] 持久化统一需求模型、日历目标计算、合并、焦点/关闭降级、重启恢复。
- [ ] 快速缓存读取与异步规划，已完整覆盖的数据不等待规划锁。
- [ ] 首屏/预热/周线/关闭后台优先级、独立实时通道及数据库短事务。
- [ ] 分批聚合、周期优先调度、完整性与指标前置历史。
- [ ] 前端预热/容量管理、缩放只扩目标、历史位置需求、进度和任务界面。
- [ ] 真冷启动 OANDA 数据验证、各周期连切、八图竞争、断网恢复、关闭重开。
- [ ] 满负荷补数的实时延迟和数据库锁观测；缓存切换性能。
- [ ] 兼容回归：柱宽、保存恢复、多图同步、只读手机、旧预警模块。
- [ ] 本机镜像构建与最终逐项验收，版本记录和回滚说明；不推送远端。

## 基线证据

`advanced-pending-switch.browser.cjs` 在现有本机容器上拦截四个高周期历史请求并延迟25秒：回 M5 后8秒超时，pending=4、queued=2、dataReady=false。单个 pending 响应不导致同样卡住，不能把 rangeGuard 当成已证实根因。


## 实施记录

### 旧请求通道释放（候选已部署 Ubuntu）

- history 请求带有效性检测；每100ms检查仍有查看者及工作区世代，失效则释放桥接槽位并向父页面发送 cancel-request。
- 父页面使用 AbortController 中断相应历史HTTP等待，保留后台任务；原生回调继续走取消错误路径，不引入未经验证的 rangeGuard 修补。
- 原有排队取消/历史去重测试通过；新增 in-flight 测试验证四个槽位180ms内释放。
- TypeScript/Vite 构建通过。Ubuntu `progressive-dev` web/chart 镜像运行中，API及worker仍为1.2.0-local。
- 真浏览器受控网络回归：4个25秒慢请求后回M5，基线8秒超时；修复后966ms恢复（含数据读取，不是纯缓存命中指标）。日志 `/tmp/mw-progressive-cancel-browser.log`。
- 整体目标仍未完成：原生渐进历史注入、持久化统一计划、读取与规划分离、实时资源隔离、预热和最终性能验收均待实施。

### 独立缓存读取接口与原生渐进验证

- 新增 `/api/market-data/history/cache`：只读已注册品种，不进入规划器、不创建补数任务。返回本地观察和覆盖信息，空结果不表示上游没有历史。
- 过滤已结束但未完整的历史K线；当前形成中K线只有在桶起点至已完成分钟之间有完整查询覆盖时才返回。
- `test_history_cache.py` 覆盖无规划副作用、冷品种不注册、历史部分K线过滤、当前K线覆盖门槛及鉴权，4 passed。此前与 market_data 的组合回归39 passed；ruff通过。
- 接口尚未接入生产 Datafeed，未部署新API镜像；后续应根据覆盖区间避免拼接历史孤岛，并与统一需求上报分离。
- 新增 `advanced-progressive-native.browser.cjs`，使用受控连续日线经公开 getBars/resetCache/resetData 验证空数据 -> 20 -> 80 根，6px柱距和右侧时间不变，再切M5可用。这不是OANDA冷启动验收，不能替代黄金交易日历/多图/指标验收。
- 扩展到历史浏览位置后复现失败：8月1日至21日视区在补到120根后跳到9月7日至8日。最新边缘测试通过不代表历史视区通过。保留失败断言，下一步需要公开API捕获/恢复视区并处理原生异步重置与用户同时缩放的竞争，不能直接接入resetData刷新。

### 公开接口渐进刷新可行性进一步验证

- 修正受控Datafeed的边界：返回足额countBack时不能标记noData=true；此前测试导致原生误以为历史结束，阻止恢复视区时追加分页。现按本地实际短页标记边界。
- 新增 `refreshChartHistory` 候选辅助函数：保存指定图表视区，订阅公开onDataLoaded后resetData，等待原生绘制周期，再通过既有restoreChartViewports恢复。仅复用dataReady或仅等待一次setTimeout(0)均复现Value is null；onDataLoaded加两个animation frame的候选通过。
- 浏览器受控连续日线：空 ->20->80根保持6px柱宽；右端容许一个D1标签偏移，尚不等于严格视觉不动；查看2026-08-01至08-21，再补到120根后范围完全一致，切M5可用。日志`/tmp/mw-native-progressive-helper2.log`。
- `advanced-viewports.cjs` 原有恢复回归通过。函数尚未接入实际补数刷新路径，需继续验证用户操作竞争、黄金交易间断、多图同步、画线/指标及真实冷数据。

### 持久化统一目标模型（尚未接入运行worker）

- 新增ChartHistoryPlan按品种唯一保存历史目标；ChartViewportDemand记录窗口当前周期、首屏、三倍窗口、焦点与45秒活动期限。
- 目标按现有NY17/UTC0和已确认休市配置逆推实际可交易分桶。持久目标只扩不缩；心跳到期后不自动延长结束时间，后台优先级降至300；其他可见窗口仍保留首屏优先级。
- 三倍D1目标与当前周期三倍窗口合并；日历扫描在写锁前执行，锁内只合并持久目标。
- 迁移j11已写入仓库但尚未在运行数据库执行。测试覆盖NY夏令时周末、目标扩展/不回退、跨事务重读、关闭降级和多窗口共享；与缓存读取测试合计7 passed，ruff通过。
- 尚需队列连接、上下游历史边界、取消语义、实时资源隔离，以及完整UI/浏览器验收。不要将数据模型测试当作端到端交付。

### 计划与下载队列连接（未部署候选）

- 新增 `advance_plan`：按活动首屏、当前周期预热、D1预热顺序，每轮最多新增一段4000分钟任务；缺口计算同时减去已有覆盖和pending/running/failed任务预留，避免重叠下载。
- ImportJob增加chart_plan所有权列，只有本计划创建且尚未执行的任务随焦点/关闭变化升降级；原有修复、手工任务不降级。j11迁移一并增加该列，运行数据库尚未迁移。
- worker维护循环连接advance_pending_plans；每品种单独事务释放锁。API新增鉴权 `/history/demand` 接受有界视图需求，接口不直接执行网络下载。
- 计划与原market_data测试40 passed；增加完整覆盖完成计划、取消计划不继续排队测试。仍需前端上报、真正异步缓存读取/补入、实时隔离和运行容器验收。

### 前端视图需求上报（候选未部署）

- history-demand.js通过公开图表宽度/柱间距计算可见根数；周期、品种、视区事件250ms防抖，15秒续期，窗口对象身份跨周期保持稳定。W1/MN不触发D1预热。
- 父页面新增historyDemand/historyCache协议映射；bridge在图表ready后启动上报，错误使用独立状态键并在成功后清除。
- 单位测试覆盖根数、未来空白裁剪、周期切换共享id、缩放增加需求、续期、月线排除和dispose；前端TypeScript/Vite构建通过。
- 尚未迁移/部署；Datafeed尚未切到渐进缓存路径，下一步需该连接及实时资源隔离。当前上报仍需真实八图焦点、布局变更、读写竞争验收，不能视为满足全部响应性能。

### 日内/D1渐进读取连接（候选未部署）

- 普通M1至D1的getBars已改走historyCache，返回已有K线及暂时本地边界，不等待下载。W1/MN和Python合成指标暂保持原路径。
- 新progressive-history模块将近期页保留在有界64条缓存内，复用同页在途请求；每2秒检查仍在查看的页，对数据修订调用公开视区恢复刷新。忙碌图表不消费修订，下轮继续尝试。
- 服务端缓存页截断到连续观察的后缀：未确认查询覆盖且处于交易时段的缺口不会连接两端历史孤岛。
- cache测试5 passed；JS覆盖去重、短期缓存、相同数据不刷新、修订刷新、忙碌后重试及离开后停轮询。原历史去重、周线后台、月线本地测试通过。
- 此连接未经真实容器验收；仍需修正/验证：空图暂无订阅时的缓存失效、历史区间恢复的用户操作竞争、多图轮询调度、跨周期主动预热、近期实时通道、后台任务UI与完整迁移部署。

### 首次运行容器集成

- 修复advanced-host/.dockerignore漏掉两个新增脚本；构建API/web/chart progressive-dev并更新Ubuntu验收容器。
- 开发库先核对账户数据库名trading_alerts_dev、通知关闭。原库alembic为h9但周线表已存在，逐列/主键/索引/外键核对与i10一致后校正版本；首次命令在stamp后因连接数上限失败，复查已是i10再升级j11成功。仅暂停本机API/worker释放连接，无生产操作、无连接限制上调。
- 新模型已迁移到开发库。空图无订阅时补入数据需要widget.resetCache回退，已加入候选。
- 首次容器验收暴露长日历扫描占用API单连接，优化为检查每小时周历变更点和精确closure结束点；NY规则仍来自现有scheduled_open/zoneinfo，不自写DST日期。与原逐分钟扫描的等价用例、既有计划用例合计6 passed。
- 重新构建/启动API及worker后，advanced-bar-spacing真实HTTPS容器测试通过D1/H1/H4/D1/M5全部6px，日志/tmp/mw-progressive-second-container.log。worker日志确认4000分钟分段OANDA下载和入库开始工作。
- 待验收仍包括真实新品种从空到日线、用户操作竞争、跨周期快速缓存、多图、实时独立资源、聚合优先级、任务界面和完整版本收口。当前运行版为开发候选，非交付版本。

### 实时维护独立执行通道（Ubuntu候选运行）

- 新增realtime_worker，独立进程和HTTP连接池，复用market.once的入库、恢复任务和预警计算，不复制预警算法。维护品种先执行，再处理有活动需求的临时品种；关闭后需求到期不再轮询临时品种。
- market.once增加可注入fetcher及include_viewers可选参数，默认原有行为不变；移除chart_history_worker内近期行情维护，历史循环只规划/下载历史。
- 本机compose增加realtime-worker；API/历史worker/实时worker使用progressive-live-dev镜像49f6b2e045cb，通知仍禁用，未操作Unraid。
- 实时选择/关闭行为测试通过；原market/recovery和新增实时回归23 passed；market_data/计划42 passed。ruff通过。
- 初步运行：17:25:21实时循环3.423s完成；并行历史页4000分钟拉取2.127s、含入库5.192s。这里只证明独立执行已运行，不能作为长期延迟/实时绝对优先验收。
- 仍需：历史入库锁切小、资源竞争时让步、持续延迟监测，聚合周期优先级和完整冷启动/八图/性能收口。

### 后台任务可查看/控制（候选未部署）

- 新增鉴权计划列表和控制API，显示固定目标UTC区间、已查询覆盖比例、优先级和失败数量。进度是查询时间范围比例，不承诺上游每分钟必有报价。
- cancel只取消本计划所属任务并撤销其租约，不删行情、不改其他修复任务；resume保留游标继续，retry重置失败任务。计划控制回归通过（计划测试合计7 passed）。
- 原生header增加历史任务入口，父页面原生dialog展示列表并每5秒刷新；支持取消/继续/重试，手机只读。TypeScript/Vite构建通过，视觉与浏览器交互尚待验收。
- 实时连续初步日志五轮约3.0–6.6秒，仍非压力性能通过证据。完整目标保持未完成。

### 渐进刷新与交互竞争

- refreshChartHistory订阅公开mouse_down/activeChartChanged；加载期间发生新操作时不恢复旧视区。绘制后柱间距变化视为新的缩放意图，同样让步；完成/失败均移除临时事件监听。
- bridge传播未完成恢复的false结果，渐进缓存保留待重试修订。需求上报监听activeChartChanged，焦点变化250ms防抖后上报，不再只等15秒心跳。
- 新advanced-refresh-interaction测试覆盖鼠标让步、柱距变化、正常恢复和监听清理；已有viewports、history-demand回归通过。
- 真实浏览器progressive-native（受控连续日线、公开接口、使用当前候选helper）退出0，日志/tmp/mw-progressive-interaction-browser.log。这不替代真实鼠标滚轮八图交互验收。

### 跨周期首屏缓存预热（候选未部署）

- 焦点需求上报成功后，顺序读取M1/M5/M15/M30/H1/H4/D1中其他周期的已有三倍窗口；只有一条预热链，品种/工作区切换时退出，不创建额外下载计划。
- 预热读取的有效性以品种仍可见为准，不要求该周期当前可见；普通读图仍按具体周期取消旧请求。
- progressiveHistory加入warm接口与覆盖范围复用：相同品种/周期、足够历史根数且时间右界被覆盖的15秒内页可直接满足请求；跨周期不复用、超出右界重新读取、64页容量淘汰。
- advanced-prewarm-cache、progressive-cache、history-demand测试通过。尚未验证浏览器100–200ms性能目标，也未覆盖全部指标warmup，不能关闭预热验收项。

### 真新品种冷启动初验

- Ubuntu全栈更新为progressive-check镜像（含任务面板/预热/交互让步），通知关闭。
- 测试前数据库确认OANDA:EUR_AUD尚未注册Instrument；新增advanced-cold-acquisition.browser.cjs使用真实API、真实OANDA，不拦截历史。
- 原生历史任务按钮实际点击并打开父页面dialog通过；首轮文本选择器撞到原生响应式隐藏副本，改用按钮可访问名称定位。
- EUR/AUD空H1切D1/M5/H1公开setResolution耗时30/28/9ms；约15秒后缓存返回2根H1、119根M1、24根M5、8根M15、4根M30、1根H4，D1尚空。截图/tmp/mw-cold-history.png确认H1柱显示，测试退出0，日志/tmp/mw-cold-acquisition.log。
- 此结果仅证明空图可切及首批数据出现；不是首屏补满、暖缓存绘制耗时、D1渐进补入或鼠标响应的完整证据，仍需后续验收。
- 检查任务取消与入库并发，统一历史入库提交的锁顺序为instrument->job，避免与规划/控制的instrument->job形成反向等待。market/recovery/plan回归29 passed；此后端小改动尚未部署。

### 关闭后持续补齐与独立进度提示

- 真实冷启动测试关闭后，开发库EUR_AUD已增长至14306根M1、240根H1、11根D1，计划仍pending；所属低优先级300任务已有完成记录，证明关闭不会停止固定目标补数。仅采样证明持续推进，不代表整个目标已完成。
- 补数文案此前复用status，被自动保存/其他周期状态覆盖；拆为history-progress独立消息和界面状态，按品种/周期保存，当前可见图集合变化移除过期项，切工作区清空。
- 进度固定在图表左下角，不接收鼠标事件，不影响原生操作。足额页清除相应提示，短页显示已返回根数；尚需核对完成边界与首屏根数提示是否一致。
- TypeScript/Vite构建与bridge语法检查通过；此UI调整未部署，视觉验收仍待执行。

### 连续批次调度与预热队列上限

- advance_pending_plans移出15秒维护节奏，改为每个import批次前执行；成功后0.2秒让步，空闲时1秒检查。周线/目录维护仍保留原节奏。
- 每品种计划所属pending/running最多两段；新高优先级首屏可替换未执行低优先级页，旧页标记superseded，统一目标保留，后续重新规划，不因恢复取消任务误复活淘汰页。
- cadence与计划回归10 passed，覆盖连续三批不等待维护时钟、队列上限、完成后补新页、新首屏替换深度预热。
- Ubuntu仅历史worker升级到progressive-continuous镜像f495fd8ae2cd；API/realtime/web/chart仍为progressive-check。新worker含此前锁顺序修复。
- 日志17:43:30至17:43:57：EUR_AUD/BTC交替连续处理，每批总耗时2.806–8.230s，批次启动间隔约0.2秒加规划开销，不再空等15秒；同期实时循环3.102/3.939/3.959s。
- 用户上轮收到的各周期整屏估算基于旧15秒批次安排，已告知该估算不再适用于新版本。尚需各周期首屏真实计时、满负荷延迟、多图及整体验收，不能用批次日志代替。

### 指标前置历史并入计划（候选未部署）

- 记录原生getBars countBack（按实际基础品种/周期合并），在视图需求中提交required。后端当前周期首屏范围取max(可见根数,required)，预热范围取max(required,3倍可见根数)，D1仍只按3倍可见根数确定，避免指标参数放大日线预热。
- 测试可见20根H1/required200，优先需求200根H1、D1目标60根；计划+market_data回归46 passed，ruff/bridge语法通过。
- 当前单次required沿用计算上限6000；超过时明确显示提示，不能静默宣称指标完整。更大需求分页及Python指标缓存计算尚未完成，指标便利性验收不能关闭。

### 恢复任务的队列上限

- 修正取消后恢复/失败重试时批量复活旧任务的问题：按当前视图优先级和最近历史排序，扣除现有 pending/running 后最多恢复到两个在途任务；其他旧任务置 superseded，由持久目标后续重新规划缺口。
- 不改变已入库数据、已提交游标或目标范围；重复恢复不复活已让位任务。
- `test_chart_history_plan.py` 11 passed，ruff通过。新增测试从四个旧取消任务恢复，验证队列上限、当前首屏优先、游标/目标保留与重复恢复。
- 仅源代码验证，尚未构建部署此修正；整体实施和验收继续，未交付。

### 缩短行情批量写入的SQL编译时间

- cProfile对完整4000根M1入库/五周期聚合测得SQLite样本2.937秒，其中SQL编译约1.08秒。将每500行展开SQL改为Core参数化executemany后，同样样本1.108秒；这不是网络下载或浏览器首屏耗时。
- 在已授权开发库trading_alerts_dev中使用单连接、会话临时candles/audit_events表进行PostgreSQL对照，整次事务回滚，不写真实行情表。4000根M1的write_bars基线0.939秒，候选0.282秒；两种实现均通过数量、重复写入幂等、已加载ORM对象修订可见性和审计断言。临时表DDL不附带外键，验证范围不包括外键约束。
- 增加跨500行边界的1001根回归，重复时间戳末次值生效，幂等不增修订，实际变更仅一次审计。行情/补数/恢复/缓存组合测试及ruff结果见本次运行记录。
- 候选尚未部署。聚合仍在历史入库事务内，不能将此优化当作独立异步聚合或实时优先完整验收。

### Python 合成指标接入渐进读取候选

- M1至D1的Python synthetic ticker不再进入旧historyQuery等待下载循环，先共享原品种progressivePages，再调用现有本地指标计算接口；空页直接返回，指标结果仅允许匹配已就绪原始页的时间戳。
- 原始页更新时通过decode匹配并重置该品种的合成指标订阅，避免价格已补齐但指标仍持有旧历史。
- 新增advanced-progressive-indicators.cjs，验证空页不调用计算、计算结果中的不完整/孤岛行不泄漏、历史扩展可见；原渐进缓存、预热缓存、旧请求取消测试通过。后端test_chart_workspace.py 19 passed，含指标分页共同起点和修订缓存失效。
- 尚未部署/进行Python指标真实浏览器渐进曲线验收；后端计算仍可能读取较大历史，性能与大countBack分页仍待处理。此项不作为指标端到端完成证据。

### 统一候选部署与Python指标真实请求失败证据

- Ubuntu本机api/realtime-worker/chart-history-worker/web/chart-origin统一更新到progressive-a257803镜像；api健康，TLS已重启。未操作生产服务。
- 新增advanced-progressive-indicators.browser.cjs，登录真实页面并调用合成SMA数据通路，断言不访问旧补数规划器且返回有效计算值。
- 首次运行失败：frame.evaluate报告“行情请求超时”，日志/tmp/mw-python-progressive-browser.log。API同时出现QueuePool size1 overflow0、15秒连接等待超时，发生于authenticated读取会话。该证据表明候选不能交付，需要定位占用连接的请求及缩短事务，而非扩大已约定连接上限。
- 并发运行日志出现历史入库1.041至6.081秒、实时循环3.252至9.126秒；不是稳定性能SLO证据。此前临时表批量写入优化不代表整条链路性能通过。

### Python指标超时根因与修复验收

- 只读开发库实测XAUUSD H1为13499根。cProfile读取约0.49秒，逐分钟has_trading_gap扫描588个间断耗时56.67秒，SMA计算0.019秒；主要成本是每分钟反复检查约260条闭市记录，长事务占据API唯一连接。
- chart_api复用已验证的bucket_has_trading边界扫描，仍使用ZoneInfo和原scheduled_open日历，不自定义DST规则。同数据缺口扫描1.07秒，总计1.60秒（含profiler开销）。
- 新增春季/秋季DST、UTC0/NY17、黄金/外汇、非整点恢复交易的差分验证；计划测试12 passed，原chart_workspace19 passed，ruff通过。
- Ubuntu api已更新indicator-gap-fix镜像，web/chart和两个worker仍progressive-a257803；镜像与源代码仅import排序差异，最终交付仍需统一构建记录。
- 原失败浏览器用例重跑成功：PYTHON_PROGRESSIVE bars=100 elapsed=1385ms planners=0，日志/tmp/mw-python-progressive-fixed.log。证明真实页面桥接下已有H1历史的Python SMA可返回有效值且不走旧规划等待。不能代替冷数据逐批曲线刷新、多图压力或M1大历史性能验收。

### 指标CPU处理归还连接与柱距回归

- 原生浏览器advanced-bar-spacing.browser.cjs在当前本机容器通过：D1/H1/H4/D1/M5均保持6px。日志/tmp/mw-spacing-current.log。
- 指标接口在读取行情、元数据与history_check后结束数据库事务，expunge品种对象；缺口判断、指标计算、结果裁剪和future_grid均在事务外完成。计算使用同一份读取快照，不在CPU阶段追加ORM查询。
- 新增连接checkout/checkin断言，验证三种CPU阶段没有持有数据库连接，且track_history正常返回；test_chart_workspace.py 20 passed，ruff已修正导入顺序。
- 本次源代码候选尚未部署；多图并发、M1大规模历史与异步优先聚合仍待验收/实施，不能由单连接释放断言推定全部性能达标。

### 单连接容器下指标与并发会话请求

- Ubuntu API部署indicator-conn-fix（image 04730caaf231，源代码a955ce4），TLS重启；worker/web/chart保持此前镜像，未操作生产。
- 浏览器用例增加指标请求期间每250ms发起一个串行会话请求，断言HTTP200且单次<5秒。真实页面返回100根SMA，2.676秒，旧规划器调用0；同期三次会话响应1.321/0.117/0.507秒，均200。日志/tmp/mw-indicator-concurrent.log。
- 仅证明该轮H1指标请求没有占满连接导致15秒超时；不是100–200ms切换目标或八图压力通过。实时worker同期周期日志2.781至6.118秒，仍需端到端M1新bar/预警延迟观测。

### 独立周期聚合步骤

- 提取aggregate_touched，从已持久化M1/coverage生成指定周期，支持一次仅处理一个周期和独立事务；保持品种写锁与现有日历/完整性/修订规则。原ingest仍同步调用全部周期，运行行为尚未切换异步。
- 新增跨事务对照：NY夏令时后的黄金时段、稀疏OANDA查询覆盖，先D1再H4/H1/M15/M5重建，全部OHLC/时间边界/完整性与原ingest一致；重复D1聚合不增修订。行情/恢复/缓存28 passed，ruff通过。
- 后续必须接持久聚合任务、动态当前周期优先、事务分批和下载/聚合独立执行；本次只是可独立调用步骤，不代表异步聚合完成。尚未部署。

### 持久聚合任务与动态选择候选

- 新增ChartAggregationJob及k12迁移，按品种/周期/区间去重，每个任务最多1440分钟。enqueue需与M1同事务并持有品种锁；目前尚未接ingest。
- aggregate_once读取当前有效视图优先级，当前周期首屏优先，M30映射M15；按品种→任务顺序加锁，聚合与删除任务同事务，失败回滚保留任务。
- 测试跨事务去重、D1→M30焦点切换选择、失败保留。与market组合17 passed，ruff通过。
- 尚未迁移运行库/启用新worker；必须补足异步入库连接、待重算bar可见性、失败退避和队列容量/选择性能，再进行真实调度验收。当前不能声称异步链路完成。

### 聚合失败退避与原子性

- 未部署的k12聚合队列增加attempts/next_at/error。选取时跳过退避任务，加锁后复查，失败按2秒起指数退避，上限5分钟；仅保存异常类型，避免错误文本包含连接信息。
- 单次计算在savepoint执行，bar写入与任务删除一并成功；失败回滚局部写入，外层事务保存退避状态。其他任务继续可选。
- 测试覆盖失败任务保留、下一任务继续执行、实际写入bar后抛异常的回滚。与market共18 passed，ruff通过。
- k12从未部署，因此更新同一待部署迁移。尚未启用历史入库异步路径，未修改开发/生产数据库结构。

### 延后聚合入库与旧bar失效候选

- ingest增加默认关闭的defer_aggregation选项：M1/coverage、聚合任务、受影响旧聚合bar complete=false在同一事务提交，修订号同步更新。默认实时入库仍同步聚合。
- chart_rows对待聚合区间标记pending_aggregation并置不完整，M30/W1/MN映射其来源周期；cache读取同时排除这些行，形成中bar也不能凭已有覆盖绕过待重算状态。指标继续按不完整bar中断计算。
- 新端到端数据库测试：先旧价同步入库，再M1修订高点并延后聚合，M5/H1缓存为空，完成五个聚合任务后两根完整M5携带新高点15；任务全部完成。聚合测试4 passed，此前相关组合43 passed，ruff通过。
- 尚未将chart import_once设为延后聚合，也未部署k12或聚合执行进程；下步需连接独立执行、队列容量背压、计划完成状态/进度以及迁移验收。

### 下载完成与聚合完成区分

- 计划达到M1覆盖目标后仍检查目标内待聚合任务，全部完成才置complete；查询也防止旧complete状态掩盖新待聚合任务。
- 历史任务面板显示待生成周期区间数、生成失败数，重试操作清除聚合退避；取消仅停止新下载，已入库数据的聚合继续，界面明确说明。
- 新测试覆盖覆盖100%但聚合失败时保持pending、重试恢复、最后聚合任务删除后complete。计划/聚合17 passed，ruff通过，前端构建通过。
- 尚未部署k12和新页面，独立聚合worker与下载背压仍需连接，未交付。

### 下载与独立聚合执行连接候选

- chart_history_worker调用import_once(defer_aggregation=True)，其他实时/旧修复调用默认同步。新增chart_aggregation_worker独立进程与本机Compose服务，按任务当前视图优先级执行，无行情HTTP和通知发送。
- 历史下载在聚合积压>=60时暂缓；最多一个下载批次增加15个任务，因此单下载进程下积压约限于74。不会使实时once等待该限制。失败任务仍计入积压，后续需验收多品种持续失败对全局吞吐影响。
- 新测试达到60个任务时不调用行情方且不改变下载游标/状态。聚合、调度节奏、行情及恢复29 passed，ruff通过。
- 尚未部署k12及新worker。启动前须检查开发账号8连接上限并清理已确认闲置的本机旧开发进程，不能扩容或操作生产服务。还需迁移、真实冷数据连续聚合、优先级切换和并发压力验收。

### k12迁移往返验收

- SQLite独立/tmp/mw-k12-migration-acceptance.db运行完整alembic upgrade head→downgrade j11→upgrade head成功。
- PostgreSQL已授权开发库使用单连接独立mw_k12_acceptance schema，仅建测试instruments与队列表；k12 upgrade→downgrade→upgrade成功，核对9个字段/唯一约束/外键。整个事务回滚，未改变public运行结构。脚本/tmp/mw-k12-postgres-migration.py。
- 新增自动迁移往返回归test_chart_aggregation_migration.py，1 passed，ruff通过。PostgreSQL测试仅覆盖k12，不代表全历史迁移链均已在PostgreSQL空库验证。
- 运行库尚在j11；独立聚合进程未启动。后续需要连接占用确认及本机实际部署、冷启动端到端验收。

### 本机异步聚合部署与真冷启动

- 核查并停止Ubuntu旧验收API PID2777442(port8002)、2801664(port8003)，cwd均为本仓库；保留8001和Docker。开发库运行容器连接4个，未提高8连接限制。
- 断言数据库trading_alerts_dev、账号trading_alerts_dev_app及旧版本j11后升级k12并验证。API/实时/历史/聚合worker运行aggregation-907bd84，web同标签；chart-origin仍progressive-a257803（静态代码无新增变化）。TLS重启，API healthy。
- 浏览器选品前确认OANDA:EUR_CAD instruments=0,candles=0。实际OANDA冷启动快速D1/M5/H1切换35/32/10ms（仅setResolution回调，非绘制时间）。约5.081秒内H1缓存返回19→43根；截图/tmp/mw-cold-history.png人工查看确认K线与角落进度可见，日志/tmp/mw-cold-aggregation.log。
- 独立聚合进程日志显示任务在执行，样本单片0.058–0.083秒；不能推定所有品种/日历或满负荷延迟。
- 截图发现右侧EUR_CAD详情“无效的商品代码”，须修复别名/报价通路；当前不满足完整图表分析接入验收。整屏补齐、D1渐进、多图竞争、关闭后台、失败恢复、最终回归仍未完成。

### 冷启动报价错误文案的复查

- 真实页面捕获quotes请求与响应：请求OANDA:EUR_CAD、响应n完全一致，s=ok、lp=1.61214及涨跌数据正常；截图/tmp/mw-quotes-check.png右侧已显示实际报价，无“无效商品代码”。因此此前别名错误仅是假设，证据不支持。
- 冷启动没有M1时现接口返回s=error，原生详情将其显示为“无效商品代码”。尚需针对已知品种暂无报价设计状态，不能伪造lp=0；成熟数据详情通路已证实正常。
- 冷启动测试关闭后重新打开，H1返回189根，D1已有72根，支持后台继续补齐的证据；这不是最终全部目标完成验证。
- 整理advanced-registered-quotes.browser.cjs用于注册品种报价一致性/有效价格/错误文案消失断言；此前诊断运行通过，新增断言尚需后续执行。未修改运行代码。

### 冷启动报价准备状态

- advanced-registered-quotes.browser.cjs真实容器通过，有效品种响应一致、价格有效且原生无错误文案。
- 依据公开DatafeedQuoteValues可选字段进行原生受控实验：s=ok，仅short_name/description/exchange，省略lp/bid/ask等；截图/tmp/mw-empty-quote.png确认详情显示“报价准备中”，价格为空，无0价格或无效品种。测试advanced-empty-quote.browser.cjs通过（行情正常，仅拦截报价响应）。
- 后端已知Instrument暂无M1返回quality=pending与上述元数据；未知品种仍error。新增API断言禁止虚构价格/涨跌字段，候选尚未部署。

### 后端整体回归与进度提示残留

- backend/tests整体205 passed、7 skipped。跳过项为隔离PostgreSQL上的备份恢复、数据库迁移搬运及5项PostgreSQL测试，需要专用隔离库/对应dump工具；不能将跳过项视为验收通过。日志/tmp/mw-backend-full-skips.log。
- 修正history-views只随historyDemand发送的遗漏：所有窗口切W1/MN后不会有日内需求，旧日内提示可能残留。现在每2秒可见图表轮询独立上报，工作区加载时跳过；已通过JS语法检查，尚需浏览器切换验收/部署。
- 全量后端回归通过不等于端到端性能、八图同步、备份恢复和完整交付通过。

### 独立PostgreSQL运行验收环境

- Docker Hub拉取postgres:16-alpine超时，备用public.ecr.aws/docker/library/postgres:16-alpine拉取成功，digest sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea。
- Ubuntu新建market-watch-postgres-isolated，绑定127.0.0.1:15432、512MB/1CPU，数据库market_watch_isolated，仅验收用途，未连接共享开发/生产库。
- 原跳过的test_postgres.py五项及test_database_transfer.py一项使用该隔离库全部通过：6 passed in6.38s。日志/tmp/mw-isolated-postgres-tests.log。
- 备份dump/restore测试仍需同版本客户端工具；此容器保持运行供后续验收。不能把这6项通过推定备份恢复已通过。

### PostgreSQL真实备份恢复与无跳过回归

- 使用隔离PG16容器内真实pg_dump/pg_restore，通过/tmp/mw-pg16-tools包装器传递环境变量并复制临时dump；无模拟数据库工具，不接共享库。备份5项通过。
- 扩展备份样本包含ChartAggregationJob，恢复连接检查instrument/timeframe/start/end/attempts/next_at/error全部一致，确保队列失败退避状态真实恢复。
- 设置TEST_POSTGRES_URL及TEST_POSTGRES_BIN_DIR后运行全部backend/tests：212 passed、0 skipped、1条Starlette弃用警告，17.91秒。日志/tmp/mw-full-isolated.log，ruff通过。
- 该结果覆盖后端现有自动测试，不等于前端八图/手机、渐进D1、真实实时延迟、上游边界及交付清单已完成。运行镜像尚有未部署候选。

### 当前异步容器的手机竖屏只读回归

- advanced-mobile-readonly.browser.cjs以412×915触屏模拟器运行当前HTTPS工作台，显式设置MARKET_WATCH_CHART_ORIGIN=https://127.0.0.1:15444/后通过。首次运行遗漏该参数，脚本查找旧5187而失败，不是图表初始化缺陷。
- 单图断言、临时周期切换、服务端工作区和偏好不变、无advanced-charts写请求、readonly=true、页面错误为空均通过。截图/tmp/mw-mobile-portrait.png人工查看确认EUR/CAD M15价格与指标可见，单图占满手机主区域；日志/tmp/mw-mobile-progressive.log。
- 这是Chromium触屏模拟验收，不是新增OPPO真机测试；手机只看图/不保存需求在此路径有证据。桌面八图压力和同步仍需当前版本验收。

### 八图同品种持续轮询回归

- 当前异步容器运行advanced-eight-chart-soak.browser.cjs通过：两分钟8次采样，8图同品种同周期共用1组/1订阅；最新数据请求8次，无pendingHistory，RPC pending样本0至4。
- 两分钟JS堆增长未超过测试64MiB限制；收起到单图只查询1组，恢复八图仍1组，页面错误[]。日志/tmp/mw-eight-progressive.log。
- 测试复用已有历史，且旧history/data接口带固定历史截止，不是八图同时冷补数/混合周期性能验收。混合品种与跨周期时间同步仍待本轮验证。

### 混合八图发现原生异常，验收未通过

- MARKET_WATCH_MIXED_SOAK=1运行当前异步容器，黄金/欧元/比特币八图加原生均线，两分钟24次最新行情请求，3订阅/3组，无pendingHistory，内存增长门槛及收起/恢复轮询断言通过。
- 最终页面错误断言失败：捕获11次Value is undefined。日志/tmp/mw-eight-mixed.log。不能声明混合八图通过，必须定位并修复。
- 增强同一复现脚本记录pageerror堆栈和initialization/mixed-symbols-and-studies/polling-soak/collapse/expand阶段，未删除或放宽原错误断言；下一轮重跑获取定位证据。

### 混合八图错误堆栈定位

- 加阶段/堆栈后重跑仍失败，日志/tmp/mw-eight-mixed-stacks.log。错误发生在collapse阶段（八图→单图），此前polling-soak采样未记录pageerror。
- 堆栈为原生nearestIndex→gotoTimeRange→seriesCompleted，位于公开setLayout触发的异步数据完成期间。说明需要检查布局变化与历史刷新/视区恢复的竞争；尚不能仅凭堆栈认定库缺陷或具体自有代码根因。
- 保留失败用例。下一步应缩小为混合图布局收起/恢复，分别控制渐进轮询和日期同步，验证旧pane刷新生命周期取消，不修改vendor私有代码。

### 历史视区刷新对布局变化让位

- refreshChartHistory监听公开layout_about_to_be_changed，与鼠标/焦点变化一样使旧刷新不再恢复视区；current还检查图表对象仍占据原可见索引，避免索引被另一pane复用。
- advanced-refresh-interaction.cjs新增布局变更期间onDataLoaded完成后不恢复旧视区、移除所有事件监听断言，通过。
- 这是已确认生命周期遗漏的候选修正，尚未部署或重跑混合八图；不能认定其解决nearestIndex异常。下一步用同一失败浏览器流程验证，必要时继续隔离日期同步路径。

### 布局保护候选未解决混合八图

- 原soak脚本新增MARKET_WATCH_CANDIDATE_VIEWPORTS，仅route替换自有viewports.js，其他运行代码不变。
- 候选完整运行仍失败，日志/tmp/mw-eight-candidate.log：expand阶段nearestIndex/gotoTimeRange Value is undefined；恢复八图最终tick仅2组HTTP请求，预期3组。不能关闭该卡点。
- 候选对旧刷新让位仍有单位测试价值，但当前证据否定其足以修复原生异常。下一步缩小布局循环，独立控制dateRangeSync与progressivePoll，检查恢复期间订阅/数据完成状态。

### 布局短复现尚未复现完整soak异常

- 新增advanced-layout-race.browser.cjs，从相同八图混合品种+均线初始化开始，连续3次单图/八图切换；baseline运行errors=[]。
- 加回原流程clearInterval(poll)、等待polling完成、缓存过期及手动tick后仍errors=[]，日志/tmp/mw-layout-manual-tick.log。
- 因此短布局循环不是当前异常的充分触发条件，不能据此宣称修复，也不应直接改日期同步。两分钟状态积累/历史修订仍是待验证条件。原完整失败soak保留。
- 探针支持no-sync/no-progressive用于后续单变量实验，但本次只运行baseline；未对未运行模式宣称结果。

### 混合八图测试时间轴不一致确认

- 发现旧soak仅拦截/history与/charts/data到固定历史日期，新/history/cache仍返回现在的数据，造成同一原生序列混用新缓存与过去轮询数据。仅将cache加入相同截止拦截，未更改运行代码，也未加载候选viewports。
- 完整两分钟混合八图测试通过：3组订阅、无pendingHistory、收起恢复请求断言通过、页面errors=[]，日志/tmp/mw-eight-aligned.log。此前nearestIndex失败不能作为正常数据路径已证实的产品缺陷；候选布局保护也不能冒领修复功劳。
- 保留所有错误断言。下一步不固定历史日期的实际实时soak验证，以及其他固定日期用例是否遗漏cache通路的核查。

### 无固定日期实时混合八图仍失败

- 新增MARKET_WATCH_LIVE_SOAK=1完全绕过历史日期route，以真实当前cache/history/data运行完整混合八图。
- 运行在collapse阶段再次出现nearestIndex/gotoTimeRange Value is undefined；单图tick网络请求0，原断言预期1失败。日志/tmp/mw-eight-live.log。
- 修正上一条证据边界：统一历史时间的通过只证明该历史场景，不能把所有原生异常归因于测试日期混用。实时修订/重载与布局切换竞争仍是实际待解决项，未交付。

### 渐进刷新与实时形成中bar隔离候选

- 实时混合八图仅关闭progressivePoll完整通过：24次采样期行情请求、收起恢复断言通过、errors=[]。日志/tmp/mw-eight-no-progressive.log。定位到渐进历史轮询参与竞争，关闭仅诊断，不作为产品方案。
- progressiveHistory原fingerprint包含形成中bar价格与revision，每次最新M1更新可能触发整图resetData，与subscribeBars重复。候选对complete=false仅比较start/end/complete身份，仍保留空图首次形成中bar、新历史、收盘转换、已完成bar修订的刷新。
- 单位测试验证形成中价格/revision变化不整图刷新，变complete=true仍刷新；渐进缓存和预热测试通过。尚未真实浏览器候选复测，不能据此关闭八图问题。
