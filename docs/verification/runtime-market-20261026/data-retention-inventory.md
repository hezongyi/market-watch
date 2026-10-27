# 阶段 0：保留与清理引用盘点

基线 `78697159`，只读源码与本任务合成库；没有访问生产，没有删除持久数据。此为阶段 1/C 的改动依据。

| 路径 | 删除/释放对象 | 当前保护与恢复 | 迁移后维护者 / 必要验证 |
|---|---|---|---|
| provider_service.cleanup | 过期 ProviderInterest、有界 ProviderDataset/ProviderBar 缓存 | 当前 interest/targets、native history load、active/paused ChartAlert dataset 及独立 ATR 引用 | data；关闭/lease 失效后无永久采集，历史分页/指标前缀仍可读；退役影响核实前保留旧保护 |
| market_stream.cleanup/_release_demand | 到期订阅、临时任务/事件、短期 MarketDemand | generation/epoch/lease、有效消费者；取消仅释放对应需求 | data；API/浏览器停止后仍不释放自建告警所需的持久来源需求 |
| history_retention.references/reclaim | dataset payload、块、派生指标、缓存；身份/manifest 留存 | 通用外键/JSON 引用、history/replay/workspace、ChartAlertVersion、CompositeRevision、CompositeWatchBinding、任务租约与来源锁 | data；保留原通用引用检查，不能用新手工白名单替代。归档/恢复前不删任务卷 |
| native 历史清理 | 分页/产物及相关临时输入 | 有效 load、消费者/截止期、被引用固定版本 | data；原生周期身份和 archive 保持 |
| 尚缺实时 30 天路径 | source minute revisions、composite minutes/inputs/events payload、旧聚合/指标/显示快照与源页缓存 | 当前未按成功切换事件协调删除；固定 seam 和旧规则/修订可能无限依赖实时输入 | 轨道 C data 有界批次；成功切换整体提交后解锁，UTC now−30×24h，未满窗不删、有效引用不删、Dukascopy 不删 |

清理顺序必须尊重 market_composite_minutes / market_composite_minute_inputs → market_source_minute_revisions 等外键及事件消费检查点；源端锁/租约与当前修订下界在事务内协调。新/旧修订引用不可靠 TTL 猜测。旧修订冻结后不得因 apply_minutes 全修订分发或 aggregate claim 自动登记重新扩写。

超过 30 天输入依赖的源码事实：composite_inputs.rows 依据固定 seam/输入修订读源分钟；composite_alerts 固定 history_version_id、composite_revision_id；fixed_indicators 需要递归前缀/检查点；CompositeInputEvent 保存源修订引用。保留窗口外完整重放与严格实时窗口不兼容，必须先交付周日统一基线/安全暂停，再启清理。旧输入不从供应商无限回补。

首次真实清理门槛：A04a shadow → A04b 一致激活/fencing → A13a/b dry-run/引用审计 → 适用备份**实际恢复**及回退边界验证 → A13c 首次删除。失败/部分激活/重启不产生清理解锁；成功批次按 switch run ID 幂等续跑。现有生产备份记录不能直接替代未来 schema 和保留边界下的适用恢复证据。

## 非 composite 退役与实时开关初值

实例影响清单由本任务基线输出（规则身份/状态、来源、指标/ATR 依赖、历史 signal、未完成 notification/outbox、保存图表、映射与消费者）。本任务合成记录只说明兼容形状，不代表真实用户数量；生产实际状态只在正式切换授权后核对。

处理策略：provider/managed 旧配置/事件保持可读、可停用/导出；不按品种名自动转换；活跃旧记录不再执行；新规则必须显式绑定就绪且实时流启用的 composite。回退不能自动恢复这些规则或重发旧 Outbox。

实时开关初值按有效 mapping + 当前有效运行修订 + 活跃实时消费者核实，已有有效实时对象保持启用，纯历史关闭。保存图表本身不等于永久实时需求。共享源只停止已退役消费者，不误停其他有效自建品种。
