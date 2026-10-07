# 三层行情最终实现验收核对

日期：2026-10-07。已验收实现提交`b0f2c78`，分支`feat/market-data-integration`；
该记录保留原实现验收基线；用户授权PR后与最新主线的兼容修改及复验见[PR主线兼容复验](pr-integration.md)。
依据[主方案](../../market-data-three-layer-plan.md)、
[桌面UI方案](../../market-data-center-ui-plan.md)和原开发交接，保留完整A–E实现范围。
最终结论：完整A–E实现及本次范围内的Ubuntu真实环境实现验收通过。
逐项证据见下表；长期质量观察按用户最新决定暂缓，不宣称其已经通过。

用户2026-10-07明确调整：快速迭代期间实现验收后暂缓长时间质量观察。
本次完成门槛为完整实现、真实Ubuntu功能/回归/并发/短时恢复；不启动48小时观察，
不为本次交付开发观察工具。长期稳定性、跨更多交易时段及持续存储增长留到固定版本后单独验证。
此前阶段报告的“未完成”是当时记录，以下按后续实际证据逐项核对，不能直接沿用旧结论。

## 主方案十项验收

| 项 | 已核对的范围与证据 |
| --- | --- |
| 1 来源隔离、共享日界、旧身份 | source-foundation.md、calendar-switch-stage.md、calendar-desktop-audit-stage.md；已检查test_source_registry_postgres的旧Bar/identity/manifest逐项不变、未知旧通道不收编，以及test_history_replay_migration旧快照保留；两来源12真实历史样本和派生共享原M1通过 |
| 2 失败保旧版、周期独立、unknown | managed-center-stage.md、history-catalog-quality-stage.md；test_history_maintenance_postgres的失败检查点/旧发布、取消保留M1和部分周期，test_data_center新M1不遮旧H4；真实M1/H4/D1发布、复查保持父清单，空响应不认闭市 |
| 3 首次并发、纯管理 | composite-definition-stage.md、composite-center-stage.md、search-pagination-stage.md；实际PG8并发首次请求只建1定义/修订/准备任务；实际管理/66页搜索/MCP读取不增加组合或需求；最终桌面无管理写入 |
| 4 日历、周月、量、缺口、修订 | calendar-desktop-audit-stage.md、cross-source-stage.md、composite-inputs-stage.md；12真实历史+12独立schema组合及24已发布版本HTTP复核；NY17春秋UTC21/22、167/169小时周与跨月独立oracle；test_composite_series的两侧适用闭市证据、unknown与跨源volume为空，test_composite_inputs保留旧价格修订 |
| 5 固定基线、显式修订、旧审计 | calendar-switch-stage.md、composite-revisions-stage.md；真实两品种NY17→UTC0→NY17、原M1不变和旧Watch/钉住图表不转移；PG父指针并发检查、准备/九周期/指标完成后原子启用；固定旧输入可再读 |
| 6 持久需求、闲置、重启恢复 | composite-watches-stage.md、concurrency-recovery-stage.md；浏览器关闭后持久策略继续，准确pricing-worker停120秒后恢复84.831秒；全部验收规则取消，50.180秒后无需求/owner、来源inactive，最新运行仍为0 |
| 7 独立就绪、依赖洞、鉴权/限流、世代 | test_composite_alerts检查确认缺失/聚合落后/指标洞/旧owner均拒绝；实际PG OandaPractice+HTTP MockTransport验证401拒绝后续发布、429共享Retry-After冷却，明确为受控故障；实际旧epoch30→31被拒绝，实际断线期间十规则拒绝、历史可读 |
| 8 接缝、防重、统一输入 | composite-alerts-stage.md、composite-watches-stage.md、fixed-indicators-stage.md；已核对test_composite_alerts接缝无假穿越/修订恢复不补发/outbox逻辑防重，test_composite_watches四规则完整依赖与固定绑定；八指标16真实全前缀TA-Lib对照、JSON检查点及修订后缀重算，43判断精确连接同输入与M1产物 |
| 9 引用、共享块、竞态回收 | reclamation-impact-stage.md、history-retention-stage.md、history-writes-stage.md；已核对回测/工作区/组合/策略/审计/运行周期引用保护和锁下竞态；真实核对后新增workspace409保留价格，重新核对仅回收专属版本，原父checksum不变/共享块保留 |
| 10 十品种、多图、维护、失败分母 | concurrency-recovery-stage.md；真实10品种、8图格、10复查、1stream owner；5分钟50预期分钟全部确认；来源p95/p99 11.112/11.405秒，HTTP缓存p95 52.647ms，首次ready126.832秒，43 evaluated+11 recovery_baseline完整披露；策略p95/p99 30.664/32.191秒及阶段等待明确保留，不宣称策略15秒SLA |

