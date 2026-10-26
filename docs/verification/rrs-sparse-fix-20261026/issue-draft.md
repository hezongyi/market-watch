# 修复平台RRS稀疏历史预热回归

用户明确要求修复已记录的5项RRS问题。独立工作树market-watch-rrs-sparse-fix-20261026，分支fix/rrs-sparse-history-20261026，起点53fb056a；前一轮接入交付保持不变。风险F0：平台指标输入分段兼容修复，无schema或持久格式变化。

范围：恢复b4e1326a中仅对平台RRS关闭推断缺口的行为，保留显式无效输入重置；主计算和备用入口保持一致，其他指标默认不变。1c8a8ac8集成提交明确移除了这三处代码但保留测试，已通过git show对照确认。

验收：5项原红例；原版literal Pine数值、框/标签几何和分页；相邻指标checkpoint/batch与Swing日历分段；Docker中运行当前候选对冻结真实来源数据的独立oracle对照。F0无需新schema或真实库迁移。无外部Issue/PR、推送、main合并或生产发布。

主机现有空闲内存约8GiB，根/Docker磁盘剩余约9.9GiB，低于标准preview的23GiB启动门槛；不新开完整PG/API/Web实例。采用带任务归属候选API镜像、无网络/无持久卷的有界短时Docker计算smoke，不操作mwa或其他任务数据库，不以历史浏览器证据冒充本次部署验收。
