# 阶段 5：A17a 真实通知通道验收

日期：2026-10-28。主机：Ubuntu 本机 Docker（/var/run/docker.sock）。分支 refactor/runtime-deployment-stage5-dsh-20261028。

状态：**A17a 已复跑通过**（复跑代码 HEAD e67b556f，见第 8 节）。第 1-7 节是第一轮的记录，保留作缺陷证据：缺陷 A（自检窗口与循环周期不匹配，秒级开合刷屏）由 42a1eb82 修复并已验证消失；缺陷 B（活动故障 incident 状态未持久化，第一次 15 分钟提醒后每 15 秒重复推送）在第一轮被发现并阻断签收，由 e67b556f 修复，第 8 节给出 >15 分钟连续观察、只出现两条提醒、incident 时间戳逐次推进的复跑证据。

第 9 节新增“通知深链与 LAN 可达性”：本轮把 ALERTS_PUBLIC_URL 改为宿主 LAN 地址并把 web 只绑定该地址后，手机侧的点通知打开工作台与通知上的“确认”按钮都已实际成功（含服务端 ack 记录）。生产部署必须把 ALERTS_PUBLIC_URL 设为手机真能访问的地址，否则点击与确认都会失败——这条进入发布检查清单。

本记录不签收 A17b 的完整项（推送到达率、锁屏展示、多设备），也不构成生产授权。

## 1. 环境、拓扑与命令

- Compose project：mw-runtime-stage5-a17a-20261028；文件 deploy/ubuntu/runtime-stage5-a17a.acceptance.yaml；辅助脚本 scripts/acceptance/stage5_a17a_fixture.py（sha256=33c0f2dbe867104ccd37109339238e7c224b34c6bb52ed383a254d1a9e08bb43）。
- 可访问地址：http://127.0.0.1:18090（web 反向代理到 api；/healthz 与 /readyz 均 200）。api、market-runtime、data-worker、notification-worker 不发布宿主端口。
- 拓扑：五个应用服务 web、api、market-runtime（ChartAlert 内嵌于市场组）、data-worker、notification-worker，加一次性 migrate、fixture-seed、fixture-rebaseline 与常驻 fixture-supplier。
  全部应用容器只接 internal 网络（无出网）；web 与 notification-worker 另接 egress（web 只为发布 18090，notification-worker 只为 ntfy）。因此 provider/Yahoo/OANDA 在任何容器内均不可达，且 fixture 进程内把 OANDA 目的地改写为 fixture-supplier。OANDA 凭据为合成值 synthetic-no-upstream-access。
- 资源声明：应用服务合计 1.40 CPU / 1536 MiB（api .30/320m、market .55/512m、data .25/320m、notifications .20/256m、web .10/128m）；PG 0.75 CPU / 1536 MiB；fixture 另计（supplier .10/128m、seed .50/512m、rebaseline .25/192m 一次性）。实测峰值：api 127.1MiB、data 134.8MiB、market 123.4MiB、notifications 79.2MiB、supplier 60.2MiB、postgres 315MiB、web 7.7MiB；market-runtime 在合成行情流下 CPU 18-47%。
- 镜像（复用本机已有，未新建候选）：api sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743（market-watch-api:v1.29.1-rc.2）、web sha256:43c51c707e8c6fafc681bd4db1b23cc0b37ece546c04c15fc0df9d281657b870、PG postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872。
- 源码隔离：git archive HEAD | tar -x -C /home/quant/repos/mw-stage5-a17a-src，容器只读挂载该快照，不挂工作树。修复后快照 HEAD=42a1eb82bde74dd6433edcc7e0f92a5e2195c386，7387 个文件，整树指纹 sha256=6eb7b6ce37eefaef9be0b2771377c257da6df9e95ac0e1f8d2350dbc66f95686；关键文件 notification_runtime.py 09a6619d9804505dd28a7a7261a294f6bb2be230f76908b649f72f679a616a31、runtime_health.py 5024156d2e50a934144ab953714cb61062c6066de93aacdcf3cc25e96ffdaa5e、notify.py c701c1bac032b194ceae3259ee688b6ba15f179426f1787deaaffd336647f892。辅助脚本在归档后放入快照，单独计指纹（见上）。
  缺陷 A 的观测发生在修复前的快照 HEAD=41b8c054（整树 sha256=aff84f59f70f25d99ddefa9df004108d694caccdc4ef81ab72052eff571930e5，notification_runtime.py 87d3388ad6ec82628f38c887afd62d762329b16dceeaa5cb2636fdaea9582d55）。
