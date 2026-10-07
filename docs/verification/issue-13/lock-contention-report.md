# P0 外部品种锁争用

2026-10-07 00:39UTC 在 Ubuntu quant-server 的独立 Compose project `mw-issue13-p0`、PG14 数据库 `issue13` 实际完成。只重置本任务合成 fixture；没有供应商、通知、网页或生产访问。入口为当前主线 `0591e56` 的真实 `managed_dataset.publish_once()`，未修改发布逻辑。

独立 PostgreSQL 事务锁定 BTCUSDT 的 Instrument 行；真实 publisher 在另一个连接执行相同 M1 目标。观察者每约100ms查询 `pg_stat_activity` 与 `pg_blocking_pids`，不收集SQL文本。持锁者、观察者使用独立 NullPool engine，不占用应用的2连接池。释放锁后继续原有九周期轮转，直到 EURUSD M1 获得正常执行。

| 实测项目 | 结果 |
| --- | --- |
| 同一 BTCUSDT M1 目标、无锁对照 | 270.75ms |
| 外部事务持锁时间 | 3.066s |
| 持锁时实际发布调用耗时 | 3.275s |
| 明确关联到持锁者的 Lock 样本 | 30次，等待 transactionid |
| 锁期间 EURUSD 已发布 M1 读取 | 10行、15.53ms |
| 释放后 EURUSD M1 完成 | 实验起点后4.704s |
| 前后完整 published bar 指纹 | 26,290行相同 |
| 前后可见 publication 元信息 | 相同（updated_at独立排除） |

实验通过的含义是：真实阻塞被明确观察、锁释放后正常恢复、无输入快照稳定。串行发布调用等待 BTCUSDT 行锁期间没有启动其他发布目标，而 EURUSD 已提交快照的读取仍可完成。健康目标耗时还包含正常周期轮转与宿主调度，不能把4.704秒全部归为锁等待；一次人工3秒锁不证明自然锁频率、生产吞吐或最长等待门槛达标。这不是 API/告警时延或并发世代正确性验收，也不支持提前修改锁顺序或把计算移出事务。

首次探针因持锁者占用了应用2连接池而在读取检查时发生连接池超时，未产生有效锁基线；[失败记录](results/lock-contention-initial-pool-failure/failure-note.json)、当次执行源码和日志均保留。修正探针外部连接配置后才产生上述结果，没有更改产品连接池或以失败样本计算收益。

执行命令：`python3 -u docs/verification/issue-13/run_lock_contention.py`。runner拒绝覆盖既有结果、要求本任务无运行服务、只启动自己的PG和临时probe，finally停止PG。既有结果需先明确归档才能重跑；PG单独启停命令见[README](README.md)。PG只在Ubuntu `127.0.0.1:19613` 提供本地连接，当前已停止（exit0、OOM=false），probe已移除，合成卷保留。

证据：[真实调用与阻塞原始记录](results/lock-contention/result.json)、[宿主采样](results/lock-contention/host.jsonl)、[停止状态](results/lock-contention/postgres-stopped.json)、[探针](lock_contention_probe.py)、[runner](run_lock_contention.py)。执行源码SHA保留在原始结果内。此补测不改变P1–P3必须等待三层合并的条件。
