# 平台行情原生历史缓冲实施方案（v1.3.2 基线）

日期：2026-10-02。状态：修订稿 R2，独立agent方案级终审通过，无剩余方案级阻塞意见；仅方案和研究证据，不表示已实施。基线固定为 `v1.3.2^{commit}` = `9596b25eda507ef708a327feb5271f238cdfdc0b`；运行源码构建提交为 `2aef8acfab6871b9e9c0770067219581c48ad16e`。正式实施应从该标签或包含它的较新已接受基线建立隔离分支，不在旧 `feature/advanced-charts` 的 db0c4e1 上直接实现。

## 1. 目标与已知限制

目标是让原生图表在自己的历史回调中接纳有限额外历史，让已加载范围内的拖动直接显示已有 bar。常见冷首屏以多数小于3秒、尽量2秒为体验目标；完整 PostgreSQL 需求缓存命中后，以原生发出请求到图表显示多数小于1秒为目标。不是仅测 HTTP，也不是浏览器下载缓存到显示。

首屏构造还包含许可库初始化；代理长尾、较大 countBack、远距离跳转、多图弱设备有单独限制，不承诺每次3秒或无限拖动不加载。已有缓存不意味着原生已加载；超过本次附带范围后仍由原生决定下一次 getBars。本方案不依赖周期性 reset、改变视区后再恢复、假指标、私有库方法或修改许可库。

v1.3.2 的连接维护修复暖两条 chart HTTP/1.1 连接，并在额度等待时让位前台；不是 candles 预取。该版本是源码发布，未构建或部署正式 v1.3.2 镜像，见[交付说明](chart-v1.3.2-delivery.md)。此前缓冲实测来自固定 v1.3.0-candidate.1 API/图表镜像，作为参数依据，不冒充新基线部署验收。

## 2. 职责、基线与变更位置

| 层 | v1.3.2 现状 | 本方案责任 |
| --- | --- | --- |
| 原生 TradingView v31.1 | 决定 countBack、历史区间、请求时机；持有各周期历史 | 接纳同周期合法超量历史；不修改许可库 |
| 图表宿主与 datafeed | bridge.js provider分支原样转发需求和交付回调；宿主保存视区 | 可传图数/聚焦/明确导航动作的上下文；无缓冲数量、上游分页和预热调度 |
| `/api/charts/data` | DataQuery 最高20000；provider请求有取消/8秒默认预算 | 校验可选上下文，保持认证、取消和预算；普通 API 调用缺上下文时保持按需 |
| API 后的取数层 | provider_cache.data() = count + Python前缀，返回 count；按覆盖和新鲜度读PG，否则分页上游 | 判定真实需求、可选缓冲及覆盖；只在此处制定数量与返回策略 |
| provider_service | 有限basic1000/depth4000、当前周期优先，其余 D1 W1 H4 M5 M1 MN H1 M30 M15；历史左右邻域已有 | 复用有限预热，保留当前周期优先和按平台额度执行；只补本轮新增明确需求 |
| provider_transport / market_resources | v1.3.2连接维护、chart/realtime/history资源分道 | 保持连接池、代理、额度和维护策略；前台缓冲不能借用后台或实时额度 |

不新建第二套前端bar缓存、SSE历史灌入或后台调度器。不默认接入 onVisibleRangeChanged 连续预热：现有每次真实读取已经激活有限预热，它本身不能追加原生历史。以后若测出数据库准备缺口，再讨论独立提示机制。

## 3. 需求与响应参数

N = native countBack（缺省时兼容 limit）。D = 实际输出必须提供的根数：至少N，且包含本次已存在的 `[from,to)` 范围内全部bar；不能用固定200或自然时间差除周期代替实际bar数量。H = 必要Python计算前缀，输出D不包含H。`to`排他且钳到当前；按平台 chart_time/交易日标签比较，实际indicator时间仍用start。

