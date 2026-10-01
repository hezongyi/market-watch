# 渐进历史加载与周期预热

状态：实施中，未交付。Ubuntu 本机验收，禁止操作 Unraid 生产服务。

**2026-10-01需求修订：** 自动视区扩展、三倍D1预热、原生请求内等待缺历史等规则已被用户确认的双数据系列与“指定历史起点、持续维护至最新”方案取代。后续以 [新方案](chart-dual-dataset-plan.md) 为准；本文保留实施与失败验证证据，冲突清单不再作为交付要求。

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

### 形成中bar判定候选真实复测未通过

- MARKET_WATCH_CANDIDATE_PROGRESSIVE=1仅route替换progressive-history.js，MARKET_WATCH_LIVE_SOAK=1与MIXED_SOAK=1，保留渐进轮询运行。
- 完整soak最终仍在collapse阶段nearestIndex/gotoTimeRange Value is undefined，错误断言失败，日志/tmp/mw-eight-forming-fix.log。候选只能减少常规形成中价格变化触发，尚不能证明解决布局异常。
- 后续需记录实际触发changed的页面/原因（历史扩展、完成态、已收盘修订、元数据）以及刷新时图表集合；保留原失败断言，不通过关闭渐进补数缩小需求。

### 刷新追踪确认形成中bar反复消失

- 测试路由注入HISTORY_REFRESH_TRACE，比较前后指纹；XAUUSD H4同一start1790787600000/end1790802000000 complete=false在198→197→198反复删除/加入，其他共同bar字段无变化。日志/tmp/mw-eight-refresh-trace.log；最终布局错误仍复现。
- read_cached_history此前要求形成中bar覆盖到墙钟cutoff，新分钟到来但M1轮询未完成时会删掉上次有效bar。候选改为要求从桶起点覆盖到最后已持久化完整M1的end，且桶仍未收盘；待重算bar仍排除，完整性不伪造为true。
- 扩展测试验证时间推进但无新M1仍保留形成中快照，真实前缀缺口仍拒绝；缓存+聚合10 passed，ruff通过。需部署并复跑实时八图，不能仅凭因果候选认定原生异常解决。

### 实时八图修复验证与失败队列隔离

- `/tmp/mw-eight-forming-deployed.log` 已完成原生八图、三个品种、实时日期的两分钟采样及收起/展开断言，最终 errors=[]，latestRequests=29；未覆盖历史修订实际补入及所有同步场景，不能据此宣布整体交付。
- 历史下载原先将所有失败聚合计入全局60任务阈值，可能使单品种失败阻断其他品种。候选改为正常聚合工作保持全局60阈值；每品种含失败任务仍限制60，选择下载任务时跳过该品种。失败任务保留并按原退避重试，实时通道不受该阈值影响。
- 新回归构造EURUSD积压60失败任务且优先级高于XAUUSD，验证仍选择XAUUSD下载、EURUSD未领取、原失败任务未丢失。聚合与历史缓存11项通过，ruff通过。此队列修复尚未部署容器。

### 队列隔离部署与切换性能未达标证据

- 本地提交6eb362b，构建market-watch-api:queue-isolation-local，已仅更新Ubuntu acceptance的api、realtime-worker、chart-history-worker、chart-aggregation-worker并重启本地tls。后端完整隔离PG测试213 passed，18.81秒。
- 新增advanced-switch-timing.browser.cjs：真实XAUUSD、当前日期、不替换数据响应，记录setResolution完成、dataReady及两帧requestAnimationFrame机会；后者并非GPU实际绘制完成证明。
- 首轮实测/tmp/mw-switch-timing.log及json，第二遍M1–D1两帧机会约511–1887ms，超过200ms体验目标；不能把已有缓存/接口回调测试视为顺滑验收通过。柱距保持6。
- 用已保存实测JSON断言200ms明确失败；浏览器脚本已补充同一阈值断言。下一步区分缓存复用条件、RPC/DB等待、原生视区恢复耗时，尚未据猜测调整实现。

### 最新快照缓存边界修复及浏览器性能对照

- 诊断日志/tmp/mw-switch-trace-instrumented.log显示原生请求before为秒级（例如1790797141000），预热before为分钟级（1790797140000），缓存仅差1秒也不能复用；读请求约0.3–1.7秒，对应切换等待。带200ms断言的真实浏览器基线退出1。
- 最新首屏（firstDataRequest且截止距当前不超过2分钟）及相应预热统一使用before:null，服务端已有语义为当前最新。最新快照先返回已有数据，活动轮询与订阅继续更新；指定历史截止时间仍严格匹配且保留15秒有效期。缓存仍有64条上限。
- 新advanced-latest-cache.cjs先复现失败，再验证超15秒的最新快照立即复用、不同数量复用、异步变化通知、历史请求隔离；连同原prewarm/progressive缓存测试均通过。诊断脚本注入已清除。
- 候选market-watch-chart-origin:latest-cache-local已部署Ubuntu。真实浏览器不替换响应、不修改日期，两轮M1/M5/M15/M30/H1/H4/D1共14次达到两帧绘制机会约21.8–36ms（第二轮21.8–30.8ms），200ms断言通过；柱距始终6。日志/tmp/mw-switch-latest-cache.log，截图/tmp/mw-switch-timing.png已人工查看为正常D1图。该指标不是GPU绘制完成测量，不证明冷品种首屏及八图压力。
- 尚需候选的历史回看、渐进新增/修订、Python指标与八图回归，不能据单图暖缓存性能宣告完整交付。

### 最新快照与Python指标协议兼容修正

- 实际Python指标回归发现before:null被父页面指标RPC正整数校验拒绝（/tmp/mw-indicators-latest-cache.log）。修正bridge调用指标计算时省略最新查询的before，保留历史查询的数字截止时间，不放宽父页面校验。
- 本机重新构建/部署latest-cache-local后同一真实浏览器用例通过：100根SMA，1801.7ms，旧阻塞规划器调用0；同时会话请求58/706/1623ms且均HTTP200。证据/tmp/mw-indicators-latest-fixed.log。Python计算耗时与原生内置指标/纯K线缓存切换指标分开报告。
- 新候选八图三品种实时两分钟回归已启动，日志/tmp/mw-eight-latest-cache.log，结果待核验。

### 最新快照八图回归未通过

- /tmp/mw-eight-latest-cache.log：八图三品种持续采样后，collapse阶段再次出现原生nearestIndex/gotoTimeRange/seriesCompleted的Value is undefined异常，最终errors断言失败。不能沿用397f387此前单轮通过作为新缓存候选的兼容证明。
- 已启动相同实时用例的渐进刷新差异追踪，/tmp/mw-eight-latest-trace.log；需要区分最新滚动页成员变化引起的重复reset与布局切换竞争。保持功能和原生代码不变，先收集差异证据。

### 八图异常复现范围进一步收窄

