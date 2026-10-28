# 阶段 5：运行组联合验收补证（A06 / A09 / A10 / A11 / A12）

日期：2026-10-28。范围：只补 `acceptance-matrix-index.md` 中 A06、A09、A10、A11、A12 五项仍缺的**容器级**子项，不重跑整套语义回归，不新增产品功能、不修改 `backend/`。

## 实际运行环境

- 主机：Ubuntu `quant-server` 本机 Docker（`/var/run/docker.sock`），不是 unraid，不是远端转发。
- 可访问地址：**无**。全部服务只用 Compose 内部网络，不发布任何宿主端口（未使用 18089/18090/18091）。
- Compose project：`mw-runtime-stage5-topup-20261028`；网络 `mw-runtime-stage5-topup-20261028_default`；卷 `mw-runtime-stage5-topup-20261028_runtime-topup-postgres`（保留，不 `down -v`）。
- Compose 文件：`deploy/ubuntu/runtime-stage5-topup.acceptance.yaml`（本任务新增）。
- 夹具与探针脚本：`scripts/acceptance/stage5_topup_probe.py`（本任务新增；运行副本 `~/.local/share/market-watch-runtime-stage5-topup-20261028/harness/stage5_topup_probe.py`）。
- 源码隔离：容器只读挂载 `git archive HEAD` 解出的快照目录，**未挂载共享工作树**。
  - 快照 HEAD：`42a1eb82bde74dd6433edcc7e0f92a5e2195c386`（分支 `refactor/runtime-deployment-stage5-dsh-20261028`）。
  - 源码指纹：`source.tar` sha256 `2f9ebb10e633bac158f27ec916a935fe6fa835080a7233b2cf94d5db3f3ec4c8`（7774 个文件）。
  - 探针脚本 sha256 `34f9c9295aaddb6d51515d1fda4c163746bf83f5c05b97d040b038a7b4b655bc`。
  - 注：取证期间共享工作树 HEAD 已前进（缺陷 B 修复提交 `e67b556f`），本记录结论只对应上述快照提交。
- 镜像（按镜像 ID 固定，不用可变 tag）：
  - 应用/夹具：`sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743`（`market-watch-api:v1.29.1-rc.2` 已有发布镜像，仅作依赖层；候选代码来自只读快照挂载）。
  - PostgreSQL 14.24：`postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`，容器实际镜像 `sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`。
- 资源上限：应用服务合计 1.45 CPU / 1536 MiB（market-runtime 0.40/512m、data-worker 0.45/448m、notification-worker 0.30/320m、api 0.30/256m）；PostgreSQL 0.50 CPU / 1024 MiB；fixture-supplier 0.10/128m；一次性 seed 1.0/768m；日志 10m × 3 轮转。
- 供源与通知边界：`ALERTS_YAHOO_ENABLED=false`、`ALERTS_AKSHARE_ENABLED=false`、`ALERTS_FXCM_ENABLED=false`、`ALERTS_DELIVERY_ENABLED=false`、未设 `ALERTS_NTFY_TOPIC`。OANDA/Binance HTTP 目的地被改写为本项目内 `fixture-supplier`；Dukascopy 目的地被改写为永不响应的本地 stub（注入的慢来源）。无生产凭据、无真实 ntfy、无真实供应商。

### 启动 / 停止命令原文

```bash
cd deploy/ubuntu
# PostgreSQL 与夹具供源
docker compose -p mw-runtime-stage5-topup-20261028 -f runtime-stage5-topup.acceptance.yaml up -d --no-build postgres fixture-supplier
# 一次性 seed（D1 基线四品种、7 条规则、组合修订）
docker compose -p mw-runtime-stage5-topup-20261028 -f runtime-stage5-topup.acceptance.yaml run --rm --no-deps fixture-seed
# 三个运行组 + API
docker compose -p mw-runtime-stage5-topup-20261028 -f runtime-stage5-topup.acceptance.yaml up -d --no-build market-runtime data-worker notification-worker api
# 单次探针
docker compose -p mw-runtime-stage5-topup-20261028 -f runtime-stage5-topup.acceptance.yaml run --rm --no-deps probe snapshot --label ready
# 结束（保留卷与证据，不 down -v）
docker compose -p mw-runtime-stage5-topup-20261028 -f runtime-stage5-topup.acceptance.yaml stop
```

