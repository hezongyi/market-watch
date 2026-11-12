# Pricing 事务优化实施与验收

## 范围与实现

2026-11-12，用户认可执行 [pricing 方案](pricing-optimization-analysis-20261112.md)。F1：报价持久化重要链路，无 schema 或持久格式变更。基线 `56f95db4`，代码候选 `7fc2ebdf`。开发部署、验收和更新 #134 已授权；不查询 CI、不合并、不打正式 tag、不操作生产。

- 已提交 handover 的报价，在原 owner → dataset 锁之后，联合读取 LiveState、Instrument、当前分钟 LiveMinute 和当前 epoch 的 ObservedMinute。对象只在本事务复用，显式区分未预读和预读缺失。
- 首次 handover 仍走原刷新/采用路径；缺分钟仍走原创建、容量及全局保护 hook。原始 forming 与符合展示准入的 OHLC 保持独立。
- Instrument 状态更新提前到消费者查询前，令稳态无规则路径一次 flush 写完四份状态。活跃输入的注册、sequence、retention 保留必要 flush。
- 局部复用 dataset key 和 forming 的 Decimal bid；没有为小额解析节省增加通用模型缓存或额外上下文 API。未实施 Core SQL 写入、跨事务规则负缓存、批量提交或展示降频。
- 实际入口回归先在基线失败：稳态 7 SELECT、3 flush；候选为 **4 SELECT、4 UPDATE、1 flush、1 commit**。

## 本地与隔离 PostgreSQL

- 本地相关回归 **101 passed**，包括报价、展示、组合告警、输入、handover、回滚及原空闲优化。
- PostgreSQL 全组初次 **126 passed、1 failed**；失败为新增预热测试先写 `+1/+2ms` 报价却在原时刻注册，被未来价格基准检查正确拒绝。测试注册时刻改为 `+10ms`，仍早于被验证报价 `+100ms`，并改善超时异常定位；未修改运行代码或放松断言。修正后相关组 **11 passed**，轮次有重叠，不相加。
- PG 覆盖新稳态查询/提交合同、分钟切换、非交易/无报价/倒挂价差、四份状态回滚、容量恢复与 epoch 隔离；确认先/报价先两种锁等待均保留共享字段；首条规则在旧路径和预读路径注册均阻塞并正确接收下一条报价。原 owner fencing、告警可靠性、迁移及发布死锁组一并运行。
- Ruff、`git diff --check` 通过。独立 Standards / Spec review 均无未解决发现；测试时刻修正另经 Spec 复核。
- 所有合成写入仅在任务 PostgreSQL `mw-idle-v2-20261112`、25475、独立 schema 中执行，未写开发业务库。

## 固定输入回放

无 profiler，三轮基线/候选交替顺序，每轮 600 接受报价、每条独立事务，跨 75 秒覆盖分钟切换。无规则场景轮转三个数据集；活跃规则场景单独集中验证一个有真实规则的数据集及有界输入日志。比较 LiveState、LiveMinute、ObservedMinute、Instrument 报价字段、PriceAlertInput、PriceAlertStream 和 owner 字段；排除随机 token、独立创建的组合品种 ID 及 LiveMinute surrogate ID。所有对应轮次逐字段校验值一致。

| 每 600 报价 | 无规则基线 | 无规则候选 | 活跃规则基线 | 活跃规则候选 |
|---|---:|---:|---:|---:|
| SELECT | 4,248 | 2,463 | 6,612 | 4,815 |
| 总 SQL | 6,656 | 4,871 | 11,416 | 9,619 |
| 实际 flush | 1,808 | 614 | 2,404 | 1,805 |
| commits | 600 | 600 | 600 | 600 |
| Python CPU 中位数 | 3.746s | 3.049s | 6.594s | 5.058s |
| 任务 PG CPU 中位数 | 0.911s | 0.743s | 1.700s | 1.304s |
| 墙钟中位数 | 6.314s | 5.187s | 10.860s | 8.374s |
| 每轮报价提交 P95 的中位数 | 15.453ms | 13.499ms | 28.861ms | 19.138ms |

无规则 Python/PG CPU 中位数分别降低 **18.6% / 18.5%**；活跃规则分别 **23.3% / 23.3%**。首分钟、handover、续租的额外语句计入总量，所以不能用稳态 8 SQL 直接乘 600。主机其他任务、频率与时序未严格控制；这是交替回放证据，不能直接作为真实行情服务总 CPU 收益或严格的延时承诺。

## 开发部署与功能验收

