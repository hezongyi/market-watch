# 剩余空闲开销优化实施与验收

## 版本与边界

2026-11-12，用户授权继续实施、验证、开发部署和更新 #134；不跟踪 CI，不合并、不打正式 tag、不操作生产。F1，未改变 schema 或持久格式。实施规格见 [方案](idle-residual-implementation-20261112.md)。

- 基线 `cf72811d`；运行代码 `2814c38b`，测试 fixture 跟进 `d0d0f022`。
- Ubuntu 本机 Docker project `mw-dev`，四核；`https://192.168.7.232:18443`。
- 四个后端运行 `market-watch-api:dev-idle-v4-20261112`，image ID `sha256:e4788f9f4b1a9e0294f3a79900c52b3ea52fbe067987f5c8b5e0fd1879425bd0`，构建 commit `2814c38b`，通过 `mw-docker build` 构建。Web 沿用此前候选。
- 启动 `mw-dev up`，停止 `mw-dev stop`，查看 `mw-dev status`。旧镜像、切换前私有配置保留；切换前新增完整逻辑备份 1,560,227,173 bytes，`pg_restore --list` 可读，本轮不声称重做全库恢复演练。

## 实现与复现

1. 缓存容量检查复用现有 ProviderDataset 的已提交 revision/updated_at 和集合签名，五分钟容量轮次无变化时跳过 ProviderBar 全表 COUNT。所有现行 bar 写入者均同事务推进签名；在 COUNT 前读取签名，提交成功且配额处理完才确认。过期清理仍每分钟执行，20 dataset 的有界删除未完成时不缓存成功；配置配额改变重数，小时强制重数覆盖外部/旧写入者漂移。更新也会保守触发重数，不增加写入锁或 schema。
2. 组合九周期产物完成时的公共广播原来会唤醒没有相关任务的通用聚合 worker。新增通用派生工作 channel，真实聚合入队、发布请求和独立读取需求同时发送专用与原公共通知；通用 worker 只监听专用 channel。告警仍接收原公共通知，断线轮询和任务重试期限保持。
3. 报价事务从已有 dataset 父锁查询复用 instrument_id，在修改状态前读取当前 Instrument；仅分钟指标读取期间禁止中间 autoflush，避免同一 LiveState 被拆成两次 UPDATE。日历、消费者与状态仍来自当前事务；每条接受报价仍独立提交，owner/epoch、dataset KEY SHARE 与首个告警注册 FOR UPDATE 的互斥语义保持。

已实际运行并观察到红灯的回归：不变缓存两次 cleanup 仍执行两次 COUNT；稳态两条报价重复读取 dataset，且中间 flush 拆分状态写入；通用 worker 监听公共组合广播。修复后的实际入口测试均通过。

固定 600 条报价在独立 PG schema 回放（两条身份轮转、同一输入；启用 cProfile，不能当生产吞吐）：SQL **7,826 → 6,626**，减少 15.3%；提交 **600 → 600**；应用进程 CPU **7.234 → 6.787 秒**。墙钟 10.379 → 10.002 秒，P95 24.548 → 25.805 ms，不据此宣称提交延时改善。

## 验收

- 相关本地回归 **172 passed**；新增完整回归最终 **6 passed**；原暂停派生/需求恢复回归 **12 passed**。轮次重叠，不相加。
- 独立 Ubuntu PostgreSQL 14.24，task project `mw-idle-v2-20261112`、25475、独立 volume：**162 passed、1 skipped**，覆盖提交/回滚、真实通知入口、报价/注册并发、owner fencing、发布/聚合与迁移兼容。skip 是旧源码路径未设置；补入已有真实 v1.14.0 归档后，旧写入兼容 + 新用例 + 原派生回归最终 **19 passed**。
- 补跑中暴露测试时钟污染：PG fixture 期间首次导入的 generic_derivation 保存了冻结 now_ms 别名，之后 SQLite 需求租期被误判过期。修正 fixture 顶部导入和显式 monkeypatch/恢复；未放宽断言或改变运行代码。失败组合命令修复后 19 passed。
- Ruff、`git diff --check` 通过。独立 Standards / Spec review 均无未解决 findings；测试时钟修正另经 Standards 复核。
- 隔离活跃告警 302.055 秒，**300 报价、1 个预期 signal、0 outbox、0 错误**。穿越至判定 65.840 ms，监控间隔 P95 250.091 ms，报价提交 P95 46.671 ms。本次前段有主机备份/构建活动，这组数据用于功能验收，不与上轮延时作严格性能比较。
- 浏览器登录、五张组合图数值、数据中心 50 条记录通过，无页面错误或失败资源。三条组合 × 九周期共 27 次读取均有数据。
- 六个 provider 均读取 40 bars，MCP 42 tools、事件 SSE、通知 SSE、ntfy、原生图表资源通过。首次 Binance 返回 503，随后单项与整组复查均成功；最终角色健康检查通过，三条实时连接 connected+ready。