- 上轮追踪进程已退出0，/tmp/mw-eight-latest-trace.log最终errors=[]、latestRequests=29，且无HISTORY_REFRESH_TRACE事件。说明原生异常是间歇问题，不能宣称已修复，也不能将上轮失败直接归因于所有历史刷新。
- 新增advanced-revision-layout.browser.cjs候选：通过浏览器响应替换模拟已收盘bar修订，不写数据库；在公开refreshChartHistory实际进入后立即收起/展开布局，验证刷新与布局变更重叠。最新用例去除旧固定日期路由，避免历史/最新数据混用；当前运行日志/tmp/mw-revision-layout-overlap.log待核验。

### 多图共享缓存重复失效修复候选

- 重叠复现基线/tmp/mw-revision-layout-overlap.log中expand-0/expand-1触发原生_createBarsetForRange的Value is null。测试仅改浏览器返回的已收盘bar高价/revision，并断言真实refreshChartHistory已进入；未写行情库。其错误栈与此前nearestIndex异常不同，仍需原始两分钟用例复验。
- 原changed回调每刷新同品种/周期的一个窗格都会再次调用所有共享订阅reset，可能在另一个窗格加载中清除共享barset。候选将缓存失效限制为该批一次，窗格仍逐个通过公开接口刷新。
- 相同重叠用例仅替换候选bridge，通过三次历史修订/收起/展开，errors=[]、退出0（/tmp/mw-revision-layout-once.log）。响应拦截测试补充关闭页面时的异常处理，避免Playwright输出请求头。
- 正在部署Ubuntu chart-origin:shared-reset-local，随后复验原始实时八图；尚不能据这一个候选测试宣布八图问题已完全解决。

### 共享失效候选原始八图复验通过

- 已部署shared-reset-local后原始实时八图/三品种两分钟用例退出0，/tmp/mw-eight-shared-reset.log最终latestRequests=29、errors=[]，包括collapse/expand后的轮询分组断言。结合修订重叠测试，当前证据支持这次修复；不替代冷品种及其他验收项。
- 已开始本机真实EURUSD M1历史日期跳转，日志/tmp/mw-history-jump-shared-reset.log，未使用固定行情响应。

### 历史日期跳转发现未满足要求

- /tmp/mw-history-jump-shared-reset.log真实EURUSD M1请求2026-08-12 08:00–14:00 UTC，setVisibleRange约155ms返回，但20秒后range变为1790781960–1790782020，未保留目标日期。pending/failed均为空不能证明历史目标满足，右边界断言失败。
- 需定位原生历史getBars需求是否进入持久化计划、空页边界与视区回退后的意图保存；当前仅视区上报可能丢失未加载日期。此项未解决，仍未交付。

### 历史跳转根因追踪

- /tmp/mw-history-jump-trace.log与/tmp/mw-history-jump-visible-trace.log重复复现：native getBars(from=1786521600,to≈1790787180,countBack≈50781,firstDataRequest=false)，适配层仅返回近期连续87根并noData=true。
- 原始from是2026-08-12目标，to是已加载近期数据左边界；countBack是跨越历史间隔所需数量，不能当作指标回看窗口。当前indicatorHistoryNeeds误将其提升至6000，而实际historyDemand.end仍为近期。
- onVisibleRangeChanged没有先发出目标日期，只在getBars回调后报告已回退的近期区间。因此仅靠该事件保存目标不足，必须在历史getBars入口处理原始意图；不能用猜测目标右边界强行恢复。
- 后续修复需保留原生未完成历史导航请求，优先准备目标from附近可用数据并异步完成回调；可切换周期取消旧导航，不能把暂缺页声明为上游历史耗尽，也不能强制下载整个五万根M1间隔后才允许交互。需要通过原生测试验证少量目标数据可完成其原始导航，再连接持久化计划。

### 目标附近有限历史页原生可行性与接入候选

- /tmp/mw-jump-target-window.log：仅浏览器getBars替换目标附近720根M1（1秒延迟、noData=false），原生远距离setVisibleRange约1067ms完成，20秒后精确保留1786521600–1786543200；无需先提供中间约5万根M1。该可行性测试不是实际行情验收。
- 候选新增history_end按现有日历正向计算目标附近有限窗口；history/demand可携带anchor_start，返回window_start/window_end，与现有持久化计划合并。getBars远距离/缺页导航按实际视图三倍（最多1998根）请求目标附近，保留原生异步回调至窗口可用；每15秒续需求，2秒读取，无阻塞遮罩。周期离开用既有checkActive取消等待。
- 历史分页countBack不再加入indicatorHistoryNeeds；首屏及Python指标自身需求仍保留。新增前端导航窗口与取消测试通过，原viewport demand测试通过；后端黄金NY17维护小时与DST正向窗口测试通过后再部署。
- 仍需处理长期失败/同周期新导航取代旧导航、真实响应与稀疏交易边界、实际跳转及拖动回归。候选未部署，未宣告历史跳转修复完成。

### 真实导航候选部署与自动刷新回退

- navigation-local API及chart、三个worker已部署Ubuntu。完整隔离数据库后端测试214 passed（/tmp/mw-navigation-backend.log）。
- /tmp/mw-navigation-real.log：真实目标页561根已返回，首次跳转566ms，原始6小时视区准确；随后progressive resetData按当前时间重新加载，返回近期短页noData=true，导致目标丢失。
- 尝试所有非空短页noData=false使新工作区首屏触发连续历史等待，实测未进入正式跳转阶段，已主动停止该探针并撤回该尝试，不能以此牺牲首屏交互。
- 新候选在公开刷新调用期间记录被刷新的历史视区，firstDataRequest按原历史右边界读取，finally清理标记；正常首屏仍保留原渐进短页行为。已部署并启动/tmp/mw-navigation-preserve-range.log真实跳转复验，结果待核验。

### 历史刷新入口尚未统一

- /tmp/mw-navigation-wheel-guard.log及/tmp/mw-navigation-visible-only.log均未通过历史视区保持。实际滚轮事件替代柱距数值判断有独立测试支撑，但不是本次回退唯一根因。
- 新historyChangeIntersects候选使不在视区内的变化不触发渐进reset，空数据首批仍刷新；相应测试及progressive cache测试通过。最新空页例外为本地新增，尚未打入navigation-local镜像。
- 检查发现tick历史revision/布局恢复路径仍调用reloadHistory，直接chart.resetData()且不保存视区，绕过refreshChartHistory。需要统一所有历史重载入口，再复验，不继续只在progressive回调局部修补。当前真实日期跳转尚未验收通过。

### 所有历史重载串行化候选

