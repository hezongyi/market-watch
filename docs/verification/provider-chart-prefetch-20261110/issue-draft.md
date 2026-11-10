# 平台单图加载与按来源预取

风险分类：F1。修改重要历史获取链路并新增持久配置；不新增数据库表，不改价格身份。

按 docs/plans/provider-chart-loading-and-prefetch-20261110.md 实现六源独立首屏采集/后台储备，减少启动等待和任务交付延迟，定位 Yahoo/AKShare/FXCM 来源成本。

最小检查：配置与任务回归、真实 PostgreSQL 并发、原生图表冷品种计时、F1 独立 Standards/Spec review、CI 与 Draft PR。未经授权不合并、不打正式 tag、不发布生产。

2026-11-10 资源盘点：11 GiB 磁盘、约 4.7 GiB 可用内存。完整 worker preview 门槛 26 GiB/5 GiB 未满足，暂不启动新隔离实例；保留其他任务的全部资源，先实施与本地检查。

2026-11-10 后续授权：用户要求先停止其他已核实任务实例并直接开发实例验收；已按此覆盖原隔离资源建议。OANDA 诊断完成并获“认可，实施”，最新实现、结果及未达标项见 README.md。
