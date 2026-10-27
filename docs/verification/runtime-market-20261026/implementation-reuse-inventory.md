# 阶段 0：实现复用清单

核对基线：`v1.29.1`，`78697159067e1c1bc6c38be8ca8218cd12c29179`。
实施 worktree：`/home/quant/repos/market-watch-runtime-20261026`；分支 `refactor/runtime-market-consolidation-20261026`。本清单来自当前源码调用链；测试执行结果另见 results，不能把测试存在当作已经通过。

| 目标 | 当前模块 / owner / 可复用合同 | 对应回归 | 缺口及最小改动 |
|---|---|---|---|
| 单前端、旧 Watch 退役 | PR #99；web 同源代理；旧 Watch 路由 410；`retire_legacy.py` 保留历史证据 | 前置 `single-frontend-20261026/completion-audit.md`、`test_legacy_retirement.py` | 不重新实现，不删除历史表；前置报告没有证明 API 停机后告警运行 |
| 协议无关共享查询 | `chart_query.py:DataQuery/data_sync` 已被 HTTP、MCP、`market_stream_worker.py` 引用；`query_errors.QueryError` 由适配器映射 | chart/MCP/stream 与 dataset 错误合同回归 | 不新增 market_query 转发层；`series_access.export_page` 仍局部导入 HTTPException，需要阶段 1 按协议边界核验 |
| 组合输入 | `confirmed_minutes.record` → `composite_inputs.apply_minutes`；OANDA/历史准备写入；持久源修订、输入事件、版本号 | `test_composite_preparation.py`、`test_composite_series_postgres.py` | 复用事务/版本；目前遍历匹配来源的全部修订，轨道 C 限制为有效/准备中修订 |
| 持久组合聚合 | `composite_aggregates.claim/build/commit/aggregate_tick`；独立 aggregate worker 或 history worker 可领取，现有租约保护 | `test_composite_aggregates.py` 及 `_postgres.py` | 阶段 2 唯一调度归 market，data 禁止领取；不重复写聚合算法 |
| 全量/临时聚合 | `composite_series.aggregate/period`、`composite_realtime.Bucket/CurrentBuckets`；固定历史 `history_artifacts` | `test_composite_series.py`、`test_composite_realtime.py`、`test_composite_chart.py` | 保持日界、接缝、稀疏输入与版本；以批量/增量/恢复对照补迁移证据，不强制新累积器 |
| 实时独占与恢复 | `oanda_worker`、`live_pricing`；账户 owner/token/epoch、REST batch/stream、确认恢复；通用 realtime 角色排除 REST batch OANDA | `test_oanda_rest_batch.py`、`test_oanda_worker_lifecycle.py`、`test_oanda_native_history_owner.py`、`test_oanda_recovery_postgres.py` | 保留状态机，仅接停止/监督回调；不将实时独占扩大为禁止合法历史请求 |
| 供应商缓存与适配器 | `provider_cache`、`provider_chart`、`provider_capabilities`、逐源适配器；PG 身份/覆盖/claim/page | `test_provider_cache.py`、`test_provider_postgres.py`、`test_provider_service.py` | 继续有界 PG 缓存；逐源分派/能力表核实后做最小静态收敛，不建插件框架 |
| 浏览订阅与断线 | `provider_service.subscribe/unsubscribe/renew`；`market_stream.register/cancel/renew/claim/commit/events/delivery`；API 交付已提交事件 | `test_market_stream.py`、`test_market_stream_lifecycle_postgres.py`、`test_market_stream_api.py` | lease、游标和 reset 可复用。reset/重载不是源端补洞证据；供应商活跃轮询/预热迁 data，告警持久需求迁 market |
| ChartAlert 判定 | `chart_alert_worker.evaluate/step`；`composite_alerts`、`fixed_indicators`、`alert_monitor.run`；当前 API 启动 | `test_composite_alerts.py`、`test_chart_alert_worker.py`、`test_alert_monitor_cadence.py` | 当前 AlertConfig 明确接受 managed/provider/composite，并有执行分支；旧 Watch 410 不代表这些已退役。阶段 1 统一来源限制及旧记录可读不可执行 |
| 旧组合策略 | `CompositeWatchBinding/Judgment` 当前运行代码仅模型、不可变监听器和历史引用保护；未发现活动判定调用 | `test_history_retention.py`、前置退役回归 | 无活动调用不证明无存量引用；保留表/FK/引用保护，实例盘点另记 |
| 通知投影与投递 | `notification_center_worker.once` 与 `notify.claim/deliver_once`；Outbox 租约、事务外 HTTP、unknown/401/403、确认 | `test_notify.py`、`test_notification_center.py` | Notification.signal_id 非空，Outbox 通过它读取 SignalRow 价格；系统/测试不能伪造价格信号，需要最小兼容持久格式扩展 |
| 主动测试 | `api.py:/api/notification-tests` 当前直接 HTTP | `test_notification_test.py` | 阶段 3B 改走持久任务，显式区分全局投递开关与单次授权，不重复队列 |
| 健康/监督 | `worker_health.Preference/Pulse`、`chart_alert_health.Heartbeat`、notice projector key；各 worker 自有循环 | `test_health.py`、`test_chart_alert_health.py`、`test_history_worker_recovery_postgres.py` | Preference 可增加稳定 role key，无需为 key 新建表；当前白名单/300 秒 stale/缺实例 fencing 不足。先做最小监督器再适配，不以总心跳替代循环进展 |
| 修订准备与激活 | `composite_revisions.create/readiness/activate`、`composite_preparation.claim/commit`；比较 expected/parent revision、持久激活记录 | `test_composite_revisions.py`、`test_composite_revisions_postgres.py` | 不是周日自动编排；活跃 ChartAlert 固定绑定也不自动更新。轨道 C 增统一绑定、基线重建、旧任务 fencing/失败汇总 |
| 历史清理 | `history_retention.references/reclaim`、native history retention、provider cleanup、stream cleanup | `test_history_retention_postgres.py`、`test_native_history_retention.py` | 不是实时源成功切换解锁的 30 天清理；轨道 C 独立实现 dry-run、成功事件门槛、恢复验证和幂等批次 |

实时开关存储：现有 Preference 表以 `managed_realtime:<instrument_id>` 保存显式选择，不修改不可变历史/实时映射身份，也不扩大历史授权。启动时只对尚无显式选择的已注册数据集做一次兼容快照：延续 `Instrument.enabled` 所示的既有运行配置；否则只在有有效 composite 映射并存在未过期浏览 lease 或有效 composite 告警时开启。其它新注册的纯历史数据集关闭。快照持久化后，lease 到期不改写用户选择；显式关闭优先。非注册的旧 managed 品种继续读取已有 `Instrument.enabled` 或 `ChartHistoryPlan.realtime_enabled`，新历史计划沿用现值，不因加入历史维护而开启实时采集。

未指定真实备用供应商；本轮后续只交付最小能力边界及双来源 fixture。未访问生产，也未把前置手机/长期压力未测项视为通过。
