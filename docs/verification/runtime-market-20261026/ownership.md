# 阶段 0：职责、生命周期与退役清单

基线 `78697159`。以下是源码实际装配与目标，尚未改变运行职责。

| 当前启动路径 / 任务 | 输入 → 输出 / 所有权及恢复 | 目标 / 资源创建与关闭者 | 验证 |
|---|---|---|---|
| api.lifespan → provider_service.start → live(source) | ProviderInterest lease、活跃 provider 规则及 ATR → 缓存分页更新；provider dataset claim | 浏览分支迁 data，告警/独立 ATR 扫描退役；data 创建逐源执行容量、客户端、stop 并关闭 | provider_service、provider_postgres、runtime profiles |
| 同上 warmer(source) | 活跃 interest/targets → 有界预热；现有逐源预算/游标/冷却 | data；不扫描全品种，不挪进 market；正常关闭取消、断连 lease 兜底 | provider buffers、market stream lifecycle、线程上下文回归 |
| 同上 janitor | 到期订阅/缓存 → 释放；保护图表、native load、active/paused 规则及 ATR 依赖 | data 有界维护循环；只在相关规则退役后移除其专用保护 | provider_service cleanup、history retention |
| 同上 alerts → alert_monitor.run | 活跃 ChartAlert 固定版本、来源水位、指标 → judgment/signal/notification/outbox | market 独立判定循环；组创建 stop、共享 engine，事务 Session 每轮独立；六服务预案启用时 market 不装配判定 | cadence、composite alerts、PG、API-off 联合验证 |
| provider_service.start → yahoo_catalog.seed/akshare_catalog.seed | 静态目录 → 幂等目录记录 | data 启动时唯一装配；保留既有安全幂等，不设常驻目录服务 | seed 幂等及真实装配测试 |
| api provider_transport.start / warm_clients | 交互请求 → 本地连接与预算池 | API 保留有界查询客户端；API 自己关闭，不由 data 关闭 API 客户端 | provider transport、API 无持续调度副作用 |
| pricing-worker → oanda_worker | 账户需求 / stream 或 rest_batch → LiveState、确认分钟/修订/组合输入 | market pricing 角色；原账户 owner/epoch/续租/确认线程保留；退出先停止领取、在途 fencing，再释放/关闭 | OANDA lifecycle/native history owner/recovery PG |
| realtime_worker / akshare_worker | 既有受控实时/维护需求 → staging、确认/发布任务 | 按需求种类拆分装配；自建高实时归 market，供应商低频浏览归 data；REST batch 通用 live 排除 OANDA | 两实时入口排除回归；需求关闭/接管 |
| composite_aggregate_worker / history_versions.worker_tick | 持久输入事件 → period tasks/bar/checkpoint；claim token/lease | 组合队列仅 market；保留已有 claim/build/commit 和有界切片，不让 data 同时领取 | aggregate PG 并发唯一 owner、修订、恢复、A08 |
| chart_aggregation_worker.cycle | managed publication + 聚合任务 → ChartPublishedBar/水位 | data；publication budget/wakeup 保留；不是组合队列 | publication scheduler PG、budget |
| chart_history_worker / native_history_loads | 明确历史需求、分页游标/lease → staging/原生缓存、就绪状态 | data 独立有界 I/O 容量，不能阻塞实时/前台更新 | history worker recovery/native history PG |
| history_versions.worker_tick | artifact / schedule / preparation / indicators / display / revisions / import 各 phase | data 历史/基础产物；组合聚合移走；同步网络需拆开，异常隔离不等于时间隔离 | history versions/modes/derive/recovery PG |
| market_stream_worker.Calculator | 短租约任务、查询身份、固定输入 → 快照/事件/临时图表柱 | data；claim/epoch/lease/cancel、固定前缀复用；临时柱不能成为第二确认发布者 | stream worker/quotes/PG、SSE 恢复 |
| notification_center_worker.main/once | signal/渠道状态 → 可重建网页投影 | notification 独立投影循环，own stop；不判定、不发网络 | notification center、慢投递隔离 |
| notify.main/deliver_once | 到期 Outbox/lease → attempt/server accepted/unknown/ack | notification 独立投递循环；组拥有客户端、网络在事务外 | notify、notification PG、API/data 停止后继续 |
| 现有 legacy import / 旧 Watch | 已退役活动入口，保留历史兼容及必要读取保护 | 不重新启用，不删除表；新 profile 不装配兼容 importer | legacy retirement 与启动零调用 |
| 尚无：周日/备用源/成功解锁清理 | 候选修订、ready、当前运行指针 → 一致激活/成功事件 → 清理批次 | 核心迁移之后轨道 C；data 准备/清理，market 激活/实时发布 | A04a/b、A13a/b/c，首次真删前适用恢复验证 |

provider_service._EXECUTOR / _STOP / futures 是进程全局，仅单进程防重，不是跨组运行锁。迁移后 market/data 不得调用完整 start。ProviderTransport 的 lane/deadline ContextVar 在每个工作提交入口复制/设置并在 finally 恢复；不能继承一次 HTTP 请求的 deadline 作为常驻循环寿命。各组只共享 engine，不共享 Session/ORM 可变状态。

## 断线、补洞和重载事实

| 行为 | 现有入口 | 可复用范围 / 尚需验证 |
|---|---|---|
| OANDA 断线/确认/旧响应拒绝 | oanda_worker、live_pricing、confirmed_minutes；OANDA recovery PG 套件 | 账户确认恢复与 fencing 已有；保留两种采集模式，迁移后补停止/接管证据 |
| 浏览器关闭与失联 | market_stream.cancel/_release_demand/renew/cleanup，provider_service.unsubscribe/renew/cleanup | 显式取消与 TTL 已有；供应商关闭后停止，自建告警持久需求不随网页释放 |
| SSE 游标续接 | market_stream.events/delivery；持久事件与快照、generation/epoch | 游标丢失/版本变化可 reset；reset 只要求重新读取，不能证明上游缺分钟已补齐 |
| 浏览器重载 | chart_query/provider cache coverage、native load/readiness | 复用已有覆盖和分页；缓存命中不等于整段重拉；补洞必须有源端请求/确认水位和 rows 证据 |
| 缓存清理 | provider_service.cleanup、market_stream.cleanup | 保留有效图表、历史加载及旧引用保护；旧 provider 告警保护随对应退役处理 |

## 逻辑心跳约定（迁移前固定身份，数值待阈值确认）

继续使用 Preference 一角色一 key：`worker_health:runtime:<deployment>:<role>`。role 至少为 pricing、composite_aggregate、chart_alert、provider_live:<source>、provider_warm:<source>、provider_cleanup、chart_history、native_history、history_io、history_artifacts、fixed_indicators、managed_publication、market_stream、notice_projection、notice_delivery、runtime_inspection；稳定来源白名单展开，不接受任意不可信 key。

字段：group、role、deployment、boot_id、started_at、checked_at、last_success_at、state、error_type、业务 watermark/checkpoint/backlog、最近有限启动记录。完成一轮/有效空闲检查才能推进 checked_at；失败不更新 last_success_at；开始重试不清错误。不同循环不得读改写同一大 JSON。

Preference 可表达此粒度，现有 worker_health.ROLES 白名单和固定 300 秒阈值要扩展。实例更替必须在明确互斥启动和既有任务 owner/fencing 约束下比较当前 boot_id，旧实例条件写入不得覆盖；单独增加 boot_id 并不提供 fencing。无首次心跳通过显式 expected-role 清单和启动宽限发现。健康写入不能依赖 API。具体限频/过期值随本次一次业务阈值检查点固定。
