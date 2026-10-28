# PR #113 review 修复与复核

日期：2026-10-28。分类 **F1**：修改运行故障提醒的阈值及维护抑制，无 schema 迁移。最小验证为定向回归、真实 PostgreSQL 持久化合同，以及任务容器的同任务租约接管/网络隔离补证。本轮不访问生产、不发送真实通知。

## 修复范围

1. 切换手册禁止创建、清空或删除发布目录 `.env`；占位核对只能在独立临时目录。
2. topup 默认网络明确 `internal: true`；catalog 原先绕过 fixture 的普通 HTTP 客户端现在同样改写目的地，保留真实 catalog 解析与刷新逻辑；Compose 合同防止重新引入外部网络及宿主端口。
3. `boot_loop` 事故按来源组存为 `runtime_incident:<group>:boot_loop`。定向维护同时抑制该组的反复启动提醒，已有事故在维护期间保持 active，不伪造恢复；其他组继续检查。
4. 五分钟内第 **3** 次启动触发汇总，替换原先第 4 次才触发的条件；两次正常启动不报。
5. 撤回旧 A11 两个不同 task 的“同任务接管”结论。新增探针固定同一个 task/notification，观察真实租约到期与新 boot 接管，使用真实通知运行组和本地 HTTP stub。

原批次网络可出网，不能宣称零真实供应商访问；旧观测仍保留在 `stage-5-runtime-topup-acceptance.md`，不把修复后的配置倒推为旧环境。本轮替代网络及同任务证据如下。

## 环境与版本

- 主机：Ubuntu `quant-server` 本机 Docker；Compose `2.40.3`，无远端转发。
- 源码：提交 `a49bce8a` 的 `git archive` 只读快照；`source.tar` sha256：`46cc043f142c09c0a9330e7235ca22db94e91752dc1bdc4ed95a6efe72242528`。
- project：`mw-stage5-review-20261028`；task：`stage5-review-20261028`。独立 network、volume、数据库；不复用原验收项目的可写数据库。
- network：`mw-stage5-review-20261028_default`；volume：`mw-stage5-review-20261028_runtime-topup-postgres`。
- 地址：无宿主端口。通知只发到内部 `http://fixture-supplier:8080/stub/notification`；无真实 topic、token 或生产凭据。
- 复用锁定依赖镜像 `sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743`，执行的代码来自上述快照。PG 固定为 Compose 中的 PostgreSQL 14.24 digest。
- 原始 artifact：`/home/quant/.local/share/market-watch-stage5-review-20261028/artifacts/`。源码快照、paths.env 与两个命令 overlay 位于同级目录；artifacts 允许镜像内 app 用户写入，不存放生产/供应商凭据；stub 回执中的验收确认 token 留在主机、不提交。
- 可提交的脱敏摘要及原始文件 SHA256：`results/stage-5-review-fixes-20261028.json`。不提交 stub 消息中的确认 token。
- 接管期间仅启动 postgres、fixture-supplier、notification-worker；API、market、data 均未启动。接管完成后单独启动 data-worker 核对 catalog fixture。

## 回归

主机执行：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q -p no:cacheprovider \
  backend/tests/test_runtime_incidents.py backend/tests/test_notification_runtime.py \
  backend/tests/test_runtime_health.py tests/ops/test_database_compose.py
```

结果：**39 passed、43 subtests passed，8.68 s**。覆盖第 3 次启动边界、跨组维护、已有 boot-loop 事故不假恢复、维护到期后恢复，以及真实 Compose 网络与端口约束。Ruff 和 `git diff --check` 通过。

真实 PG 容器执行（独立随机 schema，未使用 skip）：

```bash
C=(docker compose --env-file /home/quant/.local/share/market-watch-stage5-review-20261028/paths.env \
  -p mw-stage5-review-20261028 -f deploy/ubuntu/runtime-stage5-topup.acceptance.yaml)
"${C[@]}" run --rm --no-deps \
  -e TEST_POSTGRES_URL=postgresql+psycopg://runtime_topup:topup_acceptance_only@postgres/runtime_profile \
  --entrypoint python probe -m pytest -q -p no:cacheprovider \
  backend/tests/test_runtime_incident_postgres.py backend/tests/test_runtime_incidents.py \
  backend/tests/test_notification_runtime.py backend/tests/test_runtime_health.py
