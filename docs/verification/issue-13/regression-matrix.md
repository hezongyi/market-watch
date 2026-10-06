# 合并后回归准备

这是执行清单，不表示已通过。核心修复在三层合并后按一条失败用例、一条修复的顺序推进；现有缺陷探针仅用作基线，不固定缺陷行为。

| 合同 / 场景 | 调用链与证据 | 当前状态 |
| --- | --- | --- |
| 无输入、无队列、无到期工作进入等待 | `aggregate_once → publish_once`；idle_probe 比较完整可见 snapshot 并断言进展为零 | 已实际运行，主线预期红灯；9/9 假进展 |
| 同价格新观察仍刷新匹配快照 | `write_bars → publish_once → published M1.payload.observed_at` | PG live 探针跟踪到可见时间；只覆盖 M1，新合同仍需高周期与告警链路 |
| 新分钟、覆盖扩展触发发布 | `ingest(defer_aggregation=True) → aggregate_once → publish_once` | PG live 输入与预期 M1 匹配，完整尾部缺口合同待修复期验证 |
| 显式扩大历史起点、跨页回填 | `join → publish_once`；比较快照行数和边界 | PG backfill 场景已短测，长测进行中 |
| 区间内价格与量修订 | `write_bars + enqueue_aggregation → aggregate_once → publish_once` | PG revision 探针跟踪 M1 价格和 volume；各高周期完整差分待修复期验证 |
| 无差异任务消费、空数据初始化、聚合阻塞 | 与真实持久任务、重试及消费者 API 联动 | 尚未编写最终回归；不能靠现有布尔值证明 |
| 并发 g+1 不被 g 确认清除 | 两个独立 PG 事务，源写入与变化同事务；消费旧世代期间提交新输入 | 需新 schema/合同后加入 PG 并发用例 |
| 计数幂等、事务回滚、提交前后崩溃 | 比较重试前后 OHLC/量/complete/计数/revision，并重启真实 worker | 未实施 |
| DST、NY17 日界、M30/W1/MN、unknown/闭市 | 构造跨日历桶的已知输入，通过统一图表/CSV/MCP读口核对 | 当前 fixture 有 NY17 H4/D1、M30/W1/MN；仅性能，不是完整日历正确性证明 |
| 覆盖补齐与切换 | coverage_probe 的区间差集、原 received_at 五秒余量、完整分钟 | 八个合成案例已运行；生产或其他现有库迁移等价性未证明 |
| 异常覆盖隔离与来源身份 | source/basis、缺 bounds、重复、分数分钟、损坏 range_start、缺 received_at | 已记录兼容链缺陷；不能把损坏数据猜测补齐 |
| 移除/修正覆盖、迟到修订与缓存失效 | 更新证明版本，验证下游及身份分离 | 未实施 |
| 10 目标公平性，实时与回填并存 | worker 轮转间隔、事件提交到可见、最老队列年龄 | PG 10 身份各场景记录轮转；混合实时与回填的长测仍待集成 |
| API/告警、防重、视区历史修订 | 实际消费者接口 + 同口径 CSV/MCP + 通知 outbox | 非空120次真实认证ASGI路由及120次PG evaluate微基线通过；无网络API/浏览器实例，不计整体通过；alert_read_probe验证published价格隔离/起点/观察时间且修复后零staging读 |
| 升级/回退、通知丢失（如采用） | 加法迁移演练，旧/新 worker 排他拥有；旧任务重建 | 未实施 |

真实供应商可用性、行情确认质量和三层就绪合同仍按三层方案验收。本任务合成负载不证明十个真实品种或来源 SLA。