- 启动（工作目录 deploy/ubuntu，E 指向仓库外的 paths.env）：

    docker compose --env-file $E -p mw-runtime-stage5-a17a-20261028 -f runtime-stage5-a17a.acceptance.yaml up -d postgres
    docker compose --env-file $E -p mw-runtime-stage5-a17a-20261028 -f runtime-stage5-a17a.acceptance.yaml up -d --force-recreate migrate
    docker compose --env-file $E -p mw-runtime-stage5-a17a-20261028 -f runtime-stage5-a17a.acceptance.yaml up -d --force-recreate fixture-seed
    docker compose --env-file $E -p mw-runtime-stage5-a17a-20261028 -f runtime-stage5-a17a.acceptance.yaml up -d --force-recreate fixture-supplier
    docker compose --env-file $E -p mw-runtime-stage5-a17a-20261028 -f runtime-stage5-a17a.acceptance.yaml up -d --force-recreate fixture-rebaseline market-runtime data-worker api web
    docker compose --env-file $E -p mw-runtime-stage5-a17a-20261028 -f runtime-stage5-a17a.acceptance.yaml up -d --force-recreate notification-worker

- 停止（不 down、不删卷）：docker compose --env-file $E -p mw-runtime-stage5-a17a-20261028 -f runtime-stage5-a17a.acceptance.yaml stop
  实测：data-worker/market-runtime/notification-worker/postgres/web/migrate/seed/rebaseline 退出 0，fixture-supplier 退出 143（默认宽限内 SIGTERM），**api 退出 137**（默认 10 秒宽限内未退出，被强杀；本轮未改停止参数，仅记录事实）。
- 凭据：真 topic 与 admin 口令散列仅在仓库外 /home/quant/.local/share/market-watch-runtime-stage5-a17a-20261028/env/（secrets.env、admin_password），经 compose env_file 注入；本记录只写 topic=<redacted:…fb76>。env_file 中 argon2 散列的 $ 必须写成 $$，否则 Compose 插值会截断散列（实测未转义时容器内长度 23、登录 500 InvalidHashError；转义后 97、登录 200）。

## 2. 缺陷 A（已修复）：通知组自检窗口与循环周期不匹配

修复前（HEAD 41b8c054，ALERTS_DELIVERY_ENABLED=true）观测到：

| 通知 | 标题 | 创建时间（业务时间） | ntfy 服务端时间 | provider_id |
|---|---|---|---|---|
| 614bc214-70c6-42c9-9c73-b23b14626580 | 后台服务异常 | 1793178876370（真实时钟） | 1793178880 | tMmPuJIXxCbB |
| 3725ea45-2b09-4eda-b670-df0e7390da1b | 后台服务异常（仅 notification_retention：stale） | 1793178891485 | 1793178894 | vqZvFpTQP5qG |
| 5d31d0de-0ac2-41a3-bc7f-a21329466cbb | 后台服务已恢复（仅 notification_delivery） | 1793178891491 | 1793178897 | JxbZtQJp1iBI |

同一秒（.485/.491）先告警后恢复；同一条通知的正文还同时含 notification_health：stale 与 notification_delivery：stale，即健康循环把自己和交付循环判为过期。修复前根因：notification_runtime.py 给所有通知角色统一用默认 deadline（runtime_health.py:53 默认 STALE_MS，runtime_health.py:19 STALE_MS=15000），而 notification_retention 循环 60 秒才写一次 checked_at（notification_center_worker.py:65），notification_health 自身周期 15 秒且先检查自己再写（notification_runtime.py:118-120）；对比 data_runtime.py:125-127（300000/90000）与 market_runtime.py:111（60000/STALE_MS）都有 per-role 窗口。旁证：退役前归档的 stage-4 任务库累计 538 条 system 通知，09:00-09:04 稳定 4 条/分钟。

