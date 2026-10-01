# 双系列与平台取数验收审计

2026-10-02。依据 `chart-dual-dataset-plan.md`、`provider-fetch-service-proposal.md`、`provider-fetch-service-review.md` 及用户后续授权逐项核对。整体未完成；这份记录不以已经做出的功能缩小目标。

## 证据范围

当前API/三个worker已部署 `provider-publication-cadence-20261002`（a087d57ca79f66d31db2b6e130fd9547ddf0700e5b4b881e7517c656a69c362b）；web/chart仍为startup-metadata候选，精确ID在 `verification/dual-container/publication-cadence-runtime-images.txt`。303项完整PG16后端通过，零跳过。新API涉及兴趣配置/Settings脱敏/有界发布和worker休眠；实际浏览器结果按镜像区分，startup-metadata证据不自动证明新镜像已全量验收。

最新全量后端结果为 `verification/dual-container/backend-publication-cadence-pg16.txt`，前端35项VM为 `frontend-vm-bounded-publication.txt`。从bounded-publication到publication-cadence未修改前端产品源码。最新五分钟八图、内部预警/演练、画线保存重开/手机只读均通过，见同目录 `eight-chart-publication-cadence.json`、`managed-compatibility-publication-cadence.json`、`roundtrip-publication-cadence.json`。预警样本在八图结束后取得，不冒称同步负载成绩；最终源码/镜像提交关联仍需补齐。

`publication-cadence-source-impact.json` 比较安装alerts模块的逐文件SHA256与AST，并手工检查差异。最新镜像与工作树全部alerts模块逐字节一致；旧startup-metadata至最新候选的功能改动为配置repr/兴趣上限、managed有界发布及worker节奏，另外八模块仅导入排序/未用导入清理/同名reexport。平台缓存/分页/传输/订阅事件处理及前端未修改，因此此前明确镜像的SSE/修订/历史锚点验收可作影响审计证据；最终发布提交绑定仍未完成。

## 双系列方案逐项门槛