```

结果：**36 passed，9.63 s，无跳过**（其中 5 个真实 PG 合同，其余为容器内同源定向回归）。PG 合同包含反复启动去重、并发 claim、维护持久化/到期、JSON 提醒时刻落库与按组维护后跨 session 恢复检查。

## A11 同任务租约接管

启动命令（在仓库根目录，`C` 同上；全新任务库只 seed 一次）：

```bash
"${C[@]}" up -d --no-build postgres
"${C[@]}" run --rm --no-deps fixture-seed
"${C[@]}" up -d --no-build fixture-supplier
"${C[@]}" run --rm --no-deps probe notify --phase lease-prepare
"${C[@]}" -f /home/quant/.local/share/market-watch-stage5-review-20261028/lease-slow.yaml up -d --no-build notification-worker
# 等待在途 sending 状态后捕获原任务；不能等 HTTP 超时回写 pending 后再捕获。
"${C[@]}" run --rm --no-deps probe notify --phase lease-captured
"${C[@]}" kill -s SIGKILL notification-worker
"${C[@]}" -f /home/quant/.local/share/market-watch-stage5-review-20261028/lease-accept.yaml up -d --no-build notification-worker
"${C[@]}" run --rm --no-deps probe notify --phase lease-verify
```

两个 overlay 仅将 notification-worker 的 command 分别设为 `[runtime, --profile, notifications, --slow-delivery]` 和 `[runtime, --profile, notifications, --accept-delivery]`。其余 ownership、claim、投递和持久化均为产品代码。强制终止用于制造真实未完成租约，补充此前三组 SIGTERM 演练；不把 SIGKILL 描述为正常退出。

`lease-takeover.json` 的实际读库结果：

| 项 | 原实例在途 | 新实例接管后 |
|---|---|---|
| task | `e9d3a761-78c9-4b57-bdcf-a97c1b1f5343` | 同一 task |
| notification | `34e33e18-4812-429b-80ad-5d450b8dc049` | 同一 notification |
| boot | `3d7c9338-ae0d-49f8-8253-c07ae6819199` | `d0914afc-eb28-4256-850a-6a3c390677b6` |
| 业务时刻 | 166246444 | 166299246 |
| 原 lease_until | 166297724 | 已到期后领取 |
| attempts / status | 1 / sending | 2 / accepted |
| 同 notification 的 Outbox 数 | 1 | 1 |
| DeliveryAttempt | 无 | 仅 1 条 accepted |

共 40 次独立 session 采样，其中原租约到期前 38 次均为 attempts=1、无投递 receipt；到期后才由新 boot 完成第 2 次尝试。未修改 lease、计数、时钟或投递结果。fixture 服务端仅记录一次成功 stub 投递。该证据关闭此前未证明的“同一在途任务到期接管”子项；不扩大为所有业务事件恰好投递一次的保证。

## 网络与 catalog

实际 `docker network inspect`：`Internal=true`（`network.json`）；data-worker 的 `/proc/net/route` 仅有内部子网，没有默认路由。所有服务未发布宿主端口。

```bash
"${C[@]}" up -d --no-build data-worker
"${C[@]}" run --rm --no-deps probe supplier-state
"${C[@]}" run --rm --no-deps probe snapshot --label review-isolation
```

`supplier-state.json`：`hits.catalog=1`、`stub_deliveries` 长度 1；`snapshot-review-isolation.json` 的 `chart_history` 为 idle、`error_type=null`。因此本轮 catalog 请求到达本地 fixture 并被真实业务刷新逻辑处理，不再用旧批次的 `catalog:HTTPStatusError` 冒充禁止出网证据。

## 收尾与边界

停止命令：`"${C[@]}" stop -t 30`。实际四个容器均已停止、非 OOM（通知组/data/PG exit 0，supplier exit 143）；保留本任务 volume、源码快照和 artifacts，不 `down -v`，不操作原项目或生产资源。

本轮五项 review 修复已具备对应代码及证据。**A09 信号级仍部分覆盖**，未被本轮接管/隔离验收替代；A08 仍是用户接受的非阻塞性能偏差，轨道 C 独立交付。不能据此把阶段 5 全部矩阵改为通过。
