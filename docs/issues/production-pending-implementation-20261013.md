# 七项生产问题实施状态（2026-10-13）

实施工作区：`market-watch-production-pending-fixes-20261013`，分支 `fix/production-pending-20261013`，基线 `1b3e4a2`。需求以 [原方案](production-feasible-solutions-20261013.md) 为准；原方案的分析阶段说明保留为历史。

**用户本轮要求的补丁审查与 Ubuntu 隔离 Docker 验收已完成，未发布生产。** 审查发现的补查范围 P2 已修复，54 项后端测试及部署后真实浏览器回归通过，详见[本轮审查与验收](production-pending-review-acceptance-20261013.md)。Load failed 本轮未复现，按用户最新决定暂不处理，不能宣称根因已修。来源缺分钟仍依方案第三分支保持 unknown；中间一次未复现原生异常的历史风险保留。阶段 D 最终三路径测量已收齐，严格 OS 冷缓存未测，性能与内存限制见下文。

| 原编号 | 实施与验证结果 | 未完成范围 |
| --- | --- | --- |
| 1 原生绘图可见范围 | 恢复原生范围及调整控件、九周期统一掩码；非连续范围保留孔洞，旧范围只在显式编辑转换。真实许可库验证输入、拖动、混合值、多对象、撤销重做、取消、复制、保存、多图、九周期及430px通过；Docker原生范围、掩码506持久化恢复及原生模板UI保存/应用通过 | 功能验收通过 |
| 2 组合告警 stale | 现有生产容器只读来源复核：20分钟返回10个观测，与确认存储完全相同，无本地遗漏证据；另10分钟未知。增加固定修订有界复核、日期与未知分钟诊断；实际PG并发及Docker表单/审计配置失败分支通过 | 未知分钟没有独立闭市证据；不能宣称告警恢复 |
| 3 Swing 统计 | 默认及旧below_name/缺失配置迁至图内左下角，保留隐藏选择与强度。Docker五图明暗主题、折叠、最大化、顶部零占高、保存刷新保留hidden与high5/low6通过；私有截图视觉核对通过 | 功能验收通过 |
| 4 LWMA 默认 | 周期5及白色默认；保留已有参数/样式。Docker真实Python值、新建、参数修改及保存刷新通过 | 功能验收通过 |
| 5 统一原生结果更新 | Python LWMA/Swing/SuperTrend结果经统一原生更新；范围协调、批量读取、身份/修订/代次校验、多输出及内存预算。受控真实许可库验证0/负/null、更正/撤下、尾部缩短/空、旧handle detach；最终编译产品验证参数、模板、D1/M5、分页、五图保存恢复。Docker真实API/PG/Python值、五图、分页和三路径1/4/8对照通过 | 新路径测量为0空数据帧、0整图reset；12,000根固定窗口三路径及prepend优化前后、进程重启/驻留、1/4/8各3样本已测；最终事件/在途复用驻留9样本及完整最终三路径27样本/135页另测；未达到与内置相近的端到端效率；heap仍更高，严格冷DB端到端未测，中间一次原生异常根因未定位；不能承诺固定性能收益 |
| 6 通知/读取恢复 | 普通通知右下角非模态、最多3条、30秒合并、8秒收起，悬停/焦点暂停；草稿恢复保留确认。完整body读取预算、有限重试、共享与错误分类、100条脱敏diagnostics；受控读取恢复及Docker通知通过 | 本轮未复现 Load failed，依用户最新决定暂不处理；没有网络根因已修复的证据 |
| 7 列表布局 | 容器≤700px切两列；560px列表＋360px详情边界。构建测试701/700/560、两标签、长名、focus/filter/scroll/full通过；Docker组合行560px、主列440px、无溢出及关闭详情焦点返回通过 | Docker1600/1250/980/720px明暗主题通过，宽屏side、窄屏full及无溢出 |

## 来源复核与一致性

[来源证据](evidence/source-recheck-20261013.json) 区分Ubuntu代理504/直连不可用和现有生产容器只读成功读取；生产仅供应商GET与数据库READ ONLY，没有远端测试实例、价格写入、日历修改或告警改绑。