可选额外根数记E。先评估D/H的连续覆盖和新鲜度，决定真实需求是否命中缓存；缺少E不能把已满足需求的请求改成冷请求。历史边界已被供应商证实、真实可用数量小于D时，返回所有真实数据而不造bar。

| 场景 | E默认目标 | 返回预算 |
| --- | ---: | --- |
| 冷首屏 / 普通冷历史加载 | 600，更早侧 | 只随必需的上游请求附带，不为E发送额外HTTP |
| 新鲜完整需求缓存命中的首屏 | 3000，更早侧 | 普通单图R默认4000；仅利用连续有效缓存 |
| 冷历史跳转 | 600，更早侧 | 与冷首屏相同 |
| 缓存历史跳转 / 缓存后续历史分页 | 2000，更早侧 | 普通单图R默认4000；仅利用连续有效缓存 |

缓存输出目标为 `D + min(E, max(0,R-D), 可合法附带的连续缓存根数)`；D超过R则E=0，真实D仍完整满足。原生返回多不会自动把更多bar挤进首屏；维持原视区/柱距。

明确历史导航动作的初次请求用跳转档；没有可靠动作提示的firstDataRequest=true采用首屏档，false采用历史档。不能将false声称为用户发生了跳转；这也使普通后续分页有足够缓冲。历史恢复首次请求无动作提示时可用首屏档，但不影响任何真实D。

首版采用保守多图预算：图数>1时每序列R=2000、可选E最多1000；图数≥4且明确非聚焦序列时E=0。同品种同周期被多图共享时采用匹配图中的聚焦优先上下文，不把一份原生需求重复当作多份。R只限制额外量，不声称限制原生累积历史内存或保障60fps。

Python合成指标系列首版E=0，使用真实D+H计算窗口；原生指标（例如MA200）由native扩大countBack，正常保留缓冲。缓冲开关不改变同一真实D/H计算输入。D>N属于范围需求修正，扩大计算窗口会改变EMA等递归指标的初始化，不能承诺与旧N+H窗口逐值完全相等；如对比旧窗口应记录数值容差及差异原因。未来给Python系列附带缓冲前，需要相同D/H输出不因可选E变化的验收，不能把原生MA实验当Python指标成本验证。

可选上下文只用于平台原生历史调用，定稿为 `native_history: {chart_count: int[1,8], focused: bool|null, historical_navigation: bool=false}`，first只用已有firstDataRequest。图数必须为非bool整数，非法类型/图数返回422。缺省表示普通API，保留v1.3.2按N+H取数；非provider传此上下文返回422。前端不传E/R/cache_hit，不执行数量政策。明确导航提示只来自宿主已知动作；没有可靠提示就false，不截获原生私有按钮。匹配多图共享序列时用“任一匹配图聚焦”的信息，没有可靠图数/聚焦时发送chart_count=8、focused=null，采用保守预算。父页面AdvancedWorkspace.tsx现有白名单重建请求需同步校验并透传该对象，不能只改bridge使字段被丢弃。上下文不影响认证、真实数量上限或额度。

后端提供总开关（默认关闭直至目标验收通过）和平台/场景默认常量，不增加schema迁移、不写managed数据。对带native_history的调用，真实D/H范围修正始终生效，总开关仅控制E；无上下文维持旧N/H合同。A/B固定同一D/H，仅比较E开关。完全源码回退到v1.3.2则恢复旧N/H合同，要单独记录这一变化，不能将它与关闭E开关混为同一操作。

## 4. 前台读取算法与正确性