- reloadHistory改为异步公共入口，实时revision、隐藏窗格恢复、旧pending计划和progressive均经过refreshChartHistory；同批共享缓存仅失效一次，全局串行防止两个通道交叠。未成功恢复保留needsHistoryReload/paused状态，下轮重试，避免吞掉修订。
- /tmp/mw-navigation-unified.log仅统一入口仍失败，目标626ms首次成功但20秒后回退。新候选同时在历史重载期间传递原视区右边界、提供三倍首屏，恢复前将原生旧rightOffset归零再应用绝对日期范围。此修改需要实际浏览器证明，不能由单元测试推定正确。
- viewports/refresh-interaction/navigation-page/history-change-range/progressive-cache测试通过。新本机实际浏览器日志/tmp/mw-navigation-offset.log运行中。

### 原生重载偏移继续核验

- /tmp/mw-navigation-offset.log旧日期在恢复调用后短暂正确，随后实时新bar将范围伸展至最新。历史首屏重载仅返回旧页会改变原生序列尾部，不宜用此方式代替日期导航。
- 撤回刷新时强制旧页before覆盖，改仅在恢复上下文允许原生继续请求短页之后历史，候选已部署；/tmp/mw-navigation-native-range.log仍失败，不能宣告修复。
- 新追踪/tmp/mw-navigation-state-trace.log记录公开captureChartViewports在每次refresh前后状态及返回值，核实历史视区的offset是否确为负数。此处需从状态证据定位，避免继续把日期与原生相对偏移混为一谈。

### 历史边界回退与实时乱序修复候选

- 状态追踪确认刷新前历史视区offset=-386，先前“偏移可能非负”假设被证据否定。/tmp/mw-navigation-state-trace.log另抓到实时putToCacheNewBar时间逆序：历史getBars覆盖lastHistory，旧bar再次推入已含更新bar的native缓存。
- progressive历史边界改为lastHistory取max、firstHistory取min；tick推送前与最近已返回history尾部对齐，避免重载后的旧订阅last落后。advanced-history-boundaries.cjs真实feed.getBars路径验证最新→旧页→更新页仍保留两端边界。
- /tmp/mw-navigation-order.log无time violation，但refresh-error明确Value is null，历史保持仍失败。正在/tmp/mw-navigation-restore-stack.log记录恢复接口准确调用栈，尚未宣布修复。

### 历史日期导航与刷新保持真实通过

- /tmp/mw-navigation-restore-stack.log明确setVisibleRange→native setVisibleTimeRange读取series interval/symbol info时Value is null；dataReady并不保证这些元数据已挂回。现恢复只针对该错误最多20次100ms重试，每次检查当前意图；其他异常直接失败。
- /tmp/mw-navigation-retry.log真实EURUSD M1目标2026-08-12 08:00–14:00，首次564ms；至少两次refresh前后都精确保留1786521600–1786543200；20秒最终断言通过、退出0，无pending/failed。此为已有目标数据的真实恢复验证，不是新冷日期下载计时。
- viewports新增两次瞬态失败后成功的公开接口模拟断言，通过；刷新交互测试、历史时间边界等已有测试均通过。周期切换性能回归/tmp/mw-switch-navigation.log正在运行，之后仍需八图/真实冷日期及取消验收。

### 导航候选性能与目标优先接口回归

- /tmp/mw-switch-navigation.log两轮14次M1–D1切换退出0，第二轮两帧绘制机会22.4–34.7ms，首轮25.1–63.2ms；柱距始终6。只是已有缓存单图指标。
- 新增真实FastAPI history/demand回归：40天跨度anchor请求只将目标附近600根M1列为priority100首屏，持久化总目标仍保留。chart_history_plan共15项通过，ruff及diff检查通过。
- 新版本原始八图实时回归/tmp/mw-eight-navigation.log运行中。候选待验收仍包括冷日期下载、同周期新导航替代旧导航、失败退出/重试、手机与其他范围审计。

### 导航失败等待退出

- history/demand仅对导航目标区间查询失败ImportJob及同周期聚合连续失败（>=5），返回通用window_error，不泄露上游异常。helper先尝试可用缓存，再根据window_error退出等待并引导历史任务重试，避免已可用数据被陈旧失败任务阻断。
- 实际FastAPI目标优先测试增加失败job后续请求断言；15项chart_history_plan及前端navigation-page测试通过，ruff通过。此失败退出候选尚未构建部署；不将单元/接口测试等同于浏览器失败恢复验收。

### 布局展开轮询恢复回归修复

- /tmp/mw-eight-navigation.log退出1：无EIGHT_CHART_ERROR，但展开后轮询仅1组、预期3组。统一reloadHistory会因同步guard忙返回false，pausedForLayout分支仍continue，阻断可见实时请求。
- 移除该continue，历史恢复待重试同时继续实时查询；新增advanced-layout-poll-resume.cjs通过busy guard下仍查询、paused状态保留的断言。既有advanced-history-reload.cjs适配公开刷新helper测试替身与新恢复语义后通过，仍验证订阅分组、历史revision、失败恢复、隐藏图不轮询。
- 失败退出补丁及轮询修复已部署本机api:nav-errors-cf21767/chart-origin:nav-errors-local；原八图复验/tmp/mw-eight-resume-poll.log仍在运行。

### 八图与真实缺失日期导航验收

- /tmp/mw-eight-resume-poll.log最终退出0，latestRequests=30、errors=[]，恢复后三组轮询符合断言。
- 导航前只读开发库查询EURUSD/2018-08-16 08:00–14:00 UTC M1数量为0（2022/2023已有360根，未选作冷数据）。用原始数据feed及实际OANDA请求跳转，/tmp/mw-navigation-cold-2018.log记录2742ms完成，20秒最终range=1534406400–1534428000准确、pending/failed为空，退出0。
- 这是单个远日期M1窗口实测，不代表全新品种D1整屏或所有时段相同速度；后台依照已批准策略继续低优先完成持久化目标。
- 新advanced-navigation-cancel.browser.cjs在历史目标cache返回空页的条件下，验证切回已预热M5及原导航取消，日志/tmp/mw-navigation-cancel.log正在运行。

### 导航取消、手机只读及后端回归

- /tmp/mw-navigation-cancel.log退出0，目标cache空页保持等待后切回M5约15ms就绪，旧feed回调明确HISTORY_CANCELLED；是浏览器集成故障注入，不是普通函数模拟。
- /tmp/mw-mobile-final.log当前本机候选竖屏412x915回归通过，单图、服务器工作区/个人偏好不变、MOBILE_WRITES=[]、errors=[]；不新增用户已豁免的实际锁屏验收。
- 完整隔离PG后端测试215 passed、0 skipped、20.45秒，/tmp/mw-backend-current.log。
- 不同品种/周期视区同步及重载恢复浏览器用例/tmp/mw-mixed-current.log已启动，待核验。

### 多图同步历史移动未通过