新入口 `/api/market-data/composites/{composite}/revisions/{revision}/recheck` 固定修订，只读取拼接后已结束且含实际 unknown 的区间；单次≤24h、滚动24h每修订≤3次、间隔≥1分钟，请求编号幂等。完整观测或目标来源适用闭市覆盖的区间在消耗预算及供源读取前拒绝；历史来源闭市证据不能证明目标来源完整；补齐后同请求编号仍返回既有结果。真实观测经过confirmed_minutes.record和composite_inputs.apply_minutes登记；错身份/窗口/超期回滚；配置失败审计为configuration_error，未完成请求超过60秒重试返回timeout。空响应只证明查询完成。UI在网络失败/pending保留请求编号，结束响应后允许新查询。

[新增端到端恢复回归](evidence/production-pending-source-alert-recovery-20261013.json)以完整M5再丢1分钟为起点：连接恢复、时间结束与来源确认均满足，但覆盖unknown=1仍stale；真实来源批次经新recheck入口补齐，同一固定告警版本/组合修订恢复coverage。原input_revision的读取仍保持旧缺口，新输入只建立recovery_baseline，不补发历史上穿；后续下穿再上穿仅触发1次，同样本重复评估不重复。实际Ubuntu PostgreSQL独立schema通过。此回归证明补查入口与恢复机制正确，不证明生产缺分钟已存在真实补齐观测。

Docker无供源凭据，实际表单验证的是配置失败与unknown保持。重复验收依法达到3次限额，未绕限频。独立PG测试覆盖并发同ID仅一次源读取、不同ID限频、失败/空/失效边界；成功价格分支由受控来源与实际PG验证。

## 原生通道与分页修复

固定许可库构建钩子校验SHA256及可逆旧版本；私有结构仅由native-indicator-results.js访问。缓存按时间保存，提交时映射原生主图索引，原生串行更新负责各plot、偏移、价格轴与完成事件。删除先从最早受影响索引截断并同批恢复尾部，普通追加提交变化行，不做整图reset；真实输入更正先撤下失效结果。

实际Docker分页暴露了受控fixture未触发的stop/start清空：旧handle detach可能撤掉新代次，主图价格页可能改写计算起点，原生重启/clearData可能清曲线。已限定同主图、parent、周期及全部计算输入才传递有效时间缓存；新代次拒旧batch，删除microtask释放；仅Python结果设计算起点；时间轴ready后重投影。参数/身份变化照常清理。更正事件回归另发现：原生重启令撤下返回false仍被确认，且消费者重建会失去更正状态；现仅撤下成功后确认，并让新消费者对非零更正版本先撤下。编译产品验证普通尾部追加0空白/0reset、更正等待时撤下、尾部回撤末柱与Python一致。最终chart镜像重建并force-recreate，临时诊断bundle未留在验收容器；调试探针已移除。

左补页测量发现协调器重复读取已接受尾部，导致单样本17–19次已完成的指标读取、11.5–12.7MB响应及更高heap。现由适配器保存实际有效coverage；同身份、输入修订、更正版本和尾部版本且只左扩时，仅从旧sourceFirst读取新增区间，再以prepend提交。原生同身份重启保留coverage，身份变化、撤下和detach清除。sourceFirst保留后端源时间，避免NY17高周期标签混用。共享缓存只保留规范化结果及精简展示元数据，释放重复OHLC/指标payload。已有编译产品左补页断言在旧实现跑红，修复后及sourceFirst版本均通过。

后续时间线探针发现500ms轮询延迟范围需求，且原生reset期间主图尚未接受新范围就发起指标读取。现监听公开onDataLoaded，microtask合并同步通知；按native chart owner去重，图格移除及工作区dispose撤销监听。更正先撤下，再等主图dataReady读取新结果，保留原500ms重试/参数变化兜底。主图重启产生的新消费者可复用相同输入版本、查询及已派发指标规范的在途页；不同参数、固定身份、计算起点、输入/尾部/更正版本拒绝跨请求复用。共享读取回归先复现旧代次取消后新代次重复派发，再验证新消费者保留在途读取、旧消费者单独取消、新规范分读、修订隔离和完成后释放。新增indicator-range-events.cjs先验证旧代码在及时补页及未ready读请求两处跑红，再验证事件合并、prepend、重复读取抑制、图格/工作区清理和更正立即撤下通过。编译产品追加、更正、回撤、多输出和五图恢复均通过。

