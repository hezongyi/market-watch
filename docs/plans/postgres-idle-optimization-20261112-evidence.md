# PostgreSQL 空闲优化实施与验收（2026-11-12）

## 范围与运行版本

用户认可执行本轮方案；只更新开发实例与 PR #134，不跟踪 CI、不合并、不打正式 tag、不操作生产。风险 F1：核心报价事务和后台派生链路；无 schema 变化。

- 基线 `a344279e`；实现 `121219d0`，测试契约跟进 `fc3fa6a9`。
- Ubuntu 本机 Docker project `mw-dev`，4 核；地址 `https://192.168.7.232:18443`。
- API/market-runtime/data-worker/notification-worker 均运行 `market-watch-api:dev-pg-idle-20261112`，镜像 `sha256:f1a7d07c707c629459066c04fc6edeab63f20244db41f208dcfe694b773045c1`，构建 commit `fc3fa6a9`，通过 `mw-docker build` 构建。
- Web 沿用已验收的 `market-watch-web:dev-idle-v2-20261112`，本轮无前端修改。
- 启动：`mw-dev up`；停止：`mw-dev stop`；查看：`mw-dev status`。私有配置和切换前镜像 ID 已留档，旧镜像保留；完整开发库逻辑备份保存在私有 backups 目录。

## 已实现

1. 通知新事件投影与兼容历史 backfill/reconcile 分开。启动后约每分钟维护，满页快速排空；健康监听空闲兜底 30 秒，断连最多 2 秒轮询，错误 2 秒。
2. 确认循环一次发现到期 dataset 后才进入原锁定窗口；真正写入仍检查 owner/epoch。无任务 provider、chart-history/native-history 与通用图表 worker 使用较长等待；未来重试/在途任务保留期限，监听断连及时退出长等待。
3. 逐报价只复用事务内日历结果；handover 的正完成标记仅在成功提交后存入当前 collector；价格规则需求只读 config，不加载整组 ORM。所有接受报价的状态、OHLC、告警输入和提交边界保留，不降频。
4. 显式 managed_realtime=false 且作为映射接续目标、没有独立消费者时，暂停通用聚合与发布。来源 M1、组合确认输入与九周期组合产物继续更新。dirty range 最多合并 1,440 分钟，保留最强修复类型、年龄和重试；独立需求恢复后补齐。读取先提交短租期需求，再检查 DERIVATION_PENDING；数据快照内复查屏障，状态显示 preparing。
5. 已处理但因 gap 阻塞的历史发布纠正任务保留；无新输入时不每分钟重复 request，新输入仍正常唤醒。

未改变持久化安全参数；未增加 schema/通知 pending 新表；history_versions 和 market 角色短健康期限的部分循环保留原节奏。HTTP 探针进一步替换不属于本轮 PostgreSQL 实施范围。

## 本地与 PostgreSQL 验收

- 扩大 backend 回归最终 **762 passed、37 skipped**；跳过主要为未设置专项运行条件的 PostgreSQL/外部契约，在这轮普通回归中不声称被执行。
- 独立 Ubuntu PostgreSQL 14.24，project `mw-idle-v2-20261112`，端口 25475、独立 volume/私有凭据；关键 PostgreSQL 用例独立运行。首轮 151 passed、1 failed、1 skipped：失败源于通知旧品种测试未显式启用默认关闭的品种，已修正；skip 需要真实 v1.14.0 源码，随后从 git archive 导出到私有验收目录实际执行。
- 补验 **15 passed**（8 个新增优化 PostgreSQL 契约、6 个通知用例、1 个旧版写入兼容）；最终读取路径强化后新增契约再次 **8 passed**。这些轮次有重复，不相加作总量。覆盖提交/回滚与反序提交、首次告警注册/顺序、ownership 交接、持久化修复、并发发布、需求恢复与纠正回放。
- Ruff 和 `git diff --check` 通过。确认过暂停派生回归在原 worker 上连续 30 个 cycle 会失败，修复后通过；避免单轮偶然不领取任务造成假阳性。
- 独立 Standards review：无阻断问题。Spec review 发现并修复三项等待边界：聚合重试期限、长等待途中监听断连、锁竞争误判 runnable 后 5ms 忙轮询；最终无未解决 findings。
- 五分钟隔离活动告警：302.147 秒，300 条报价、1 个预期 signal、0 outbox（测试禁用发送）、0 错误；报价提交 P95 28.541 ms，穿越至判定 45.186 ms，监控间隔 P95 250.209 ms。