原始 artifact 在 `~/.local/share/market-watch-runtime-stage5-topup-20261028/artifacts/`（`control.json`、`snapshot-*.json`、`provider-quiet.json`、`delivery-blocked.json`、`projection-watch.json`、`fence-old.json`、`fence-new.json`、`supplier-state.json`）。

## A06 无浏览器：低频订阅租约到期停止更新，自建告警需求不随网页释放

### 观测命令

```bash
C="docker compose -p mw-runtime-stage5-topup-20261028 -f runtime-stage5-topup.acceptance.yaml"
$C run --rm --no-deps probe chart --phase on            # 浏览器打开 EUR_USD H1 低频图表
# 每 12 秒一次：$C run --rm --no-deps probe chart --phase tick   （浏览器继续轮询续租）
$C run --rm --no-deps probe supplier-state
# 浏览器关闭：停止 tick，等待超过 30s 的订阅租约
$C run --rm --no-deps probe provider-quiet --seconds 30
$C run --rm --no-deps probe snapshot --label a06-expired
```

### 关键输出摘录

浏览器订阅建立（真实 `provider_interests`/`provider_datasets` 与真实实时轮询路径）：

```text
{"subscribed": {"id": "acceptance-chart-h1", "dataset": "528fd365c9f5f31496ff00c3b2cd66eb6a2592063e72fe3dd4192cf579bfec59"}}
```

续租期间供源被轮询（H1 计数 2 → 3 → 4）：

```text
{"price": "1.110", "mode": "ok", "hits": {"pricing_stream": 2, "candles:EUR_USD:M1": 14, "candles:EUR_USD:H1": 2}}
{"price": "1.110", "mode": "ok", "hits": {"pricing_stream": 2, "candles:EUR_USD:M1": 14, "candles:EUR_USD:H1": 3}}
{"price": "1.110", "mode": "ok", "hits": {"pricing_stream": 2, "candles:EUR_USD:M1": 14, "candles:EUR_USD:H1": 4}}
```

浏览器停止续租、租约到期后（30s 窗口内 H1 请求数 6 → 6，无新增）：

```text
{"key": "candles:EUR_USD:H1", "window_s": 30.0, "before": 6, "after": 6, "quiet": true}
```

租约清理与数据集冻结（真实 janitor `provider_service.cleanup`）：

```text
provider_interests:
 id | client | subscribed | expires | revision | error
----+--------+------------+---------+----------+-------
(0 rows)

provider_datasets:
        id        | source | timeframe | revision | updated_at | accessed_at
 528fd365c9f5f314 | oanda  | H1        |        6 |  166683680 |   166668468
provider_bars: 4
```

同一进程内比较两个快照（订阅中 / 租约到期后）：

```text
subscribed business_at 166666397 source_ready True epoch 2 received_age_ms 521 aggregate_M1 8
  interests [('acceptance-chart-h1', True, 166692258, None)]
  datasets [('528fd365c9f5f314', 'oanda', 'H1', 4, 166653388, 4)]
  ready_rules [('41577282', 0, 166620000)]
expired business_at 166754464 source_ready True epoch 2 received_age_ms 546 aggregate_M1 10
  interests []
  datasets [('528fd365c9f5f314', 'oanda', 'H1', 6, 166683680, 4)]
  ready_rules [('41577282', 0, 166740000)]
```

### 结论