- /tmp/mw-mixed-current.log与/tmp/mw-mixed-trace.log均失败：目标1790631000–1790717400，主图实际1790782200–1790782500，其余同步到近期短范围。与八图稳定轮询不是同一验收项。
- trace中主图没有对目标日期发getBars，只看到其他窗格跟随回退后的22根近期请求；原生缓存中短页noData边界可能阻止历史导航。
- 候选撤回只在变化与当前视区相交时才刷新这一优化，保留统一串行刷新及视区恢复；历史补入必须使原生旧noData失效。已部署nav-sync-local，/tmp/mw-mixed-refresh-all.log复验中。该假设尚需运行证据验证，不宣称多图同步已解决。

### 短页边界候选继续验证

- /tmp/mw-mixed-refresh-all.log仍失败，撤回视区过滤不足以解决，先前归因需修正。候选将非空短页noData置false，使原生还能发历史请求；此前导致首屏等待的风险仍需重测。
- historicalNavigationPage新增仅M1的覆盖区间合并判定，覆盖完整但第一分钟无bar时不再永久等待。更高周期不能以M1覆盖代替聚合完成。window.timeframe由API明确返回；前端稀疏M1回归通过。
- /tmp/mw-mixed-short-pages.log未走到同步验收，在工作区重载时测试直接读取未创建的rangeGuard.busy抛TypeError；已给测试就绪条件增加ready/loading和控制器存在判断，不据该运行判断产品通过。
- 正在构建api/chart nav-sparse-local一致版本，build session6481；待部署并重跑八图历史同步。现运行nav-sync-local仍是上一候选。

### 一致镜像部署后代理地址刷新

- nav-sparse-local API/chart/worker部署完成，20项相关后端测试与ruff通过。
- /tmp/mw-mixed-sparse.log在登录后遭web代理502而退出，未进入功能断言。web/nginx.conf静态解析api地址，API重建更换IP后只重启tls不足。已重启Ubuntu web/tls，补充deploy/local-container-acceptance.md操作步骤。
- 同一功能用例重新启动/tmp/mw-mixed-sparse-proxy.log，待核验。未以该502作为多图功能结论。

### 非空短页候选等待问题定位中

- nav-sparse-local一致版本与web/tls代理刷新后，/tmp/mw-mixed-sparse-proxy.log进程session1103仍在真实运行，尚未达到MIXED_PANES断言，不能当成已完成。
- 只读开发库观测聚合66任务且error=None/attempts=0；历史worker仍持续OANDA4000分钟批次，下载约0.45–0.56秒，说明不是全部worker停摆。
- 最新需求对应EURUSD M30缓存1999根、最早早于目标；相邻EURUSD M5窗口只返回6–7根连续后缀。需要进一步核对原生缺页请求的目标续报与聚合覆盖，不可凭全局数据库有数据认定每窗就绪。
- 测试新增可选MIXED_DEMAND记录，下一次运行可在配置图表阶段记录需求（现运行脚本版本未包含该记录）。仍保留当前运行句柄等待，不重启测试。

### 多图等待遇到旧失败任务占位

- /tmp/mw-mixed-sparse-proxy.log已退出1（超时），不再等待。只读核验EURUSD M5目标缺口1790721720000–1790734980000等4段，无覆盖此区间的聚合任务，8个旧ImportJob(status=failed,priority100,chart_plan=false,attempts5,error空)占位阻止新规划；NZDUSD也有3个同类任务。
- control_plan retry原先只选择chart_plan=true，无法释放这些旧占位，同时未重置尝试次数。候选将计划目标内legacy chart失败纳入同一有限重试批次，排除priority<100实时修复，重试attempts归零；测试test_retry_includes_legacy_chart_failures_but_not_live_repairs覆盖该行为。
- 尚未对开发库实际执行重试，需先部署候选，并验证任务面板能反映旧失败。多图同步验收仍未通过。

### 开发库旧失败任务实际重试

- plan_status补充目标范围内旧图表失败计数；接口状态测试验证失败数1→0，16项相关测试及ruff通过。
- 已仅部署Ubuntu api/worker:legacy-retry-local，并重启web/tls刷新代理。
- 在acceptance API容器调用正式control_plan retry，EURUSD失败8→0，NZDUSD失败3→0；有限批次之外的旧任务superseded以释放缺口，由持久计划重排。未删除行情，未修改priority<100实时修复任务。
- /tmp/mw-mixed-legacy-retry.log多图历史同步已重新启动，session3214待核验；旧任务释放不是同步通过证明。

### 2026-10-01 本机优先级修复与范围对照

- legacy-promote-local历史worker部署完成（session79693退出0）；已有pending、priority>=100任务若占用前台目标，提升其优先级而不重复下载。17项chart_history_plan测试再次通过。
- session3214退出1，主图历史范围被缩短，其余图未同步，不能视为通过。
- 修复部署后直接范围对照/tmp/mw-mixed-promote-direct.log退出0（诊断分支，不代表完整验收）。EURUSD、BTCUSDT、NZDUSD已接近目标；XAUUSD M5/M15右界仍差约一小时。关闭同步并逐图调用setVisibleRange后黄金得到相同范围，提示需核对原生休市压缩行为，而非直接认定跨图事件丢失。
- worker近期实际OANDA单批4000分钟下载0.374–1.123秒，含入库0.519–1.891秒；批间调度、聚合与刷新另计，不能外推为完整首屏耗时。
- 黄金独立对照继续运行：/tmp/mw-mixed-promote-gold.log。完整八图保存恢复、冷D1逐周期计时等仍待验收。

### 原生历史请求数量与旧视区几何不一致

- 黄金独立对照最终退出0，八图在该次目标均对齐；因此此前一小时偏差不能归为固定休市规则问题。
- 完整鼠标验收/tmp/mw-mixed-promote-full.log失败。trace明确显示EURUSD M5请求countBack529，却回调114根（1790633100000–1790667000000），24小时目标被缩成约9.4小时，随后所有图同步到被缩短的范围。该次没有history refresh trace支持“刷新覆盖视区”解释。
- bridge候选按max(对应品种周期图表几何窗口, ceil(min(1998,countBack)/3))计算有界导航需求，避免以切换前38根屏宽限制目标为114根；不提高2000根单次查询上限。原生超大请求仍需独立核验。
- 实际八图浏览器回归正在运行/tmp/mw-mixed-countback.log（session5837），仅通过路由加载候选bridge，尚未部署镜像；语法与git diff --check通过，不等于功能通过。

### 左边界缩放同步回归

- countback候选浏览器退出1：历史目标范围与十字线断言通过，滚轮缩放失败；主图仅左界移动7800秒，其他图未同步。edgeRangeSync原先只检测右界偏差。
- advanced-edge-sync.cjs新增左界单独移动场景，修复前实际失败100!==700；补偿判断加入左界后通过。navigation-page、range-sync既有测试亦通过。
- /tmp/mw-mixed-both-boundaries.log真实八图仍失败，前两个跟随图已缩放，后续图未完成。未把单测或部分图成功当作整体完成。候选仅浏览器路由加载，未部署。
- /tmp/mw-viewports-edge-probe.js添加临时同步中断/开始追踪，真实浏览器运行/tmp/mw-mixed-edge-abort.log（session20454），待核验；探针不写入产品文件。