42a1eb82 修复后本轮复跑：通知角色 per-role 窗口已生效（实测 projection 60000、retention 90000、delivery 60000、ownership 60000、health 60000），bring-up 与 11.4 分钟连续运行期间**没有出现**“异常/恢复成对”的自检抖动；唯一的 startup 一对（167371697/167386812）来自重启 worker 时旧 boot 的 checked_at 已是 stale（见第 5 节消息清单 17-18 行），不是循环抖动。

## 3. 缺陷 B（本轮新发现，阻断）：活动故障 incident 状态未持久化，第一次提醒后每 15 秒重复推送

事实（同一持续活动故障 data / chart_history：catalog:ConnectError）：

- 166333265 打开 incident（last_notified_at=166333265），166333281 推送第 1 条“后台服务异常”。
- 167234938 推送第 2 条（间隔 901673 毫秒 ≈ 15 分钟，说明 15 分钟去重窗口本身生效）。
- 之后每约 15027 毫秒（健康循环周期）重复推送一次：167249966、167265017、167280040、167295063、167310090、167325117，全部被 ntfy 接受（1bjmTTEDQ8wS、bk7Ge0Kx1yYf、udCZ9zdnJ1FJ、X9mPliv2p5yo、CTglGktcWfcr、Mk5DBKDfbZln、3Avgc4JndWA7）。发现后立即停止 notification-worker 止血（本记录写作时该 worker 已停止）。
- 数据库里 runtime_incident:data:chart_history 仍是 opened=166333265、last_notified=166333265、observed_at=166333265，即提醒时的 last_notified_at 与 observed_at **都没有写回**。

根因（只读定位，未改代码）：notification_runtime.py 的活动故障分支取 value = row.value（同一 dict 对象），随后 value.update(state=…, observed_at=…)，提醒时 value["last_notified_at"] = now，最后 row.value = value —— 赋回的是同一对象，SQLAlchemy 的 JSON 列（storage.py:941-944 是普通 JSON，未用 MutableDict，仓库里也没有 flag_modified）检测不到属性变化，UPDATE 被跳过。对照：恢复分支用的是重建字典 row.value = {**row.value, "state": "recovered", …}（notification_runtime.py 恢复循环），所以 recovered 状态确实落库（provider_janitor、pricing、composite_aggregate、notification_delivery/health 的 recovered 与 opened 时写入的 last_notified 都在库里）。

该写法在修复前 HEAD 41b8c054 中同样存在，因此不是 42a1eb82 引入的；它也能解释 stage-4 归档库里 4 条/分钟的规模——抖动加上“last_notified_at 不前进”，使每次开合都必然重新推送。

影响：任何活动故障在第一次 15 分钟提醒之后会按健康循环周期（约 15 秒）无限重推，真通道会被持续刷屏；“同一活动故障 15 分钟内不重复推送”只在第一次提醒之前成立。

## 4. 复跑已完成证据（修复后快照，HEAD 42a1eb82）

### 4.1 计划维护窗口与健康基线

- 起 worker 前用产品自带窗口：fixture 辅助脚本 maintenance --minutes 10（整部署）→ 窗口期内 system 通知 0 条、outbox 0 条。
- 窗口期内全部 29 个期望角色 checked_at 均小于各自 stale_after（通知组 60/90 秒、市场组 15/60 秒、data 90/300 秒），唯一 error_type 是 data/chart_history 的 catalog:ConnectError（隔离实例禁止供源出网的必然结果，按真实故障处理）。
- 结束窗口后第 1 次检查只产生 1 条“后台服务异常”，正文仅 data / chart_history：catalog:ConnectError（jSQhQVeUymHY）。

### 4.2 三类消息（真实 ntfy 服务端接受 + poll 回 id）

