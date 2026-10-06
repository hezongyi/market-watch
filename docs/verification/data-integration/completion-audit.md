# P0–P2 完成门槛逐项审计

2026-10-06。实际运行 Ubuntu 本机 Docker project `market-watch-data-integration`，
访问 http://127.0.0.1:16589/market-data 。启动、停止和复现命令见 [runbook](README.md)。
MT4 实时留到后续；OANDA 故障只降级，不切源。目标仍 active。

| 门槛 | 当前结论 | 证据 / 剩余工作 |
| --- | --- | --- |
| 来源身份、元数据及迁移 | 已验证 | 独立来源/账户/BID/日历身份，旧 series 不重绑；后端及 PostgreSQL 回归 |
| 生产存量和备份恢复 | 已验证 | [只读清点](production-legacy-inventory.json)、[Ubuntu 恢复](production-backup-ubuntu-restore.json)；未迁移生产 |
| 真实 Python SDK 历史采样 | 已验证 | [最早年、近月、跨年/DST](dukascopy-samples.json)，SDK 4.0.1 |
| 历史中断、检查点及租约 | 已验证 | [graceful restart](history-worker-restart.json)、[冻结 running 后 SIGKILL](history-worker-crash.json)；旧 chunks 保留 |
| XAUUSD 十年固定查询区间 | 已发布、原始内容校验通过 | [全量审计](history-ten-year-integrity.json)：3,540,725 observed / 1,718,155 unknown；unknown 不等于确认闭市 |
| EURUSD 十年固定查询区间 | 进行中 | [真实六位价格证据](dukascopy-eurusd-six-decimal-page.json)；五位父任务隔离，六位身份由不可变 chunks 派生后续传 |
| 来源会话及有限适用范围 | 代码及合成回归已验证；实际证据仍不充分 | [一手研究](source-calendar-research.md)；账户法律实体/地区和十年例外未证明，实际 calendar_verified=false |
| 固定历史版本与回放不变 | 已验证小时版本 | [真实再导入](replay-real-reimport.json)、[样本完整性](history-sample-integrity.json)；十年最终版本待发布后选用 |
| 实际 practice 账户和共享流 | 已验证双品种及十品种 | [账户采样](oanda-stream-probe.json)、[十品种 50 completed M1](load-ten-symbols.json)；无外部通知投递 |
| 断线、401/429、单品种、浏览器恢复 | 已验证 | fault-pause-30s/120s、fault-restart、fault-unauthorized、fault-rate_limited、fault-single_symbol、browser-acceptance |
| 真实规则到本地 signal/notification/outbox | 单样本已验证 | [561ms 本地信号](live-signal-runtime.json)，保持一个信号；外部 delivery disabled |
| 两活跃交易日、欧美段、跨日和黄金暂停/恢复 | 尚未达到时长 | [03:50:58 UTC 新窗口](sustained-observation-window.json)，计划至 2026-10-08；[原中断窗口](sustained-observation-window-interrupted.json)保留错误 |
| 全窗口 p50/p95/p99 与缺失/失败/迟到分母 | 等待持续窗口 | backend receive、Chromium receive→browser、M1→confirmation/evaluation 分别记录；短负载不代替长期结果 |
| 时钟误差说明 | 接收机 NTP 已采样；供应商时钟偏差未独立证明 | [窗口时钟](receiver-clock-sync-window.txt)，同主机 browser/backend；不将源时间差宣称为纯传输延迟 |

所有“已验证”只指链接对应的实际样本/范围，不扩大为全部 P0–P2 验收通过。
来源会话未知保持 unknown，不能为了满足覆盖门槛裁剪边界柱、补价格、静默减分母或换成 MT4。