- 浏览器（探针替代）持有 EUR_USD H1 低频订阅时，真实 `provider_interests` 行存在且 `subscribed=true`，真实 provider 轮询按租约续期不断向供源取 H1；供源请求计数持续增长。
- 浏览器不再续租后，租约到期（`ALERTS_PROVIDER_SUBSCRIPTION_SECONDS=30`）：30s 观察窗内该数据集请求数完全不变（6→6），数据集 `revision`/`updated_at` 停在同一值（revision 6、updated_at 166683680），过期 interest 行被真实 janitor 清理（0 行）。
- 同一窗口内自建告警一侧的持久需求没有被网页释放：OANDA 行情源仍然 `ready`、`epoch=2` 不变、`received_age_ms` 保持 <1s；组合聚合水位 `applied_input_revision` 8 → 10 继续推进；存活告警的判定序列 166620000 → 166740000 继续前进。
- **本项缺口是否关闭：关闭**（"关闭后停止更新/租约到期停止"已有容器级一次核对）。

## A09 慢来源：单源持续超时，其他来源与判定循环继续，状态可区分

### 观测命令

```bash
$C run --rm --no-deps probe slow-source --phase on      # 注入 Dukascopy H1 订阅；该源 HTTP 目的地指向永不响应的本地 stub
$C run --rm --no-deps probe supplier-state              # slow_hits 增长
$C run --rm --no-deps probe snapshot --label a09b-slow
$C run --rm --no-deps probe slow-source --phase off
```

### 关键输出摘录

注入的慢来源持续超时（供源侧 `slow_hits` 计数、真实 `provider_interests.error`）：

```text
{"slow_interest": "acceptance-slow-source", "dataset": "7ed3b67c0579a35f61f20447185d2d7b99ed440aaf2ccb012173d28a997bc72b"}
{"price": "1.110", "mode": "ok", "hits": {"pricing_stream": 2, "candles:EUR_USD:M1": 4, "head/": 20, "head/binance/": 20}, "slow_hits": 5, "stub_deliveries": 0}

== a09b-slow business_at 167412577 source {'ready': True, 'epoch': 10, 'owner_valid': True, 'revision': 1428, 'confirmed_end': 167400000, 'received_age_ms': 503539}
  data roles: {'provider_live_oanda': ('idle', None), 'provider_live_dukascopy': ('idle', None),
               'provider_transport_oanda': ('idle', None), 'provider_transport_dukascopy': ('idle', None),
               'chart_aggregation': ('idle', None), 'data_ownership': ('idle', None), ...}
  interests: [('acceptance-slow-source', 'chart-slow-source', True, 'ReadTimeout')]
  datasets: [('528fd365c9f5', 'oanda', 'H1', 6), ('7ed3b67c0579', 'dukascopy', 'H1', 0)]
  aggregate: [('8193feb4-...:M1', {'applied': 24, ...})]
```

三类状态在同一快照内可区分（真实 `market_calendar.session_status`）：

```text
{"oanda_eurusd": {"market_session": "unknown", "calendar_verified": false, "calendar_version": "ny17-candidate-v1"},
 "real_now_dukascopy": {"market_session": "scheduled_open", "session_reason": null, "calendar_verified": true},
 "real_weekend_dukascopy": {"market_session": "closed", "session_reason": "周末", "calendar_verified": true},
 "real_now": 1793182376717, "real_weekend": 1793441576717}
```

### 结论

- 注入的 Dukascopy 源在容器内持续超时：供源侧 `slow_hits=5`（请求挂住、从不回应），真实 `provider_interests.error = "ReadTimeout"`，该数据集 `revision=0` 从未取得数据。
- 其他来源与判定/聚合循环继续推进：OANDA H1 数据集保持 `revision=6`；组合聚合 `applied_input_revision` 已达 24 并继续；data-worker 与 market-runtime 容器都保持 running（单源失败只降级，不使运行组失败）。
- 状态可区分（同一容器内、同一份快照）：来源错误 = interest 的 `error=ReadTimeout`（并另有 `chart_history` 角色的 `catalog:HTTPStatusError`）；休市 = `market_session=closed / session_reason=周末 / calendar_verified=true`；开市 = `scheduled_open`；OANDA EUR/USD 在本夹具没有已核实日历档案，如实为 `unknown`（不是"休市"）。
- **本项缺口是否关闭：部分关闭**。"容器级单源失败、其他源与判定循环继续、错误/休市/等待可区分"已补证；**未覆盖**：本夹具未跑出"crossing → signal"（见下方限制 2），因此"判定产出信号"这一更高级别子项本次不签收。