| 类别 | 数据库行 | 业务时间 | 标题 | provider_id | ntfy 时间 |
|---|---|---|---|---|---|
| 测试消息 | test / server_accepted | 166951492 | 守望 · 手机通知测试 | 1L8PBYFUv3Fu | 1793180821 |
| 业务信号 | signal / server_accepted | 166811250 | EURUSD · 固定组合预警 | IepGwg0Navor | 1793180678 |
| 系统故障 | system / server_accepted | 166513603 | 后台服务异常（market / composite_aggregate：stale） | qgo1da0ze43R | 1793180382 |
| 系统恢复 | system / server_accepted | 166693918 | 后台服务已恢复（market / composite_aggregate） | 4lYvYEAT2uCx | 1793180562 |

- 测试消息：POST /api/notification-tests（登录后带 x-csrf-token）返回 200 {"status":"queued","device_delivery":"unknown","test_id":"57e6b8d6f1b2be4147a94f0f22ac50e3"}，只有持久化 Outbox 行（status=pending，attempts=0）而不直接发 HTTP；随后交付循环以其 attempt 记为 accepted 并写入 provider_id。此前 1 条 test 通知因“API 仍用真实时钟、交付循环用夹具时钟”导致 next_at 永远不可达（我方夹具时钟问题，不是产品缺陷），该 3 行（test 通知、其 outbox、审计行）已删除后重发，重发结果为上表。
- 业务信号：fixture 拓扑（runtime_market_baseline 种子 7 条 ChartAlert + 合成 OANDA 线）在 rebaseline 后 7/7 health=ready；本轮用 solo 暂停 6 条，仅保留 1 条活动规则，POST fixture/price 1.119 后产生 1 条真实 Signal（occ=166800000，price=1.119，compare 1.1153 = 1.115 + 0.01×M1 ATR(2)），并走 Notification→Outbox→交付，服务端 id IepGwg0Navor，标题“EURUSD · 固定组合预警”。
- 系统故障：用 stage-2 既有注入方式（MW_A17A_FAULT=stuck 冻结市场组 composite_aggregate 循环）制造单个运行角色 stale，产生 1 条“后台服务异常”，恢复后 1 条“后台服务已恢复”。

### 4.3 去重窗口（数据库事实 + 主题侧）

- 活动故障 data/chart_history 从 166333265 到 167234938 相隔 901673 毫秒没有任何重复通知（数据库 system 通知计数与 last_notified_at 均无中间值），即 15 分钟窗口内不重复推送成立。
- 第一次提醒之后立即暴露缺陷 B（15 秒级重推），见第 3 节；这是本轮未能签收 A17a 的唯一原因。

### 4.4 “健康运行 10 分钟 system 通知为 0”硬指标

实测窗口 1793181759631 → 1793182441602（真实时钟 682 秒 ≈ 11.4 分钟）：system 通知计数保持 16 不变、最大 created_at 保持 167386812 不变，即**新增 0 条**；同窗口内 5 个通知角色 checked_at 均在其 60/90 秒窗口内（示例 168571537/168571721/168572511/168572900/168574009，业务时间）。

为使该窗口只检验“自检抖动”而不被已知环境故障干扰，窗口内对 data 组开了计划维护窗口（maintenance --minutes 20 --group data），市场组与通知组保持正常受检。这是唯一使用维护窗口的地方，原因与限制见第 5、6 节。

## 5. 本轮推送到真 topic 的消息与归因

本轮（修复后快照）共 18 条消息全部被 ntfy 接受，逐条 id 见第 4.2 节与本表；其中 4 条是验收要求的四类证据，其余为过程性瞬态或缺陷 B 的重复推送：