## 开发实例功能

- 网页登录、五张组合图 OHLC、数据中心 50 条平台记录通过；无 pageerror/HTTP 失败资源。
- OANDA、Binance、Dukascopy、Yahoo、AkShare、FXCM 均读到 40 根 K 线；MCP 42 个工具、事件流、通知流、ntfy 健康、图表资源通过。
- 三条组合 × 九个周期共 27 次 chart-data 请求均有数据。
- 启动初期 OANDA 返回三次上游 504，随后自动恢复。复核 38 个角色全部正常、三条 connected+ready；不能把启动瞬时 degraded 报成一直健康。
- 观测前关闭验收浏览器，确认 0 browser、0 subscription、0 active alert、3 ready live；本任务测试 PG 已停止，未停止其他任务项目。观测期间不运行测试、构建、profiler 或备份。

## CPU 观测

2026-11-12 08:00:56–08:15:57 UTC，三段各约 300.10 秒，累计 900.293 秒。每段首尾均为 0 浏览器、0 订阅、0 active 告警、3 connected live。单位为单核百分比；全服务加总除以 4 才是四核整机百分比。

| 样本 | 接受报价 | PostgreSQL 单核 | 全服务单核 | 四核整机 |
|---|---:|---:|---:|---:|
| 1 | 1,374 | 2.915% | 14.004% | 3.501% |
| 2 | 1,201 | 2.720% | 13.072% | 3.268% |
| 3 | 1,244 | 2.670% | 13.241% | 3.310% |
| 时间加权平均 | 总计 3,819 | **2.769%** | **13.439%** | **3.360%** |

| 服务 | 基线单核 | 新均值单核 |
|---|---:|---:|
| market-runtime | 6.444% | 5.996% |
| data-worker | 5.117% | 3.021% |
| PostgreSQL | 3.399% | 2.769% |
| notification-worker | 0.872% | 0.463% |
| ntfy（含探针） | 0.860% | 0.819% |
| API（含探针） | 0.372% | 0.369% |
| Web + TLS | 0.003% | 0.003% |

与同日基线相比，PG 约下降 18.5%，全服务约下降 21.3%。总计仍约 0.134 核，**没有达到全服务单核 3%=0.03 核的期望目标**。

同窗累计 41,392 commits（45.98/s）、0 rollback、1,222 行新增、25,831 行更新、252 行删除、1,550,216 buffer hits、189,255 buffer reads。五分钟内各新增 15 个确认组合输入、135 个组合周期产物；paused 聚合队列无新 insert/delete，仅合并留存范围，未停止来源和组合写入。报价速率约 4.24/s；按整组总 CPU/报价折算约 31.7 ms/quote，这是摊入后台、数据库、探针后的 CPU 时间，**不是报价提交耗时**。

本轮统一部署后测量，只报告整组差值，不将收益分配到单项代码。基线只有 120.097 秒且没有同窗报价计数；邻近独立窗口约 3.84 报价/s，不能用作基线精确分母。最终五分钟窗口包含周期容量检查，不能与两分钟短窗口视作严格控制实验。未启用 pg_stat_statements，不声称有逐 SQL CPU/commit P95 的运行实例汇总。

## 剩余开销与实际限制

- 行情线程和数据库仍逐报价维护多份必要状态/观测；本轮保留了用户明确要求的逐条持久化。market-runtime 的剩余约 6% 单核不能用本轮结果证明全部必要。
- provider janitor 的软容量检查每 300 秒执行 `count(*) FROM provider_bars`。第二段统计显示该表 3 次 sequential scan、989,391 seq_tup_read（含并行扫描计数）；这与每段约 63,000 个 buffer reads 一致，仍有优化空间。表统计能定位扫描，不能据此声称它占用了全部 PG CPU。
- Preferences 与 dataset/demand 的重复发现、未修改的 history_versions/复合 worker 轮询，以及 Python HTTP 探针仍存在。优先后续评估“按缓存写入变化检查容量、无变化不精确重数”和余下空任务发现；不以关闭持久化/告警或调低展示刷新换取数字。


所有原始日志、CPU/数据库前后计数、截图和私有回退配置位于 `/home/quant/.local/share/market-watch-dev/updates/idle-v3-execution-20261112/`，不提交凭据、完整浏览器状态或私有数据。