1. 校验真实N/from/to及上下文；时间区间本身应使用未经钳制的native to验证from<to，随后剔除未来空白、禁止取未来bar。输入类型或非法区间返回422。已知H后检查N+H，超过20000返回422，结构化code=`NATIVE_HISTORY_CAPACITY_EXCEEDED`，前端正常err回调，不返回noData。未知D在下一步发现，不能先用时间差估出D来判容量。20000约束单次前台读取总量D+H+E，不是后台目标或native累积历史的上限。
2. 使用同身份/覆盖/新鲜度规则，逐页发现真实D。停止条件是“数量N已满足且coverage证明from到有效to范围已完成”，或供应商已证实终点；from未传则只需数量条件。原始from<原始to合法、但from>=钳制后的有效to时，本次有效范围为空，范围条件真空满足，只按N/H读取，不能因此422/503或noData。已有范围内多于N的bar全部计入D；H是最早输出之前的计算前缀。冷路径覆盖尚不到from时，继续必需分页，不把已满足N误认为完成。仅用实际bar/coverage证明，不用周末、月线自然跨度。受限查询至多取20001条并结合覆盖判别：D+H=20000可完成且不附带E；必须输出/计算的真实bar到20001时容量错误。尚无充分覆盖证据且预算到期返回503，不能把未知范围伪装为恰好20000或历史终点。真正边界少数据按实际可用量完成。可选E在必需容量确定后裁减。
3. 冷暖分类基于请求开始的必需D/H覆盖和新鲜度，保留该分类；过期tail刷新按cold/miss档，不能因刷新后的缓存完整改成hot档。需求命中时，只读与本次窗口连续、同身份且合法的PG额外历史。最新tail遵守provider_fresh_seconds，不能用扩大缓存动作绕过刷新。不要将 `read(..., D+H+E)` 作为热路径唯一调用，否则缺E会触发上游。
4. 未命中时仍按基线租约、覆盖、deadline和取消状态完成真实需求。冷E只合并入最后一个本来需要的上游请求的可用容量；达到D/H即停止前台，不为剩余E继续分页。必要的新鲜tail刷新不额外抓整段旧历史：先完成tail，余量来自PG。
5. 冷路径必须区分“必需剩余根数”和“期望附带根数”，不能把count简单改成D+H+600后沿用“凑满count”循环。否则原生高周期的交易日标签转换、+3转换余量、过滤和内部native_page循环仍可能引入额外HTTP。adapter应允许请求携带可选量，却在必需数据已满足后停止补可选量；实施测试统计真实HTTP调用次数，不只统计native_page次数。无法保证这种停止语义的路径保守E=0，继续后台补。
6. 租约和提交继承generation防护；每页只发布它实际证明的coverage，供应商I/O不持有DB事务。后台或另一请求补了数据后重新检查覆盖，避免重复取。同时间重复bar去重，按chart_time严格升序，仅交付 `<to` 的数据。
7. 最终D/E bars、coverage、history_boundary、cache_revision/as_of/latest_at必须来自同一一致数据库快照。首版采用单条SQL读取dataset元信息与有界历史（例如LATERAL子查询/聚合；空bar时也返回dataset行），共享一个statement snapshot；不把PG默认READ COMMITTED下多SELECT的普通transaction当成一致快照。更新accessed_at单独处理，不改变revision，不混拼旧metadata与新bars。必需结果本身同样遵守此协议。可选重读只能替换为另一份完整自洽响应，不能把两份快照拼接；可选查询不可即时完成/失败时回退已完成的自洽必需快照，尊重总deadline且不等待上游或租约。必要时限制SQL statement timeout，禁止为E新增重试。noData仅来自真实供应商终点，不能因可选不足/超时/取消置true。
8. 最终快照须再次满足真实需求覆盖和最新新鲜度；若真实修订需重新必需读取，按原deadline进行，不能给旧bar配新revision宣布已交付。只补更早历史不修改最新cursor；纯读取E不增加revision，新增更早bar保留既有revision=1语义，已有bar真实修订仍正确reset。晚到响应的处理采用下一段确定协议，不盲目max或无条件倒退revision/as_of/cursor。
9. 使用真实需求锚点、D+H及既有client激活有限预热；count不因E或返回数量膨胀。可选激活失败只记录、由后续成功读取恢复，不新建无限重试队列，不把已完成的必需读取改成失败。真实取数失败仍正常报错。

