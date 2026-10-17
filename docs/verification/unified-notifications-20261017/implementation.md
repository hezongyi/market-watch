# Issue #75 统一通知中心 · 实现与验收证据（2026-10-17）

## 1. 环境

| 项目 | 值 |
| --- | --- |
| 主机 | Ubuntu 本机 Docker（`/home/quant/dsh/market-watch-issue75-20261017`） |
| 分支 | `feat/issue75-unified-notifications-20261017`（基于 `51e5d1e`，即 v1.26.0） |
| Compose project | `mw-issue75-20261017`，独立网络/volume/PG14.24 |
| 访问地址 | 网页 `http://127.0.0.1:18176`；API `http://127.0.0.1:18175`；图表 `http://127.0.0.1:18177` |
| 镜像 | `market-watch-api:issue75-center` / `market-watch-web:issue75-center` / `market-watch-chart-origin:issue75-center` |
| 构建 | `mw-docker build --repo . --component {api,web,chart} --task mw-issue75 --project mw-issue75-20261017 --purpose acceptance` |
| 启动 | `docker compose --env-file <private acceptance.env> -p mw-issue75-20261017 -f deploy/ubuntu/unified-notifications.acceptance.yaml up -d --no-build` |
| 停止 | 同上 `down`（保留 volume）；清理用 `down -v`（仅本任务已确认归属） |
| 登录 | 真实登录页 + 管理员密码（密码与哈希只存在于 `/home/quant/dsh/.mw-secrets/issue75/`，不入库） |

镜像内容与本次提交一致；验收后未发布正式 tag、未触碰生产。

## 2. 实现范围

- **可靠来源与投影**：`notification_stream/incidents/events/changes/observations/source_claims` 六张加性表；投影 worker 仅消费已提交且无处理凭据的 `Audit`，处理凭据记录 `change_seq`，`event` 因来源唯一键幂等。旧 `notifications/outbox/delivery_attempts/device_receipts` 不变。
- **游标与恢复**：`(epoch, seq)` 单调变更流；JSON 补拉与 SSE 同一读取逻辑；epoch 不符/留存缺口返回 `reset`；历史页 `first_seq <= high_watermark`。
- **观察与渠道**：`received/rendered/viewed/handled/phone_stop` 与 `sound_*` 独立记录；`phone_stop` 才调用旧 `acknowledge`（`ack_at` + Outbox cancelled）；旧 ntfy/Android 确认未改。
- **父页面**：唯一入口 + 未读角标 + 单条锚定气泡（3s/8s，悬停/焦点暂停）；中心支持筛选、稳定分页（内存 200 条窗口，可连续翻页）、详情时间线、Escape 与焦点回归。
- **离线与声音**：本地 `web:` 事件先展示后写 IndexedDB；重连指数退避幂等补传；声音播放前持久预留 + Web Locks，跨标签至多一次自动尝试，结果分别记录。

## 3. 验收矩阵

浏览器证据：`playwright-results.json` + `screenshots/`（20 项全部通过）。
后端证据：`backend/tests/test_notification_center.py`（10 passed）。

| ID | 结果 | 证据 |
| --- | --- | --- |
| A1 | 通过 | `a1-entry.png`、`a1-bubble.png`；入口唯一、气泡唯一；布局高度稳定性在 A15 断言 |
| A2 | 通过 | 7 页 693 条连续读取；类型/级别/关键词筛选；`a2` 分页窗口 100→200 且不超过预算 |
| A3 | 通过 | `a3-detail.png`；详情含稳定 ID、来源、本地/UTC、received/rendered/viewed 时间线 |
| A4 | 通过 | `a4-alert-detail.png`；实际值/阈值/规则版本/图表代次/观测 ID |
| A5 | 通过 | 渠道 `ntfy,device` 与网页观察分离；`a8-r2-chain.json` |
| A6 | 通过 | 同事故 3 次以上计数保留；刷新后断言不再弹泡 |
| A7 | 通过 | 成功短提示且可在中心回查 |
| A8 | 部分 | `a8-r2-chain.json` 串联 audit→claim→change→event→channels/observations；未采集完整网络/DOM 时间线与生产只读观察 |
| A9 | 通过 | `a9-projector-restart.txt`：停 worker 期间 4 条来源不投影，重启后恰好 +4，再次重启不变 |
| A10 | 通过 | 离线立即展示、待同步计数、恢复后 pending=0、刷新后事件仍在 |
| A11 | 通过 | 后端 `changes_since` 版本合并与前端 updated 应用；晚到旧版本不覆盖（详见后端测试） |
| A12 | 通过（后端） | 迟提交的低 `Audit.id` 仍被投影且只生成一次事件（`test_late_committed_lower_audit_id_is_still_projectable`） |
| A13 | 通过 | 断线重连后写端 pending 清零、另一标签页仅靠补拉收敛到同一事件；epoch/留存 reset 由后端测试覆盖 |
| A14 | 通过 | 网页 viewed 不写 `ack_at`；显式停止才写旧确认 |
| A15 | 通过 | 阻断图表宿主后父页面入口仍可打开并查看记录；打开中心前后 `main.advanced-workspace` 宽高不变（`a15-fallback.png`） |
| A16 | 通过 | 双标签共享声音预留，`sound_reserved=1` |
| A17 | 部分 | 未解锁 `sound_blocked`、超 30 秒 `sound_expired` 已验证；隐藏页/静音/失败组合未自动化 |
| A18 | 通过 | 跨品种同名 2 instruments/2 incidents；显式标记恢复后再发生会创建新事故（新 incident_id，旧事故保持 resolved）；严重升级未单独自动化 |
| A19 | 部分 | 40 条突发 185–315ms 内可打开、内存条目 ≤200；未做量化 DB 增长/资源阈值 |
| A20 | 通过 | `a20-migration.txt`：新库升级→降级→再升级，旧 `notifications/outbox` 行始终保留；键盘/Escape 焦点回归；独立 PG 演练 |

