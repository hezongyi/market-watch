# 空闲 CPU 优化验证

基线：PR #132 / 2d3c4509；实现：37d469a3、27dbe782。风险 F1：重要后台链路，
无 schema 或持久格式变化。用户要求不追踪 CI，本任务没有查询检查或 workflow run。

## 修改

- 开发 Uvicorn 保留热重载，扫描间隔从 0.25 秒增至 2 秒。
- 流与告警指标无需求等待 1 秒，通知投影无积压等待 2 秒；三个独立 PostgreSQL
  channel 在注册需求/生命周期操作/接受通知的原事务内发送，提交后立即唤醒。
  活跃告警/流与积压快节拍保留，错误退避不被通知打断，断线/丢提示仍有有界轮询，未引入高水位漏单风险。
- 纯观测聚合按已解析的实际桶区间定位源行，不再逐分钟重复日历计算；保持逐行
  内容/成交量/完成状态比较、待修复屏障、真实 observed_at 和普通派生发布路径。
- 清理先选取候选，纯过期删除或无候选不统计全表。每分钟过期清理不变，容量软配额
  每五分钟准确检查，失败后下一分钟重试；未假定数据库统计等于精确行数。

## 本地验证

新增前三个用例在修改前均失败：通知空闲 .5 秒、D1 分桶调用 2880 次、无容量需求仍 COUNT。
实现后新性能回归通过，D1 单桶只计算一次日历边界，同时全部 1440 源行仍参与内容核对。

主回归 [tests.log](tests.log)：361 passed、7 skipped。补充配置全部 PostgreSQL 连接参数后
[tests-extra.log](tests-extra.log)：30 passed；指定真实 v1.14.0 源码后
[tests-compat.log](tests-compat.log)：17 passed，覆盖前述所有跳过项目。
各组有重叠，不将相加视为独立用例总数。包含通知较小 ID 晚提交、提交/回滚/保存点、
通知故障恢复、真实需求入口、流并发/代际、告警健康/失败、23/25 小时 DST、发布/聚合
预算和公平性及真实旧 writer 回退后再升级。未运行完整仓库测试套件。

[Standards / Spec 独立审查](reviews.md) 通过；修改 Python 文件 Ruff 与 diff check 通过。

## 第二轮：发布和普通聚合成本

首轮开发实测 data worker 未下降，45 秒调用栈仍集中于聚合/发布。进一步发现：
M15/D1 快照已完整比对且原子刷新后仍被重复排入 native 发布；普通聚合回退也重复计算日历。
新增真实路径用例修改前失败：D1 fallback 分桶调用 1562 次、纯观测仍创建 native job。
修复仅让已证明内容相同的快照跳过 native 排队，M30/W1/MN 继续派生；价格、成交量、
完成状态不一致及 pending 仍完整修复，不删除既有任务或提前确认代际。
普通聚合复用桶边界并用 bisect 定位，保留全部源行及 coverage/完成/修复计算。

第二轮相关回归 [tests-publication-followup.log](tests-publication-followup.log)：
186 passed；包含真实 PostgreSQL、聚合规则、成交量、发布调度及死锁/交错回归。
各轮用例有重叠，不合计独立数量。第二轮独立 Standards/Spec review 通过。

## 开发实例验收

实际主机 Ubuntu quant-server（4 CPU），project mw-dev。
入口 <https://192.168.7.232:18443>；ntfy HTTPS 18444。
运行 clean 实现提交 27dbe7825f582803e144bbf3023a44e7c1bb102e；
API、market-runtime、data-worker、notification-worker 统一镜像
`market-watch-api:dev-idle-final-20261111`，镜像 ID
`sha256:6c4872f0396e7d9090f4221c8f04d27b2b46f553564d77ed6b2b8a089db86dff`。
使用 mw-docker / market-watch-ubuntu，task mw-dev-idle-20261111、purpose development；
镜像 dirty=false，四个服务挂载源码 SHA 与提交一致，无重启或 OOM。
schema 仍为 bd57_notice_source_poll_index。