- Ubuntu 本机 Docker `mw-dev`，四核；`https://192.168.7.232:18443`。启动 `mw-dev up`，停止 `mw-dev stop`，状态 `mw-dev status`。
- API、market-runtime、data-worker、notification-worker 均运行 `market-watch-api:dev-pricing-v5-20261112`，image ID `sha256:31f2a592a599df7105d56bcead63597b9c299abd973f0e00801aee931715fc27`，构建 commit `7fc2ebdf`、dirty=false、用途 development。通过 `mw-docker build` 构建，Web 沿用此前候选。
- 切换前完整逻辑备份 **1,560,761,700 bytes**，`pg_restore --list` 可读；本轮不声称全库恢复演练。旧后端镜像和私有配置保留。
- 隔离 PG 活跃告警实际调用新 `publish_event` 与连接内 handover 正缓存：**302.034 秒、300 报价、1 预期 signal、0 outbox、0 错误**。报价提交 P95 **25.316ms**，穿越到判定 **58.217ms**，监控间隔 P95 **250.303ms**。该组用于功能验收，不当作隔离性能比较。
- 浏览器五张图有数值、数据中心 50 条，无页面错误或失败资源；三组合 × 九周期 **27 次读取**均有数据。六个 provider 各 40 bars、MCP 42 tools、事件及通知 SSE、ntfy、原生资源通过。
- 采样前 **38 角色健康、3 connected+ready**。验收浏览器已关闭，任务测试 PG 已停止，volume 保留。

## 同窗 CPU

2026-11-12，UTC **2026-11-12T10:27:45.964546+00:00 至 2026-11-12T10:42:47.129262+00:00**，三段累计 **900.298s**。每段首尾均为 0 browser、0 subscription、0 active alert、3 connected，采样前后 3 ready；任务测试 PG 停止、浏览器关闭，期间未运行测试、构建、备份或 profiler。测量结束后才用一次不含 locals 的线程快照映射已有 /proc 差分。

| 服务 | 上轮单核均值 | 本轮单核均值 |
|---|---:|---:|
| market-runtime | 5.829% | 4.496% |
| data-worker | 2.528% | 2.488% |
| postgres | 2.497% | 2.114% |
| ntfy | 0.831% | 0.823% |
| notification-worker | 0.472% | 0.449% |
| api | 0.374% | 0.369% |
| web + TLS | 0.003% | 0.003% |
| 合计 | **12.534%** | **10.742%** |
| 四核整机 | **3.134%** | **2.685%** |

| 样本 | 报价数 | PG 单核 | 合计单核 | 四核整机 |
|---|---:|---:|---:|---:|
| 1 | 1064 | 2.265% | 11.192% | 2.798% |
| 2 | 902 | 2.039% | 10.398% | 2.600% |
| 3 | 979 | 2.036% | 10.635% | 2.659% |

本轮 **2,945 报价，3.271/s**，上轮 **4,085，4.537/s**，速率降低 **27.9%**。总 CPU 观测降低 **14.3%**，不是同负载受控降幅。全服务 CPU 时间/报价 **27.63 → 32.84ms**，固定后台成本摊入更少报价使该比值上升；它不是报价延时，也不作为本轮优化效果的单独证据。

pricing 线程 **3.178% → 1.910%**（原始降幅约 39.9%），其中含报价速率下降影响。按接受报价折算该线程 CPU 时间 **7.004 → 5.840ms/quote**（约低 **16.6%**）；仍含心跳/流处理固定成本。与固定输入交替回放的改善方向相符，不把原始约 40% 降幅全归因于代码。

| 线程 | 本轮单核均值 |
|---|---:|
| pricing | 1.910% |
| composite_aggregate | 1.080% |
| oanda-confirmation | 0.732% |
| history_compute | 0.295% |
| history_network | 0.269% |
| alert_indicator | 0.253% |
| chart_alert | 0.201% |
| chart_history | 0.168% |
| chart_aggregation | 0.166% |

三段均各新增 **15 个确认输入、135 个组合周期产物**，合计 **45 / 405**。数据库 **36,606 commits、0 rollback**，1,174 inserts、19,303 updates、243 deletes；ProviderBar 三段均无写入、无 sequential scan。buffer reads **1,448**，是 shared-buffer miss 计数，不能称为物理磁盘读取。

**最终复核 38 角色健康、3 connected+ready，最近接收年龄均小于 3 秒。全服务单核 3%（四核 0.75%）目标仍未达到。** pricing 改善后，组合聚合约 1.080%、确认约 0.732% 基本保持，data-worker 约 2.488%、PostgreSQL 约 2.114% 仍有固定后台开销；本轮没有擅自扩大到下一项优化。开发运行镜像、旧镜像、配置和备份保留，测试 PG 停止但 volume 未删除。

原始证据、运行脚本、私有配置及回退材料保存在 `~/.local/share/market-watch-dev/updates/pricing-v5-20261112/`，不提交凭据或浏览器状态。
