# 合并后回归准备

这是执行清单，不表示已通过。核心修复在三层合并后按一条失败用例、一条修复的顺序推进；现有缺陷探针仅用作基线，不固定缺陷行为。

| 合同 / 场景 | 调用链与证据 | 当前状态 |
| --- | --- | --- |
| 无输入、无队列、无到期工作进入等待 | `aggregate_once → publish_once`；idle_probe 比较完整可见 snapshot 并断言进展为零 | 已实际运行，主线预期红灯；9/9 假进展 |
| 同价格新观察仍刷新匹配快照 | `write_bars → publish_once → published M1.payload.observed_at` | PG live及补充mixed每身份同价观察可见；只覆盖M1，新合同仍需高周期与告警新鲜度链路 |
| 新分钟、覆盖扩展触发发布 | `ingest(defer_aggregation=True) → aggregate_once → publish_once` | PG live 输入与预期 M1 匹配，完整尾部缺口合同待修复期验证 |
| 显式扩大历史起点、跨页回填 | `join → publish_once`；比较快照行数和边界 | PG backfill 三份300秒长测已完成；队列空不代表全部历史补齐 |
| 区间内价格与量修订 | `write_bars + enqueue_aggregation → aggregate_once → publish_once` | PG revision 探针跟踪 M1 价格和 volume；各高周期完整差分待修复期验证 |
| 无差异任务消费、空数据初始化、聚合阻塞 | 与真实持久任务、重试及消费者 API 联动 | 尚未编写最终回归；不能靠现有布尔值证明 |
| 并发 g+1 不被 g 确认清除 | 两个独立 PG 事务，源写入与变化同事务；消费旧世代期间提交新输入 | 需新 schema/合同后加入 PG 并发用例 |
| 计数幂等、事务回滚、提交前后崩溃 | 比较重试前后 OHLC/量/complete/计数/revision，并重启真实 worker | 未实施 |
| DST、NY17 日界、M30/W1/MN、unknown/闭市 | 构造跨日历桶的已知输入，通过统一图表/CSV/MCP读口核对 | 当前 fixture 有 NY17 H4/D1、M30/W1/MN；仅性能，不是完整日历正确性证明 |
| 覆盖补齐与切换 | coverage_probe 的区间差集、原 received_at 五秒余量、完整分钟 | 八个合成案例与正式只读覆盖差集已完成；迁移补齐/并发追赶/下游等价与回退尚未演练 |
| 异常覆盖隔离与来源身份 | source/basis、缺 bounds、重复、分数分钟、损坏 range_start、缺 received_at | 已记录兼容链缺陷；不能把损坏数据猜测补齐 |
| 移除/修正覆盖、迟到修订与缓存失效 | 更新证明版本，验证下游及身份分离 | 未实施 |
| 10 目标公平性，实时与回填并存 | worker 轮转间隔、事件提交到可见、最老队列年龄 | PG各场景及新增300秒混合记录90目标轮转；20/20两类输入可见，最长等待29.55秒超目标；新调度待合并实施 |
| API/告警、防重、视区历史修订 | 实际消费者接口 + 同口径 CSV/MCP + 通知 outbox | 非空120次真实认证ASGI路由及120次PG evaluate微基线通过；新增120次实际TCP请求与十个M1触发/十唯一signal，短并发通过artifact审核；新增完整lifespan/真实网页/单浏览器双图/保存刷新短测通过；持续输入/成功供应商I/O未验收，不计整体通过；alert_read_probe验证published价格隔离/起点/观察时间且修复后零staging读 |
| 升级/回退、通知丢失（如采用） | 加法迁移演练，旧/新 worker 排他拥有；旧任务重建 | 未实施 |

真实供应商可用性、行情确认质量和三层就绪合同仍按三层方案验收。本任务合成负载不证明十个真实品种或来源 SLA。


接续补测（`d362766`之后新增，2026-10-07）：`supplemental_probe.py`已完成完整持久bar指纹、每身份两类输入及混合负载，结果见supplemental-report.md；`audit_supplemental.py`已通过原始事件分母、90目标、锁采样和300秒范围审核。`network_alert_probe.py`与`run_network_alert.py`已完成实际TCP API、发布循环和每秒告警step并发，十个新分钟各一个signal且无重复；network-alert-report.md保留超时指标及采样/SQL归因限制。它不包含provider lifespan、完整网页/浏览器或高周期触发合同。


网页补充：browser-report.md对应真实产品构建/原生库/Ubuntu PG/完整API lifespan六步骤，原始请求及CPU采样可审计。API与publisher外部网络隔离，固定历史/收盘告警可stale；不证明成功供应商线程负载或持续实时新鲜度。仍待新主线完整正确性与三重复验收。

外部锁补充：lock-contention-report.md已实测独立PG事务持有BTCUSDT品种行锁3.066秒，真实publish_once等锁3.275秒、30个明确blocker样本；另身份已发布读取可继续、释放后轮转恢复且完整快照稳定。人工单锁不证明生产锁频率、多锁顺序、世代并发或调度门槛通过；合并后的锁顺序/事务预算回归仍需验证。

高周期独立计算补充：high-period-report.md已完成十身份M30/W1/MN四阶段120案例，图表/CSV/MCP SDK各152页和告警stored_rows全量核对；独立预期不用产品聚合/快照函数，变化覆盖包括open/close/extrema/volume/volume_complete/revision/observed_at。最终实际PG20,014行快照可离线重算，12种副本破坏被拒绝；重复输入包含行revision和publication可见元信息的指纹相同。M15/D1为输入，仍不证明M1生成、DST/节假日、evaluate触发、覆盖撤回或并发世代。

持续观察补充：observation-alert-report.md已完成330秒、50/50准确同价新观察→发布→intrabar告警sequence推进，十个stale→ready且末次标记一致、零新增signal/源修订变化。提交可见与可见判断的p95/p99仍超冻结目标；采样有不确定性，未把功能路径通过当性能达标。仅同一完成M1的样本标记，无新分钟/上游/API/lifespan/网络/浏览器或通知，不替代触发、防丢并发和容量验收。