预算：实例≤200,000行，共享≤400,000行/1,000,000plot值/24条，全体≤2,000,000plot值，单范围≤100页/30秒。一次页读取最多12个不同指标规范，更多分组并校验相同输入修订；独立消费者取消不影响其他共享读取。计算仍由Python承担，普通内置指标沿用原路径；禁用构建钩子可回旧通道，同实例不双写。

## 验证证据与性能解释

- 后端相关7文件98通过；本轮来源复核/目录契约41通过；实际PG Swing/固定指标/确认分钟30通过，来源复核PG原7项通过；新增固定告警恢复回归后来源复核/告警29项及PG8项通过。
- Web npm build及mw-docker Web镜像重建通过，已有大chunk提示保留；读取恢复、parent guard、shared read、原生结果、Swing及绘图范围回归通过。
- [最终编译产品](evidence/production-pending-compiled-product-20261013.json)、[Docker产品](evidence/production-pending-docker-browser-20261013.json)、[Docker界面](evidence/production-pending-docker-ui-20261013.json) 验收通过。
- [Docker三路径性能](evidence/production-pending-docker-performance-20261013.json) 保存两轮原始测量的脱敏数值；新通道各1/4/8为0空数据帧/0reset。旧通道较早一轮11/8/8空数据帧、更热缓存轮为0，不能合并为固定收益比例。
- firstValidDataMs是原生结果可用时间，nextAnimationFramesMs是后续动画帧；均不等同pixel首次绘制。缓存导航p50/p95是20次双动画帧等待，不能标为真实分页完成时间。
- HTTP测量含history-loads/reserve/data，CDP任务/脚本/布局/样式含parent UI，heap为浏览器估计。较早一轮遗漏history-load/reserve的HTTP统计，其0代表不可用；后轮已纠正采集。较早两轮各lane/count单次、后端缓存驻留，不能宣称完整冷/热阶段D达标。
- [API分段重复测量](evidence/production-pending-docker-performance-profiled-20261013.json) 每lane/count三次，共27样本，新路径9样本全部0空数据帧/0reset。仅验收API启动wrapper提供SQL driver/roundtrip、Python计算wall/thread CPU、backend response-start耗时及API进程高水位RSS；不含SQL文本/身份/参数。1/4/8为相同period5实例，共享后不代表1/4/8不同算法成本。第3轮部分与受控host正确性浏览器重叠，数字包含本机争用。
- [实际画布与分页测量](evidence/production-pending-docker-pixel-pagination-20261013.json)：将曲线临时染magenta，在大绘图canvas中检测真实像素；三路径1/4/8均取得首次pixel时间。左补页等待主图扩展及全部指标起点对齐；每样本仅1–2页。观察含缓存往返和实际分页，新通道各样本0空数据帧/0reset，旧通道1/4/8为19/32/13空数据帧。扫描增加CPU/heap，且部分与短受控回归/probe重叠，不和未扫描轮作速度/内存比较；不是冷缓存达标声明。
- [进程重启测量](evidence/production-pending-docker-process-cold-20261013.json)：仅本task停止API/workers、重启PG，再原Compose启动全部服务；新通道8实例0空白/0reset。OS页缓存与持久合成数据保留，图表初始化先读主图，不能当完整冷DB端到端。
- [不同算法并发](evidence/production-pending-docker-mixed-performance-20261013.json)：4种LWMA/EMA/SMA/BBANDS及8种再加RSI/MACD/ATR/STOCH，旧/新Python分别单样本，真实补页。新通道0空白/0reset；指标HTTP读取数量与计算规模见原值。新通道8算法补页约998ms，不能宣称全面更快；没有对应混合内置和完整冷/热比较。
- [完整固定输入矩阵](evidence/production-pending-docker-full-matrix-20261013.json)：三路径优化前27个浏览器样本/135次真正补页，最终新通道9样本/45次补页，共36样本/180次补页。每lane/count首样本重启API/native-worker及PG进程，另两样本进程驻留，均新浏览器；OS页缓存保留，bootstrap先读主图。12,000根M5窗口由合成数据初始化，固定前后台来源维护曾修订少量柱；矩阵使用固定后的实际缓存内容，测量前后SHA256相同，并非最初seed哈希或纯净供源证据。专用wrapper固定fixture时钟并禁止合成symbol的真实供源cache miss；monotonic与CPU计时正常。每格15页统计样本仍有限，首pixel使用真实canvas扫描，heap含parent UI，API RSS为累计高水位。