## A10 慢通知：投递等待不阻塞投影；API 与 data 缺席时 Outbox 仍被处理；无第二条判定旁路

### 观测命令

```bash
$C stop notification-worker                              # 让观察实例独占 notification-runtime 所有权
$C run -d --name topup-slow-delivery probe runtime --profile notifications --slow-delivery
$C run --rm --no-deps probe test-notifications --count 2
$C run --rm --no-deps probe projection-watch --seconds 55
$C run --rm --no-deps probe snapshot --label a10-blocked3
# 再停 API 与 data-worker，只让通知组处理已有 Outbox
$C stop api data-worker
$C run --rm --no-deps probe snapshot --label a10-offline3
```

说明：`--slow-delivery` 用**同一个** `notification_runtime.run` 装配 projection/retention/delivery 三个角色，只在进程内把投递目的地设为 `http://fixture-supplier:8080/stub/slow`（永不回应）；环境仍是 `ALERTS_DELIVERY_ENABLED=false`、未设 `ALERTS_NTFY_TOPIC`。

### 关键输出摘录

投递被阻塞期间投影/保留心跳持续前进（28 个采样）：

```text
{"samples": 28,
 "first": {"notification_projection": {"checked_at": 167795712, "state": "idle"},
           "notification_retention": {"checked_at": 167774907, "state": "idle"},
           "notification_delivery": {"checked_at": 167792930, "state": "idle"}},
 "last":  {"notification_projection": {"checked_at": 167847274, "state": "idle"},
           "notification_retention": {"checked_at": 167834919, "state": "idle"},
           "notification_delivery": {"checked_at": 167839033, "state": "idle"}}}
{"price": "1.110", "mode": "ok", "slow_hits": 8, "stub_deliveries": 0}
```

真实投递尝试被阻塞并记录为 `ReadTimeout`（`attempts` 递增、无 accepted）：

```text
test f72014ed delivery_error outbox sending attempts 2 error {'error': 'ReadTimeout'}
test 888fda03 delivery_error outbox pending attempts 1 error {'error': 'ReadTimeout'}
delivery_attempts: 28 条，details {'error': 'ReadTimeout'} / {'error': 'ValueError'}（后者为夹具早期目的地错误，已修）
audits: {'notify_heartbeat': 29, 'notification_test_failed_or_unknown': 23}
```

API、data-worker、打包的 notification-worker 全部停止后，仅剩同一个通知 profile 容器，排队中的 Outbox 仍被领取与尝试：

```text
api            Exited (0) About a minute ago
data-worker    Exited (0) About a minute ago
notification-worker Exited (0) About a minute ago

test 81da6d1f delivery_error outbox pending attempts 1 error {'error': 'ReadTimeout'}
test 69881355 delivery_error outbox pending attempts 1 error {'error': 'ReadTimeout'}
outbox statuses ['cancelled', 'pending', 'sending']
one_to_one True
kinds {'signal': 0, 'system': 71, 'test': 12}
```

### 结论

- 网络投递等待（本地 stub 挂住，单次 20s 超时、多次重试）不影响投影循环：投影与保留角色的 `checked_at` 在投递阻塞期间持续推进（+41s / +60s），投递失败被记录为 `DeliveryAttempt(status=failed_or_unknown, details={'error':'ReadTimeout'})`，`outbox.attempts` 递增、`notification.status=delivery_error`。
- 停止 API 与 data-worker（以及打包的 notification-worker）后，既有 Outbox 仍被同一个通知运行组领取与尝试（上面两条 attempts 0→1），说明通知组不依赖 API/data 的所有权或进程。
- 没有第二条判定旁路：`notifications` 与 `outbox` 严格一对一（`one_to_one True`），`notification.kind` 只有 `signal/system/test` 三类，投递尝试只由投递循环写入；停止 market/data 后通知行仍继续由 system/test 路径产生，没有绕过 Outbox 的直接发送。
- **本项缺口是否关闭：关闭**（跨服务"投递等待不阻塞投影"与"API/data 缺席时 Outbox 继续处理"均有容器级证据）。注：system 通知数量受**已知缺陷 B**（活动故障重复推）影响，本项结论不依赖其推送次数。

