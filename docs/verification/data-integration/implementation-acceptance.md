# P0–P2 实现验收

2026-10-06。结论：**实现验收通过**，可作为独立功能交付。
用户要求将实现验收与质量验收分开；[质量验收](quality-acceptance.md)尚未通过，
整体目标保持 active。实现通过不表示长期性能、供应商日历或生产发布已经通过。

验收范围：Dukascopy Python 历史与固定版本回放、OANDA practice 实时，首批EURUSD/XAUUSD。
用户明确的聚合口径：历史BID M1由本系统按纽约当地17:00切H4/D1，随DST转换；
不要求与Dukascopy原生高周期K线一致。会话证据另用于缺失分钟与完整性判断。
MT4实时互备延期；OANDA故障时降级与暂停依赖缺失数据的判断。保留Binance/yfinance既有能力。

实际环境：Ubuntu本机隔离Docker project `market-watch-data-integration`，
PostgreSQL14、API、历史/实时/聚合worker及web。访问 http://127.0.0.1:16589/market-data 。
代码位于 `/home/quant/repos/market-watch-data-integration`，分支 `feat/market-data-integration`，
已验收运行实例业务基线3c18f60、最后部署业务修改42ec051。
本地worktree另已整合origin/main 826d316（v1.11），[兼容检查](main-compatibility.json)
记录回归及迁移合头；这部分未部署到后台观察实例，PR按用户最新指示暂缓。
启动、停止及复现见[runbook](README.md)。没有生产迁移、发布、下单或外部通知送达验收。

| 实现要求 | 结论及直接证据 |
| --- | --- |
| 来源/通道/环境/账户/BID/日历身份与旧数据隔离 | 通过；[契约回归](contracts-tests.txt)、[真实PG回归](postgres-tests-calendar-final.txt)；既有series不重绑，显式身份与不可变元数据受保护 |
| 存量清点、迁移及备份恢复路径 | 通过；[生产只读清点](production-legacy-inventory.json)、[Ubuntu恢复现有备份](production-backup-ubuntu-restore.json)；只证明恢复及迁移路径验证，未执行生产迁移 |
| 真实SDK、有界导入、精度及错误结果 | 通过；[真实采样](dukascopy-samples.json)、[六位原始页](dukascopy-eurusd-six-decimal-page.json)、[精度派生](history-precision-derivation.json)；SDK4.0.1，精度溢出明确失败，不取整/换源 |
| 检查点、任务租约、崩溃恢复、不改旧分块 | 通过；[正常重启](history-worker-restart.json)、[实际SIGKILL](history-worker-crash.json)、[分块全量校验](history-ten-year-integrity.json) |
| 两品种十年固定版本发布及unknown分区 | 通过；[全量内容审计](history-ten-year-integrity.json)、[当前发布状态与校验和](implementation-runtime-current.json)；区间2016-10-06至2026-10-06，observed/unknown分别明确，不把unknown解释为闭市 |
| 不可变版本回放、预热、step/seek、再导入不改输入 | 通过；[真实十年API回放](ten-year-replays.json)、[真实浏览器恢复](ten-year-browser.json)；完整预热数百万根，页面未来隐藏，输入校验和不变 |
| 会话证据契约与保守聚合 | 通过；[日历回归](backend-tests-calendar-final.txt)、[PG日历回归](postgres-tests-calendar-final.txt)、[实际候选聚合修正](calendar-revalidation.json)；未知会话保持unknown，来源冲突保留真实柱；适用性认证另列质量门槛 |
| 账户目录、共享stream、租约/世代、常驻与需求 | 通过；[实际账户](oanda-stream-probe.json)、[十品种](load-ten-symbols.json)、[浏览器共享订阅](browser-acceptance.json)、[PG并发回归](postgres-tests-calendar-final.txt) |
| REST完成M1确认与故障降级/恢复 | 通过；[30秒](fault-pause-30s.json)、[120秒](fault-pause-120s.json)、[restart](fault-restart.json)、[401](fault-unauthorized.json)、[429](fault-rate_limited.json)、[单品种停更](fault-single_symbol.json)；401/429为本地响应接缝，其余仍真实上游 |
| Health/SSE、临时与确认柱、版本及监控UI | 通过；[桌面/手机及断网恢复](browser-acceptance.json)、[冷却接口真实部署](cooldown-health-runtime.json)、[冷却PG验证](cooldown-health-container-tests.txt)、[API/worker函数核对](cooldown-health-code.json) |
| 同源规则、信号防重与本地notification/outbox | 通过；[真实信号561ms样本](live-signal-runtime.json)、[本地outbox](local-notification-outbox.json)、[当前两规则推进](implementation-runtime-current.json)；外部delivery关闭，长时连续性另列质量门槛 |
| 完整测量分母和观察工具 | 通过；[逐时段回归](sustained-report-tests.txt)、[更新率回归](update-rate-tests.txt)、[规则实测含续期](rule-observer-validation.json)、[浏览器续期](observer-auth-renewal.json)；工具已实际运行，未达48小时不算质量通过 |

回归证据：后端[612 passed/48 skipped](backend-tests-calendar-final.txt)，
Ubuntu真实PG[144 passed](postgres-tests-calendar-final.txt)；之后冷却改动
[28项本地](cooldown-health-tests.txt)/[12项容器](cooldown-health-container-tests.txt)通过。
跳过项不视为通过；实际功能证据按表中范围判断。此次仅拆分文档和核对当前只读状态，未重建镜像或重复全量测试。

实现交付的质量限制必须随交付保留：来源日历未认证、供应商clock offset未独立证明、
完整回放同步预热约411/439秒，以及长观察中已有迟到、中断和宿主磁盘写入失败。
这些由[质量验收](quality-acceptance.md)独立跟踪，不从整体完成门槛删除。