| 编号 | 要求（对应方案第8节及正文） | 已检查证据/源码 | 当前判定与欠缺 |
| --- | --- | --- | --- |
| D01 | 新搜索默认平台；旧工作区自建；不后台替换系列 | `test_provider_workspace`两项；`advanced-series.cjs`；series身份贯穿bridge | 最新后端303项与前端35项VM通过；最终源码镜像关联待绑定 |
| D02 | 未维护品种平台日内/D1/W1/MN可读，不建自建任务 | 36项 `provider-series/native-periods-live.json`；provider API独立模型；缓存订阅驱动核对managed plans/bars/jobs | 旧实测通过；当前镜像未维护OANDA完整预热已通过 |
| D03 | 平台翻页/日期跳转/快速切换/八图竞争；错误非边界 | 后端完整分页、exclusive to、错误回归；历史锚点预热；rapid-switch和五分钟八图结果 | 当前八图/快速切通过；历史跳转最终影响核对待完成 |
| D04 | 所有九周期平台冷首屏<3s，争取2s；完整缓存需求显示<1s | 最新18项1385–2597ms、缓存199–490ms，均无新TLS；已有3769ms等失败；最新API复用等待响应头4574ms | **未通过稳定性收口**，不能只挑选全绿矩阵；完全冷TLS与运行池分别计量 |
| D05 | 拒绝维护不建任务、不显示未准备段 | `test_viewing_unmaintained_never_creates_plan_or_task`；旧managed-browser；当前NZD_CAD有界发布复验已通过（CAD_CHF原失败保留） | 后端通过；新候选UI完整通过 |
| D06 | 只提交起点，提交即持续维护，不自动前移 | managed API/store；`test_api_start_only_maintenance_and_published_read_does_not_download`；browser单输入、start不变 | 后端/旧UI通过；新候选UI通过 |
| D07 | 关闭/退出/历史完成不停止维护；重启补缺口 | persisted plan realtime_enabled；realtime worker；旧recovery-live；最新八图维护水位推进 | 核心逻辑未改；最终故障/版本影响审计待补明确关联 |
| D08 | 就绪水位推进，不追逐now；已发布图自动实时更新 | `session_boundary_freezes_historical_expansion_but_latest_advances`；固定initialization_end；八图采样 | 回归及当前八图通过 |
| D09 | 阶段失败/重启不发布半成品；重试只补缺口 | aggregation rollback、publication transaction测试；`publication-recovery-publication-cadence.json`实际故障和容器重启 | 最新镜像通过：写入后聚合失败旧快照不变、重启续做无重复、发布事务回滚完整 |
| D10 | 倒序分段，各周期三屏/指标先开放，不等全任务 | managed_dataset/worker；`period_opens_before_full_target_when_three_screens_complete`；managed-browser | 回归/旧真实通过；新候选UI通过 |
| D11 | 实际plot width/spacing；3N完整bar，形成中不计，不放大柱宽 | dataset阈值逻辑、forming-prefix测试；真实948/6=474；八图spacing6 | 回归/实际几何通过 |
| D12 | 已补到起点的短目标可看；无完整bar/指标不足不伪造或越权补 | completed-short-target、approved-empty-session、indicator历史校验 | 后端通过；状态文案与空图限制单列D20 |
| D13 | 跨段高周期不完整不输出，已就绪M5不等周月 | staged publication及周月聚合；short-target测试；旧managed-browser initialized=false | 回归/旧实测通过；新候选UI通过 |
| D14 | 历史边界渐进；失败取消不损害旧范围/实时/柱宽位置 | cancel/resume、staging revision、publication rollback测试；managed-session左界冻结；新修订视区保持 | 核心回归通过；新候选UI通过 |
| D15 | NY DST、黄金休市、起点截断周月/形成中、无成交与真实边界 | calendar_profile、history_plan DST双季、provider_chart标签、managed prefix/截断、legacy-boundary-live | 对应后端测试与旧真实边界通过 |
| D16 | 缓存/订阅/Python/工作区/画线永久系列隔离，无复制入口 | series namespace、provider API422；VM身份测试；managed drawing切换；`roundtrip-publication-cadence.json` | 最新候选跨系列画线及跨工作区隔离、保存重开、手机临时修改不写桌面工作区均通过 |
| D17 | 预警/演练只用自建；平台负载下维护延迟可接受 | `managed-compatibility-publication-cadence.json`真实历史预警5163ms/演练OHLC、平台422；最新八图managed最大lag91232ms | 最新镜像通过；预警样本在八图之后，不声称通知网络延迟或同步负载成绩；未发送通知 |
| D18 | 历史饱和时实时/近期修复优先获额度/DB/聚合资源 | market_resources独立额度、DBpool测试、aggregation backpressure、recovery-live、八图 | 单元/集成及实际负载通过；没有扩池 |
| D19 | 断线修复积压让位，恢复继续且不重复 | crash lease、recent repairs split old gap、recovery-live、publication-recovery-live | 回归及真实故障通过；最终源码影响关联待补 |
| D20 | 绘图区无应用进度/无数据占位；原生可控范围单独核实 | index只有chart/error；bridge无应用进度文字；`blank-plot-product.json/png`及`blank-plot-transient-publication-cadence.json/png`真实未维护USD_SGD拒绝维护，无测试路由/翻译注入 | 空图无K线/占位文案；初始化至拒绝后23次文本采样无Loading/No data。产品已有公开custom_translate_function词条处理，未改vendor/增加新策略；100ms采样不证明每一帧，也不覆盖所有加载场景 |
| D21 | 本机集成/版本/回滚/使用文档全部齐全 | 使用/本机回退文档已写；schema n15；包更新1.3.0本地候选，正在建立源码快照/同提交镜像 | **交付未完成**；正式附注tag与最终manifest须全部门槛通过，不合并main、不push、不操作生产 |

## 平台取数模块契约