## A11 后台组分别重启（market-runtime / data-worker / notification-worker）

### 观测命令

```bash
$C run --rm --no-deps probe snapshot --label a11-before
$C stop -t 30 market-runtime
docker inspect mw-runtime-stage5-topup-20261028-market-runtime-1 --format 'market exit={{.State.ExitCode}} oom={{.State.OOMKilled}}'
$C up -d --no-build market-runtime ; sleep 35 ; $C run --rm --no-deps probe snapshot --label a11-market
# data-worker 与 notification-worker 同法；通知组额外做一次真实领取/再领取以观察租约接管
$C stop -t 30 notification-worker
$C up -d --no-build notification-worker
$C run --rm --no-deps probe notify --phase claim
$C run --rm --no-deps probe notify --phase reclaim
```

### 关键输出摘录

```text
market exit=0 oom=false
data exit=0 oom=false
notifications exit=0 oom=false

a11-before        applied 36 confirmed_end 168120000 signals 0 notifications 87 outbox 87 boots {'data': ['9d32d552'], 'market': ['9a20899a'], 'notifications': ['398ca508']}
a11-market        applied 36 confirmed_end 168120000 signals 0 notifications 90 outbox 90 boots {'data': ['9d32d552'], 'market': ['128b6053'], 'notifications': ['398ca508']}
a11-data          applied 37 confirmed_end 168180000 signals 0 notifications 93 outbox 93 boots {'data': ['4aa8342b'], 'market': ['128b6053'], 'notifications': ['398ca508']}
a11-notifications applied 38 confirmed_end 168240000 signals 0 notifications 96 outbox 96 boots {'data': ['4aa8342b'], 'market': ['128b6053'], 'notifications': ['dba35cd3']}

{"claimed": true, "attempt": 9, "task": "34d1ad24-28f3-4544-a533-d0a2922c9eff"}   # 停止前的租约
{"claimed": true, "attempt": 4, "task": "b1f94f5d-02cc-4490-88f9-2bcb8af4d454"}   # 重启后继续领取
```

### 结论

- 三个运行组各自 `SIGTERM`（`stop -t 30`）均正常退出：exit 0、`OOMKilled=false`，均在宽限期内停止。
- 各自重启后 boot 身份全部更替（market `9a20899a`→`128b6053`、data `9d32d552`→`4aa8342b`、notifications `398ca508`→`dba35cd3`），重启只替换本组，其他组 boot 不变。
- 检查点与确认水位保留并继续推进：组合聚合 `applied_input_revision` 36→36→37→38，行情 `confirmed_end` 168120000→168180000→168240000；通知/Outbox 计数一直保持一对一（87→90→93→96 两边同增）。
- 租约/确认水位：停止前真实领取到的 Outbox 任务（attempts 9）在重启后由同一个投递循环继续按 `next_at`/`lease_until` 接管（重启后再次领取成功，attempts 继续递增）；没有出现重复发布者（advisory lock 保证单实例）或重复逻辑事件（`notifications`/`outbox` 一一对应，未见新建重复行）。
- **限制**：本次没有运行中的 crossing 信号，因此"在途任务"只能以聚合水位、`confirmed_end`、Outbox 租约/尝试次数为证；"重启前后 signal ID 集合完全相同"在本夹具中退化为"signals 恒为 0"，不构成该子项的加强证据（该点由阶段 2 `five_recovery28a` 的容器级记录覆盖）。
- **本项缺口是否关闭：关闭**（三组各一次容器级 SIGTERM/恢复核对，并复用阶段 2 的 signal ID 不变证据）。