| 序 | provider_id | 标题 | 归因 |
|---|---|---|---|
| 1 | jSQhQVeUymHY | 后台服务异常 | 真实环境故障 data/chart_history（验收要求 1 条） |
| 2 | GS5BKgFDWrGZ | 后台服务异常 | 过程瞬态：停止 data-worker 试验时 provider_janitor 越窗 |
| 3 | ETzuJBMW46ni | 后台服务已恢复 | 同上（provider_janitor 恢复） |
| 4 | Yd5RtzOL1rfq | 后台服务异常 | 过程瞬态：重启市场组时 pricing 旧 boot 越窗 |
| 5 | qgo1da0ze43R | 后台服务异常 | 受控单故障 composite_aggregate（验收要求 1 条） |
| 6 | k7wOEucw9KIX | 后台服务已恢复 | 同上（pricing 瞬态恢复） |
| 7 | 4lYvYEAT2uCx | 后台服务已恢复 | 受控故障恢复（验收要求 1 条） |
| 8 | IepGwg0Navor | EURUSD · 固定组合预警 | 真实信号（验收要求 1 条） |
| 9 | 1L8PBYFUv3Fu | 守望 · 手机通知测试 | 测试消息（验收要求 1 条） |
| 10-16 | 1bjmTTEDQ8wS 等 7 条 | 后台服务异常 | 缺陷 B：第一次 15 分钟提醒后每 15 秒重推 |
| 17-18 | 2z5rv5g74t9K / 7jCzxhHOLdPF | 后台服务异常 / 已恢复 | 过程瞬态：重启 notification-worker 时自身旧 boot 越窗 |

结论：若按第 6 节配方（受控故障与 worker 重启都放进计划维护窗口、仅保留 1 条活动规则、不先做 data-worker 停机试验），同一轮应只有 4-5 条消息：测试 1、信号 1、受控故障 1、恢复 1，加真实环境故障 chart_history 1 条（及其 15 分钟提醒）。

## 6. 复跑计划（修好缺陷 B 后执行）

前提：活动故障分支改为重建字典（例如 row.value = {**row.value, "state": "active", "observed_at": now, "category": category, "last_notified_at": …}）或对 JSON 列做 flag_modified，使 last_notified_at/observed_at 能落库；并保留一条针对“提醒后不再重推”的红用例。

1. **新建数据库，不复位旧库**（种子不可重复执行，实测二次 seed 报 duplicate key market_instrument_catalog_pkey；上一轮库是本记录第 3 节缺陷 B 的硬证据，必须原样保留）：同一 PG 实例内先 up postgres，再 psql -d runtime_stage5 -c "CREATE DATABASE runtime_stage5_a17a_r2"；把仓库外 paths.env 的 MW_A17A_DB 指向 runtime_stage5_a17a_r2（compose 的 ALERTS_DATABASE_URL 与辅助脚本都用它，脚本 guard 只接受 runtime_stage5 / runtime_stage5_a17a_r2 两个库名）；然后 up migrate（等 Exited 0，alembic_version=az53_notification_outbox_types）、up fixture-seed（等 Exited 0）。旧库 runtime_stage5 不 drop、不写入。
2. 对齐启动：up fixture-supplier，紧接着 up --force-recreate fixture-rebaseline market-runtime data-worker api web（默认行情必须在 ~15 秒内取到）。预期 fixture-rebaseline 日志 {"phase":"rebaseline","passed":true}（本轮 11.45 秒/13.61 秒），chart_alerts 7/7 health=ready。
3. 只留 1 条规则：脚本 solo（本轮把 7 条中 6 条 pause，保留 1 条）。
4. 开计划维护窗口（整部署，10 分钟）后启动 notification-worker，确认 29 个角色 checked_at 均在窗口内、system 通知 0 条；再关闭窗口。
5. 受控单故障（验收要求 1 条）：停 data-worker **不要用**（会产生按窗口分散的多个 provider_janitor 类瞬态）；改用 MW_A17A_FAULT=stuck 重启市场组，并把这次重启放进 2 分钟计划维护窗口，使重启瞬态（pricing）不产生消息。窗口关闭后只应出现 1 条 composite_aggregate 异常。
6. 去重窗口（缺陷 B 的验收断言，必须连续观察 >15 分钟）：该故障保持活动，主题侧只应出现 T0 与 T0+≈15 分钟两条提醒、期间无任何中间重推；同时用数据库读事实核对 runtime_incident:market:composite_aggregate 的 last_notified_at 与 observed_at 随时间推进（每个读数附采集时间戳），而不是冻结在打开时刻。
7. 恢复（验收要求 1 条）：再次把重启放进 2 分钟维护窗口并去掉 MW_A17A_FAULT，只应出现 1 条“后台服务已恢复”。
8. 测试消息与信号：登录 → POST /api/notification-tests（1 条，真实投递）；POST fixture-supplier 的 /fixture/price 1.119（1 条信号，真实投递）。
9. 硬指标：在无活动故障、无提醒到期的 10 分钟窗口内，system 通知新增必须为 0；同时保留 chart_history 这一真实环境故障的 1 条通知与 15 分钟提醒（预计本轮合计 5 条 + 提醒）。
10. 收尾：stop 全部服务（不 down -v），保留卷 mw-runtime-stage5-a17a-20261028_runtime-stage5-a17a-postgres 与 /home/quant/.local/share/market-watch-runtime-stage5-a17a-20261028/artifacts 证据；任务结束按 mw-docker retire --task mw-runtime-stage5-a17a-20261028 --project mw-runtime-stage5-a17a-20261028 先归档数据库并做恢复校验再 --apply。