实际浏览器登录及保存的五图布局均显示数值 OHLC；数据中心 50 条，无脚本或资源错误。
OANDA、Binance、Dukascopy、Yahoo、AKShare、FXCM 分别读取 40 根实际柱；
38 个运行角色健康，42 MCP 工具、行情/通知 SSE、ntfy、许可资源通过。
保留原 Web 镜像、前端开发及私有许可资产挂载。热重载保留，首轮触发到新进程实测 3.19 秒；
第二轮未修改重载配置，未重复触发。

独立 PG 验收实例 mw-cpu-fix-20261111（PG14.24、1CPU/1GiB、127.0.0.1:25473）
已停止，volume 保留；未在开发可写库执行回归测试。性能采样期间无测试、构建或 profiler，
浏览器关闭后等待租约自然过期，不删除客户端或任务记录；其余 Ubuntu 实例保持运行。

私有原始记录、截图、旧配置和脚本位于
`/home/quant/.local/share/market-watch-dev/updates/idle-final-20261111/`；
首轮证据位于相邻 idle-fix-20261111，未公开凭据或私有许可库。
启动 `mw-dev up`；停止 `mw-dev stop`；状态 `mw-dev status`；
重启后端 `mw-dev restart api market-runtime data-worker notification-worker`。

## 回退与边界

本轮前镜像 `market-watch-api:dev-idle-validated-20261111`（源码 cc8ad83a）保留；
原优化前镜像、源码及全库备份也保留。compose.env.before / mw-dev.before 在私有证据目录。
源代码以挂载方式运行，回退需先停止四个 backend，同时恢复对应代码及镜像配置再启动；
只换镜像不会回退挂载代码。无 schema 变化，不需要数据库降级。
此前全库备份仅验证 pg_restore 目录可读，没有进行全库恢复，不宣称恢复演练。

未合并 main、未创建正式 tag、未操作生产。按用户要求不查询、轮询或追踪 CI。

## 最终 CPU 实测

[comparison.json](comparison.json) 保存脱敏指标；[acceptance.json](acceptance.json) 保存功能与部署结果。
同一采样器每约 10 秒取一次 Docker CPU 增量；基线 19 点/183 秒，首轮与最终均
31 点/约 305 秒。统一排除每段首个不完整 CPU 间隔，按四核折算整个 mw-dev。
首轮曾报告包含首点的 10.82%，统一口径重算为 11.01%。

| 指标 | 优化前 | 首轮 | 最终 |
| --- | ---: | ---: | ---: |
| 整个 mw-dev，占四核 | 13.32% | 11.01% | 10.49% |
| API，占单核 | 8.59% | 1.66% | 1.69% |
| data-worker，占单核 | 18.47% | 19.23% | 17.66% |
| market-runtime，占单核 | 8.85% | 8.71% | 8.39% |
| PostgreSQL，占单核 | 11.24% | 8.88% | 8.63% |
| notification-worker，占单核 | 2.22% | 1.70% | 1.71% |
| 数据库事务提交/秒 | 172.84 | 146.14 | 138.21 |
| shadow 尝试增量 | 0 | 0 | 0 |

总实例实测下降约 21.2%，约 0.42 核；未达到低于 5% 四核占用。
首轮到最终仅下降约 0.52 个百分点，不能从这两段实时样本给第二轮单独做精确归因。
数据 worker 仍是主要开销，最终相对基线只小幅降低；持续行情、源行读取、聚合/派生
核对及后台心跳仍运行，后续优化不能把必要的真实内容校验简单跳过。

所有段客户端、订阅和 stream task 全程为 0；首轮/最终同时持续记录 0 interest、
0 active alert，基线由额外只读查询确认这些值。基线 enabled Instrument 记录为 3，
首轮/最终动态在 3/4 间变化（含运行时维护标志，不能解释为不同品种数）；未改用户开关。
这是非重放的真实短时观察，不能宣称严格同负载、长期或高负载结论。

最终聚合队列 26/31 点为空，末点聚合队列与发布 pending 都归零；期间发布 pending
为 0–21，持久 publication job 记录 8–13，并非所有队列每刻为空。shadow 三项
始终 shadow_ready、尝试不增加。新增 7 条发布行，内容修订总和增加 50，包含正常
内容变化和新增行，不把该总量当作纯观测错误修订数。采样结束后四个 backend
继续运行、零重启、零 OOM。