可抽出内部 `provider_history_policy.py` 放场景/预算纯计算；读写、覆盖证明和paging仍在provider_cache。不要重复实现另一条可访问上游的缓存读链。既有其他调用者继续使用按需read，只有native_history调用启用政策。

### 晚到历史响应的有界复核协议

宿主按workspace/系列/周期保存已经交付给native的历史及SSE观察版本，不制定复核算法，只转交后端给出的快照信息。准备交付的响应若比本序列已经交付的revision/as_of更旧，保留其合法native回调，不丢弃、不取消，不把旧观察版本覆盖当前版本。通过既有`/charts/data`最多执行一次复核：原品种/周期/N/from/to/indicators不变，增加可选`history_observation:{revision,observed_at,first,last}`，时间是原响应chart_time边界，传旧快照而非前端伪造新版本。此字段仅新后端支持的native调用使用，未知字段仍按v1.3.2 ignore兼容；不新建endpoint或事件预热请求。

取数层对该窗口核实是否存在`revision>1 && changed_at>observed_at`的真实历史修订，并在一致快照中返回验证结果。纯revision=1 backfill或仅数据集revision增加不使旧bar失效：返回可用快照并维持已有最新cursor，不触发reload。若原窗口被真实修订，则返回新完整D/H自洽快照、E=0并标记`history_revalidation.changed=true`；桥接交付新bar后，以既有公开历史reload机制安排本序列一次更正重载，合并重复待办。活跃系列执行，暂非活跃系列回切时执行；不把它作为预加载机制。复核请求不得由changed标记递归触发另一个复核，标识pending/已消费状态，直到本序列没有旧快照回调待交付且更正重载已完成再清理。

若复核失败、原预算耗尽或另一更新在复核期间再次到达，原合法回调仍按native合同完成，保留一次有限更正待办，不宣布旧快照已看见新修订；错误明确显示且不造noData。后端更正检查仍以真实`revision>1`为条件抑制纯backfill重载。普通顺序响应、同revision的E只读不增加复核请求。这个协议只处理乱序一致性提示，数量/覆盖/修订判断仍在取数层；编码前必须通过真实修订与纯backfill两类屏障交错，不能拿盲目max或每个response强制reset代替。

复核接口落实三个不变量：first/last为原响应实际bar的chart_time闭区间，检查包含last，空响应不造窗口；旧后端没有history_revalidation字段表示只获得旧合同，不能当changed=false证明；待更正状态不能被普通SSE/另一较新响应提前清除或提升为所有旧历史已交付。只能在无旧回调待交付且更正完成后消费，失败/待办按原workspace及有限生命周期收敛。

## 5. 历史跳转与预热

公开库行为已经实测：[跳转研究](native-chart-additive-buffer-jump-study.md)。从最新首屏跳到约10000根前时，native countBack为9391或6991；直接历史启动为10166，to仍指向最新。真实需求本身含目标到现有原生缓存之间的走廊。加载完成后四场景的12次左右手势无新增getBars。

因此用户“前600/2000 + countBack + 后600/2000”的较新侧作为数据库覆盖意图，不机械第二次加到同一回调。已有原生走廊不重复塞入>=to的bar。不把to+周期跨度的数据当作可以合法插入历史回调的捷径。

已有activate历史任务以to附近为右侧锚，不知道实际跳转视区。首版保持现有有限邻域预热：首先完成真实native走廊后，这已经覆盖可见目标较新侧；更早侧任务仍按D+goal沿to补。若确需围绕目标右侧单独准备，必须另传可靠目标窗口并由取数层推导覆盖任务，不能将to误标目标。此独立事件/目标预热不作为首版交付依赖。

