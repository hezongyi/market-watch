# 阶段 5：运行组切换与回退操作手册

日期：2026-10-28。状态：**仅隔离 Ubuntu 任务实例演练通过**（证据见 `stage-4-preflight-acceptance.md`）；生产切换、回退、删除仍须按仓库规则取得本次授权，本手册不构成生产授权。

## 1. 适用范围

- 从旧多服务拓扑切到五个常驻应用服务：`web`、`api`、`market-runtime`、`data-worker`、`notification-worker`，加一次性 `migrate`（`compose.production.yaml` 渲染结果；`backup` 只在 `maintenance` profile 下出现）。
- 覆盖：切换前留档、配置核对、互斥切换顺序、回退顺序、回退后风险核对、异常处理。
- 不覆盖：轨道 C 的周日自动基线、30 天窗口清理解锁（尚未实施）；生产主机清单与授权流程。

## 2. 切换前留档（脱敏，存仓库外）

1. 旧部署清单：旧 Compose project 名（可多个）、旧 release 文件路径、旧镜像 digest。
2. 候选镜像 digest：`api`、`web`、`backup` 三处 `MW_*_IMAGE` 的固定引用（不可用浮动 tag）。
3. 数据库身份：host/库名/volume 名（不含口令）与当前 Alembic revision。
4. 旧版启动入口与自动重启配置：切换期间必须收口，避免检查后又被拉回。
5. 生产私有 `.env`：留在发布目录，不提交、不写入本记录。

## 3. 切换前配置核对（命令已验证可执行）

在发布目录使用已有的生产私有 `.env` 执行（`docker compose 29.1.3` 实测）。**不得创建、清空或删除该目录的 `.env`**。仅使用占位配置核对服务图时，把模板复制到独立临时目录，并只在该临时目录创建占位 `.env`；真实发布核对必须使用实际配置。

```bash
export MW_API_IMAGE=<api digest> MW_WEB_IMAGE=<web digest> MW_BACKUP_IMAGE=<backup digest>

# 3.1 服务图：必须只有下面 6 个（backup 需 --profile maintenance 才出现）
docker compose -f compose.production.yaml config |
  awk '/^services:/{s=1;next} /^[a-z]/{s=0} s && /^  [a-z0-9-]+:$/{print $1}'

# 3.2 Yahoo 开关：后端服务必须全部为 "true"（实测：api/data-worker/market-runtime/migrate/notification-worker）
docker compose -f compose.production.yaml config |
  awk '/^services:/{s=1;next} /^[a-z]/{s=0} s && /^  [a-z0-9-]+:$/{svc=$1} s && /ALERTS_YAHOO_ENABLED/{printf "%s %s\n", svc, $0}'

# 3.3 三组运行时只依赖 migrate 成功，不依赖 API healthy
docker compose -f compose.production.yaml config | grep -nE 'market-runtime:|data-worker:|notification-worker:|depends_on:|condition:' | head -30

# 3.4 记录库当前 revision（迁移前；本条未在文档切片中执行，需在发布目录按实际镜像核对）
docker compose -f compose.production.yaml run --rm migrate alembic current
```

3.1—3.3 已在本机用 docker compose 29.1.3 实跑验证（占位镜像与占位 `.env`）；3.4 需真实镜像与数据库，按发布目录执行。任一项不符预期即停止，不改写历史 release 清单。

### 3.5 通知深链可被手机访问（A17b 阶段暴露的落地要求）

ntfy 消息里的 `click` 与"确认"按钮都取自 `ALERTS_PUBLIC_URL`（`backend/alerts/notify.py:126-155`）：信号点击 = `{public_url}/advanced-charts?panel=notifications&signal=<id>`，确认 = `{public_url}/api/notification-actions/<id>/ack`。若它被设成 `http://127.0.0.1:...`，手机上点开的是**手机自身的回环地址**，点击与确认必然失败（阶段 5 验收实例上实测复现过）。

- 发布前必须把 `ALERTS_PUBLIC_URL` 设成手机真能访问的地址（生产走 HTTPS 域名），并在发布后**用手机实际点一次**通知与确认按钮。
- 生产必须保持 `ALERTS_COOKIE_SECURE=true`（配合 HTTPS）；只有局域网明文验收实例才允许临时置 false，且不得写入生产模板。
- 该地址同时是登录 Cookie 的作用域来源，改域名/端口时需一并复核登录与 CSRF 行为。

## 4. 切换顺序

1. 完成第 2、3 节，留档候选镜像 digest 与旧 project 名单。
2. **停止旧调度与旧 API**（用旧部署自己的 Compose 文件与 project；不 `down`、不删 volume）：
   ```bash
   docker compose -p "$OLD_PROJECT" -f "$OLD_RELEASE_FILE" stop \
     api notification-projector market-stream chart-history native-history
   ```
   服务名以实际旧清单为准；等待在途任务结束，检查 owner/fencing 状态。
