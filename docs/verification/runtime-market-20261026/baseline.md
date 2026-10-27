# 阶段 0：并发基线

基线镜像来自 `v1.29.1` / `78697159067e1c1bc6c38be8ca8218cd12c29179`，OCI revision 与 dirty 状态已核实。仅 Ubuntu 本机隔离任务数据库；不访问生产、不使用真实供应商/ntfy 网络。五场各 61 个两秒报价、约 124–126 秒，六个独立 owner 进程共用 probe cgroup。一个复合品种、七条规则、九个周期和一个 ProviderInterest 前台低频请求。PG14.24，JIT off，0.75 CPU/768 MiB；probe 1.5 CPU/1536 MiB，各 owner pool2/overflow0。完整逐样本及资源证据为 `results/runtime_baseline_*.json`、对应 JSONL 和 `baseline-summary.json`；容器环境记录在 `results/environment.json`。

该机器当时有其他任务容器运行，MemAvailable 约 6 GiB、swap 几乎耗尽，load average 约 6–9。所测容器无 OOM，记录到一次 6.4 ms cgroup throttle；这只能描述竞争环境，不代表空闲宿主机容量。前台查询每场实际调用 8–9 次；该探针只调用真实 ProviderInterest 调度/服务边界与合成 adapter，不覆盖完整 HTTP/browser/SSE。

| 场景 | 候选循环间隔 | 候选就绪 | 预期事件 | 窗口 oracle | 未处理输入/规则对 |
|---|---:|---:|---:|---|---:|
| normal | 1 s | 不适用 | 13/13 | 通过 | 1 |
| busy（历史、周期、指标积压） | 1 s | 不适用 | 13/13 | 通过 | 1 |
| candidate（历史/九周期/EMA 与实时同时） | 1 s | 28.20 s | 13/13 | 通过 | 2 |
| slow-source（合成供应商请求超时） | 1 s | 不适用 | 13/13 | 通过 | 2 |
| candidate aggressive control | 0.05 s | 14.04 s | 12/13 | 末段 price_intrabar 窗口缺失 | 1 |

Oracle 按单条规则、预定时间窗检查，防止一次窗口的重复事件抵消另一窗口漏发。所有已产生的信号均有 projection 和 mock ntfy accepted；candidate aggressive control 的缺窗不会被其它类别事件或总数掩盖。normal/busy/slow-source 中，未处理配对集中在分钟切换时 EMA 暂处 warming；candidate 标准节奏还在初始化期漏观测了一对 EMA 输入。事件窗口仍成立，但这些配对是未处理数据，不能当作完整扫描。

输入到判定的 artifact 延迟按 `issued` 至 commit observer 的保守上界。normal/busy 中 price intrabar p95 约 0.85/1.02 s，EMA intrabar 0.87/0.88 s，确认 price close 1.07/0.89 s，ATR close 小样本最大 2.73/1.81 s。candidate 标准节奏相应 p95 为 1.48/1.77/1.15/3.16 s。每类 close/ATR 仅四个配对，不能据此声称长期百分位。M1 publication 每场只有两个确认点，观察上界 p95 0.38–0.46 s。实际事件到 NoticeEvent 和 mock server accepted 的逐信号观测在 JSON 摘要中；没有手机到达结论。

候选 aggressive control 将准备缩短至 14.04 s，但 alert CPU 约 30.8s 对标准候选 31.0s变化不大，history CPU 从约 9.6s 升至 30.5s、aggregate CPU 约 6.5s，SQL 读写和判定 p95 同时上升，且遗漏末段一条盘中事件。该控制只改变既有 fixture worker 的循环间隔，不是新的优先级/预算调度器，不能证明低优先级预算实现；它证明候选准备加速存在争用及事件正确性风险。A08 必须在五/六服务真实装配下重测并提供有界调度预算。

其他实际证据：五场所有 owner 正常退出，未发布确认输入为零，ProviderInterest 轮询各 8–9 次。实例盘点在五个 fixture schema 均见七条 composite 规则、一个 mapping、四个实时消费者、OANDA revisions12（seed10 + 两个受控新分钟）；旧 binding、旧 judgment、保存图表和旧 provider/managed 规则数为零仅限这些合成库。任何一项都不能证明生产记录为空或授权变更。Dukascopy 覆盖、真实 OANDA 日增长、30 天外引用均未触达生产，留待获准切换盘点。

恢复计时、完整 live revision / pricing publish 状态机、浏览器/SSE、真实网络、长期 p99、空闲宿主资源均不在此探针覆盖范围。特别是短暂 stale/重新 warming 会产生未处理输入配对，阶段 2 需要补定位与回归。本结果不对建议业务门槛作通过/失败认证。