## UI九项验收

| 项 | 已核对的范围与证据 |
| --- | --- |
| 1 平台选品到自建/发布/图表/回测 | managed-center-stage.md、history-catalog-quality-stage.md、replay-search-stage.md、fixed-replay-stage.md；实际来源目录、创建、各周期发布、固定图表及Dukascopy/OANDA H4各10根固定回测与图表完全一致，保存恢复保留清单 |
| 2 同名口径、默认值、改日界 | source-foundation.md、search-pagination-stage.md、calendar-switch-stage.md；同名多源/口径分别显示，外汇金属NY17/加密UTC0/指数与other需显式选择，改日界新身份复用M1且旧引用不变 |
| 3 首次/部分可用/失败保旧/暂停归档 | test_data_center、test_history_maintenance与实际PG/浏览器；M1不提前开放未发布周期、旧H4仍可读；计划暂停不取消策略需求，任务安全停止/取消保留已发布产物，归档隐藏默认列表但固定引用可读 |
| 4 管理无采集、首次共享、规则持续 | composite-center-stage.md、search-pagination-stage.md、concurrency-recovery-stage.md；纯浏览、搜索、回测不建实时需求；实际使用与PG并发共享，离开图表后持久规则继续 |
| 5 独立健康/映射/接续/恢复/闲置 | composite-quotes-stage.md、composite-watches-stage.md和Composites.tsx；抽样报价与确认收盘分别核验，有报价不代表依赖ready，正常无需求不报故障；读失败显示“实时健康未知；以下为上次快照”，映射缺失有准确配置入口 |
| 6 切换/防重/超时/离线/焦点/并发 | tasks-creation-stage.md、calendar-desktop-audit-stage.md、search-pagination-stage.md；真实创建成功响应丢失+查询503后GET找回原任务，仅1POST；复查同key、维护409不覆盖输入；503保留快照、离线保留表单、轮询不丢焦点；最新实际自建/组合详情返回保留筛选/页码/原行，恢复一次焦点且轮询不抢焦点通过 |
| 7 生命周期/删除/引用变化 | history-retention-stage.md、history-writes-stage.md、reclamation-impact-stage.md、tasks-creation-stage.md；停止计划、暂停任务、取消、归档、物理回收分别命名，准确逐版本范围/共享空间说明，提交时新引用409给最新影响并聚焦 |
| 8 桌面可访问性 | data-center-final-audit.browser.cjs、tasks-creation-real.browser.cjs及各许可图表浏览器；三宽度1024/1440/1920、键盘、内容CSS zoom200%、长真实目录标签、状态文字和错误摘要、指针按钮/选择器/来源summary至少24px、最新930可见DOM文字样本通过；CSS zoom及canvas等测量限制保留 |
| 9 真实API/PG/MCP与权限 | 各阶段真实供应商/HTTP/PG/browser记录及最新15组HTTP/MCP对照；单管理员HTTP及既有MCP market:read/market:write分别检查，旧凭据不扩权；价格夹具只用于独立测试schema与受控故障，不冒充真实来源 |

## 正文要求核对

