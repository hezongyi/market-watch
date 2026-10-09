# 统一行情订阅完成审计（进行中）

实施依据：`../../market-data-unified-subscriptions-plan.md`；开发起点 `6fd9273`。
任务仍 active，未生产发布；以下不构成全部验收通过。

| 要求 | 当前直接证据 | 状态/余项 |
| --- | --- | --- |
| Ubuntu隔离worktree、分支、Compose、数据库及端口 | README运行信息；本机Compose ps、迁移ar45；镜像标签核对 | 已运行；95d501e三镜像已重建并运行；后续仅harness/文档变更另标 |
| 统一bar/quote出口、认证/CSRF、身份/世代隔离 | market_stream/api/quotes的SQLite与真实PG契约；许可浏览器原生回调 | 工程行为通过；已找到本机Practice配置，供应商原生行为验收进行中 |
| 九周期、NY17/DST/接缝、替换/缩小/撤回、量语义 | test_composite_realtime九周期×两相位×三个边界差分；composite_series/worker真实PG差分 | 差分通过；真实浏览器组合M1/D1/W1/MN通过 |
| 多图、连接及API共享计算 | 四同周期图+双浏览器双API一task；PG1/8消费者；两组合×W1/MN×四连接 | 95d501e四图/双连接/双API成本复核保持1个bar task，两个client均逐输入回调 |
| 临时高周期不反复扫M1，指标共享 | W1/MN首次build、warm零历史M1yield、确认delta一条；M1 EMA31冷/热探针；组合EMA许可浏览器 | 通过；冷启动6–8秒单独记录 |
| 仅报价、图表关闭后自选表持续、最后取消释放 | quotes-current许可浏览器；quote需求及迟到取消PG契约 | 通过 |
| 活跃预警独立需求保留 | canceling_last_browser_demand_preserves_other_internal_owners真实PG；已有composite_alerts回归 | 真实供应商独立watch需求及输入正在验收 |
| 首读竞争、窗口修订、指标进度 | bridge实际回调Node检查、真实PG对应契约；managed/组合EMA浏览器 | 95d501e固定历史指标/分页/切换整组许可浏览器通过 |
| 分页、切品种/周期/工作区不污染旧回调 | bridge世代/拒收/窗口过滤Node；historical_window真实PG | 95d501e许可浏览器生命周期场景通过 |
| 断线跨多柱、重启、接管 | 实停本项目web网关，期间追加三柱逐柱恢复；worker进程接管；API重启浏览器 | 95d501e真实网关断线130027ms跨三柱恢复通过；EMA/worker接管/API重启复核通过 |
| owner/账户/来源/修订变化，旧价不冒充实时 | quotes/worker过期和binding切换真实PG；同名身份隔离回归 | Practice REST/stream连通性通过；实际owner/账户过期切换待补 |
| 无常态15秒行情轮询，历史仍HTTP | 默认真实浏览器跨tick无charts/data、quotes、latest；显式marketPolling回退Node与浏览器 | 默认已通过；回退已实测 |
| 背压/有限队列/清理/租约 | PG快慢消费者133结果、128条上限；过期清理精确保留有效消费者 | 有界契约通过；60秒有效负载、无消费者结果队列为0实测已归档；长期容量不作保证 |
| 延迟P95≤3秒 | 许可浏览器fresh callback：managed八周期1036ms、EMA1028ms、共享1275ms、接管场景正常2455ms；组合1821ms/EMA1758ms | 上述指定负载通过；不推断来源延迟或生产容量 |
| 新增CPU/内存/SQL/发送/磁盘开销 | resources只读Docker累计CPU/内存/网络和PG WAL/表统计；成本探针；同输入60秒回退/SSE比较入口 | 资源报告已归档：单/八周期回退对照、多连接、空闲、EMA分窗、SQL/WAL/发送/表大小；旧版本物理磁盘净增量及多组合容器对照未证明 |
| 最终运行版本、完整检查和交付 | 95d501e镜像内58项PG通过；后续仅验收脚本/文档调整 | 运行版本复核通过；主要性能对照完成；供应商行为验收及最终交付审计进行中 |
| 使用说明/地址/启停/保密/退役 | README实际loopback端口及命令；凭据/许可材料在忽略目录 | 可运行说明已有；任务进行中不finish/retire；生产另行授权 |

资源比较使用本版本显式轮询回退作为可重复对照，不等同旧发布版本。
第一次成本试跑未排尽前轮浏览器120秒租约，保留原始报告但不作为严格增量结论。
新成本入口检查整个任务所有有效消费者已排尽，再执行60秒定频输入，结束精确取消自身订阅。
CPU含本项目容器进程，不含宿主浏览器/fixture；网络内部流量不得相加当外网带宽；
镜像逻辑大小不得当共享层物理磁盘新增占用。最终资源报告须保留这些边界。

真实OANDA验收新增业务红例：已有ChartHistoryPlan时managed quote Calculator
读取不存在error字段导致AttributeError。3956df2修正，新增确认价格更新/无变化不重算
回归先红后绿（20 quote/worker项通过）；需重建新API及真实supplier整组复跑。
验收Compose已补provider-history-worker执行原生平台历史分页，避免首屏任务等待。
真实Practice三天M1历史published，接续组合定义已建立，原生组合回调仍待验。