## 3.1 独立 review 落实（2026-10-18）

| 级别 | 问题 | 落实 |
| --- | --- | --- |
| P0 | 默认/生产 compose 没有投影 worker，部署后告警不进中心 | `compose.yaml`、`compose.production.yaml` 增加 `notification-worker`；两份 compose `config -q` 通过 |
| P1 | 刷新后声音“已开”但无 AudioContext，先预占再 failed | 仅在 `running` 上下文才预留；否则记 `blocked/gesture_required`；顶部按钮在“待解锁”时点击即重新解锁 |
| P1 | 并发同 dedupe_key 唯一键冲突导致浏览器事件被丢弃 | 浏览器入口先锁 `notification_stream` 行串行化；API 对 IntegrityError 重试一次并返回可重试 503；客户端不再因 422/5xx 删除待同步 |
| P1 | 事故永不 resolved | 新增显式恢复接口与详情按钮；部分唯一索引保证恢复后再发生创建新事故 |
| P1 | 观察写入失败静默丢失 | 有界（100 条、5 次）观察重试队列；服务端唯一键保证幂等 |
| P2 | 气泡去重只在内存 | 按 `subject/profile/event_id/attention_version` 写入 IndexedDB（DB v2），跨标签/刷新生效 |
| P2 | refresh 期间游标回退 | 刷新前关闭旧 SSE，游标取 `max(cursor, H)` 后再重连 |
| P2 | A12 测试无法区分 claim 与 max(id) | 改为两个新信号 + 显式低 `Audit.id`，断言两个事件/两条凭据 |
| P2 | 证据断言不足 | A6 增加刷新不弹泡、A13 增加对端收敛、A15 增加布局宽高断言 |
| P2 | 行锁只在 SQLite 验证 | 新增 `TEST_POSTGRES_URL` 双线程投影测试（CI 的 PG 14 服务上运行，20 事件/20 凭据） |

## 4. 迁移与回退

- 迁移 `ba50_notification_center`（`down_revision=av49_indicator_demands`）只建新表；降级只删新表，旧通知/投递/回执证据保留（`a20-migration.txt` 实测）。
- 应用回退到旧镜像时新表保留但不再写入；投影 worker 可停止而不影响旧投递链路。

## 5. 已知边界（W5/W6 待补）

1. 事故恢复目前只有显式动作（详情“标记事故已恢复”/`POST /incidents/{id}/resolve`），生产者自动上报恢复尚未接入；没有恢复证据时仍保持 `open`。
2. A8 全链路 R2：缺少网络/DOM 时间线、生产只读观察与错误注入证据。
3. A17 隐藏页/静音/音频失败组合与 A19 资源量化需在 W5 补测并冻结阈值。
4. A12 跨页并发创建/更新与反序提交压力尚未做浏览器级注入（后端逻辑已覆盖）。
5. 浏览器声音依赖用户手势；验收环境为 headless，实际可听性需人工确认。

## 6. 复跑

```bash
# 密码/环境文件在任务私有目录，不提交
set -a; . /home/quant/dsh/.mw-secrets/issue75/acceptance.env; set +a
docker compose --env-file /home/quant/dsh/.mw-secrets/issue75/acceptance.env \
  -p mw-issue75-20261017 -f deploy/ubuntu/unified-notifications.acceptance.yaml up -d --no-build
docker compose ... exec -T api python -m alerts.notification_seed --signals 620 --spacing-ms 5000
docker compose ... exec -T api python -m alerts.notification_seed --signals 3 --same-alert --alert acc-group
docker compose ... exec -T api python -m alerts.notification_seed --signals 2 --alert acc-cross --instrument EURUSD
docker compose ... exec -T api python -m alerts.notification_seed --signals 2 --alert acc-cross --instrument XAUUSD
docker compose ... exec -T api python -m alerts.notification_seed --deliver-latest 5 --receipt-latest 5
LD_LIBRARY_PATH=/home/quant/dsh/.browser-libs/root/usr/lib/x86_64-linux-gnu \
  MW_ACCEPTANCE_PASSWORD=*** node web/tests/unified-notifications.browser.cjs
```