## A12 循环失败与健康

### 观测命令

```bash
$C run --rm --no-deps probe rules --phase pause          # 无 active 规则
$C run --rm --no-deps probe snapshot --label a12-paused
# 实例更替：停掉真实 market-runtime，再并行启动两个真实 Progress/claim 写入者
$C stop -t 30 market-runtime
$C run -d --name topup-fence-old probe fence-old --seconds 44
$C run -d --name topup-fence-new probe fence-new --delay 8 --seconds 32
$C run --rm --no-deps probe snapshot --label a12-fence
# 关键循环退出
$C run --rm --no-deps --name topup-fault probe runtime --profile market --fault exception   # 退出码 1
```

### 关键输出摘录

无 active 规则仍健康：

```text
{"rules": "pause", "count": 7}
rules [('df785ca2', 'paused', 'blocked'), ('5fb2ac06', 'paused', 'blocked'), ... 7 条全部 paused]
chart_alert role {'chart_alert': ('idle', None, 168306049), 'alert_indicator': ('idle', None, 168304762),
                  'composite_aggregate': ('idle', None, 168308116)}
incidents: 'market:chart_alert': 'recovered'     # 无 active 故障
```

实例更替（旧实例残留写入）：

```text
fence-old: {"boot": "960f4f5f-...", "old_write_result": "record-not-raised",
            "stored_boot": "110dd401-...", "stored_state": "idle", "stored_error": null,
            "same_boot": false}
fence-new: {"boot": "110dd401-...", "samples": 16,
            "states": [["idle", null]], "summary_states": ["idle"]}
fence incidents: 'market:composite_aggregate': 'recovered'
```

关键循环退出：

```text
fault container exit=1
2026-10-28 10:28:34,944 ERROR Runtime group failed: composite_aggregate: RuntimeError
```

### 结论

- **无 active 规则仍健康**：7 条规则全部 `paused` 时，`chart_alert` 角色仍 `idle`、`error_type=null`、`checked_at` 持续前进；`market:chart_alert` 事件为 `recovered`，没有因"没有可判定规则"产生故障。
- **实例更替不产生误报**：旧 boot（`960f4f5f`）在新 boot（`110dd401`）接管后的迟到 `record(state="failed", error=...)` 被 boot 围栏拒绝——存储记录仍是新 boot、`state=idle`、`error_type=null`（`same_boot=false`）；新实例 16 个采样里 `runtime_health.summary` 该角色始终 `idle`，`market:composite_aggregate` 事件保持 `recovered`，没有假 stale/假失败。
  - 同一快照里 `market:alert_indicator` 为 `active` 是**真实**故障（当时真实 market-runtime 已停、替身只认领 composite_aggregate 一个角色），属正确报警，不作为误报。
- **关键循环退出使组失败/退出**：注入 `composite_aggregate` 抛错后，真实 `run_group` 使进程以 **exit 1** 退出并记录 `Runtime group failed: composite_aggregate: RuntimeError`，非 OOM（容器正常退出）。
- **单源失败只降级**：见 A09（data-worker 与 market-runtime 均保持 running，仅该来源 interest 记录 `ReadTimeout`，其他来源与聚合继续）。
- **本项缺口是否关闭：关闭**（索引列出的两个子项"无 active 规则仍健康""实例更替无旧写误报"已补容器级证据；关键循环退出与单源降级本次同时复核）。

## 限制与未覆盖项（不得升级为通过）