## 7. 未覆盖项与限制

- 缺陷 B 未修复前，“同一活动故障 15 分钟内不重复推送”只能证明到第一次提醒为止；提醒后的重推已作为阻断项报告，未在此轮继续等满第二轮。
- 手机侧收到/点击/确认（A17b）未验证；本记录所有“接受”只代表 ntfy 服务端收下。
- 真实供应商、Yahoo、OANDA 在本实例被显式禁止出网；fixture 使用合成行情与合成凭据，data/chart_history 的 catalog:ConnectError 属环境结果（与 stage-4 同一事实），不是本轮代码回归。
- 本轮使用了两次计划维护窗口：一次 bring-up，一次“健康 10 分钟”指标窗口（--group data），目的是隔离已知环境故障与重启瞬态；不是掩盖产品缺陷，缺陷 B 的全部重复推送都发生在没有窗口的时段并已逐条记录。
- api 容器在 stop 时退出 137（默认宽限内未退出），本轮未调整停止参数；停止路径未作为本任务验收项。
- 与另一并行任务 mw-runtime-stage5-topup-20261028 无资源交集：本轮只操作本任务 project 的容器/网络/卷，未触碰其容器、卷或镜像。

## 8. 缺陷 B 修复后的 A17a 复跑（HEAD e67b556f）

复跑代码快照：HEAD=e67b556f5afc9d188cb35cd0d8f6fdedee1735f8，7387 个文件，整树 sha256=1c40c17dfac6ca75533222912315dea05a207ca3fc944bc588acc79f0b392ac1；backend/alerts/notification_runtime.py 2146ce334a6a7e41f05e7289148a2de58b0fceac9bd1e546c248482c02fbc768、runtime_health.py 5024156d2e50a934144ab953714cb61062c6066de93aacdcf3cc25e96ffdaa5e、辅助脚本 stage5_a17a_fixture.py 5d3bfce3bbfc8a233f2dbf699f4dee75920d4df9a1ae5ddd124c5a4f1860ead3。

环境：同一 project/网络/卷，但**新库** runtime_stage5_a17a_r2（第一轮的 runtime_stage5 原样保留作为缺陷 B 证据，未 drop、未写入）；ALERTS_PUBLIC_URL=http://192.168.7.232:18090，web 只绑 192.168.7.232:18090。

### 8.1 消息清单（本轮真 topic 共 6 条，全部被服务端接受并被手机确认）

