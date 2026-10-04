# 原生历史实施进度与验收记录

2026-10-04，独立 worktree `/home/quant/repos/market-watch-chart-sync`，分支 `fix/native-chart-window-sync`。

P0 基线为 `ea56630`；方案归档为 `62ec8f1`。此前未提交的闪烁候选已在私有验收目录单独保存 patch 和测试，不回退或夹带提交。保留 Ubuntu 原验收项目 `mw-chart-sync-ubuntu-20261004`。原问题验收目标及停止条件依据 `native-history-implementation-plan.md`。

P1 读取改用短 PostgreSQL REPEATABLE READ 事务，元数据只解码一次；原生规划使用有界索引时间计数，未补齐时仅读取尾 bar，齐备后按必需量、前缀和可选储备读取。查询容量与产品容量分离，暂保持 20,000 产品上限。housekeeping 通过 savepoint 隔离并发修订的序列化冲突，provider I/O 在事务外。

P1 初验：容器依赖环境运行 provider cache/service/Yahoo 和真实 PG 独立 schema 回归，96 passed。并发修订读保持同一观察，锁定 dataset/interest 不阻塞热交付，租约隔离与前缀合同保留。尚须新增大缓存小请求计数及最终候选性能对照，旧性能结果不能代表本版本。
