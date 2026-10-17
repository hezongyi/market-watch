# 统一通知中心 W1 合同（2026-10-17）

依据 [Issue #75](https://github.com/hezongyi/market-watch/issues/75) 与[方案](unified-notification-center-plan-20261016.md)。本文件在写业务代码前冻结身份、游标、观察与渠道语义；实现只能按此合同扩展，改名需同步更新本文件与验收证据。

## 1. 数据对象

| 表 | 作用 | 关键唯一键 |
| --- | --- | --- |
| `notification_stream` | 单行 `(epoch, seq)`，投影发布在同一事务内加锁递增 | `id=1` |
| `notification_incidents` | 事故分组：`dedupe_key` 稳定故障上下文 | `(subject, dedupe_key)` |
| `notification_events` | 一次发生（不可变身份 + 可变展示版本） | `id`；服务端来源 `(subject, source_kind, source_id, source_version)` |
| `notification_changes` | 可补拉变更日志 | `seq`（全局单调） |
| `notification_observations` | 网页/声音/停止等观察事实 | `(subject, event_id, kind, profile_id, dedupe)` |
| `notification_source_claims` | 投影处理凭据，防重复投影 | `(source_kind, source_id, source_version)` |

所有表为加性迁移；既有 `notifications/outbox/delivery_attempts/device_receipts/audit_events` 语义不变，不删除、不回写。

## 2. 身份与序号

- `event_id`：服务端 `srv:<signal_id>`；浏览器 `web:<uuid4>`，由可信父页面在本地保存前生成，服务端在认证主体内幂等接受。
- `subject`：当前为单管理员会话主体 `owner`。
- `incident_id`：`(subject, dedupe_key)` 唯一事故；恢复后复发新建事故。
- `source_kind`：`signal`、`chart_alert`、`delivery`、`receipt`、`browser`、`backfill`。
- `source_version`：来源记录不可变版本（信号固定 `1`；投递/回执为各自记录 id）。
- 投影只按**处理凭据**去重，不做 `Audit.id > last_seen` 水位；迟提交的小 ID 仍会被投影。
- 变更序号只在 `notification_stream` 行锁内分配；回滚不暴露序号。

## 3. HTTP 合同

| 路由 | 语义 |
| --- | --- |
| `GET /api/notification-center/events` | 历史分页；返回 `epoch/high_watermark/items/next_before/unread`；`limit<=100`，API 上限 500；条件不含游标时重新取基线 |
| `GET /api/notification-center/events/{id}` | 详情 + 观察时间线（未知字段返回 `null`，不补造） |
| `POST /api/notification-center/events` | 浏览器事件上报；同 ID 同负载返回既有记录，不同负载 `409 CONFLICT`；16 KiB、每分钟 60（突发 120） |
| `POST /api/notification-center/observations` | 幂等观察；`viewed/handled` 不影响手机；`phone_stop` 同时执行旧 `acknowledge` 语义 |
| `GET /api/notification-center/changes?after_seq=` | JSON 补拉；`epoch` 不匹配或游标早于留存返回 `reset` |
| `GET /api/notification-center/stream` | SSE，`Last-Event-ID` 与 `after_seq` 同合同；`event: reset` 要求重建 |

`high_watermark` 与历史页在同一事务读取：历史只含 `first_seq <= H`，客户端随后用 `after_seq=H` 补拉，保证交接无静默遗漏。

## 4. 观察与渠道

| kind | 触发 | 约束 |
| --- | --- | --- |
| `received/rendered` | 客户端自动 | 幂等确认，不产生新事件 |
| `viewed/handled` | 用户动作 | 不影响 `ack_at`/Outbox |
| `phone_stop` | 显式按钮 | 调用旧确认：`ack_at`、`acknowledged`、Outbox `cancelled` |
| `sound_blocked/suppressed/expired/reserved/started/failed/unknown` | 声音 Module | `reserved` 每事件/渠道至多一次，失败不自动重试 |

旧 `/api/notifications/{id}/ack`、ntfy 动作与设备确认保持原语义；新网络已读不回填历史 `ack_at`。

## 5. 展示与降级

- 父页面持有入口与状态：`parent_starting → native_ready | parent_fallback`；切换不复制事件、未读和声音状态。
- 最多一个锚定气泡；按 `subject/profile/event_id/严重级别` 持久去重（级别升级可重新提示，渠道更新/计数不重弹）；普通成功 3 秒、故障 8 秒，悬停/焦点暂停。
- 首次快照、reset、历史翻页、回填、渠道状态更新不弹泡、不响铃。
- 目标宿主不可用时，父页面入口仍可打开中心并查看原因。

## 6. 预算（W1 冻结）

单事件 16 KiB；本机待同步 1,000 条 / 10 MiB / 7 天；入口 60 每分钟（突发 120）；内存 200 摘要；气泡队列 20；分页/补拉 100（API 500）；投影 30 天、变更 7 天。到限必须显式提示缺失范围。

## 7. 与旧链路的兼容矩阵

| 旧行为 | 新链路 |
| --- | --- |
| `notify_web=false` | 不生成即时气泡/声音候选，但事件仍可在中心查询 |
| `notify_ntfy=false` | 不创建 Outbox；投影事件 `channels.ntfy=disabled` |
| `late_delivery=log_only` | Outbox `suppressed`；投影记录 `late=true`，不重新推送 |
| 网页声音开关 | 只影响浏览器声音候选，不覆盖手机静默/重试设置 |
| 历史 `ack_at` | 保持"手机已确认"，不映射为网页已读 |