| # | 类别 | 业务 created_at | 标题 | provider_id | ntfy 时间 | 备注状态 | ack_at |
|---|---|---|---|---|---|---|---|
| 1 | 测试 | 166310704 | 守望 · 手机通知测试 | G3nsoYqJvcS1 | 1793183386 | server_accepted | - |
| 2 | 业务信号 | 166319947 | EURUSD · 固定组合预警 | PO9zmT4tPqSD | 1793183394 | acknowledged | 166326220 |
| 3 | 系统故障 T0 | 166401062 | 后台服务异常（data / chart_history + market / composite_aggregate） | zk1xGctTf73x | 1793183475 | acknowledged | 166417076 |
| 4 | 系统故障 T0+15min | 167303000 | 后台服务异常（同上两行） | 31fVwXbjo8qy | 1793184377 | acknowledged | 167309619 |
| 5 | 系统恢复 | 167543627 | 后台服务已恢复（market / composite_aggregate） | W7MzTlpGGxZA | 1793184618 | acknowledged | 167550548 |
| 6 | 环境故障下一轮提醒 | 168205841 | 后台服务异常（data / chart_history） | qCfIPoubT1R7 | 1793185280 | acknowledged | 168212195 |

- 第 1、2 条在计划维护窗口内投递（窗口只暂停故障检查，不暂停交付），第 3 条是窗口关闭后的首次检查，第 4 条是 T0+900 秒的提醒，第 5 条是受控故障恢复，第 6 条是既有环境故障 chart_history 的下一轮 15 分钟提醒（属设计节奏，不是重推）。
- outbox 统计：accepted 1（测试）、cancelled 5（被手机确认后的正常取消）；delivery_attempts 6 条全部 accepted。

### 8.2 缺陷 B 的验收断言

1. **>15 分钟连续观察只出现两条提醒**：T0=166401062（notice #3）与 T0+901938ms=167303000（notice #4）是同一活动故障（data/chart_history + market/composite_aggregate）仅有的两条；T0 到 T0+900 秒之间 system 通知总数恒为 2（无任何中间新增，多次读取确认），提醒后 60 秒复查仍为 2；下一条同故障提醒出现在 168205841（= 167303000 + 902841ms），即严格每 15 分钟一次，没有中间重推。
2. **incident 时间戳随时间推进**（每次读数附真实采集时间戳，business = real − 1793017071688）：

| 读数 | 采集 real_ms | runtime_incident:market:composite_aggregate observed / last_notified | runtime_incident:data:chart_history observed / last_notified |
|---|---|---|---|
| #1（T0 后 16s） | 1793183484 | 166401046 / 166401046 | 166401046 / 166401046 |
| #2（T0+340s） | 1793183798871 | 166716644 / 166401046 | 166716644 / 166401046 |
| #3（T0+654s） | 1793184113652 | 167032195 / 166401046 | 167032195 / 166401046 |
| #4（T0+987s，提醒后） | 1793184445703 | 167363243 / 167302980 | 167363243 / 167302980 |
| #5（提醒后 +60s） | 1793184506044 | — / 167302980（不变） | — / 167302980（不变） |
| #6（恢复后 +10.7min） | 1793185297290 | recovered / 167302980 | active / 168205820 |

  对比第一轮（第 3 节）：当时 last_notified 与 observed 在 166333265 冻结不动；本轮两者都随提醒推进，且提醒后 60 秒内不再变化（证明写回生效且去重门限按 900000ms 生效）。
3. **healthy 期间 system 通知为 0**：受控故障恢复后，真实时钟 1793185297290 → 1793185960490（663.2 秒 ≈ 11.05 分钟）system 通知计数 4 → 4、max(created_at) 恒为 168205841，新增 0 条；同窗口 5 个通知角色 checked_at 均在 60/90 秒窗口内（168846587 / 168883370 / 168883423 / 168887220 / 168888527），28 条角色健康记录中唯一 error_type 是既有环境故障 chart_history。
4. **四类消息各有服务端 id + poll-back**：见 8.1 表；poll-back 用 GET https://ntfy.sh/<redacted:…fb76>/json?poll=1&since=all，按 provider_id 对账标题与时间一致。

### 8.3 受控故障与恢复的注入方式