保持basic1000/depth4000两轮、当前周期优先再 D1/W1/H4/M5/M1/MN/H1/M30/M15，不为了新政策重排跨周期或全量重复补数。cold缺少的600、hot缺少的3000/2000由已有有限任务覆盖；最新已完成旧目标在时间移动后不能假设永远满足，必要刷新仍由前台新鲜度/实时订阅负责。高周期、年轻品种可少于目标，止于真实边界。

当前activate相同锚点fast return需最小修正：传入真实D+H，latest目标为max(goal,D+H)，历史左目标为goal+D+H；相关目标即使之前done=true，也在真实需求增长后重新检查coverage并单调扩量。跨周期和右侧固定目标不因E或输出量增长，不重启全部18/20目标。latest沿用既有固定anchor，不能把移动的now悄悄带入同锚点目标。

并发回写采用JSON任务版本CAS，无新增schema：每个target保留generation（旧任务缺省0），activate在行锁下扩大count、重判done并增加generation；两个activate串行合并max目标。warm_step捕获ident/anchor/index/generation，取数后以短行锁事务核对当前任务身份和版本。版本已变化则丢弃旧任务的状态回写，已成功写PG的页保留，下一轮按新目标检查coverage。版本相同才提交其done/next_at/error；任何回写都不能降低当前count，不能把旧小目标done=true覆盖扩量目标。未变化目标保持进度，目标到期/被替换时丢弃旧状态。

同ident删除后重建也不能误认旧worker为新任务：每次新建/替换任务分配JSON中的随机task_id，与generation一起核对；仅扩大原任务保留task_id并增generation。无需新增表字段。

前台/实时优先、共享取数与有限interest/TTL/cleanup继续沿用。warm_step前台busy检查只在当前进程有效，不能把它写成跨所有worker即时抢占；跨进程仍由现有共享lane资源/租约约束，已在途HTTP不能承诺立即中断。不得因此加新的无限调度或重试机制。

## 6. 快速切周期与并发

v1.3.2已明确：同workspace内暂时切周期不取消provider历史请求，因为native回切可能复用它；workspace被替换才取消旧epoch。方案不得按“当前周期变了”丢弃仍合法回调。复用现有4个前端并发和64等待队列、native回调隔离、订阅注册/退订、服务端deadline，不再扩大并发数。

图数/聚焦在请求时快照用于可选预算；切到非聚焦时不能反过来削减已经承诺的真实需求。可选读取无新增网络循环。审查firstHistory/lastHistory/providerHistoryState接收额外bar后的revision/cursor语义，实时订阅仍只更新最新或添加新bar，历史修订保留v1.3.1合法重载。

## 7. 实施拆分与验收

实施顺序：后端政策与覆盖读取 → 冷合并可选量停止条件 → 相同锚点预热目标增长修正 → 最薄上下文透传 → 固定v1.3.2隔离构建/产品浏览器验收 → 默认开关启用。新增测试集中在已有test_provider_cache/service/chart/transport和现有provider浏览器入口；不复制测试只为验证常量。

必需行为测试矩阵：

| 类别 | 必须验证 |
| --- | --- |
| 热缓存 | D满足、E不足不发上游；缺口不跨越；真实终点少数据；tail过期刷新；native上下文缺省按需 |
| 冷路径 | Binance N=200/700/1000/1200、OANDA临近4000；Python前缀/部分缓存；实际HTTP次数不因E增加；必需不够则继续分页；可选不足即停 |
| 时间与大需求 | M1/M5/H4/D1/W1/MN；OANDA休市/DST、周月标签；from/to范围bar比N多；D>4000完整返回；D/H接近20000；真实超上限容量错误 |
| 跳转 | cold/cache两种，历史直接打开和latest后跳转；合法to、真实native大countBack；加载完成立即向两侧拖；超过有限缓冲正常再次请求 |
| 指标/订阅 | 原生MA200满足真实countBack；Python E=0，与同D/H按需计算一致，D=N及D>N均覆盖；边界/NULL/gap；历史修订重载、实时最新bar、重复time为零 |
| 并发/生命周期 | 连续快速切周期并回切、同序列多图共享、workspace切换；旧epoch不交付；同workspace仍合法回调保留；租约generation/coverage/connection维护不退化 |
| 预热 | 同锚点D变大扩大target，包括旧done=true；两个activate并发；屏障固定worker旧快照→activate增长→worker回写，count不降且done正确；不因E增加目标，有限轮/TTL/清理/前台额度优先；预热失败不破坏需求响应 |

