# 原生历史实施进度与验收记录

2026-10-04，独立 worktree `/home/quant/repos/market-watch-chart-sync`，分支 `fix/native-chart-window-sync`。

P0 基线为 `ea56630`；方案归档为 `62ec8f1`。此前未提交的闪烁候选已在私有验收目录单独保存 patch 和测试，不回退或夹带提交。保留 Ubuntu 原验收项目 `mw-chart-sync-ubuntu-20261004`。原问题验收目标及停止条件依据 `native-history-implementation-plan.md`。

P1 读取改用短 PostgreSQL REPEATABLE READ 事务，元数据只解码一次；原生规划使用有界索引时间计数，未补齐时仅读取尾 bar，齐备后按必需量、前缀和可选储备读取。查询容量与产品容量分离，暂保持 20,000 产品上限。housekeeping 通过 savepoint 隔离并发修订的序列化冲突，provider I/O 在事务外。

P1 初验：容器依赖环境运行 provider cache/service/Yahoo 和真实 PG 独立 schema 回归，96 passed。并发修订读保持同一观察，锁定 dataset/interest 不阻塞热交付，租约隔离与前缀合同保留。后续已补齐大缓存小请求计数及本候选性能测量，见下方记录。


## P2～P5 候选实施（2026-10-05）

产品实现提交为 `b3dd20c`（前序 `cc6b935`、`932a4fd`、`d0b8716`）。历史任务逐页写 PG；前端保持一次原生回调，取消旧公开范围请求时结束其原生等待，旧侧追加在原生时间轴更新完成后同步按语义时间重放光标。指标异步创建先预留预算；空页仅在覆盖、边界或有效 bars 变化时计为进展。Standards 与 Spec 复核本次实现均无新阻断项。

Ubuntu 独立候选已运行：`mw-native-history-ubuntu-20261004`。默认产品设置仍保留 20,000；隔离候选经测量收窄为 80,000 bars / 工作区加权 260,000 bars / 32 MiB / 600 秒 / 80 页。Unraid 与生产未改动。

本版本已验证原 EURUSD 四图大历史请求、静止光标与 hover、故障恢复、原生与 Python 指标、画线、按住拖动、真实 PG 更正经 SSE 核实刷新、视区/柱宽恢复和保存重开；2/4/8 图混合周期连续导航通过。后端相关回归 164 passed；原生 hook/导航/历史观察/视区模块回归、TypeScript/Vite 构建通过。编译仅有既有 chunk-size 警告。

冷 PG 独立 schema 60,031 根真实 EURUSD M5，16 页，约 48 秒；热读取 0.93～1.13 秒；小请求含储备返回 1,200 根约 0.046 秒，PG 有界 payload SELECT 回归通过。完整产品四图约 5.1 秒点击至就绪，八图约 6.7 秒；最大观测长任务约 0.76 秒/1.92 秒。不是无限容量或任意客户端性能保证。

详见 [验收交付](native-history-acceptance.md) 与 [证据目录](verification/native-history/)。人工验收待用户完成；生产发布另行授权。长期泄漏、多商品全源日历与模板批量恢复没有扩大为全部通过。

人工验收入口、容器和预算细节见 `docs/native-history-acceptance.md`；公开范围重叠的验收要求是新范围成功且旧 promise 最终 settled，旧请求若已在切换前完成则允许 `completed`，不得出现原生 `Value is null`。
