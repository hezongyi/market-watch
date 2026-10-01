# 双系列与平台取数验收审计

2026-10-02。依据 `chart-dual-dataset-plan.md`、`provider-fetch-service-proposal.md`、`provider-fetch-service-review.md` 及用户后续授权逐项核对。按用户2026-10-02修订的性能门槛完成本地验收；不代表生产发布。

## 证据范围

当前为1.3.0同提交镜像集：构建提交 `a71439b34964fea9cf825d7a6e2d412bac071fc5`，精确镜像ID与回退见 `../deploy/releases/v1.3.0-local.json`。候选构建与最终镜像内容相同，不重写原有镜像构建标签。运行核验为 `verification/dual-container/candidate.1-runtime-images.json`；最后六样本实际浏览器复核为 `verification/provider-cache/first-screen-1.3.0-candidate.1-six.json`。

303项完整PG16后端、35项前端VM、五分钟八图、内部预警/演练、画线/手机、日期同步、真实重启及发布失败恢复均有下表证据。镜像API代码/迁移与这些最新测试的源码逐字节一致，web18项/chart2943项静态文件逐字节一致，详见 `candidate-api-content-equivalence.json` / `candidate-static-content-equivalence.json`（verification/dual-container目录）。较早startup-metadata的SSE/修订/历史锚点证据通过 `publication-cadence-source-impact.json` 的安装源码diff和手工审计关联，相关处理代码未修改；修订及历史读取无需重复网络验收。

用户最新指令：“不再以每次冷首屏都在3s为目标，因为代理等原因，大多数达到3s即可。建议不再虚耗时间，可以收口。”这只修订D04的网络性能门槛，不取消功能、完整缓存小于1秒、资源隔离、秘密排除、使用及回滚要求。最新18项和部署后6项各全部低于3秒；较早18项矩阵17/18低于3秒，原始passed=false及3769ms慢样本保留。完全冷TLS和复用响应头长尾也保留，不以最新全绿样本承诺每次或任意网络环境耗时。

## 双系列方案逐项门槛

