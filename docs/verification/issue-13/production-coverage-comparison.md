# 正式实例覆盖只读对照

在正式worker内执行有5秒statement timeout的read-only repeatable-read SELECT，Ubuntu本地计算区间；未创建unraid实例、修改数据或迁移。凭据未导出。

| 身份 | 审计数 / 当前basis | 结构化匹配行 | 旧路径减结构化缺少分钟 | 缺source审计 | 异常审计 |
| --- | --- | --- | --- | --- | --- |
| EURUSD / oanda / bid | 31138 / 31138 | 13971 | 264964 | 0 | 0 |
| XAUUSD / oanda / bid | 31384 / 31384 | 13968 | 266161 | 0 | 0 |

区间差集与格式分母见 [production-coverage-comparison.json](production-coverage-comparison.json)，原始白名单字段见 [production-coverage.jsonl.gz](production-coverage.jsonl.gz)，压缩往返与SHA256记录见 [manifest](production-coverage-manifest.json)。

旧路径有效区间包含审计与结构化并集，按旧received_at五秒余量与完整分钟裁切；没有使用迁移当前时间扩展证明。缺source不等于允许猜测来源；explicit错误source单独计数。异常记录隔离只是对照行为，不代表当前生产读口可容错。

此为单时刻区间对照。即使没有差集，仍须演练历史补齐与并发追赶、下游结果一致性及回退，方可切换读路径；没有以本报告授权生产修改。