| 路径 | 实例数 | 补页p50/p95（ms） | 浏览器CDP heap峰值（MB，十进制） | 每样本已完成指标HTTP次数 | 补页空白帧总数 |
| --- | ---: | ---: | ---: | --- | ---: |
| 内置WMA | 1 | 194/298 | 66.6 | 0/0/0 | 0 |
| 内置WMA | 4 | 229/276 | 74.2 | 0/0/0 | 0 |
| 内置WMA | 8 | 241/306 | 98.1 | 0/0/0 | 0 |
| 旧Python | 1 | 623/1109 | 69.2 | 9/8/8 | 373 |
| 旧Python | 4 | 605/1186 | 79.8 | 9/8/8 | 382 |
| 旧Python | 8 | 730/1087 | 102.2 | 9/8/8 | 360 |
| 新Python优化前 | 1 | 1863/2782 | 108.9 | 17/18/17 | 0 |
| 新Python优化前 | 4 | 2208/2801 | 163.0 | 17/17/18 | 0 |
| 新Python优化前 | 8 | 2176/3032 | 224.2 | 18/19/18 | 0 |
| 新Python仅prepend优化 | 1 | 1027/1463 | 97.4 | 6/7/7 | 0 |
| 新Python仅prepend优化 | 4 | 1177/1478 | 127.0 | 6/6/6 | 0 |
| 新Python仅prepend优化 | 8 | 1161/1585 | 193.6 | 6/6/7 | 0 |

所有新通道样本0空白/0整图reset；旧Python缓存往返0空白，空白来自实际补页。相同LWMA参数共享不代表不同算法成本；页大小/扩展柱数有所不同，原始数字已保留。这里HTTP计数仅requestfinished，未包含取消或未结束请求，不能作为全部已发起读取的计数。优化降低已完成重复读取和响应体，但这轮新通道仍比旧Python慢、heap更高；内部更新稳定性收益已验证，接近内置的端到端效率尚未达到。

- [prepend优化后不同算法回归](evidence/production-pending-docker-optimized-mixed-20261013.json)：4/8算法各单样本及5页，新通道均0空白/0reset，分页p50/p95为1233/1380ms及1918/2096ms，CDP heap峰值146.3/243.6MB；各6次已完成的指标读取。仅最终新路径驻留进程回归，不能与先前不同窗口/页数的998ms样本直接比较。

- [事件/在途读取诊断](evidence/production-pending-event-diagnosis-20261013.json) 保留改动依据和中间版本一次 `Value is null` pageerror；当时未捕获堆栈，随后相同4实例三次定向复测未重现，不能宣称已定位该异常根因。
- [最终事件与在途复用测量](evidence/production-pending-docker-event-performance-20261013.json)：相同固定窗口/哈希，1/4/8各3次、每次5页，共9样本/45页，全部0空白/0reset。进程驻留，未重新重启API/PG，不能与先前进程重启矩阵混称同冷缓存实验。无其他浏览器负载；首个新代码编译验证在首样本前已完成。主图扩展量仍逐样本报告。

| 最终新Python实例数 | 分页p50/p95（ms，15页） | CDP heap峰值（MB，十进制） | 发起指标HTTP次数（三样本） | 失败/取消请求数（三样本） |
| ---: | ---: | ---: | --- | --- |
| 1 | 937/1406 | 89.9 | 6/7/6 | 0/1/0 |
| 4 | 784/1784 | 130.9 | 6/7/6 | 0/0/0 |
| 8 | 1028/2606 | 184.0 | 7/7/7 | 1/1/1 |

