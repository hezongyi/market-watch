# 统一行情订阅完成审计

实施依据：`../../market-data-unified-subscriptions-plan.md`；开发起点 `6fd9273`。
Ubuntu 技术验收与交付记录已完成；087b135 的闲置组合首屏、owner 恢复、账户切换复验通过。实例保留供用户验收；用户验收及退役尚未结束。未执行生产发布。

| 要求 | 当前直接证据 | 状态/余项 |
| --- | --- | --- |
| Ubuntu隔离worktree、分支、Compose、数据库及端口 | README运行信息；本机Compose ps、迁移ar45；镜像标签核对 | 通过；当前运行镜像为 `087b135`，修复后复验见下方 |
| 统一bar/quote出口、认证/CSRF、身份/世代隔离 | market_stream/api/quotes的SQLite与真实PG契约；许可浏览器原生回调 | 通过；真实 Practice 平台、组合、只报价及账户切换均通过 |
| 九周期、NY17/DST/接缝、替换/缩小/撤回、量语义 | test_composite_realtime九周期×两相位×三个边界差分；composite_series/worker真实PG差分 | 差分通过；真实浏览器组合M1/D1/W1/MN通过 |
| 多图、连接及API共享计算 | 四同周期图+双浏览器双API一task；PG1/8消费者；两组合×W1/MN×四连接 | 95d501e四图/双连接/双API成本复核保持1个bar task，两个client均逐输入回调 |
| 临时高周期不反复扫M1，指标共享 | W1/MN首次build、warm零历史M1yield、确认delta一条；M1 EMA31冷/热探针；组合EMA许可浏览器 | 通过；冷启动6–8秒单独记录 |
| 仅报价、图表关闭后自选表持续、最后取消释放 | quotes-current许可浏览器；quote需求及迟到取消PG契约 | 通过 |
| 活跃预警独立需求保留 | canceling_last_browser_demand_preserves_other_internal_owners真实PG；已有composite_alerts回归 | 0eb7f6c真实Practice在最后browser取消后watch quote_at继续推进，最后watch暂停释放来源 |
| 首读竞争、窗口修订、指标进度 | bridge实际回调Node检查、真实PG对应契约；managed/组合EMA浏览器 | 95d501e固定历史指标/分页/切换整组许可浏览器通过 |
| 分页、切品种/周期/工作区不污染旧回调 | bridge世代/拒收/窗口过滤Node；historical_window真实PG | 95d501e许可浏览器生命周期场景通过 |
| 断线跨多柱、重启、接管 | 实停本项目web网关，期间追加三柱逐柱恢复；worker进程接管；API重启浏览器 | 95d501e真实网关断线130027ms跨三柱恢复通过；EMA/worker接管/API重启复核通过 |
| owner/账户/来源/修订变化，旧价不冒充实时 | quotes/worker过期和binding切换真实PG；真实双账户浏览器报告 | 通过；备用 Practice 账户真实报价独立，旧账户报价被 fence，原组合历史/身份指纹不变并恢复原账户 |
| 无常态15秒行情轮询，历史仍HTTP | 默认真实浏览器跨tick无charts/data、quotes、latest；显式marketPolling回退Node与浏览器 | 默认已通过；回退已实测 |
| 背压/有限队列/清理/租约 | PG快慢消费者133结果、128条上限；过期清理精确保留有效消费者 | 有界契约通过；60秒有效负载、无消费者结果队列为0实测已归档；长期容量不作保证 |
| 延迟P95≤3秒 | 许可浏览器fresh callback：managed八周期1036ms、EMA1028ms、共享1275ms、接管场景正常2455ms；组合1821ms/EMA1758ms | 上述指定负载通过；不推断来源延迟或生产容量 |
| 新增CPU/内存/SQL/发送/磁盘开销 | resources只读Docker累计CPU/内存/网络和PG WAL/表统计；真实双组合稳定窗口 | 通过并已量化；旧版本物理磁盘净增量仍无法由镜像逻辑大小推导 |
| 最终运行版本、完整检查和交付 | 087b135镜像内60项PG、本地132项通过；真实首屏/owner/账户三组修复后报告 | 技术交付完成；用户验收及退役待完成，生产另行授权 |
| 使用说明/地址/启停/保密/退役 | README实际loopback端口及命令；凭据/许可材料在忽略目录 | 交付说明齐全；验收实例仍保留，未执行 retire；生产另行授权 |

