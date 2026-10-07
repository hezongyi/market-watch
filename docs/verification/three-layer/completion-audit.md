# 三层行情完整验收核对（进行中）

日期：2026-10-07。依据[主方案](../../market-data-three-layer-plan.md)及
[桌面UI方案](../../market-data-center-ui-plan.md)，完整A–E目标不变。
下表列出可核查证据入口与仍需检查的范围。阶段报告和全量测试不能自动证明完整需求；
“待最终复核”不表示实现缺失，也不表示已经通过。目标未完成。
2026-10-07用户最新调整：快速迭代期间实现验收后暂不进行质量观察。本次收口为完整实现和
真实环境实现验收；不启动48小时观察，不再为本次交付开发长时工具。长期稳定性未验证，
核心链路稳定/准备发布时再固定版本观察。此前报告中的观察要求保留为历史决策记录。

## 主方案十项验收

| 项 | 当前证据入口 | 最终审计状态 |
| --- | --- | --- |
| 1 来源独立/多日界共享/旧回测不变 | source-foundation.md、calendar-switch-stage.md、calendar-desktop-audit-stage.md；test_source_registry_postgres、test_source_history_store_postgres、test_history_replay_migration | 真实共享内容及原manifest证据已核对；旧身份全链迁移证据待最终复核 |
| 2 失败保留旧版/周期独立/unknown | managed-center-stage.md、history-catalog-quality-stage.md；test_history_maintenance_postgres、test_history_artifacts_postgres | 新真实历史样本不推断闭市；故障与分周期API证据待最终复核 |
| 3 幂等首次使用/纯管理 | composite-definition-stage.md、composite-center-stage.md、search-pagination-stage.md；test_composite_definitions_postgres | 最新11页管理无POST、最终活跃需求0；实际并发准备证据待复核 |
| 4 日历/周月跨源量/两侧缺口/来源修订 | calendar-desktop-audit-stage.md、composite-inputs-stage.md；test_composite_series_postgres、test_composite_aggregates_postgres | 真实历史12项及独立schema12组合通过；供应商修改的受控合同与缺口逐项待复核 |
| 5 固定基线/显式修订/旧输入 | calendar-switch-stage.md、composite-revisions-stage.md；test_composite_revisions_postgres | 真实NY17→UTC0→NY17且旧Watch不迁移；固定旧输入审计待最终复核 |
| 6 持久策略/全闲置释放/重启恢复 | concurrency-recovery-stage.md、composite-watches-stage.md | 实际断线120秒/恢复84.831秒、关闭浏览器后策略持续、退出归零证据已核对；长期观察未开始 |
| 7 报价与确认分离/预热洞/401/429/旧epoch | concurrency-recovery-stage.md；test_composite_alerts_postgres、test_live_pricing_postgres | 故障HTTP为受控注入；需要核对每个门槛合同范围，不能说真实供应商故障 |
| 8 接缝/逻辑防重/统一输入 | composite-alerts-stage.md、composite-watches-stage.md、fixed-indicators-stage.md | 精确判断链43记录证据已核对；内置指标与四类规则每项合同待最终核对 |
| 9 引用回收/共享块/并发新引用 | reclamation-impact-stage.md、history-retention-stage.md；test_history_reclamation_impact_postgres | 精确影响/共享块及核对后新引用409通过真实PG/浏览器，专属价格已回收、原父版本checksum不变 |
| 10 3–10品种/多图/维护负载/完整分母 | concurrency-recovery-stage.md、search-pagination-stage.md | 实际10品种/8图格/10复查与50确认分钟通过；长期存储增长、阶段延迟与48小时分母未完成 |

## UI九项验收

| 项 | 当前证据入口 | 剩余核对 |
| --- | --- | --- |
| 1 选源→自建→发布→历史/回测 | managed-center-stage.md、replay-search-stage.md、calendar-desktop-audit-stage.md | 指定复查真实发布及固定回测链接通过；全流程原始成功记录待复核 |
| 2 同名口径/资产默认/指数/改日界 | search-pagination-stage.md、calendar-switch-stage.md | 保留旧引用证据待最终核对 |
| 3 首次/部分周期/失败旧版/暂停归档 | managed-center-stage.md、history-retention-stage.md | 各状态不误导及可操作合同待最终核对 |
| 4 管理无采集/首次共享/持久需求 | composite-center-stage.md、concurrency-recovery-stage.md、最新桌面audit | 管理无POST与最终需求0已核对；搜索、首次共享原始记录待复核 |
| 5 独立健康与映射/接续/恢复/无需求 | composite-quotes-stage.md、composite-watches-stage.md | 页面旧快照失败时健康表述待核对 |
| 6 切换/防重/超时/离线/焦点/并发配置 | search-pagination-stage.md、calendar-desktop-audit-stage.md | 最新真实409、丢失成功响应同key、503/离线/焦点通过；创建超时查结果合同待复核 |
| 7 暂停计划/任务/归档/删除/竞态 | reclamation-impact-stage.md、history-retention-stage.md | 准确影响与竞态最新引用/聚焦错误通过；暂停任务与计划合同待最终复核 |
| 8 三桌面宽度/200%/键盘/长标签/对比播报 | 最新data-center-final-audit、各实际许可图表浏览器 | 997 DOM文字样本通过；长名称、错误摘要焦点、目标尺寸、危险确认页另需核对；CSS内容zoom限制保留 |
| 9 真实API/PG/权限且夹具不替代 | 各阶段真实记录、test_history_mcp、test_history_writes_postgres | 单人管理员HTTP；既有只读/写入MCP权限分别核对，不另造多用户权限体系 |

## 正文中的交付要求

第一层支持供应商原生参数和周期，第二层 immutable M1/周期产物，第三层固定T/M1接续与
sampled stream分别披露；不得将观察报价包装为全tick。原生参数、跨源身份、八内置指标完整
检查点与原始周期一致性的证据分别见native-parameters、dukascopy-native、fixed-indicators等阶段报告。
新接口与MCP共用业务函数；本轮新增固定版本清单对比和精确自建组合列表筛选已由合同核对。

仍需逐一核对正文操作/字段：版本比较（已补）、指定复查（已补）、映射/组合引用入口（已补）、
物理回收准确影响（已由真实删除/竞态核对）、任务历史过滤/脱敏详情、创建字段错误可访问摘要、跨层搜索就绪原因、
配置异常入口、图表修订与策略迁移用户可理解提示。不能以十项/九项表代替这些正文要求。

实际环境Ubuntu Compose `market-watch-three-layer`，16629/16630，ak38；八服务运行，
2026-10-07 09:49新加坡时间DB268,447,067字节、宿主51GB余量、需求/活跃stream owner为0。
这是当前规模快照，不是多年或48小时容量证明。启停命令见[最新阶段报告](calendar-desktop-audit-stage.md)。
无生产/推送/PR/订单，MT4延期。凭据和许可资源不提交。

后续若开展质量观察，旧脚本仍绑定16589/旧源输入，须改用16629/固定组合并记录全部失败分母，
至少涵盖实际开市、跨日、金属维护、每日自建维护及持久策略恢复。
新观察启动后记录确切进程/时间/代码版本；未开始之前不得报预计完成日期，满48小时也不自动通过。