每样本指标未结束请求数为0。中间事件版本曾发起11–13次并取消3–6次，说明只数完成请求会遗漏代次切换成本。最终复用显著减少这一模式的重复派发，但8实例p95仍有2.6秒样本，heap仍高于旧通道，未达到与内置相近的端到端效率。最终9样本stack捕获脚本未收到新的pageerror；中间异常仍列为未解释风险。

- [最终不同算法回归](evidence/production-pending-docker-event-mixed-20261013.json)：4/8种算法各单样本/5页；0空白/0reset，补页p50/p95分别1188/1451ms及1901/2181ms，heap峰值138.7/223.9MB；均发起7次指标HTTP，1次失败/取消、无未结束指标请求。未进行这两种混合算法的完整内置/旧/新或进程重启对照。

- [最终同条件三路径矩阵](evidence/production-pending-docker-final-matrix-20261013.json)：最终事件/ready/版本在途复用代码下，内置WMA、旧Python、新Python的1/4/8实例各3次，共27个浏览器样本/135次真实补页；全程没有其他浏览器验收或构建。每格首样本在API/native-worker及PG进程重启后，另两次进程驻留；均先bootstrap主图，OS页缓存保留。测量前后12,000根固定窗口内容hash一致。以下单独报告重启后5页与驻留10页；样本有限，不能由进程重启声称严格冷DB端到端。

| 路径 | 实例数 | 重启后p50/p95（ms，5页） | 驻留p50/p95（ms，10页） | CDP heap峰值（MB） | 发起指标HTTP（三样本） | 补页空白帧 |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| 内置WMA | 1 | 260/300 | 221/319 | 68.7 | 0/0/0 | 0 |
| 内置WMA | 4 | 290/370 | 374/468 | 82.2 | 0/0/0 | 0 |
| 内置WMA | 8 | 330/512 | 439/610 | 84.8 | 0/0/0 | 0 |
| 旧Python | 1 | 1939/3201 | 1885/2787 | 75.0 | 10/8/9 | 799 |
| 旧Python | 4 | 877/1227 | 869/2080 | 80.3 | 8/7/10 | 493 |
| 旧Python | 8 | 828/1832 | 1171/1795 | 111.3 | 8/9/10 | 528 |
| 最终新Python | 1 | 852/982 | 770/1167 | 91.5 | 6/6/8 | 0 |
| 最终新Python | 4 | 922/1026 | 933/1312 | 137.7 | 6/8/6 | 0 |
| 最终新Python | 8 | 993/1146 | 1043/1324 | 166.0 | 6/6/7 | 0 |

新通道9样本全部0空白/0整图reset；指标失败/取消次数分别为1实例0/0/2、4实例0/2/0、8实例0/0/1，未结束指标请求全部为0。指标请求发起、完成、失败/取消与未结束分别保存，不再将requestfinished计数当成全部发起。旧Python4实例原采样进程在结果写入后因浏览器关闭时仍触发网络capture失败；修正capture边界并排空异步任务后，重启进程重跑该格，表与证据只含成功重跑。该采样错误不计为产品异常。

首个实际曲线pixel、真实扩展柱数、backend/SQL driver/计算wall与thread CPU、CDP renderer耗时、响应体和API RSS均保留每样本原值；SQL/backend并发累加不能当成互斥耗时分解，renderer累计耗时也不是纯paint耗时。最终新通道比内置慢且heap更高；与旧Python的速度比较因实例数、页大小及进程状态不同而变化，不能承诺全面更快或相同端到端效率。阶段D规定的比较报告已形成；其有限样本、缓存及算法边界仍保留。

- [原生异常有界复现](evidence/production-pending-native-null-reproduction-20261013.json)：当前Docker产品与私有重放的event+ready中间host各8次/40页，共16次/80页；未捕获pageerror或未处理异常断点。重放替换仅私有浏览器host响应，后端仍真实HTTP/PG/Python；不是正式部署该中间版本。Debugger会改变时序，数字不作为性能基线。没有复现原一次Value is null，根因仍未定位；不反复无界运行。

- profiler仅scripts/production_pending_profile.py在隔离API的私有profile.override.yaml只读挂载，task/数据库/无凭据guard；正常API入口不导入。测量结束以原Compose force-recreate api/native-history-worker恢复正式入口，再启动全部worker。未修改生产镜像/部署配置。