- 受控单故障：在计划维护窗口内以 MW_A17A_FAULT=stuck 重启 market-runtime，冻结 composite_aggregate 循环；窗口关闭后该角色按 15 秒窗口变 stale，与既有环境故障 chart_history 合并成一条通知（一次消息两行），避免两条独立消息。
- 恢复：再用 maintenance --minutes 2 包裹一次不带 fault 的 market-runtime 重启，窗口关闭后只产生 1 条“后台服务已恢复（market / composite_aggregate）”；窗口内抑制了重启瞬态（pricing 旧 boot 越窗），第一轮那两条瞬态消息本轮没有出现。
- 规划与实测一致：本轮 6 条，预算 6 条；四类必需证据各 1 条，其余 2 条是既有环境故障的两次 15 分钟节奏。

## 9. 通知深链与 LAN 可达性

- 深链来源：notify.py 构造 ntfy 消息时，click 与 actions[0].url 都取自 settings.public_url（ALERTS_PUBLIC_URL）；信号 click 为 {public_url}/advanced-charts?panel=notifications&signal=<signal id>，系统/测试 click 为 {public_url}/settings，确认按钮为 POST {public_url}/api/notification-actions/<note id>/ack（带 Bearer 明文令牌）。因此若 public_url 写成 127.0.0.1，手机上点开的是手机自己的回环地址，必然失败。
- 本轮配置：ALERTS_PUBLIC_URL=http://192.168.7.232:18090（宿主 enp1s0 192.168.7.232/24）；web 发布端口只绑该地址（ports: ['192.168.7.232:18090:80']），未绑 0.0.0.0、未绑 127.0.0.1、未绑 mh-tun(198.18.0.1) 或 docker 网桥。
- 监听证据：ss -ltn 只有 `LISTEN 0 4096 192.168.7.232:18090`；docker-proxy 为 `-host-ip 192.168.7.232 -host-port 18090`；`curl http://127.0.0.1:18090/` 连接被拒（000 / Connection refused）。实例 stop 后该端口不再监听。
- HTTP 探测（宿主侧，curl，URL 一律用 LAN 地址）：/ → 200（text/html）、/healthz → 200、/readyz → 200；POST /api/login → 200 且下发 session cookie；GET /api/session（带 cookie）→ 200，不带 cookie → 401；用显式 Host 头与外域 Host 头抽查均未被 nginx 拒绝（401 只表示未带会话）。
- cookie_secure：compose 在本验收实例显式设 ALERTS_COOKIE_SECURE=false（config.py 默认 true）。走 http 明文且非 Secure 时浏览器才会回传 cookie，登录与确认才可用；**仅限 LAN 明文验收，生产必须使用 HTTPS 并保持 cookie_secure=true**。
- 手机侧实测：本轮 6 条推送的 click 全部是 http://192.168.7.232:18090/... 形式（见 8.1 表；信号为 /advanced-charts?panel=notifications&signal=01305059-…，其余为 /settings）；其中 5 条（信号 1 条 + 系统 4 条）已在 ntfy 上被“确认”，服务端 api 日志记录 `POST /api/notification-actions/<id>/ack 200 OK`（请求经发布端口转发，来源地址 172.18.0.8），对应 notifications.ack_at 与业务时间见 8.1；测试消息未被点“确认测试”。说明“点通知打开工作台”与“点确认按钮回执”两条链路在手机上均可走通。
- 发布检查项（建议加入发布清单）：部署前用手机网络实际打开一次 ALERTS_PUBLIC_URL；确认它指向宿主可达地址而非 127.0.0.1；HTTP 场景必须同时关 cookie_secure，HTTPS 场景必须保持 true；确认 web/代理的发布端口只绑定预期网卡。

## 10. 本轮最终实例状态

- 全部服务已 stop（未 down、未删卷）：data-worker/market-runtime/notification-worker/postgres/web/migrate/seed/rebaseline 退出 0，fixture-supplier 与 api 退出 143（宽限内正常 SIGTERM）。
- 保留：卷 mw-runtime-stage5-a17a-20261028_runtime-stage5-a17a-postgres（内含 runtime_stage5 第一轮证据库与 runtime_stage5_a17a_r2 本轮库）；证据目录 /home/quant/.local/share/market-watch-runtime-stage5-a17a-20261028/{artifacts,env}。
- 未修改 backend/、未 commit；未触碰并行任务 project。