### 同步过程中新的滚轮意图

- session20454退出1，历史导航20秒超时，未到滚轮；未重启仍运行的测试。另用固定已测日期1790719800运行/tmp/mw-mixed-edge-fixed.log（session93499，退出1）。
- 固定日期trace显示旧目标逐图edge-start持续进行，滚轮后无新目标edge-start、无edge-abort；新事件被applying分支忽略。候选在finally比较主图最新范围，若变化且同步仍开启，则重新调度最新范围。尚需回归并核对逐图串行延迟，不能称缩放已通过。

### 同步耗时定位到会话查询

- 最新意图单测覆盖peer等待期间再次滚轮：去掉候选finally补调度后实际失败false!==true，候选通过。
- /tmp/mw-mixed-latest-intent.log退出1，三秒缩放验收仍失败。
- /tmp/mw-mixed-sync-timing.log退出1：prepare休市RPC逐图耗时1350、1221、575、504、4526、591ms；对应原生setVisibleRange仅约0.4–12ms。明确瓶颈为串行重复会话查询及请求排队，不能靠增加验收等待解决。
- 尝试并发prepare使既有“用户关闭同步阻止剩余写入”测试失败，已撤回该尝试；下一步需设计独立会话缓存/合并与可取消并发，保留用户意图优先规则。未部署生产。

### 并行准备、按取消条件应用

- viewports候选仅并行prepare（返回已捕获错误的结果），setVisibleRange仍逐项检查generation/blocked再应用，保持取消规则。
- bridge在同一绑定生命周期内合并相同品种/目标范围的在途会话RPC；请求完成即移除，不缓存过时日历结果。八图相同品种的不同周期不再重复查询同一范围。
- edge-sync单测通过，包括关闭同步、周期切换、dispose、等待期间新的滚轮意图。测试改为等待实际peer调用开始再取消，避免依赖固定一次microtask。
- 本机真实八图回归/tmp/mw-mixed-parallel-prepare.log运行中（session40044）；仅路由加载候选，语法与diff检查通过，尚未判定功能通过。

### 交互请求排队与拖动竞态

- session40044退出1：八图缩放断言通过，拖动左界未对齐。主图18根历史请求已成功返回，跟随图未对齐，不能归为主图缺数据。
- 候选drain优先选择viewport请求，保持最多4个在途请求；新增队列优先级回归与queued/inflight取消、edge-sync测试通过。
- /tmp/mw-mixed-interaction-priority.log(session94216)仍失败：鼠标拖动阶段出现原生Value is undefined，BTC右界偏差；需要进一步定位交互与范围设置竞态，未判通过，未部署候选。

### 刷新与范围补偿双向互斥

- bindEdgeSync的blocked加入historyReloading；此前只有reloadHistory等待edgeGuard，反向无保护。阻塞期间范围事件改为延后重试而非丢弃，单测覆盖等待结束后继续处理。
- edge-sync、refresh-interaction、viewports三项测试通过。
- /tmp/mw-mixed-refresh-exclusive.log(session85022退出1)本轮无Value is undefined，缩放通过，拖动仍部分未对齐。EURUSD补页18根、M15/M30小页已返回；BTC M5/M15、NZDUSD等历史小页已请求但三秒断言前未返回。需继续核对请求调度/缓存覆盖与交互刷新，不能以一次无异常断言竞态彻底修复。

### 前台补页与预热区分

- /tmp/mw-mixed-page-queue.log(session92943退出1)捕获RPC排队：waiting4–7的cache读取耗时3.5–3.9秒，waiting0样本约0.53秒。viewport优先后约0.59–0.64秒，拖动仍被历史cache排队影响。
- 候选将直接historyCache读取置于预热之前，warm及poll标记background；保持4并发。request-cancellation/inflight-cancellation与progressive-cache测试通过。
- /tmp/mw-mixed-foreground-cache.log(session59443)正在验证bridge/viewports候选，但未路由加载progressive-history的新poll标记，只能作预热优先级局部对照。测试已补MARKET_WATCH_PROGRESSIVE_SOURCE，下次完整候选需设置该变量。未部署生产。

### 目标范围内实存bar证明非全休市

- session59443及完整候选session15159(/tmp/mw-mixed-priority-complete.log)均退出1，拖动三秒仍未全部对齐；单靠队列优先级不足。progressive-cache测试新增初读foreground、poll background断言并通过。
- prepare候选检查对应品种周期已观察first/last bar是否落在目标半开区间，存在则无需查询“是否全休市”；无法证明时仍调用日历API，不能用两端包围目标推断目标开市。
- /tmp/mw-mixed-observed-session.log正在运行，加载bridge/viewports/progressive完整候选；尚未判通过。

### 拖动控制器状态诊断

- observed-session(session28309)退出1：拖动后主图补页返回，但无跟随图新getBars，不能继续单一归因为缓存网络延迟。
- 新增仅TRACE模式的DRAG_CONTROLLERS，记录historyReloading、range/edge busy、开关、队列与dataReady，不含认证内容。
- 首次诊断session50432(/tmp/mw-mixed-drag-controllers.log)因测试读取局部变量viewportRestoring而失败，已删除该非法读取。该次所有M5范围对齐但黄金M15左界偏差一小时；不作为完整通过证据。
- 修正探针后/tmp/mw-mixed-drag-state.log正在运行。edge-sync/progressive-cache及diff检查通过；候选未部署生产。

### 逐图范围promise阻塞后续图

- drag-state(session66727)退出1。DRAG_CONTROLLERS：historyReloading/loading/rangeBusy均false、所有dataReady true，但edgeBusy true且同步开关暂时false。后续图未执行，不是周期加载控制器阻塞。
- 候选将已准备范围的setVisibleRange独立并发应用，调用前仍检查generation/blocked；一个图等待不会阻挡其他图。统一finally仍负责恢复开关和补调度最新范围。
- 单测新增slow peer不阻挡其他图，并用实际未完成prepare验证用户关闭同步、周期切换、dispose后不会启动新写入，全部通过。此前串行测试通过让前图阻塞间接制造“后图未开始”，已改成直接控制prepare完成时间，保留取消要求。
- /tmp/mw-mixed-independent-ranges.log(session48217)真实八图回归正在运行，未判通过。

### 黄金M15左界休市对照