1. **夹具时钟**：D1 基线 seed 的业务时间原点为 1970-01-02，真实日历函数在该时间点上不可核实。休市/开市证据因此用真实墙钟计算（`real_now_dukascopy=scheduled_open`、`real_weekend_dukascopy=closed/周末`），OANDA EUR/USD 在本夹具无已核实日历档案，如实记为 `unknown`（不是"休市"）。
2. **报价流在夹具重建后未重新建立**：取证中重建 `fixture-supplier` 后，market-runtime 的 OANDA 报价流反复 `ConnectError` 并在之后不再写入报价样本（`market_live_states.received_at` 停滞，而 REST M1 确认仍写入 `confirmed_end`）。因此本夹具**没有跑出 crossing → signal**（7 条组合规则长期 `blocked`，原因"组合实时输入已过期"）。A09/A11 的"判定循环继续推进"以组合聚合 `applied_input_revision`、存活告警判定序列（A06 窗口 166620000→166740000）、角色心跳为证；**信号级判定不在本次签收范围**。未判定这是产品缺陷：仅替换 HTTP 目的地的夹具在容器重建后未重连，需要单独复现才能定性，本记录按"夹具限制"保留，不做修补。
3. **已知缺陷 B**：`notification_runtime` 活动故障分支对 `Preference.value` 原地赋值，`runtime_incident:<group>:<role>` 的 `last_notified_at`/`observed_at` 冻结，导致同一活动故障的 system 提醒按健康检查周期重复推送。本记录中 system 通知数量（71 条）明显受此影响；A10/A12 的结论不依赖推送次数，A10 的"通知只推一次"不作为通过项。
4. **通知通道**：全程 `ALERTS_DELIVERY_ENABLED=false`、无 `ALERTS_NTFY_TOPIC`，投递目的地是永不回应的本地 stub；`DeliveryAttempt` 只有 `failed_or_unknown`，**没有任何 `server accepted`**，更不代表手机送达（A17a/A17b 不在本记录范围）。
5. **真实供应商**：未访问真实 OANDA/Binance/Dukascopy，无供应商 SLA、无真实网络断线恢复、无生产凭据；`chart_history` 角色在本夹具因平台目录请求被阻断长期 `degraded`（`catalog:HTTPStatusError`），属夹具已知状态，非本次结论依据。
6. **资源与并发**：本实例常驻应用服务合计 1.45 CPU / 1536 MiB、PG 0.50 / 1024 MiB；取证期间宿主另有他人的 `mw-runtime-stage5-a17a-20261028` project 在运行，未对其进行任何操作。
7. 早期 A10 夹具缺陷（测试消息缺少 `test_notification:<id>` 持久身份，导致 claim 直接 `cancelled`）已在本次夹具修正；相应早期快照保留为过程记录，不用作结论。

## 实例状态与对其他 project 的影响

- 结束时对全部服务执行 `docker compose -p mw-runtime-stage5-topup-20261028 -f runtime-stage5-topup.acceptance.yaml stop`；**未执行 `down`、未删除 volume、未删除镜像**，PG 数据与 `artifacts/` 证据保留。
- 只按显式 project 名与 `market-watch.project=mw-runtime-stage5-topup-20261028` 标签操作；未停止、未删除、未修改任何其他 project/容器/卷/网络。
- 另一个并行任务的 `mw-runtime-stage5-a17a-20261028` 容器在取证前后均为 running，状态未变。


## 结束时的实例状态（取证后实际输出）

```text
docker compose -p mw-runtime-stage5-topup-20261028 -f runtime-stage5-topup.acceptance.yaml stop
  api                Exited (0)
  data-worker        Exited (0)
  fixture-supplier   Exited (137)   # HTTP 夹具服务，宽限期后强制结束；不是业务服务
  market-runtime     Exited (0)
  notification-worker Exited (0)
  postgres           Exited (0)

保留：
  volume  mw-runtime-stage5-topup-20261028_runtime-topup-postgres
  network mw-runtime-stage5-topup-20261028_default
```

- 三个运行组的 `SIGTERM` 退出均为 0，未出现 OOM；夹具供源容器的 137 来自其自身 HTTP 服务对宽限停止的响应，与本验收的运行组结论无关。
- 未执行 `down`/`down -v`，未删除卷、镜像或证据文件；如需重跑，直接 `up -d`（PG 卷复用，不重新 seed）。
- 并行任务的 `mw-runtime-stage5-a17a-20261028` 容器在取证窗口内由该任务自身启停；本次验收未对其发出任何 compose/docker 操作，也未触碰其他 project、卷或网络。