| 编号 | 要求 | 已检查证据/源码 | 当前判定与欠缺 |
| --- | --- | --- | --- |
| P01 | datafeed只桥接，移除×3/M1合成/业务分页/轮询预取 | bridge provider路径直接countBack、from/to/firstDataRequest；后端native_page；SSE转交 | 当前源码/实际请求通过；managed专用边界逻辑不混为平台策略 |
| P02 | API后单模块集中持久缓存/分页/调度，不新增Redis/微服务 | provider_cache/service/chart/transport四内部模块，现有API进程；m14/n15 | 当前运行架构通过 |
| P03 | OANDA≤4000/Binance≤1000单页；4500等需求完整满足 | native_page适配上限；large_count后端分页测试；native countBack无倍率断言 | 回归与真实矩阵通过；直接请求资源上限20000给明确错误 |
| P04 | 身份含source/env/真实品种/周期/报价/日历版本；唯一桶键 | cache.identity、ProviderBar主键；alias/shared slice回归 | 后端回归通过 |
| P05 | 覆盖不是min/max或count；缺口、休市、边界、错误区分 | range_gap、disjoint_preceding、failure no coverage、coverage tests；native_page coverage | 后端回归通过 |
| P06 | 前台按需立即满足；缓存命中只补尾部、不等待预热 | read缺口数量及fresh_tail；首屏请求limit=countBack；预热后台独立 | 当前真实矩阵和缓存显示通过 |
| P07 | 待启动缺口共享/前台提升，已发单页可共享但不等余下页 | dataset租约序列与重查；真实PG同范围只一次上游、短等待者独立deadline | PG回归通过；不以数字优先级声称可抢占HTTP |
| P08 | 排队/共享/HTTP等计入8s总截止；取消仅自身等待 | chart_api异步前台截止；request_slot剩余timeout；PG共享等待测试；cancelled_waiter | 回归通过，HTTP在途页可继续完成，错误不是noData |
| P09 | bar/覆盖同短事务；网络不占DB；代际栅栏/旧观测不能回退 | commit_page事务、claim/release fence；PG rollback/4000 commit；older_response complete测试 | PG及后端通过 |
| P10 | 最新桶刷新短尾部、≤15s允许年龄，不用last价合成高周期 | stale_latest_refresh、provider native granularity；realtime SSE driver | 两源startup-metadata普通/Python回调通过；安装源码差异已核对，事件处理/尾部获取不变，最终提交关联待补 |
| P11 | 当前周期先基本窗口，九周期两轮1000/4000及用户顺序 | activate PERIODS与fixed targets测试；warm_step每次单页；prewarm证据 | 当前OANDA九周期24570ms完成；Binance九周期38660ms完成 |
| P12 | 历史同锚点/左右实际根数，右止now、左真边界；不自然时间冒充根数 | right_buffer市场休市回归；historical-prewarm-paced-cold实际20目标/共享锚点 | 最新后端回归/旧57秒真实通过；源码影响已核对，缓存目标/锚点/缓冲代码未改，最终提交关联待补 |
| P13 | 有限目标不递归；活动10min/订阅60s、关闭回收，不永久维护 | finite_two_rounds、renew/unsubscribe scoped、service expires/cleanup；driver关闭subscriptions0 | 当前OANDA关闭回收通过 |
| P14 | 每会话目标上限可配置，回收不影响其他会话/订阅 | 原固定16已改provider_interest_limit；新真实activate回归先红后绿 | 配置已部署、新全量303项通过；最新五分钟八图通过 |
| P15 | 历史让位前台/近期修复；多品种/会话批次公平、失败周期退避不堵后续 | warm_step busy/backoff/next_at；pacing和shared-goals测试；market_resources | 核心回归通过；8图当前负载通过 |
| P16 | 持久缓存容量/保留，清理与覆盖原子，活跃目标不能被删 | cleanup whole dataset原子删除；保护focus/目标；cache_max_bars/cache_days | 回归通过；实际大容量清理负载未证明，按当前门槛不声称百万根负载成绩 |
| P17 | 订阅从历史cursor衔接，重连补接、顺序推送；缺口/旧修订走公开reset | provider_service.events/registration；gap/python discontinuity测试；`restart-publication-cadence.json`及revision-startup-metadata | 最新重启恢复16679ms/cache57ms；旧修订reload3764ms、视区保持、fixture恢复，源码事件处理未改 |
| P18 | 新增更早预热不重载；真实旧bar改动与重复观测区别 | unchanged_reobservation、old_revision；revision driver extra_history_no_reset | 当前真实修订通过 |
| P19 | 同一订阅传输SSE；前端不自己定时取API | providerSubscriptions、API event stream；cache-service16秒无data请求 | 两源startup-metadata普通/Python通过；源码影响已核对，SSE/前端代码未改，最终提交关联待补 |
| P20 | Binance默认代理；HTTP池复用/失败恢复不能扩大总并发 | effective_binance_proxy；chart/realtime/history池2/1/1；transport回归；48次协议证据 | 修复及回归通过，TLS/响应等待长尾仍未消失，不能宣称SLO已达标 |
| P21 | 真实缓存/HTTP各冷暖分开，计量各层，留失败和8图/预警负载 | first-screen public trace、timings_ms、48协议、16API、CPU、八图/alert evidence | 已实施计量；D04稳定性仍未通过 |
| P22 | 可配置默认值、短事务同步落库；不新增预测/异步写入必需项 | config/env.example；1000/4000、15s、8s、600/60s、16兴趣、7天/百万根 | 参数已部署且回归通过；方向预测/切回宽限/异步落库不纳入首版必需 |

## 当前下一步

最新五分钟八图、画线/手机只读、内部预警演练均通过；原生UI保存/比较和新格式同步由未变更的web/chart镜像上的bounded-publication复验覆盖。继续当前18周期冷PG/新文档完整缓存矩阵、最新worker发布故障恢复，并核对SSE/修订/历史锚点的修改影响。网络长尾与启动优化仍须继续处理，D04未满足时不得制作“验收全部通过”的交付结论或标记goal完成。版本/源码提交与镜像清单仍待最终绑定。
