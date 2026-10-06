# P0–P2 质量验收

2026-10-06。结论：**未通过，已恢复后台观察**。
[实现验收](implementation-acceptance.md)已经独立通过；整体目标仍active。
质量验收保留正式方案第10节的全部长期测量、覆盖、失败/迟到分母与来源证据要求。

| 质量要求 | 当前结论 | 剩余证据 |
| --- | --- | --- |
| 至少两个活跃交易日、欧美活跃段、跨日、黄金维护及恢复 | 未完成；清理磁盘后已启动新独立观察窗口 | 原计划10月8日结束不能作为完成事实；已保留中断，重新记录新窗口及实际覆盖，不拼接成连续运行 |
| M1确认候选p95≤15s、p99≤30s与预警计算分布 | 未完成 | 结束后按全窗口和阶段统计；[首个EUR32.005s](m1-first-late-detail.json)及[恢复失败分钟](m1-recovered-failed-minutes.json)必须保留，短窗口p99回落不等于故障修复 |
| 报价价龄、后端接受更新率、浏览器可见更新率 | 工具与短样本已验证，长期待完成 | 完整时间分母包含unknown、闭市、无观测、失败及间隙；1s合并不验收全tick，各测量窗口分别统计 |
| 每条规则的长期状态与推进 | 中断前可见推进，未完成时长 | [原规则摘要](rules-disk-interrupted-summary.json)；首值是基线、跳变不补造执行，轮询上界与后端阶段耗时分别报告 |
| 来源会话、维护、假日和十年unknown归因 | 证据不充分 | [一手研究](source-calendar-research.md)；OANDA账户division/法律实体/地区及Dukascopy Python十年例外未证明，实际calendar_verified=false；不减少原始unknown分母 |
| 时钟及测量误差说明 | 接收机NTP已采样，供应商偏差未独立证明 | [接收机记录](receiver-clock-sync-window.txt)及逐规则小时样本；源到接收时差不宣称为纯网络延迟 |
| 多品种、历史并发与恢复性能 | 短时真实样本通过，长期尚未通过 | [十品种50根M1](load-ten-symbols.json)最慢13.399s；正常、部署、异常、补数分别汇总，不能用短样本替代持续观察 |
| 完整历史回放使用体验 | 功能通过，性能限制仍存在 | [API记录](ten-year-replays.json)同步预热411/439秒；不截断完整预热来制造快响应；质量报告明确实际限制 |
| Ubuntu验收宿主持续可用性 | 已发生磁盘写入失败 | [中断证据](observation-disk-interruption.json)；只清理明确本任务资源，不清理其他任务或全局prune；恢复后重新证明记录持续追加 |

## 已归档的磁盘中断

浏览器PID2266365于 **2026-10-06 06:41:44UTC** 失败退出，规则PID2669988于
**06:42:06UTC** 失败退出。规则日志明确 `OSError: [Errno 28] No space left on device`；
浏览器只有脱敏失败记录，不能仅凭同一时段证明其具体根因。六个验收容器仍运行，
API和PG健康；[只读当前状态](implementation-runtime-current.json)证明发布版本与推进后的规则。

原始JSONL保持原字节，规则尾部116字节未完成JSON单独计数和hash，
[浏览器摘要](browser-disk-interrupted-summary.json)/[规则摘要](rules-disk-interrupted-summary.json)
明确仅统计成功解析记录，不隐藏损坏尾部。原窗口不作为完整48小时验收。
[连接变化](first-sustained-epoch-transition.json)保存06:43UTC epoch50及随后恢复，
没有据此推断网络、宿主或供应商根因。

## 当前观察与交付安排

用户决定先提交实现 PR，Ubuntu 隔离实例继续后台质量观察；发现需要修改的问题再提交修复 PR。
质量未通过不阻塞实现 PR，也不代表生产发布或合并授权。

“至少两个活跃交易日”来自正式方案第10节；连续48小时是工程观察方式，
不是 Dukascopy/dukascopy-python 官方要求，也不是提交PR的必要条件。
本轮主要验证本项目新增的存储、聚合、OANDA实时、SSE与规则链路。
维护中的SDK不替代这些集成验证，后台观察也不证明供应商数据毫无缺失。

经用户授权按明确归属清理8个已完成/被替代的Ubuntu Compose项目及可重建下载/编译缓存，
保留活动实例、源码、原验收记录和私密数据库备份；没有全局prune，没有操作unraid。
[清理实测](ubuntu-cleanup-result.json)显示可用空间恢复至约16GiB；
数据库新增粗估1–3GiB/48h，原始观察约20MB，具体估算见[容量清点](ubuntu-capacity-inventory.json)。
其他任务并发仍会改变余量。系统journal清理因权限不足未执行，镜像与build cache未删除。

原始JSONL已按[归档清单](observation-restart-archives.json)保留原字节和hash，
旧窗口元数据分别保存为[浏览器](sustained-observation-window-disk-interrupted.json)与
[规则](rules-observation-window-disk-interrupted.json)。当前raw使用新文件，不能拼接旧窗口时长。

- 浏览器PID2233613：[新窗口](sustained-observation-window.json)，
  2026-10-06 10:47:53.719UTC → 2026-10-08 10:47:53.719UTC。
- 规则PID2233614：[新窗口](rules-observation-window.json)，
  2026-10-06 10:47:48.874UTC → 2026-10-08 10:47:48.874UTC。
- 完整源分钟/规则计算起点为1791283680000（10:48UTC）。

两个service已核对active/running，新记录继续追加。预计 **10月8日18:47（新加坡时间）**
结束本轮观察并汇总；时间到达不会自动判为质量通过，实际交易覆盖、分布及来源证据仍须说明。
原预计10月8日12:42收口已失效。历史磁盘中断与迟到/失败证据不删除。