3. **运行 preflight**（可重复 `--legacy-project`）：
   ```bash
   python deploy/ubuntu/runtime_preflight.py \
     --project "$NEW_PROJECT" --legacy-project "$OLD_PROJECT"
   ```
   - `0`：显式列出的 project 中无存活旧 API/调度，可继续。
   - `1`：仍有点名的旧容器存活（输出含 project/service/容器名），先停它再重跑。
   - `2`：Docker 查询失败（权限或 socket），先修访问，不得跳过。
   该检查只观察运行中的容器，不读心跳新鲜度；因此旧启动入口在切换期间必须保持停止。
4. **启动候选**：先 PG 依赖与一次性 `migrate`，再三个运行时组与 `api`：
   ```bash
   docker compose -p "$NEW_PROJECT" -f "$NEW_RELEASE_FILE" up -d
   ```
   `web` 在 API healthy 后启动（模板已声明该依赖）。不得与旧调度双跑。
5. **验证**：三组各自写入新 boot ID 且 role 为 healthy/idle；用隔离 fixture 触发一次输入，确认 signal/notification/outbox 各一条、ID 唯一无重复；再停 API 短时（演练用 12 秒）确认后台继续推进。真实供应商投递在验收中关闭。
6. **收口**：确认旧启动入口/重启策略不会再拉起旧调度，保留旧容器与数据库。

## 5. 回退顺序

1. 停止候选：先 `web`、再 `api`、再三个运行时组；确认无候选 owner 残留、容器已停。
2. **核对 schema 兼容，禁止运行旧迁移**。`v1.29.1-rc.2` 旧镜像 head 为 `ay52_history_modes`，无法解析 `az53_notification_outbox_types`：旧 `alembic upgrade`/`alembic current` 都会失败。不得 downgrade schema，不得让旧迁移改写任务库。
3. 用旧版**显式命令集**启动（形态与 `deploy/ubuntu/runtime-stage4-legacy.acceptance.yaml` 一致）：
   ```yaml
   api:                  [uvicorn, alerts.api:app, --host, 0.0.0.0, --port, "8000"]
   notification-projector: [python, -m, alerts.notification_center_worker]
   market-stream:        [python, -m, alerts.market_stream_worker]
   chart-history:        [python, -m, alerts.chart_history_worker]
   native-history:       [python, -m, alerts.native_history_loads]
   init: true
   ```
   `init: true` 是实测必需项：不加时通知投影、chart-history、native-history 在 10 秒与 30 秒宽限内都被 137 强杀（`OOMKilled=false`）；加上后五个旧服务全部在 1 秒内以 143/0 退出。该失败记录保留在 `stage-4-preflight-acceptance.md`。
4. 验证：旧 API `/readyz` ready、旧 projector 报 `ok`；旧 ORM 对 `notifications` 表基本读写正常（PostgreSQL 为 `az53` 新增列提供默认值）。演练只证明六列基本读写，**未覆盖全部旧业务写路径**；provider 被关闭时旧 `chart-history` 为 `degraded` 属预期。
5. 回退验证失败时保留新旧两侧容器、日志、数据库与证据，不删除任何 project/镜像/volume。

## 6. 回退后风险核对清单

- [ ] 已退役的 provider/managed 非 composite 规则**不得**因恢复旧镜像而自动恢复执行（恢复镜像不等于恢复运行状态）。
- [ ] 不自动重发旧 Outbox；旧通知只作兼容读取。
- [ ] 不与新组长期双跑；旧启动入口保持收口直到明确决定。
- [ ] 心跳不作为 owner 锁；preflight 只做切换防错，不消除"检查后旧版本又被启动"的竞争窗口。
- [ ] 轨道 C 的 30 天清理尚未实施：当前不存在"旧版读不到已删除输入"的风险；该轨道上线后，回退前必须重新核对保留边界，或按已验证备份恢复。
- [ ] 未改写历史 release 清单和既有 tag。

## 7. 异常处理

- preflight `2`：修 Docker 访问/权限，不跳过、不改用别的主机。
- 迁移失败：停候选、保留现场，不降级 schema、不重建 volume。
- 资源不足（磁盘/内存/swap 低于仓库阈值）：报告并等用户协调，不停止其他任务、不删除他人资源。
- 只清理本次任务已核实的容器/网络；`down -v`、全局 prune、删除备份或正式/回滚镜像均需授权。

## 8. 已演练与未演练

- 已演练：preflight 纯/CLI 合同 5 passed；隔离 fixture 冲突返回 1 并点名 `notify-worker`，仅停该容器后返回 0；真实 preflight 对活着的 `mw-single-frontend-20261026` 返回 1（点名 `api`、`notification-projector`）；隔离 old→new→old 顺序、候选迁移与恢复、旧 ORM 通知表读写（证据 `stage-4-preflight-acceptance.md`）。
- 未演练：真实生产清单与主机、真实供应商数据、真实 ntfy 与手机、旧版全部业务写路径、轨道 C 首次删除后的回退。