资源比较使用本版本显式轮询回退作为可重复对照，不等同旧发布版本。
第一次成本试跑未排尽前轮浏览器120秒租约，保留原始报告但不作为严格增量结论。
新成本入口检查整个任务所有有效消费者已排尽，再执行60秒定频输入，结束精确取消自身订阅。
CPU含本项目容器进程，不含宿主浏览器/fixture；网络内部流量不得相加当外网带宽；
镜像逻辑大小不得当共享层物理磁盘新增占用。最终资源报告须保留这些边界。

真实OANDA验收新增业务红例：已有ChartHistoryPlan时managed quote Calculator
读取不存在error字段导致AttributeError。3956df2修正，新增确认价格更新/无变化不重算
回归先红后绿（20 quote/worker项通过）；需重建新API及真实supplier整组复跑。
验收Compose已补provider-history-worker执行原生平台历史分页，避免首屏任务等待。
真实Practice三天M1历史已 published，接续组合定义及原生组合回调已通过。

0eb7f6c真实OANDA平台/managed只报价/独立watch整组通过，证据oanda-runtime-summary.json。
最后browser消费者取消后，真实source received_at及watch quote_at继续推进；
暂停该独立watch后EUR_USD退出desired_datasets。配置及完整浏览器证据保留私有。
真实OANDA固定M1版本published，真实组合native symbol会大写hash；验收使用正式
MWSeries.same规范化身份比较，而不是将相同系列的大写展示误判为加载失败。
账户切换报告为私有 `oanda-account-switch-0eb7f6c-passed.json`，摘要包含哈希。

实际OANDA组合/owner停止恢复整组已通过：冷恢复与稳定更新分开，sampled-BID就绪
停止后撤回为保存的确认M1，重新启动后恢复真实quote，独立watch接数/判断通过，
最后HTTP首读120秒lease退尽后wanted来源释放。oanda-runtime-summary.json为正式摘要。
两组合各 W1/MN 的真实稳定窗口已通过，私有 resources 报告记录 CPU、内存、WAL、队列和网络。
历史资源窗口运行 `0eb7f6c`，当前运行 `087b135`，未生产发布；物理磁盘净增量和长期生产容量仍属于测量边界，不是本次验收失败项。

## 最终修复验收

运行版本 `087b1356be1d8aa0845fb0d2989d9a7a286cf511`；API healthy，Ubuntu project
`mw-unified-sse-20261008`，未在 unraid 部署/修改实例；前置阶段仅只读核对生产版本。132 本地回归及 60 镜像内 PostgreSQL gates
均通过，新增 LiveState 读取竞争测试也通过并继续拒收真正未来报价。Node 三组桥接检查、Ruff 通过。

真实供应商三个修复后原始报告及 SHA-256 已加入 oanda-runtime-summary.json：
闲置组合首屏至少两次原生回调且稳定窗口无行情 HTTP、owner 停止/恢复（报价就绪撤回/恢复）、
双账户切换（实价独立/旧账户隔离/历史身份不变/原账户恢复）。后两组都验证浏览器取消后
独立预警继续推进，以及最终来源需求释放。所有 7 份历史与新增报告哈希核对一致。

首屏冷恢复可因来源尚未就绪、确认历史推进而合理重读；稳定有效报价不再因读取竞争误撤回。
资源报告沿用已记录的实际版本和测量窗口，不能声称此次文档版本重新测得生产净增量。
工程交付与技术验收完成；用户验收仍进行中，实例及数据库保留，未标记 Docker task 结束。
用户验收结束后须按 mw-docker retire 预览、备份/恢复核验及精确退役流程收尾。

## 原始目标最终核验（2026-10-09）

重新读取 /tmp/market-watch-unified-sse-development-handoff-20261008.md 及原方案后，
逐项检查上述正确性、性能和交付要求。隔离 worktree/branch、前置进程布局/共享归属/变化触发源
记录、实现与默认前端 SSE 出口、真实 Ubuntu/Practice 验收、启停/地址/限制及开销交付均有直接证据。
19 份许可浏览器原始报告、15 份资源报告、8 份 OANDA/连通性报告的登记文件哈希核对通过；
7 份组合 SQL/扫描成本原始报告与摘要逐字段相等，并补充文件路径及 SHA-256。
历史负载矩阵保留各自运行 commit，不冒称为087b135重新跑过的全部矩阵；95d501e之后的
业务修改仅涉及组合报价标签、managed历史计划读取、LiveState快照时间，最终132项本地、
60项镜像内PG及三组修复后Practice复验覆盖这些影响路径，bridge与传输/聚合主体无后续修改。
7个核心服务核对实际镜像commit/task/project/acceptance标签，均为087b135且运行；
主API /healthz正常，测试schema（provider_/unified_/test_）残留0，工作树只有审计文档更新。
未新增提交env/token/许可材料。原始开发目标已达到；生产发布及用户验收后的资源退役不作为已完成行为。