| 编号 | 要求（对应方案第8节及正文） | 已检查证据/源码 | 当前判定与欠缺 |
| --- | --- | --- | --- |
| D01 | 新搜索默认平台；旧工作区自建；不后台替换系列 | `test_provider_workspace`两项；`advanced-series.cjs`；series身份贯穿bridge | 通过；303后端/35VM及源码—镜像—交付清单关联已核对。 |
| D02 | 未维护品种平台日内/D1/W1/MN可读，不建自建任务 | 36项 `provider-series/native-periods-live.json`；provider API独立模型；缓存订阅驱动核对managed plans/bars/jobs | 旧实测通过；当前镜像未维护OANDA完整预热已通过 |
| D03 | 平台翻页/日期跳转/快速切换/八图竞争；错误非边界 | 后端完整分页、exclusive to、错误回归；历史锚点预热；rapid-switch和五分钟八图结果 | 通过；八图/快速切及历史锚点实测、后端完整分页回归，缓存/锚点相关代码未改，已关联最终镜像。 |
| D04 | OANDA/Binance九周期大多数冷首屏<3s；完整数据库缓存需求显示<1s | 最新18项1385–2597ms、缓存199–490ms，均无新TLS；已有3769ms等失败；最新API复用等待响应头4574ms | 通过用户修订门槛；九周期18/18及部署后6/6低于3秒，PG缓存199–490ms/204–321ms；旧超时/慢样本保留，不承诺每次达标。 |
| D05 | 拒绝维护不建任务、不显示未准备段 | `test_viewing_unmaintained_never_creates_plan_or_task`；旧managed-browser；当前NZD_CAD有界发布复验已通过（CAD_CHF原失败保留） | 后端通过；新候选UI完整通过 |
| D06 | 只提交起点，提交即持续维护，不自动前移 | managed API/store；`test_api_start_only_maintenance_and_published_read_does_not_download`；browser单输入、start不变 | 后端/旧UI通过；新候选UI通过 |
| D07 | 关闭/退出/历史完成不停止维护；重启补缺口 | persisted plan realtime_enabled；realtime worker；旧recovery-live；最新八图维护水位推进 | 通过；旧真实断线修复、最新八图维护水位和发布worker重启组合核验；持久实时/修复逻辑回归及最终源码关联已核对。 |
| D08 | 就绪水位推进，不追逐now；已发布图自动实时更新 | `session_boundary_freezes_historical_expansion_but_latest_advances`；固定initialization_end；八图采样 | 回归及当前八图通过 |
| D09 | 阶段失败/重启不发布半成品；重试只补缺口 | aggregation rollback、publication transaction测试；`publication-recovery-publication-cadence.json`实际故障和容器重启 | 最新镜像通过：写入后聚合失败旧快照不变、重启续做无重复、发布事务回滚完整 |
| D10 | 倒序分段，各周期三屏/指标先开放，不等全任务 | managed_dataset/worker；`period_opens_before_full_target_when_three_screens_complete`；managed-browser | 回归/旧真实通过；新候选UI通过 |
| D11 | 实际plot width/spacing；3N完整bar，形成中不计，不放大柱宽 | dataset阈值逻辑、forming-prefix测试；真实948/6=474；八图spacing6 | 回归/实际几何通过 |
| D12 | 已补到起点的短目标可看；无完整bar/指标不足不伪造或越权补 | completed-short-target、approved-empty-session、indicator历史校验 | 通过；短目标、无完整bar/指标不足回归通过；空图及原生可控范围见D20。 |
| D13 | 跨段高周期不完整不输出，已就绪M5不等周月 | staged publication及周月聚合；short-target测试；旧managed-browser initialized=false | 回归/旧实测通过；新候选UI通过 |
| D14 | 历史边界渐进；失败取消不损害旧范围/实时/柱宽位置 | cancel/resume、staging revision、publication rollback测试；managed-session左界冻结；新修订视区保持 | 核心回归通过；新候选UI通过 |
| D15 | NY DST、黄金休市、起点截断周月/形成中、无成交与真实边界 | calendar_profile、history_plan DST双季、provider_chart标签、managed prefix/截断、legacy-boundary-live | 对应后端测试与旧真实边界通过 |
| D16 | 缓存/订阅/Python/工作区/画线永久系列隔离，无复制入口 | series namespace、provider API422；VM身份测试；managed drawing切换；`roundtrip-publication-cadence.json` | 最新候选跨系列画线及跨工作区隔离、保存重开、手机临时修改不写桌面工作区均通过 |
| D17 | 预警/演练只用自建；平台负载下维护延迟可接受 | `managed-compatibility-publication-cadence.json`真实历史预警5163ms/演练OHLC、平台422；最新八图managed最大lag91232ms | 最新镜像通过；预警样本在八图之后，不声称通知网络延迟或同步负载成绩；未发送通知 |
| D18 | 历史饱和时实时/近期修复优先获额度/DB/聚合资源 | market_resources独立额度、DBpool测试、aggregation backpressure、recovery-live、八图 | 单元/集成及实际负载通过；没有扩池 |
| D19 | 断线修复积压让位，恢复继续且不重复 | crash lease、recent repairs split old gap、recovery-live、publication-recovery-live | 通过；实际缺口修复/历史让位及最新发布失败重启无重复，相关核心回归与最终源码关联已核对。 |
| D20 | 绘图区无应用进度/无数据占位；原生可控范围单独核实 | index只有chart/error；bridge无应用进度文字；`blank-plot-product.json/png`及`blank-plot-transient-publication-cadence.json/png`真实未维护USD_SGD拒绝维护，无测试路由/翻译注入 | 空图无K线/占位文案；初始化至拒绝后23次文本采样无Loading/No data。产品已有公开custom_translate_function词条处理，未改vendor/增加新策略；100ms采样不证明每一帧，也不覆盖所有加载场景 |
| D21 | 本机集成/版本/回滚/使用文档全部齐全 | 使用/本机回退文档已写；schema n15；包更新1.3.0本地候选，正在建立源码快照/同提交镜像 | 通过本地交付；包1.3.0、附注标签v1.3.0、源码/逐服务镜像清单及使用/回退文档齐全；不合并main、不push、不操作生产。 |

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
| P10 | 最新桶刷新短尾部、≤15s允许年龄，不用last价合成高周期 | stale_latest_refresh、provider native granularity；realtime SSE driver | 通过；两源普通/Python回调实测，尾部/事件处理代码未改，最终镜像关联完成。 |
| P11 | 当前周期先基本窗口，九周期两轮1000/4000及用户顺序 | activate PERIODS与fixed targets测试；warm_step每次单页；prewarm证据 | 通过；OANDA九周期24570ms完成，Binance九周期38660ms完成；最终镜像相关预热代码未改 |
| P12 | 历史同锚点/左右实际根数，右止now、左真边界；不自然时间冒充根数 | right_buffer市场休市回归；historical-prewarm-paced-cold实际20目标/共享锚点 | 通过；最新后端回归及历史20目标/固定锚点实测，缓存目标/缓冲代码未改，最终镜像关联完成。 |
| P13 | 有限目标不递归；活动10min/订阅60s、关闭回收，不永久维护 | finite_two_rounds、renew/unsubscribe scoped、service expires/cleanup；driver关闭subscriptions0 | 当前OANDA关闭回收通过 |
| P14 | 每会话目标上限可配置，回收不影响其他会话/订阅 | 原固定16已改provider_interest_limit；新真实activate回归先红后绿 | 配置已部署、新全量303项通过；最新五分钟八图通过 |
| P15 | 历史让位前台/近期修复；多品种/会话批次公平、失败周期退避不堵后续 | warm_step busy/backoff/next_at；pacing和shared-goals测试；market_resources | 核心回归通过；8图当前负载通过 |
| P16 | 持久缓存容量/保留，清理与覆盖原子，活跃目标不能被删 | cleanup whole dataset原子删除；保护focus/目标；cache_max_bars/cache_days | 回归通过；实际大容量清理负载未证明，按当前门槛不声称百万根负载成绩 |
| P17 | 订阅从历史cursor衔接，重连补接、顺序推送；缺口/旧修订走公开reset | provider_service.events/registration；gap/python discontinuity测试；`restart-publication-cadence.json`及revision-startup-metadata | 通过；最新重启恢复16679ms/cache57ms；旧修订reload3764ms、视区保持、fixture恢复，源码事件处理未改 |
| P18 | 新增更早预热不重载；真实旧bar改动与重复观测区别 | unchanged_reobservation、old_revision；revision driver extra_history_no_reset | 当前真实修订通过 |
| P19 | 同一订阅传输SSE；前端不自己定时取API | providerSubscriptions、API event stream；cache-service16秒无data请求 | 通过；两源普通/Python及16秒无前端data轮询实测，SSE/前端代码未改，最终镜像关联完成。 |
| P20 | Binance默认代理；HTTP池复用/失败恢复不能扩大总并发 | effective_binance_proxy；chart/realtime/history池2/1/1；transport回归；48次协议证据 | 通过；默认代理、分lane池和失败恢复回归/实测，不扩大并发；外部TLS/响应长尾为已记录限制，按用户修订门槛不再阻塞交付。 |
| P21 | 真实缓存/HTTP各冷暖分开，计量各层，留失败和8图/预警负载 | first-screen public trace、timings_ms、48协议、16API、CPU、八图/alert evidence | 通过；分层及冷暖条件、失败/长尾和八图负载全部留证，性能按用户最新D04门槛验收。 |
| P22 | 可配置默认值、短事务同步落库；不新增预测/异步写入必需项 | config/env.example；1000/4000、15s、8s、600/60s、16兴趣、7天/百万根 | 参数已部署且回归通过；方向预测/切回宽限/异步落库不纳入首版必需 |

## 最终判定和实际限制

43项门槛均已按各自范围核对；证明及文件哈希汇总见 `verification/dual-container/final-local-acceptance.json`，不把旧候选passed直接当作新镜像的全量证明。每项测试范围及限制保留在上表。

- 网络长尾仍可能产生超过3秒甚至超时的请求；用户接受大多数低于3秒，不再以消除代理/提供商长尾为交付前提。真实失败仍走错误，不伪装历史边界。
- 空图公开配置与100ms采样证明已测试的加载/拒绝场景，不声称逐帧或所有vendor状态全覆盖；未修改vendor/读取私有模型。
- 缓存清理策略及保护活跃目标经回归证明，不声明百万根容量压测成绩；这是配置容量，不是新增吞吐承诺。
- 内部预警用真实已观察历史交叉验证worker派发，未发送通知；不把它当作实际通知网络延迟。八图负载下持续维护水位有独立实测。
- 仅本机交付，来源回环HTTPS；未来生产部署须另行配置域名、构建主站并遵循备份/迁移流程。