另在真实PG用屏障固定“必需读取→历史修订提交→可选读取→订阅注册”交错，证明返回bars/metadata自洽、纯backfill不reset、未交付修订不漏reset、已交付修订不重复reload。覆盖“新响应/SSE已经交付→旧历史响应晚到”的纯backfill和真实修订两类交错，验证复核次数有界、回调不丢失、非活跃回切待办、复核失败不造边界；E>2000不能误触发实时SSE的2000变更上限。

性能验收使用正式React/postMessage链路、相同机器/代理/窗口、固定镜像ID，两平台每关键场景至少10次，交替对照同D/H的E开关，失败/超时进入分母，不删除长尾。冷t0为UI打开/导航动作，热t0为native getBars入口（包含前端排队/postMessage）；t1=dataReady后可见绘制代理，辅以截图/空白帧观测，不只看HTTP。UI冷指标和旧实验widget构造指标单列，不能混算。常见冷首屏（约200根，无昂贵Python）每平台至少8/10小于3秒，追求中位小于2秒；报告达标率，不当总体SLO。若同场基线也不达标，保留证据并以对照定位，但不自动判通过或启用默认开关，不反复补测凑过线。

完整PG真实需求命中且连续约3200–4000根可用：每平台native请求→显示至少8/10小于1秒，native已有缓存的零请求动作另列不混入此门槛。无重试正常样本中缓冲开关不得增加前台candles真实HTTP调用次数；429/503/连接重试单列每次attempt及原因，HEAD维护、后台预热和前台candles独立归类，不把adapter一次page当作一次HTTP。首屏视区和柱距不因多返回变化；在附带范围内实际移动，不新增getBars、无加载状态/空白帧，边界外允许原生发起请求。

随机连续切周期20次含快速回切，记录每次UI动作→显示和是否来自native已有缓存/PG/上游；没有无限等待、未处理异常、错误周期回调、历史时间重复、永久加载或队列增长。命中native缓存的动作与命中PG的动作分别统计，不能混作一次缓存指标。

多图测试1/2/4/8图、至少正常和4×CPU，记录同轮响应量/字节、长任务、拖动帧间隔及JS heap；多图默认预算可依据正式链路降级，不声称所有设备60fps。任何还未完成的门槛在交付记录单列，不由此前合成renderer成绩代替。

只改方案时不运行产品全套测试。实施后运行受影响后端测试及相关frontend本地脚本、真实PG coverage/lease测试，再完成目标浏览器验证；正式发布遵守现有发布/迁移说明。没有新schema，仍需匹配v1.3.2的o16及API/worker版本。

## 8. 开关、回退与交付物

部署前审核固定源码差异及许可库未变。隔离验收通过后开启后端总开关；关闭仅E退回0，同native上下文的真实D/H合同保留，native已持有额外历史不强制reset。最低兼容回退后端为v1.3.2：审核已用真实DataQuery验证未知native_history被忽略、N不变；新前端可直接optional透传，旧后端继续N/H按需。实现显式冻结未知可选字段ignore合同，并测新旧组合。旧前端没有上下文，新后端维持旧合同；新后端E开关关闭但有上下文则D/H按需。未验证的更早或拒绝unknown fields的后端不列入支持范围。不修改裸指标catalog加入capabilities，不增加启动网络请求或通用协商框架。