- 三层入口与四个数据中心分区、URL/旧路由、可深链接详情已接通；旧bare/MD/MC、固定MWH/MWC与原生MWP身份保留。新策略默认组合、回测默认自建，旧入口仍显式保留。搜索未就绪原因给进度/维护/映射入口。
- 第一层Dukascopy九原生周期直接读取JSON3；OANDA原生Bid/Ask/Mid、smooth、日/周/时区参数进入独立身份/缓存；真实21组参数页面及9历史日历窗口对照。Dukascopy不提供确认位，保持null，时间结束不冒充来源确认。见dukascopy-native-stage.md、native-parameters-stage.md。
- 第二层日更固定截止、近期复查、指定补数/复查、暂停/恢复/取消、覆盖与安全读取错误日志、周期父M1、发布时间、固定回放及版本checksum比较均有实现和真实证据。比较披露分块/周期事实，不假称逐分钟价差计数。
- 第三层映射保存本身不采集，经济匹配有显式依据；历史/T/规则固定，先M1接续再派生，临时stream标为采样、不作为确认产物。图表/指标/四既有规则/图表预警共用固定解析；递归指标从有效检查点重算。新修订先准备再明确启用，已运行规则保留旧绑定。
- 报价、来源确认、时间结束、覆盖、周期水位、指标和每条策略分别返回事实；跨源量不相加。恢复、历史补数与修订建立基准，不补发过期通知，逻辑事件防重与outbox同事务。
- 任务历史/状态/来源搜索在分页前过滤，默认运行及需处理；实际类型/范围/创建/读取开始/更新/重试、中文原因与脱敏折叠详情已补齐。旧更新时间不补造。创建字段错误行内+摘要，超时先查持久结果、同意图同key重试。见tasks-creation-stage.md。
- 组合与引用页显示保存映射/组合及准确回收影响；删除空间区分共享保留与唯一payload，排除索引/WAL，不承诺宿主即时释放。危险确认固定快照token，锁下再检查。见reclamation-impact-stage.md。
- 常规读取用固定周期索引、排他分页和缓存；完整指标不以页面截断作为前缀。长输入>20000根合同、分批恢复/完整起点与实际16组指标对照已检查。大目录实际1380 Dukascopy条目/66页，容量夹具260自建/600平台/56映射只作独立合同。
- 来源共享预算、确认优先、历史公平、冷却/鉴权/过期世代拒绝已由source_resources、live_pricing、composite_preparation及修订轮换合同检查；实际十品种历史复查同时完成。未知日历不扩大供应商能力或策略可用承诺。

## 最终验证与当前运行

最终后端 **1075 passed /239 skipped /235.79秒**，33条既有Alembic警告；
`tasks-creation-full-regression-final.log`。跳过不当通过，所需真实PG按各阶段独立结果计。
本批PG任务/创建3项、PG迁移/旧预警8项，MCP定向34项，实际HTTP/MCP15组和真实浏览器通过。
上批精确回收PG15项/MCP6项/真实删除竞态通过。最终前端构建、Ruff、JS语法和diff通过。
两个旧MCP数量断言失败及早期nullable列重复迁移、脚本错误均保留失败日志并修正复验。
最终桌面导航复核初轮错误使用组合表格选择器dc-table（实际table-scroll）；修正工具后
完整13页/错误状态审计及两类列表返回通过，最终检查930文字样本，pageerror与对比失败均为0。
日志data-center-final-audit-delivery-04.log；导航改动仅前端，不另行重复后端回归。

实际Ubuntu22.04.5本机Docker，独立project `market-watch-three-layer`，PG14，head `al39_history_task_activity`。
八服务运行，API/PG健康；最新数据库269,798,747字节（约270MB），宿主54,124,347,392字节可用，
60个已发布版本，活动Watch/ChartAlert/图表租约/stream owner为0，来源inactive，日历重放临时schema为0。
这是当前规模快照，不是长期容量保证。专属删除样本已回收，创建样本取消任务/暂停归档/无读取；
其他已发布样本与固定审计保留。短期验收MCP凭据已撤销、精确token文件已删除。
凭据、原始私有证据、许可资源在ignored目录，未提交。

UI/API <http://127.0.0.1:16629/market-data>，回测 <http://127.0.0.1:16629/replay>，
许可图表origin <http://127.0.0.1:16630>。完整状态及原始结果入口见各阶段报告。
已准备本机ignored Compose/runtime环境文件和许可资源；保留数据库的启停在工作树根执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime start postgres api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop'
```

源码/构建由本任务worktree只读挂载，最终构建已用于实际web。迁移使用本项目run --rm migrate；
未重启旧16589观察、未改unraid/生产、未推送/PR/合并、未下单或发送外部通知；MT4后续。

## 明确保留的质量范围

本次实现验收只证明上述实现、有限真实样本和受控恢复合同。48小时观察未启动，
持续存储增长/更多开市及维护时段/低频供应商故障/更大冷历史并发尚无长期结论。
抽样stream不承诺全tick或全瞬时触价；真实前日突破样本有覆盖缺口，后端正确等待，
正常完整日线突破由独立PG合同证明，未为验收伪造真实触发。
策略判断延迟与来源确认分别披露；来源候选15/30秒目标在五分钟样本满足，
不能扩展为策略延迟目标或长期SLA。按用户决定，这些后续质量项不阻塞本次实现交付。