- session48217退出1：同步不再busy、M5全部对齐，仅黄金M15左界22:00 UTC与目标20:50偏差。20:50后下一个M15边界21:00处于NY17休市，下一实存bar为22:00。
- /tmp/mw-gold-drag-direct.log(session50212退出0，诊断非全验收)：关闭所有同步独立setVisibleRange，黄金M15左界仍22:00，立即及1秒后相同。说明该偏差不由同步实现引起。
- 拖动验收补充实存bar核对，仅XAUUSD下一周期落NY17且首个实际bar落NY18、休市不超过1小时，允许匹配实际bar边界；不放宽其他品种/任意缺数偏差。
- /tmp/mw-mixed-session-aware.log(session89705)运行中；该进程启动早于上述NY17/18限制加入，之后必须以完整当前测试再核验。未部署生产。

### 实时修复队列无执行者

- session89705退出1，未到拖动：EURUSD导航窗口仅37根后缀，20秒超时。只读开发库发现M1缺口1790775960000–1790781919398，被priority0 pending ImportJob(cursor1790775960000,end1790781960000)占位，无对应M5聚合任务。
- 部署组合中realtime_worker仅once()轮询，chart_history_worker仅import_once(chart_only=True)，无人消费priority<100修复/人工历史队列。此前不能提升这类任务优先级是对的，真正缺的是执行者。
- 候选历史worker每轮先执行非图表修复队列，无任务才执行图表队列，仍独立于实时轮询且不增加连接池；添加修复优先/完成后继续图表的调度测试。需构建部署Ubuntu并验证实际缺口恢复，未部署生产。

### 修复队列实际恢复

- 构建market-watch-api:recovery-consumer-local成功，仅更新Ubuntu chart-history-worker（session83231退出0），未重启API或操作Unraid。
- 开发库只读复核：EURUSD priority0任务从pending变complete，cursor=end=1790781960000；1790633400000–1790793300000范围M1覆盖缺口为[]。ready aggregation52，后续仍由独立聚合worker处理。
- 使用当前完整前端候选及收紧NY17/18的验收脚本重跑/tmp/mw-mixed-recovery-fixed.log，尚未判通过。

### 同步关闭验收基准修正

- recovery-fixed(session96072)退出1：十字线、缩放、拖动（含实际bar及NY17/18校验）通过；关闭同步断言比较的是鼠标操作前moved快照，重设目标后的M15/M30取整变化误判为开关未生效。
- 测试在关闭同步后、移动主图前记录全部视区，后续要求非活动图精确不变；没有放宽关闭同步行为。/tmp/mw-mixed-save-baseline.log运行中，随后继续自动保存/刷新恢复断言。

### 历史页本地缓冲

- save-baseline(session86515)退出1，拖动三秒仍出现部分图临时补十几根数据的等待，未到保存恢复。既往一次拖动通过不能证明稳定完成。
- 候选对非首屏getBars多读取50%本地历史，上限仍2000，向原生返回合法的额外早期bar以缓冲小幅拖动。是否触发后台下载仍按原生requested判断，不因缓冲未满扩大下载目标。
- /tmp/mw-mixed-local-buffer.log(session99929)运行中。请求取消单测、语法、diff检查通过；功能尚未判通过。

### 八图完整用例首次通过与本机镜像

- local-buffer(session99929)退出0：完整八图历史范围、鼠标十字线/缩放/拖动、关闭同步非活动图精确不变、自动保存及刷新恢复全部断言通过，errors为空。黄金边界使用实存bar及NY17/18窄条件验证。
- 构建并仅部署Ubuntu chart-origin:mixed-buffer-local，重启本项目TLS刷新上游地址；bridge/viewports/progressive-history/history-demand四文件HTTP内容逐字节匹配工作树。未操作Unraid。
- 五项关联前端单测通过。移除全部脚本路由替换，实际镜像浏览器复验/tmp/mw-mixed-deployed.log运行中；单次用例通过尚非整体交付，冷D1计时/满负荷实时SLO等仍在原清单内。

### 实际镜像八图通过与冷启动计时

- mixed-deployed(session9986)退出0，实际部署文件无路由替换，完整八图鼠标/关闭同步/自动保存刷新恢复通过。
- 只读开发库确认OANDA:AUD_CAD instruments不存在、Bar计数0。新增advanced-cold-timing.browser.cjs，真实选择新品种D1，目标屏宽200，逐周期观察cache200根就绪（不同于GPU绘制时间），输出/tmp/mw-cold-200-timing.json及截图。
- /tmp/mw-cold-200.log计时启动。最多15分钟观察窗口并不代表承诺耗时；轮询只读取缓存，不对其他周期单独创建下载需求。

### 冷启动初步计时（继续运行）

- cold-200(session18232)实测10.626秒：M1/M5/M15均200根，M30 147、H1 74、H4 19、D1 4，原生dataReady=true。47.636秒H1达到200，D1 10；完整结果以JSON最终记录为准，不是GPU绘制时间或D1整屏完成。
- 同时只读快照EURUSD/BTCUSDT最新完整M1距当前约52秒，最后写入相对bar结束约18.9/17.7秒，库Lock waiters=0。XAU最新结束21:00 UTC需结合休市/开市日历单独判断，不能拿单个快照宣称实时SLO通过。

### 冷D1显示范围待核验、后端回归

- 冷启动持续运行session18232，200根缓存首次就绪：M30 15.902秒、H1 47.636秒、H4 95.719秒。183.393秒D1 64根；采样间偶有200→199，包含形成中bar变化，最终解释需区分完整bar。
- 原生range持续1790640000–1791925200且spacing5.59不变，缓存增加尚不能证明日线原生显示渐进扩展。需在运行完成后检查截图/原生数据边界，保持该需求未验收。
- 最新后端全量回归仅隔离本机PostgreSQL执行，/tmp/mw-backend-recovery-current.log：218 passed，19.81秒。未运行破坏性测试于共享开发库，未操作生产。

### 冷启动持续下载与显示诊断准备

- session18232仍真实运行，312.624秒D1缓存94根，range不变。只读队列plan pending、failed0、aggregation_failed0，前台priority100；下载/聚合仍在推进，不重启计时。
- 为下一次显示诊断补充cold-timing样本：nativeFirst/nativeLast、symbol/resolution、offset、控制器busy及每轮截图；当前已运行进程不会加载这些新增记录，不能把新探针能力描述为本次已采集证据。

### 首屏自动续页与历史跳转待区分

- session18232持续运行，423.244秒D1 114根，range仍初始值。代码发现所有非firstDataRequest短页均进入historicalNavigationPage等待目标完整，可能误把冷首屏自动续页视为主动历史跳转；这是待证假设，不据此直接修改生产逻辑。
- 下一轮cold-timing新增COLD_FEED记录原生请求countBack/from/to/firstDataRequest及回调耗时、首末时间，只记录市场数据。需结合最终截图和请求追踪后确定修复。

### 冷图存在额外历史导航需求