交付包含：方案、独立审核记录与采纳/不采纳理由、代码变更、固定source/image标识、条件明确的浏览器原始样本、开关默认值、回退操作。方案及证据更新不等于合并/推送/部署。

## 9. 已有证据定位

- [本轮缓冲数值汇总](verification/native-history/additive-buffer-summary.json)：36冷缓存取数、30真实API→独立native显示、6慢CPUrenderer。冷约774–775根中位1.496/1.417秒；需求701＋600中位1.905/2.069秒；PG约3174根请求→显示0.610/0.638秒，5501根1.123/1.119秒。每平台每配置3次，主要M5，不能泛化全周期。
- [冷取数原始记录](verification/native-history/additive-acquisition/results.json)、[API→native显示](verification/native-history/additive-display/results.json)、[慢CPU原始记录](verification/native-history/additive-multichart/results.json)。样本在连接池已运行条件，不是每次新TLS。
- [历史跳转报告](native-chart-additive-buffer-jump-study.md)、[原始参数和12次手势](verification/native-history/additive-jump/results.json)。是24×7合成M5，50ms模拟回调，无真实上游或指标，机制证据不充当性能验收。
- [初轮227次实验数值摘要](verification/native-history/buffer-sizing-summary.json)、[旧实验镜像与哈希清单](verification/native-history/buffer-artifact-manifest.json)。本轮复制保持原始bytes，清单中的旧镜像标识不能改为v1.3.2；较早完整报告/脚本仍在research worktree，实施不依赖它的分支HEAD。
- [本轮证据导入清单](verification/native-history/v132-plan-evidence-import.json)记录12个复制文件的SHA256与来源。旧buffer-artifact-manifest属于原research目录，不冒充当前方案文件清单；当前路径可独立读取本轮完整结果与复现脚本。
- v1.3.2接口源码：[provider_cache](../backend/alerts/provider_cache.py)、[provider_service](../backend/alerts/provider_service.py)、[DataQuery与请求生命周期](../backend/alerts/chart_api.py)、[薄桥接](../advanced-host/bridge.js)、[源码发布清单](../deploy/releases/v1.3.2-source.json)。

## 10. 独立审核与修订

审核agent为 `gpt-6.1-sol / max`。[首轮审核](verification/native-history/v132-plan-review.md)发现2项P1、3项P2，本稿全部采纳；审核不等于实现、部署或性能验收。

| 意见 | 处理位置与采纳理由 |
| --- | --- |
| P1-1 最终响应一致快照 | 第4节明确单SQL statement snapshot及完整自洽响应替换；避免revision/as_of与bars混搭影响SSE。新增PG交错测试。 |
| P1-2 预热目标增长并发回写 | 第5节明确JSON generation CAS、行锁增长/版本核对，旧worker只保留PG写入不覆盖新目标；旧done=true也重判。 |
| P2-1 Python计算窗口比较 | 第3/7节用同D/H按需结果比较；明确D>N初始化差异，不承诺旧N/H逐值相等。 |
| P2-2 可选上下文及兼容 | 第3/8节字段定稿、父页面白名单透传、验证过的v1.3.2 unknown ignore直接降级；取消不必要握手，区分E关闭与完全源码回退。 |
| P2-3 范围/容量/性能口径 | 第4/7节逐页发现D、20000/20001停止与容量code、开始时冷热分类、实际candles attempt归类、UI/native两个时钟、分平台/失败分母和启用门槛。 |

R1复核确认五项已实质处理，要求再明确晚到响应动作及未来空白范围。本稿R2补充了第4节晚到有界复核协议和空范围数量需求规则；agent已完成R2终审，结论为方案级审核通过，无剩余方案级阻塞意见。实施代码、数据库交错测试和性能验收尚未开展。初稿/修订稿哈希与复核状态见[审核记录](verification/native-history/v132-plan-review-record.json)。当前文件是后续实施的唯一政策来源，历史研究数量候选只保留证据角色。
