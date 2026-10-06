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
| EURUSD 十年固定查询区间 | 已发布、全量原始内容及派生 provenance 通过 | [全量审计](history-ten-year-integrity.json)：3,724,278 observed / 1,534,602 unknown；685 个前缀 chunks 与父任务原分块逐块一致 |
| 来源会话及有限适用范围 | 代码及合成回归已验证；实际证据仍不充分 | [一手研究](source-calendar-research.md)；账户法律实体/地区和十年例外未证明，实际 calendar_verified=false |
| 存量候选聚合完整性 | 修正完成 | [实际核对](calendar-revalidation.json)：520,262 标记核对，116 个 XAUUSD 不支持的 complete 撤销；M1/不可变历史/固定回放保留 |
| 固定历史版本与回放不变 | 两品种十年 API 与浏览器均通过 | [十年回放](ten-year-replays.json)验证数百万根预热、step/seek 与同源再导入不改 pinned input；[浏览器](ten-year-browser.json)验证版本选择、恢复及未来隐藏 |
| 实际 practice 账户和共享流 | 已验证双品种及十品种 | [账户采样](oanda-stream-probe.json)、[十品种 50 completed M1](load-ten-symbols.json)；无外部通知投递 |
| 断线、401/429、单品种、浏览器恢复 | 已验证 | fault-pause-30s/120s、fault-restart、fault-unauthorized、fault-rate_limited、fault-single_symbol、browser-acceptance |
| 真实规则到本地 signal/notification/outbox | 单样本已验证 | [561ms 本地信号](live-signal-runtime.json)，保持一个信号；外部 delivery disabled |
| 持续完成柱规则计算 | 已建立，实际逐分钟推进；长期未完成 | [规则起点](sustained-m1-watches-start.json)、[当前规则](sustained-m1-watches-checkpoint.json)；04:08 起真实存在，不能回填之前无规则的时段 |
| 两活跃交易日、欧美段、跨日和黄金暂停/恢复 | 尚未达到时长 | [04:04:14 UTC 新窗口](sustained-observation-window.json)，计划至 2026-10-08；[原中断窗口](sustained-observation-window-interrupted.json)保留错误 |
| 全窗口 p50/p95/p99 与缺失/失败/迟到分母 | 等待持续窗口 | backend receive、Chromium receive→browser、M1→confirmation/evaluation 分别记录；短负载不代替长期结果 |
| 有界逐时段分母及观察分组 | 实际只读 PostgreSQL 快照通过 | [分段快照](sustained-live-report-checkpoint.json)、[9 个统计回归](sustained-report-tests.txt)；未观测/unknown/闭市/补数分别列出，伦敦纽约分组及黄金 NY17–18 均非官方会话证明 |
| 时钟误差说明 | 接收机 NTP 已采样；供应商时钟偏差未独立证明 | [窗口时钟](receiver-clock-sync-window.txt)，同主机 browser/backend；不将源时间差宣称为纯传输延迟 |

所有“已验证”只指链接对应的实际样本/范围，不扩大为全部 P0–P2 验收通过。
来源会话未知保持 unknown，不能为了满足覆盖门槛裁剪边界柱、补价格、静默减分母或换成 MT4。

04:35 UTC 的实际分段快照：两品种各30个已确认完整分钟，missing/fail/over30s均为0，
M1确认 p95 为 XAU 7.638s、EUR 11.237s，p99 为 XAU 10.485s、EUR 11.624s。
04:09首根合格规则柱之后分别有27个入库与规则阶段审计；这些审计不含逐规则执行记录，
规则连续活跃还需结合起点、当前last_event及长期观察判断，不能只凭阶段审计认定。
浏览器62块，errors0、无心跳块0，原始不健康状态仍保留。此记录仅为短窗口进展。
浏览器计划于10月8日04:04:14UTC结束；规则48小时窗口须独立延续并检查至04:09UTC之后。