## CPU 观测

2026-11-12 09:06:07–09:21:08 UTC，三段累计 900.320 秒。每段首尾均为 0 browser、0 subscription、0 active alert，3 connected；开始前和最终复核均为三条 ready。测试 PG 停止，验收浏览器关闭，采样期间无测试、构建、备份或 profiler。测量结束后才用一次无 locals 的线程名称快照标注已有 /proc CPU 差分。

| 服务 | 上轮单核均值 | 本轮单核均值 |
|---|---:|---:|
| market-runtime | 5.996% | **5.829%** |
| data-worker | 3.021% | **2.528%** |
| PostgreSQL | 2.769% | **2.497%** |
| ntfy（含探针） | 0.819% | 0.831% |
| notification-worker | 0.463% | 0.472% |
| API（含探针） | 0.369% | 0.374% |
| web + TLS | 0.003% | 0.003% |
| 合计 | **13.439%** | **12.534%** |
| 换算四核整机 | **3.360%** | **3.134%** |

| 样本 | 报价数 | PostgreSQL 单核 | 合计单核 | 四核整机 |
|---|---:|---:|---:|---:|
| 1 | 1,410 | 2.668% | 12.608% | 3.152% |
| 2 | 1,364 | 2.428% | 12.380% | 3.095% |
| 3 | 1,311 | 2.395% | 12.615% | 3.154% |

总 CPU 较上轮下降 **6.7%**，data-worker 下降 **16.3%**，PG 下降 **9.8%**。本轮 **4,085 报价**（4.54/s），上轮 3,819（4.24/s），约增加 7%；同窗各新增 45 个组合确认输入、405 个组合周期产物。全服务 CPU 时间/报价为 **31.68 → 27.63 ms**，约下降 12.8%；这个比值摊入固定后台和 PG/探针开销，不能当作报价处理耗时或严格隔离收益。

数据库累计 **38,598 commits、0 rollback**，1,257 inserts、24,091 updates、251 deletes。buffer hits 1,261,756，buffer reads **68,668**，上轮 189,255。第一段包含一次验收读取改变缓存修订后的容量重数（并行扫描统计 3 seq_scan、989,400 seq_tup_read，不能说是三个独立 COUNT）；后两段 ProviderBar **seq_scan=0、seq_tup_read=0**。三段 buffer reads 分别 63,933 / 4,539 / 196；这里是数据库 shared-buffer miss 计数，不等同物理磁盘读取。

Preferences seq_scan 三段 210 / 229 / 219（上轮约 750/段）；chart_aggregation_jobs 489 / 507 / 495（上轮约 629/段）。表扫描次数不是单 SQL 的 CPU 归因，未启用 pg_stat_statements。

## 剩余开销与结论

| 线程 | 本轮单核均值 | 上轮参考 |
|---|---:|---:|
| pricing | **3.178%** | 3.321% |
| composite_aggregate | **1.108%** | 1.114% |
| oanda-confirmation | **0.733%** | 0.751% |
| history_compute | 0.293% | 0.300% |
| history_network | 0.262% | 0.265% |
| chart_aggregation | **0.157%** | 0.675% |

通用聚合线程降低约 **77%**，与减少无关唤醒及扫描一致；总开销改善有限，不能据此宣称当前空闲占用已合理。**全服务单核 3%（四核 0.75%）目标仍未达到**。

下一项收益上限最大的仍是逐报价事务（pricing 单线程约占本组总 CPU 四分之一，另外有 PG 工作），本轮已删除一条元数据 SELECT 和一次中间 LiveState UPDATE，但稳态仍约 11 条 SQL/报价。后续应测量关联读取合并、其余 ORM flush/序列化成本，继续保留逐条提交和首个规则注册围栏。组合聚合约 1.11%、确认约 0.73% 仍可评估；本轮未改这两项的调度或计算规则。历史两个 5 秒循环合计约 0.56%，因仍包含 retry/readiness/每日调度，未盲目延长等待。

不同时间的供源速率和主机其他并行项目未严格控制；比较提供观测证据，不把全部差值强行归因给某一修改。全部授权实现、验收和开发部署已完成，PR 更新不代表合并、正式发布或 CI 状态。

原始证据和私有回退材料位于 `/home/quant/.local/share/market-watch-dev/updates/idle-v4-execution-20261112/`，不提交私有配置、凭据或浏览器状态。