- [构建后Docker诊断](evidence/production-pending-docker-diagnostics-20261013.json)：编码身份曾在api-read-recovery.cjs跑红，现按URL解码后匹配；畸形编码保守隐藏，大写UUID同样隐藏。真实构建页面通过replay读取一个不存在的合成版本，验证路径隐藏身份/查询、HTTP404不重试、诊断副本不可改写内部记录；无响应替换/数据写入。正常Docker产品回归随后通过。真实用户Load failed仍缺现场请求证据。

## Ubuntu实例与可重复入口

实际主机：Ubuntu `quant-server`，本机 `/var/run/docker.sock`，通过 `sg docker -c` 使用已有docker组；没有远端转发。Task/Compose project均为 `mw-pending-fixes-20261013`，专用BuildKit为market-watch-ubuntu。

- Web：<http://127.0.0.1:20271/>；chart origin：<http://127.0.0.1:20272/>。
- Compose：deploy/ubuntu/production-ux.acceptance.yaml；PG数据库production_ux_acceptance；卷mw-pending-fixes-20261013_pg-data；网络mw-pending-fixes-20261013_default。
- 三镜像：market-watch-api:pending-fixes-20261013、market-watch-web:pending-fixes-20261013、market-watch-chart-origin:pending-fixes-20261013。通过mw-docker构建，task/project、acceptance用途均显式登记。
- 私有env及登录材料：/tmp/mw-pending-fixes-20261013-private/，0600/0700。许可库、截图、完整布局不提交。Yahoo/通知投递/OANDA stream关闭；图表合成缓存只作验收，不是来源或覆盖证据。

在本工作区执行；登录材料从私有目录读取，不输出：

```bash
sg docker -c 'mw-docker build --repo . --component api --tag market-watch-api:pending-fixes-20261013 --task mw-pending-fixes-20261013 --project mw-pending-fixes-20261013 --purpose acceptance'
sg docker -c 'mw-docker build --repo . --component chart --tag market-watch-chart-origin:pending-fixes-20261013 --task mw-pending-fixes-20261013 --project mw-pending-fixes-20261013 --purpose acceptance'
sg docker -c 'mw-docker build --repo . --component web --tag market-watch-web:pending-fixes-20261013 --task mw-pending-fixes-20261013 --project mw-pending-fixes-20261013 --purpose acceptance --build-arg VITE_ADVANCED_CHART_ORIGIN=http://127.0.0.1:20272'
sg docker -c 'docker compose --env-file /tmp/mw-pending-fixes-20261013-private/acceptance.env -p mw-pending-fixes-20261013 -f deploy/ubuntu/production-ux.acceptance.yaml up -d --no-build'
sg docker -c 'docker compose --env-file /tmp/mw-pending-fixes-20261013-private/acceptance.env -p mw-pending-fixes-20261013 -f deploy/ubuntu/production-ux.acceptance.yaml stop'
```

已有合成初始化走scripts/production_ux_fixture.py的seed/native-seed/fixed-seed/composite-seed及真实导入/发布，未捏造ready。scripts/production_pending_fixture.py仅本task/pg/数据库、无供源凭据与投递配置可用，暂停本task history-worker并确认lease结束后，通过真实claim/commit的明确合成empty_success完成接续查询；不新增价格或确认覆盖。执行时用私有fixture.override.yaml挂载及task标记，结束恢复worker；不要对已有实例重复fixed-seed生成无关版本。

浏览器执行：LD_LIBRARY_PATH=/tmp/mw-volume-browser-libs/usr/lib/x86_64-linux-gnu:/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu，加node web/tests/production-pending-{docker,ui,performance}.browser.cjs。最终受控编译host置于/tmp/mw-pending-built-assets-20261013，通过MW_PENDING_HOST_ASSETS运行native-indicator-product.browser.cjs，不在仓库生成许可资源。

任务仍进行中，保留隔离资源；不finish/retire。验收真正结束后按AGENTS及deploy/ubuntu/README.md精确预览、数据库归档与实际恢复校验后退役，禁止全局prune。本分支无提交、PR或生产发布；生产发布/切换/删除需明确授权。

