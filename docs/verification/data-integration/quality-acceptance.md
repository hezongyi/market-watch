# P0–P2 质量验收

2026-10-06。结论：**未通过，持续验收待恢复**。
[实现验收](implementation-acceptance.md)已经独立通过；整体目标仍active。
质量验收保留正式方案第10节的全部长期测量、覆盖、失败/迟到分母与来源证据要求。

| 质量要求 | 当前结论 | 剩余证据 |
| --- | --- | --- |
| 至少两个活跃交易日、欧美活跃段、跨日、黄金维护及恢复 | 未完成；两个宿主观察进程已失败退出 | 原计划10月8日结束不能作为完成事实；恢复前保留中断，恢复后独立记录新窗口及实际覆盖，不拼接成连续运行 |
| M1确认候选p95≤15s、p99≤30s与预警计算分布 | 未完成 | 结束后按全窗口和阶段统计；[首个EUR32.005s](m1-first-late-detail.json)及[恢复失败分钟](m1-recovered-failed-minutes.json)必须保留，短窗口p99回落不等于故障修复 |
| 报价价龄、后端接受更新率、浏览器可见更新率 | 工具与短样本已验证，长期待完成 | 完整时间分母包含unknown、闭市、无观测、失败及间隙；1s合并不验收全tick，各测量窗口分别统计 |
| 每条规则的长期状态与推进 | 中断前可见推进，未完成时长 | [原规则摘要](rules-disk-interrupted-summary.json)；首值是基线、跳变不补造执行，轮询上界与后端阶段耗时分别报告 |
| 来源会话、维护、假日和十年unknown归因 | 证据不充分 | [一手研究](source-calendar-research.md)；OANDA账户division/法律实体/地区及Dukascopy Python十年例外未证明，实际calendar_verified=false；不减少原始unknown分母 |
| 时钟及测量误差说明 | 接收机NTP已采样，供应商偏差未独立证明 | [接收机记录](receiver-clock-sync-window.txt)及逐规则小时样本；源到接收时差不宣称为纯网络延迟 |
| 多品种、历史并发与恢复性能 | 短时真实样本通过，长期尚未通过 | [十品种50根M1](load-ten-symbols.json)最慢13.399s；正常、部署、异常、补数分别汇总，不能用短样本替代持续观察 |
| 完整历史回放使用体验 | 功能通过，性能限制仍存在 | [API记录](ten-year-replays.json)同步预热411/439秒；不截断完整预热来制造快响应；质量报告明确实际限制 |
| Ubuntu验收宿主持续可用性 | 已发生磁盘写入失败 | [中断证据](observation-disk-interruption.json)；只清理明确本任务资源，不清理其他任务或全局prune；恢复后重新证明记录持续追加 |

## 当前中断与时间安排

浏览器PID2266365于 **2026-10-06 06:41:44UTC** 失败退出，规则PID2669988于
**06:42:06UTC** 失败退出。规则日志明确 `OSError: [Errno 28] No space left on device`；
浏览器只有脱敏失败记录，不能仅凭同一时段证明其具体根因。六个验收容器仍运行，
API和PG健康；[只读当前状态](implementation-runtime-current.json)证明发布版本与推进后的规则。

原始JSONL保持原字节，规则尾部116字节未完成JSON单独计数和hash，
[浏览器摘要](browser-disk-interrupted-summary.json)/[规则摘要](rules-disk-interrupted-summary.json)
明确仅统计成功解析记录，不隐藏损坏尾部。原窗口不作为完整48小时验收。
[连接变化](first-sustained-epoch-transition.json)保存06:43UTC epoch50及随后恢复，
没有据此推断网络、宿主或供应商根因。

原预计10月8日12:42（新加坡时间）结束的质量窗口已经中断，**该收口时间失效**。
恢复观察时会记录实际新起点，最早在新起点48小时后做质量汇总；
还须来源适用性、完整分布与覆盖门槛通过，才能宣称整体完成。
实现交付不需要等待质量窗口，质量报告不因时间到达自动改为通过。

10:27UTC重新核对：两个观察service仍failed/MainPID0，六个Docker服务仍running，
API和PG健康，Ubuntu宿主仅余约429MB。只读计数本任务API/OANDA/PG/web日志合计约6MB，
ignored验收文件约58MB，删除这些不足以解决容量压力；保留原证据及历史版本。
已请求Ubuntu扩容或有余量的Ubuntu本地数据目录，未清理其他任务或生产资源，未转移到unraid。
