# 七项实施完成性审查（2026-10-13）

审查对象：`fix/production-pending-20261013`，基线`1b3e4a2`。原要求来自[交接文档](/tmp/handoff-market-watch-production-issues-20261013.md)及[七项方案](production-feasible-solutions-20261013.md)。**用户本轮要求的「1 审查现有补丁、2 Ubuntu 实例验收」已完成；Load failed 本轮未复现，按最新决定暂不处理。** [本轮报告](production-pending-review-acceptance-20261013.md)记录补查范围 P2 修复、54 项后端测试、API 镜像重建及部署后浏览器结果。下表保留原七项的证据边界，未证实的网络根因、生产来源缺分钟及历史原生异常仍不能宣称已修复。正式发布不在本次实施授权内；未发布不等于开发未完成。

| 要求 | 实现与直接证据 | 判定及边界 |
| --- | --- | --- |
| 1 使用原生范围控件，九周期同一掩码，孔洞、混合多对象、原生撤销/取消/模板/复制/保存/窄屏 | `advanced-host/drawing-visibility.js`经原生范围属性及UndoWrapper改变同一mwMask；`web/tests/advanced-drawing-visibility.browser.cjs`驱动许可库，Docker UI证据验证原生模板保存/应用、506掩码和响应式 | 实施与功能通过；许可库资产私有，不提交 |
| 2 同一来源、账户、口径核实缺分钟，按证据选择路径 | [来源实测](evidence/source-recheck-20261013.json)：供应商20分钟窗口仅10观测，与生产确认存储一致，无本地漏观测；其余10分钟没有独立闭市证据 | 满足方案第三分支：保留unknown/stale；不能将实际告警恢复列为完成 |
| 2 固定修订有界补查、去重、预算、审计、只登记真实观测，旧修订与恢复基准 | `backend/alerts/composite_recheck.py`限制24h/滚动24h3次/1min；通过record/apply_minutes写入；11项来源复核与原告警回归总29通过，独立PG8通过；[端到端恢复证据](evidence/production-pending-source-alert-recovery-20261013.json)核验完整M5缺1分钟、补查、旧input_revision保留缺口、恢复基准及后续单次触发 | 正确实现补查/恢复路径；本轮新增 unknown 范围保护及补齐后幂等回归，四组后端 54 通过（含实际 PG 12 项），新 API 已部署；受控源＋真实 PG 不是生产供应商补齐或真实告警恢复证据 |
| 2 确定闭市及日历冲突不能由空响应推断，日历身份不可原地替换 | 未写闭市规则/改绑；`test_composite_series.py::test_only_applicable_segment_closure_certifies_a_missing_minute`覆盖观测/closure冲突；新接口空响应及错身份/窗口/超期均不生成价格/完整覆盖 | 保持既有边界；当前没有适用闭市证据，不能实施第二分支 |
| 3 Swing统计图内左下角；保留隐藏/强度、多实例、主题、折叠/最大化、保存刷新、顶部不占高 | Python目录及`swing-sr-display.js`迁移旧below_name/缺失值；[Docker产品证据](evidence/production-pending-docker-browser-20261013.json)真实五图/明暗/hidden/high5-low6/zero-top/刷新恢复 | 实施与功能通过 |
| 4 LWMA新建period5白色，保存参数/颜色优先 | 后端目录＋原生定义默认值；编译产品验证模板period7恢复，Docker新建实际Python值/白色及参数改变/刷新 | 实施与功能通过；没有迁移既有20周期输入 |
| 5 Python计算＋统一原生结果更新，不能前端重算或整图reset；生命周期/身份/修订/批次/零负空/撤下/回撤正确 | `native-indicator-results.js`唯一结果容器/时间映射私有适配，校验并使用native serialized update/完成事件；`patch-native-reserve.mjs`校验构建指纹且可撤回；原生结果与[最终编译产品](evidence/production-pending-compiled-product-20261013.json)直接验证追加、更正、删除、缩短/空、过期代次、模板和五图 | A/B/C已实现并验证；无双写、计算来源保持Python；受许可版本约束 |
| 5 主图范围、共享页、多输出、隐藏/删除需求释放、内存上限 | `indicator-coordinator.js`规范化共享范围及prepend/sourceFirst，onDataLoaded/ready触发，版本隔离的在途复用；`indicator-range-events.cjs`与`indicator-shared-read.cjs`曾在旧代码跑红；实例200k行/shared400k行/1m plot值/全体2m plot值/最多100页30秒的检查在产品入口 | 实现预算/清理与正确性；不以1/4/8同参数共享等同不同算法成本 |
| 5 D相同数据内置/旧Python/新通道，1/4/8，冷/热，首pixel、真实分页p50/p95、闪烁/reset、网络/SQL/计算CPU/renderer/内存 | [最终驻留测量](evidence/production-pending-docker-event-performance-20261013.json)、[不同算法](evidence/production-pending-docker-event-mixed-20261013.json)，[最终三路径矩阵](evidence/production-pending-docker-final-matrix-20261013.json)27浏览器样本/135实际补页，1/4/8各一次进程重启后及两次驻留 | 首pixel用canvas实际颜色扫描，分页必须扩展/对齐；最终三路径比较报告已形成，新通道9样本均0空白/0reset；heap高于旧通道，速度未全面领先。OS页缓存未清；bootstrap先读主图，不能宣称严格冷DB端到端。没有固定速度比例承诺 |
| 5 稳定性：中间一次Value is null | [有界复现](evidence/production-pending-native-null-reproduction-20261013.json)当前及中间host各8次/40页，Debugger暂停未处理异常，均未重现 | 一次异常根因未证实；本机未重现不能当已修复 |
| 6 右下角非模态/无抢焦点，去重/收起/窄屏，草稿恢复仍确认 | `chart-notices.js`与bridge，受控通知浏览器与Docker UI验证焦点、分组、关闭/上限/窄屏、草稿确认；最多3卡/30s合并/8s收起 | 实施与功能通过 |
| 6 主动取消/超时/HTTP/网络区分，安全读取有限重试/抖动/共享，body预算及100条脱敏诊断 | `web/src/api.ts`的readFetch及observedFetch；`api-read-recovery.cjs`直接驱动header/body故障、共享、取消/超时、鉴权/cooldown/写入不重试，已通过，新增编码OANDA/MWP/大写UUID/畸形编码回归先红后绿；[构建后Docker诊断](evidence/production-pending-docker-diagnostics-20261013.json)实际404/隐藏身份/副本隔离通过 | 恢复及诊断实现通过；本轮真实浏览器未复现 Load failed，按用户最新决定暂不处理，未声称根因已修；部署到生产以采样需要单独发布授权 |
| 7 列表按剩余容器排两列、560+360边界，长来源/操作不挤主列，标签/缩放/焦点/筛选/滚动保留 | `window.css`命名container 700px阈值，DetailPanel用920px边界，OpenChart说明移到tooltip；构建列表回归及[Docker UI](evidence/production-pending-docker-ui-20261013.json)双标签/长名/焦点/明暗1600-720px | 实施与功能通过 |
| 可审查产品代码、构建/适当回归、脱敏证据、Ubuntu独立Docker、实际地址/启停方法；不迁移到unraid | 本worktree产品代码及测试已完成审查，用户随后授权提交/PR；[实施报告](production-pending-implementation-20261013.md)含构建/启停，三镜像mw-docker task/project归属，本机20271/20272独立PG/volume/network；[环境恢复](evidence/production-pending-final-environment-20261013.json) | 已形成可审查补丁；保留资源供PR审阅；无生产发布/切换/删除 |

本轮补丁审查与 Ubuntu 验收已结束，最终同条件矩阵已收齐且恢复正常配置；API 新补查保护已部署，54 项测试及产品/UI 回归通过。Load failed 未复现，依用户决定暂不处理，后续出现真实请求证据时再定位。生产来源缺分钟只有新真实观测或独立适用闭市证据才能转分支。不能为完成目标而填价格、强制 ready、改固定告警修订、注册假闭市或把未复现异常归为已修复。