早期短计时复现：在原Compose参数后加 `-f /tmp/mw-pending-fixes-20261013-private/profile.override.yaml up -d --no-build --no-deps --force-recreate api`，运行performance浏览器并设置MW_PENDING_PERFORMANCE_REPETITIONS=3及私有MW_PENDING_PERFORMANCE_EVIDENCE输出；结束去掉override执行相同force-recreate api。数据库/操作系统缓存未强制清空。

本轮最终验证：编译产品尾部追加/更正/回撤连续两次通过，原生结果回归通过；最终chart镜像重建并force-recreate后Docker产品及原生模板/响应式UI通过。API已恢复原uvicorn启动，无profile挂载；任务仍active。最终性能pixel分页测量允许并单独计数“已取消旧图表的历史加载”这一旧代次正常取消，其他pageerror仍失败。

[最后环境核对](evidence/production-pending-final-environment-20261013.json)（最终矩阵结束后）：API与全部3个worker、PG、web/chart服务均恢复运行；API健康，正式uvicorn入口且无profiling挂载。新chart镜像为最终事件/ready检查/按版本在途复用版本，构建输出配置SHA256为ba43207cee705e46636309b6d224560383df678c4d67683fcdfefd2ca9a33fe8，实际容器Image ID为sha256:a1098f9fcaa5c321f4b78b80511c6dc103b381caded26b37a09a4941f0c9971a，通过mw-docker重建和force-recreate，非docker cp覆盖。最终三路径矩阵结束、输入hash核对并恢复环境后，新增编码身份脱敏Web镜像通过mw-docker重建与force-recreate；构建后诊断和Docker真实产品回归通过（Python数值、五图Swing明暗/隐藏/强度、保存刷新）；API readyz 200。未提交/推送/PR；可审查补丁和脱敏证据留在本分支。


最终固定输入矩阵的复现条件：先用 `scripts/production_pending_performance_seed.py` 在本task专用seed容器准备12,000根合成M5并记录内容hash，暂停本task history/chart-history workers。在私有Compose overlay给API/native-history-worker只读挂载 `scripts/production_pending_profile.py`，分别使用 `python /acceptance/production_pending_profile.py` 和相同入口加 `--native-worker`；设置 `MW_PENDING_ACCEPTANCE_TASK=mw-pending-fixes-20261013`、`MW_PENDING_PIN_SYNTHETIC_SOURCE=true`、`MW_PENDING_SYNTHETIC_CLOCK=1791837599000`。fixture end为1791837600000；不要将这组固定时间用于其他来源或正常验收服务。私有env不进入仓库。

每lane/count cell停止本task API/native-history-worker、重启本taskPG，再启动overlay API/native-history-worker；浏览器使用以下环境变量运行performance脚本：

```bash
MW_PENDING_SYNTHETIC_CLOCK=1791837599000 \
MW_PENDING_PERFORMANCE_LANES=new-python \
MW_PENDING_PERFORMANCE_COUNTS=8 \
MW_PENDING_PERFORMANCE_REPETITIONS=3 \
MW_PENDING_PERFORMANCE_RESTARTED=true \
MW_PENDING_PERFORMANCE_PIXEL=true \
MW_PENDING_PERFORMANCE_PAGINATION=true \
MW_PENDING_PERFORMANCE_PAGES=5 \
MW_PENDING_PERFORMANCE_SOURCE_BARS=12000 \
MW_PENDING_PERFORMANCE_EVIDENCE=/tmp/mw-pending-fixes-20261013-private/repeat-matrix.json \
LD_LIBRARY_PATH=/tmp/mw-volume-browser-libs/usr/lib/x86_64-linux-gnu:/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu \
node web/tests/production-pending-performance.browser.cjs
```

分别设置lanes为native/old-python/new-python，counts为1/4/8。prepend优化后不同算法回归加 `MW_PENDING_PERFORMANCE_MIXED=true`，单次counts为4,8。重新seed的内容hash可能随时间/fixture输入改变，不能与本报告直接混称同输入。测量结束先用seed脚本 `--check` 且 `MW_PENDING_SOURCE_END=1791837600000`核对hash，再撤overlay并用原Compose force-recreate API/native worker、up全部服务，确认无profile挂载及正式入口；本轮已完成这些恢复与最终真实Docker产品回归。