- 只读ChartViewportDemand：AUD_CAD同时有正常D1 viewer需求(start1766613600000,end1790806200000)及无viewer后缀的导航需求(start1695070800000,end1767823386000)，两者focused=true且续期中。这支持自动续页误入导航等待的假设，但仍需原生trace确认。
- session18232继续运行，512.584秒D1缓存135根。未中断/清除本轮数据，未改变计时定义。

### 保留导入来源兼容

- 恢复队列现由chart-history-worker消费后，fetch_page也可能收到旧Dukascopy任务；候选对非OANDA/Binance来源回落既有fetch_source，避免字典KeyError使队列卡住。该小改尚未部署，当前冷启动继续使用recovery-consumer-local。
- 三项worker调度测试再次通过（不代表实际Dukascopy联网已验收）。session18232仍在计时，日线显示问题保持未完成。

### 冷启动基准完成但显示验收失败

- session18232退出0仅因200根cache断言达成：M1/M5/M15 10.626秒，M30 15.902秒，H1 47.636秒，H4 95.719秒，D1 796.233秒（13分16秒）。不能当作前端验收通过。
- 人工检查/tmp/mw-cold-200.png：页面顶部“历史刷新等待超时”，图表无正常K线，角落仍等待目标日期数据。冷D1渐进显示明确失败，需修复。
- 保存原始基准/tmp/mw-cold-audcad-baseline.json与png；新冷品种OANDA:EUR_CHF（此前只读确认无注册/无bar）用补充原生trace/offset/截图的用例继续诊断，日志/tmp/mw-cold-eurchf-trace.log。

### 冷首屏自动续页复现与候选

- EUR_CHF trace：首次空页，随后firstDataRequest返回2根(1790640000000起)，原生立即以to1767824280续取186根，自动跳过数月。11.4秒起historyReloading=true且nativeFirst停住，复现无需等满15分钟。
- 已在证据完整后主动结束诊断session95052（非超时重启），不删除已下载数据，持久任务仍后台继续。
- bridge候选以初始空页标记coldHistory（有界64项），冷系列首屏不足requested时noData=true，阻止错误自动续页；逐次progressive reset继续展示新数据，首屏达到requested后解除标记。暖历史导航仍保持非空短页noData=false。
- OANDA:AUD_NZD（前次只读确认无注册/无bar）新冷图候选诊断/tmp/mw-cold-audnzd-candidate.log运行中，路由仅替换bridge；尚未判通过。需要回归主动日期跳转及冷图手动导航行为。

### 冷首屏候选实际逐步显示

- session69965运行中，原生回调2→6→8→43根，均firstDataRequest、noData=true，不再触发跳到数月前的自动续页。nativeFirst及可见range.from向过去扩展，spacing5.59/rightOffset10保持。
- 已人工查看/tmp/mw-cold-200-progress.png：K线实际可见、无顶部刷新超时，角落显示后台准备进度；仍需观察首屏完成和手动历史跳转。
- 新增advanced-cold-pagination.cjs直接调用真实feed.getBars，覆盖初始空、冷部分页、暖部分页、补满解除冷标记，测试通过；navigation-page也通过。
- cold-timing最终门槛补充nativeFirst/range扩展与无刷新超时，当前已运行进程不包含新增末尾断言，需按其日志/截图单独核验或后续重跑，不能混称已执行。

### 部分历史重新打开边界

- session69965仍运行，168.238秒D1 99根，nativeFirst/range向左扩展、historyReloading=false，图表柱距5.59保持。后台缓存就绪不是单独验收依据，已观察原生序列增长。
- 冷标记条件补充首次观测即有少量bar、但从未向原生交付过该系列的情况，覆盖关闭重开部分品种。已完整加载过的暖系列仍允许非空短页历史导航。
- cold-pagination加入REOPEN部分首屏及先完整后部分的WARM场景，测试通过，navigation-page通过。当前真实冷图进程仍使用前一候选，补充边界需后续浏览器验证。

### 持续负载下实时采样启动

- session69965继续运行，288.998秒D1缓存164根、nativeFirst/range向左推进，柱距和右侧留白稳定，无控制器busy堆积。
- session61358在Ubuntu API容器另开只读单连接采样，每15秒共20次，事务结束后sleep；输出/tmp/mw-realtime-under-history.jsonl。记录三维护品种完整M1新结束时间、采样时年龄、最后写入延迟、聚合/下载待办和锁等待数；不是通知端到端延迟测试。
- 首样本EURUSD/XAUUSD/BTCUSDT end一致，采样年龄30.176秒、received lag约17.8–19.5秒；聚合61、下载10、Lock waiters0。需等完整序列，不以首样本宣称负载验收通过。

### 冷图候选200根完成

- session69965退出0，AUD_NZD200根cache：M1/M5/M15 5.969秒、M30 11.379秒、H1 17.231秒、H4 61.090秒、D1 367.378秒。不同品种/并发背景，不能当作与AUD_CAD严格A/B吞吐比较。
- 人工核验最终/tmp/mw-cold-audnzd-candidate.png：正常日线铺满、无刷新超时，原生末次回调199根（当前交易日标签过滤与形成中bar需分别看待）；柱距保持。记录保存/tmp/mw-cold-audnzd-candidate.json。
- 开发库只读EUR_CHF完整D1仅49根，启动advanced-cold-reopen.browser.cjs，验证非空部分首屏及主动跳2026-01-05至01-30；日志/tmp/mw-cold-reopen.log。新边界尚未判通过。

### 冷终点标记限制主动导航

- cold-reopen(session5464)退出1：重开dataReady=true且图表可见，但要求2026-01-05..01-30后实际仍2026-08区间。确认冷首屏noData=true使原生认为更早历史结束，候选尚不满足完整导航需求。
- 临时探针/tmp/mw-cold-auto-error-bridge.js（未写产品/未部署）保留非空首屏noData=false，仅对冷系列p.to早于已观察首bar的自动跳跃续页用onError结束，验证不设置全局历史终点能否保留手动跳转；日志/tmp/mw-cold-reopen-auto-error.log运行中。若可行还须验证UI不出现持久错误及冷增量显示，不可直接判交付。

### 分页探针及实时采样结果

- auto-error(session20188)退出1：重开range0/dataReady=false，手动范围设置Value is null；该探针不可用，未并入产品。
- 供应商公开HistoryMetadata声明支持nextTime。临时/tmp/mw-cold-nexttime-bridge.js对冷非空短页提供实际首bar时间（秒），保留noData=false，运行/tmp/mw-cold-nexttime.log验证；未修改供应商代码或部署探针。
- 实时采样session61358退出0，共20样本、三品种各观察5个不同M1结束点；最大采样年龄75.44秒，最后写入延迟上界EUR19.12秒/XAU19.93秒/BTC17.87秒，最大Lock waiters1。样本年龄包含一分钟形成中等待；这些不是首次到达精确时刻或通知端到端测量，不能据此宣称全部SLO通过。

