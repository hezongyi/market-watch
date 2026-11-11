# 开发实例持续 CPU 占用诊断

2026-11-11；范围：只读观察现有 Ubuntu `mw-dev` / v2.0.6，应用基线 `d2a3e092`。
本次没有调整 worker、轮询频率、业务数据或运行版本，没有执行 shadow、激活或清理。

## 结论

发现可确认的 shadow 失败重试循环，以及观测时间更新带来的聚合/发布写入放大。
实时行情订阅同时保持活跃，因此本次不能作为关闭网页后的纯空闲 CPU 基线。
不能仅凭这组观测认定全部占用属于无效工作，也不能承诺修复后的具体 CPU 降幅。

## 三分钟连续观测

2026-11-11 13:41:29–13:44:32 UTC，共 19 个快照、18 个约十秒区间。
CPU 以 100% 为一个核心；前述瞬时采样不参与本次均值。

| 服务 | 平均 CPU |
|---|---:|
| data-worker | 67.51% |
| PostgreSQL | 30.73% |
| market-runtime | 17.49% |
| API | 15.95% |
| 开发前端 | 2.63% |
| notification-worker | 2.24% |
| ntfy | 1.55% |
| TLS | 0.07% |
| web | 0.05% |

约新增 9 根已发布 K 线，发布行 revision 累计增加 5,802。
19 次快照中 14 次聚合队列为空；非空队列随后会清空。
历史计划 cursor 未推进；实时尾部正常前进。因此不是长期历史积压在持续消耗 CPU。
数据库统计增加约 72,008 次 commit、32,724 次行更新，含本次监控查询。
这些计数是数据库整体工作量，不是某一个线程的精确归因。
完整脱敏摘要见 [summary.json](summary.json)。

## 明确异常：已生效候选被 shadow 重试

- 3 条 `baseline_shadow` 记录均为 failed / shadow_failed。
- 错误类型 ValueError，原因“修订请求编号已用于不同参数”。
- 观测时每条累计 attempts 为 109,619；另一个 15 秒窗口每条增加 13。
- 只读 JOIN 核实：相同请求编号的旧候选存在，而且已经是当前 active revision。
  历史版本和 seam 相同，但旧候选的 parent 与当前 active revision 不同。
- `baseline_shadow.candidate_plan()` 的 request_id 只包含 composite、历史版本和 seam。
  `create_candidate()` 每次将当前 active revision 写入 expected_revision_id。
  原候选生效后，同一 request_id 的请求参数因父修订改变而冲突。
- `composite_revisions.create()` 按完整请求 hash 验证幂等性，拒绝不同参数，行为本身正确。
- `baseline_shadow._finish()` 将错误保存为 failed；
  `switch_schedule.shadow_cycle()` 仍将失败视为 worked，`run_shadow()` 只等待 0.5 秒后重试。
  每次会重复读取、建立报告、更新状态，形成持续开销。

证据见 [shadow-retry-results.json](shadow-retry-results.json)。
优先修复方向：已启用的同一候选应完成或跳过；稳定失败应退避或等待相关输入变化。
不能通过关闭幂等校验、任意新建 request_id 或自动清除失败记录来掩盖冲突。

## 确认的写入放大：仅新鲜度变化

独立 16 秒窗口：新增 2 根 K 线，483 根已有发布行变化。
按各组字段变化计数，按字段计数的保守上界，最多 17 行涉及价格或成交量变化，至少 466 行仅元数据变化。
其中 397 行所在组严格只改变 observed_at。

调用链：`bar_batch.write_bars()` 在再次观测旧 M1 时更新 observed_at，
并为 M1 发布与五个聚合周期排队；`aggregate_observation.refresh()` 刷新对应聚合新鲜度并排发布。
`managed_dataset.publish_corrections()` 比较完整 payload，observed_at 变化也增加发布 revision。
实时获取默认会重读最近约 120 根 M1，放大了元数据传播工作。

这些时间戳是有效的新鲜度证据，不能直接丢弃或伪造。
优化需要保留告警与图表的新鲜度语义，再缩小元数据传播与历史重算的范围。
本轮未在现场关闭这条链路，不能给出它对总 CPU 的独立贡献率。

## 线程采样与真实订阅

无应用代码注入、无重启地从一次性本机诊断容器采样 Python 栈。
首轮 50 Hz / 0.25 CPU 出现采样落后，仅作定位；第二轮改为 10 Hz / 0.5 CPU、25 秒 GIL 采样。
第二轮有效 113 个样本、48 个读取错误，样本分布只能指示热点，不能当作精确 CPU 百分比。
两轮均指向 `market-stream_*`、`switch_shadow` 和 `chart_aggregation`。
见 [profile-summary.json](profile-summary.json)。

现场存在 1 个活跃 client、20 条订阅、18 个共享任务：
10 个平台报价、3 个组合报价，以及 M5/D1/W1/H4/H1 各一个平台 K 线任务。
这些订阅解释了部分计算需求，不能视为无人使用下的后台空转。

优先级：先修 shadow 的确定性失败循环，再优化观测元数据传播，最后测量无页面与有页面的订阅成本。
本轮只诊断；精确收益需在独立副本验证正确性后，以相同业务负载做前后对照。

## 本机原始证据

`/tmp/mw-dev-cpu-investigation-20261111/` 保存观察脚本、19 次快照、字段差分和两次 profile。
临时诊断容器已自动退出删除；没有停止或重建原服务。
详细快照含运行身份与时间戳，仅留本机，不复制到公开解释页。
一次调用 candidate_plan 的只读事务被 PostgreSQL 拒绝 SELECT FOR SHARE 后已回滚；
后续身份核对改用纯 SELECT JOIN，无业务写入。