### nextTime分发实现边界

- nextTime秒探针session11795仍活跃时发现d.ts声明毫秒，主动结束参数有疑问的探针，启动毫秒探针session34778。
- 随后只读实际library.e2f8b3a016c9e1a0b7a5.js：_processEmptyBarset把nextTime乘1000；_processFullBarset对非空页nextTime仅警告，应只用于空页，忽略其值。该实际分发实现与d.ts单位不一致，非空短页提示方向不可行。主动结束session34778，未修改供应商文件或产品逻辑。
- 冷图noData终点导致主动导航失败仍未解决，需进一步以公开缓存重置/用户导航事件验证，不能将已正常显示的冷首屏当作该需求完成。

### 公开缓存重置隔离探针

- 只读供应商resetCache实现确认purge清除endOfData；request_only_visible_range_on_reset可避免其立即以旧leftDate自动发起请求。
- /tmp/mw-cold-reset-probe.js临时启用该feature，部分首屏交付后100ms调用订阅提供的reset回调，远历史firstDataRequest允许走现有导航准备路径。此为可行性探针，7天分类是临时试验参数，不是已接受的产品规则。
- /tmp/mw-cold-reset-probe.log运行中；未部署、未修改供应商，不据该探针缩减冷首屏/原生拖动/主动日期跳转要求。

### 缓存重置探针仍未完成目标范围

- reset-probe(session21031)退出1：重开可见，主动跳转右界达到1769731200，但左界1769385600而非1767571200。说明仅重置缓存不足以完成目标左侧历史，未判通过。
- cold-reopen新增原生请求/回调首末时间COLD_NAV追踪，用同一探针复验/tmp/mw-cold-reset-trace.log，继续区分目标补齐与视区应用问题。不修改供应商文件。

### 2026-10-01：日线分页日期过滤边界回归

- 上轮浏览器诊断 `/tmp/mw-cold-reset-trace.log` 已退出失败：原生请求 countBack=1 的上一页得到空数组及 noData=true，此后日期跳转不再请求更早历史。请求前的数据库页面并非空，但 D1 session 缓冲经交易日期转换和 exclusive to 过滤后为空。
- 新增 `advanced-cold-pagination.cjs` 的真实 feed.getBars 边界用例：过滤前存在一根未来交易日期 bar，过滤后没有可用 bar；修复前历史请求次数 0（应为1），修复后通过。
- bridge 使用转换后且早于 p.to 的可用数量决定冷启动标记及历史补数。导航、渐进缓存、请求取消单测通过；git diff --check 通过。
- 浏览器临时探针 `/tmp/mw-cold-filtered-reset-probe.js`，日志 `/tmp/mw-cold-filtered-reset.log`，会话27908仍在运行。探针包含之前的 reset 实验，不是最终实现，尚未部署。不能以单测通过认定冷启动导航完成。

### 2026-10-01：导航验收避免后台补数造成假通过

- 会话27908失败；重置探针并未恢复越过缓存边界的日期跳转。订阅跟踪会话27441曾通过，但当时目标日期已落在本次读取的缓存内，因此不能证明越界加载成功。
- `advanced-cold-reopen.browser.cjs` 改为根据 firstHistory 动态跳到已加载边界之前30天，避免固定日期随着后台下载变成温缓存测试。
- D1读取额外预留两条本地记录用于 session 日期缓冲过滤；过滤后的实际可用量继续用于判断是否补数。对应读取限额回归及分页回归均通过。
- 使用当前工作树 bridge（不含临时 reset 探针）的实际浏览器会话33910，日志 `/tmp/mw-cold-boundary-current.log`。已观察初始请求190根返回191/192根且 noData=false，消除了已充足历史被错误标成短页的情况。越界跳转结果仍待最终检查。
- 冷启动 noData 与用户主动越界导航兼容仍未完成验证；暂不部署本轮候选。
- 会话33910最终确实发起了越界请求并返回34根更早日线；失败仅为动态目标落在周日2025-12-07，原生左边界吸附到周五12-05，超过测试一天容差。将测试目标显式调整到工作日（不放宽容差），再验会话28239之外请以工具实际句柄为准，日志 `/tmp/mw-cold-boundary-weekday.log`。本结果证明温缓存越界可以请求，不能证明真正短历史冷启动已解决。

### 2026-10-01：独立原生接口验证门槛未通过

按用户要求暂停产品修补，新增纯原生测试页和10项浏览器检查，无应用bridge、后台API或数据库。最终基线7通过3失败，中文资源无加载错误。详情 `docs/native-history-interface-verification.md`，原始事件在 `docs/verification/native-history/`。

关键结论：分批显示与已有视区恢复可行；noData短页结束后，原生日期按钮、setVisibleRange和真实拖动都不能请求更早数据。日期目标未从所测公开事件暴露。因此前述“快照边界+协调器刷新”不能直接作为满足全部需求的实现方案。可见范围重置开关未解决；nextTime产生连续空请求；错误回调造成刷新超时。未部署产品修改，也未操作生产。

### 2026-10-01：timeframe公开接口六组对照

按用户同意验证初始化timeframe、onIntervalChanged修改timeframe，以及按可见范围计算首请求的特性开关。20根固定完整D1、6px柱宽，六组均未同时满足部分显示/保持柱宽/持续历史分页。最优候选首请求降至11根，但柱宽升至102.3px；恢复6px立即追加请求154根，本地仅剩9根，再次触发短页结束。完整事件存档 `docs/verification/native-history/timeframe.json`，结论补充至原生接口报告。未修改产品加载逻辑，未部署。


### 2026-10-01：用户纠正维护边界语义

自建行情仅指定历史补数起点，从该起点往后持续维护；不填写截止日期，也不需要另行启用实时维护。此前固定区间/默认不启用后续维护的描述作废，已修订双数据系列方案及验收条件。内部下载分段和发布水位不构成用户维护截止日期。


### 2026-10-01：从近到远分段补数、分段开放

用户进一步确认：从现在向历史起点倒序分段补，每段准备好即启用查看，不等待整个目标范围完成。新方案已改为逐段覆盖检查、按周期聚合和发布；未完成段不输出，更早段失败不影响已发布近期范围，实时维护持续运行。先前“整体完成才开放”条款作废。此规则仍不恢复视区自动扩大历史目标或原生getBars内等待补数。


### 2026-10-01：各周期首次开放门槛已确认

用户确认按实际绘图区容量的三屏完整K线作为各周期首次开放门槛，同时满足覆盖完整性和所选指标的前置历史。完成一个下载分段不直接等于可查看；开放后逐段扩大范围。补至指定历史起点仍不足三屏时显示真实根数/边界并允许查看，不自动前移起点。此门槛不恢复原来的三倍D1自动预热/扩展策略。最终以双数据系列方案4.4节为准，取代此前“第一段完成即开放”的表述。
