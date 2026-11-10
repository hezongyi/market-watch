# 价格告警可靠性：实施与验收记录（进行中）

风险分类 **F1 / 定向 R2**：新增有界持久输入、规则执行契约、到期结算、故障通知及兼容迁移。本记录不是完成声明。**10 分钟固定负载尚未验收；远端 CI 和 Draft PR 待最终验收后更新。GitHub API 登录已恢复。**

## 基线、隔离与运行

- 固定基线：`v2.0.3-rc.1`，`ef57bed61f66715a4c5ec2797f9abd67cb23d2fb`。
- 工作树：`/home/quant/repos/market-watch-price-alerts-v203rc1`；分支：`feat/price-alert-reliability-v203rc1`。
- Ubuntu 本机：`quant-server`；Compose project：`mw-price-alerts-v203rc1`。
- 网页：**http://127.0.0.1:28463**；PG：`127.0.0.1:25463`。均仅绑定本机回环地址，不是 Unraid 或 SSH 转发实例。
- 已运行 PG、migrate、API、market-runtime、data-worker、notification-worker、本地 HTTP 通知 fixture、web。API `/readyz` 已通过。行情、账户和通知 topic 均为本任务 fixture；不发送真实手机消息。
- PG 固定 `postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`，实际 `server_version_num=140024`。健康检查同时临时启用 JIT 并检测 `pg_jit_available()`。
- 当前运行镜像：API `sha256:261c73a7be4a48f1e866fbd7bb13a865979519cd4ea3251252105242a732cdb6`；web 镜像最终浮层修复重建后另行记录。应用运行源码包含 `e2dde20a` 的修复；镜像在提交前从同一工作树构建，标签中的 Git revision 仍是旧 HEAD，以上 image ID 才是本次实际运行证据。
- 私有配置：`/home/quant/.local/share/market-watch-private/price-alerts-v203rc1`（目录 0700，配置 0600）；密码、env、许可库、完整浏览器输出不入 Git。
- 网络、数据库、schema、volume、端口均属本任务。测试 schema 在任务 PG 中独立创建；未修改或停止其他项目、`mw-dev` 或生产。
- market-runtime 使用真实 supervisor，只将 pricing loop 替换为受控 producer；故障验收可在真实 alert monitor 的 step 边界暂停规则推进。其余确认、聚合、消费、Outbox、通知投递与投影走真实模块。

```bash
cd /home/quant/repos/market-watch-price-alerts-v203rc1
export MW_ALERT_PRIVATE=/home/quant/.local/share/market-watch-private/price-alerts-v203rc1
export MW_ALERT_PROJECT=mw-price-alerts-v203rc1
export MW_ALERT_COMPOSE=docs/verification/price-alert-reliability-v203rc1/compose.yaml

docker compose --env-file "$MW_ALERT_PRIVATE/compose.env" -p "$MW_ALERT_PROJECT" \
  -f "$MW_ALERT_COMPOSE" up -d --no-build
# 保留数据库与 volume：
docker compose --env-file "$MW_ALERT_PRIVATE/compose.env" -p "$MW_ALERT_PROJECT" \
  -f "$MW_ALERT_COMPOSE" stop
```

构建必须使用 `mw-docker`（本机安装版本的 web 默认 context 较旧，故显式指定）：

```bash
mw-docker build --repo . --component api --tag market-watch-api:price-alerts-v203rc1 \
  --task mw-price-alerts-v203rc1 --project mw-price-alerts-v203rc1 --purpose acceptance
mw-docker build --repo . --context . --file web/Dockerfile --component web \
  --tag market-watch-web:price-alerts-v203rc1 \
  --task mw-price-alerts-v203rc1 --project mw-price-alerts-v203rc1 --purpose acceptance
```

## 实现范围

- 触价按 dataset 共享已提交日志、每规则独立游标；采集快照与日志同事务。支持同毫秒不同报价、重发去重、REST close 采样口径、保留裁剪和断线边界。每轮最多 256 条观察。
- close 固定 revision / input_revision，按周期终点补判，每轮最多 128 周期。区分稀疏有效分钟、查询确认失败和真实未知区间；不以当前报价有效性挡住历史已确认柱。
- 输入保留为 24h、每 dataset 100,000、全局 1,000,000 条；裁剪与边界同事务。无输入时仍由既有 worker 定期维护。
- 到期冻结 version/run/有效区间/输入截止位置；只结算已取得且可验证的有效期内输入。关闭采集不丢弃已提交积压；不能判定时有限终结并留痕。
- 运行故障保留用户 active 意图。稳定 reason_code、不可补判区间、故障实例和恢复均持久化；notifications runtime 独立巡检接管/推进停滞。短故障站内留痕，手机临时故障延迟 60s，永久错误和已确认缺口立即排队。
- edit/restart 保留故障引用，实际恢复后关闭对应实例；编辑离开价格路径明确结束观察，不伪称恢复。正常休市不代替连接恢复证据。
- React 与原生图表入口按 close / intrabar 分模式准入，展示执行进度、缺口、通知状态和规则链接。复杂指标/几何/ATR 路径保持原契约。组合切换不会自动改绑价格规则。

## 当前验证证据

以下均为实际命令结果；历史失败不冒充通过。

| 检查 | 最新结果 | 证据/限制 |
|---|---|---|
| 三项原始行为回归及输入/close/到期 | 已有通过证据；本轮受影响集复验 | 快照覆盖、跳柱、故障不自动暂停 |
| 审查修复 + execution / settlement / close | **67 passed** | `/tmp/mw-price-alerts-v203rc1-review-final.log` |
| 迁移三模块 | **21 passed** | `test_alerts_mcp_migration.py`、`test_chart_alert_migration.py`、`test_chart_alert_postgres.py`；55 条 Alembic 既有弃用警告 |
| 真实 PG 可靠性专项全文件 | **64 passed，0 skipped** | `/tmp/mw-price-alerts-v203rc1-pg-review.log`；包括真实旧 evaluator 回退 |
| PG既有链路整合5模块 | **46 passed，0 skipped** | composite alerts /live pricing /market usage /notification outbox /switch activation；`/tmp/mw-price-alerts-v203rc1-pg-integration-final.log` |
| 后续 PG 故障/控制并发/DST 边界 | **15 passed，0 skipped** | `/tmp/mw-price-alerts-v203rc1-pg-final-boundaries.log`；涵盖全文件运行后补充场景 |
| 春秋 DST 周末最后 M1 / W1 收盘柱 | **4 passed** | 真实确认→聚合→创建/判断，闭市期间补判，不重复；已纳入上述 PG 复验 |
| HTTP 通知故障 | 已通过，纳入 execution 复验 | 本地真实 HTTP 500、401、403、超时、静默、200；server_accepted 不等于设备到达 |
| 最新核心15模块 | **199 passed** | `/tmp/mw-price-alerts-v203rc1-core-final.log`；含原任务11模块及追加输入/能力/节奏/原始可靠性 |
| CI ops | **110 passed，88 subtests passed** | `/tmp/mw-price-alerts-v203rc1-ops.log` |
| Python Ruff（相对 rc.1 全部改动） | 通过 | 后续新增 Python 另行复验 |
| 前端69条CI Node命令 | **全部通过** | `/tmp/mw-price-alerts-v203rc1-web-ci.log`，包括适用browser脚本 |
| 前端生产构建 | 通过 | 最新 web Docker build 含 tsc、Vite 与单前端产物构建 |
| 浏览器 | 部分已通过，浮层修复后待最终重跑 | 已真实创建/幂等、零浏览器继续判断、断线恢复、缺口与通知链接；末步发现浮层挡住详情按钮，已修复，不能据此先标 A23 完成 |
| 独立巡检运行时故障注入 | **2场景通过** | [runtime-faults.json](runtime-faults.json)：真实monitor存活不推进、market-runtime进程停止；notifications独立检测/恢复 |
| 全 backend suite | **未通过完整运行** | 旧轮运行在 557 passed /15 failed /2 skipped 时中断；已定位的失败已修复并定向重跑。不能把相关模块通过表述为全套 CI 通过 |
| 远端 CI / Draft PR | 待创建 | 先前 gh 登录失效，本轮复查已恢复，继续交付 |

### 存量迁移与代码回退

`test_populated_alembic_upgrade_and_rc1_evaluator_rollback_fence` 在独立任务 schema 中提取固定 rc.1 原源码，执行原 Alembic head，再用原 evaluator 生成旧状态和历史：active close/touch、paused、带明确 stale_input 的旧暂停、expired、archived、completed、已有 signal/judgment/pending Outbox。

实际 revision：`bb55_provider_catalog_indexes` → `bc56_price_alert_inputs`。升级前后不可变历史逐项相等；旧 active 幂等接管，touch 留升级边界，不自动恢复 paused。回退验证先停新写入者并将 price-v2 规则保持暂停，再运行原 evaluator，证明不误读新日志游标，旧信号及 Outbox 仍可读取。没有执行破坏性 downgrade。

### 性能：未验收

公开数值见 [performance-smoke.json](performance-smoke.json)。这只是 `--seconds 10` 的脚本烟测，**不是要求的 600 秒验收**。

| 指标 | rc.1 基线 | 当前候选 |
|---|---:|---:|
| 品种 / 规则 / 提供观察 | 10 /50 /400 | 10 /50 /400 |
| 计划输入时间 /实际时间 | 10s /159.45s | 10s /111.18s |
| 实际有效观察速率 | 2.51/s | 3.60/s |
| 采集提交 p95 | 871.35ms | 459.73ms |
| 输入到信号提交 p95 | 4086.66ms | 14877.56ms |
| 产生信号 /预期 | 12 /100 | 100 /100 |
| 最终候选输入积压 | 不适用 | 0 |

两边全部 400 输入被真实 collector 接受；候选没有丢掉预期穿越。固定速率不成立，`fixed_load=false, passed=false`。主机为共享 4 vCPU；本轮 load average 约 22–26，PG 配置 1 CPU /512 MiB，同期还有功能回归与构建。本结果同时反映主机竞争、验收 PG 配额及串行模块成本，不能归因单一因素，也不能外推性能达标。候选 p95 本轮实际不达标。保留现场，需在资源可维持固定速率时错峰运行原 600 秒负载；不停止其他任务，不扩大到多实例或更高输入率。

## A01–A24 对照

| 编号 | 当前证据与状态 |
|---|---|
| A01 | 原生真实创建/HTTP 重放已通过；API/MCP 共用幂等事务回归通过 |
| A02 | 浏览器已关闭全部 context，图表租约归零后真实 producer/runtime 产生 101 信号 |
| A03–A04 | 真实 collector 连续路径与同毫秒、重发用例通过，PG 运行 |
| A05 | 10 品种 /50 规则烟测按 dataset 共享输入、候选100个信号通过；固定40/s性能未验收 |
| A06 | PG 信号/游标/次数/Outbox 一起回滚并重试、不重复，通过 |
| A07 | stream / REST receive-time、模式切换、显示容量独立性用例通过 |
| A08 | 连续积压及 late_delivery 用例通过 |
| A09–A10 | 真断线恢复浏览器部分已通过；PG 保留裁剪/缺口/恢复基准通过 |
| A11–A13 | 顺序 close、多批、次数上限、旧报价失效、稀疏M1/未确认/失败窗口，PG 通过 |
| A14 | 九周期、月桶截断、春秋 DST、闭市最后M1/W1，PG 通过；不以 NY17 代替来源会话证据 |
| A15 | 老 seam、窗口不可读、冻结/账户变化、固定绑定和能力分模式回归通过 |
| A16 | pause/edit/restart 与已持锁判定并发，旧事件保留 version/run，PG 通过；resume 未来基准另有采集回归 |
| A17 | 有限结算、有效期等值拒绝、关闭采集后有效积压、分批/回滚，PG 通过 |
| A18 | 最新核心回归199项通过，保留复杂指标/几何/ATR路径 |
| A19 | PG 故障去重/恢复/再次故障/永久区间、edit/restart与离开价格路径、休市实际恢复，通过 |
| A20 | PG独立巡检及真实运行时存活停滞/进程停止均通过，规则active、每实例故障与恢复对应 |
| A21 | 配置错误、真实本地 HTTP 故障/重试/blocked/quiet/200，execution 回归通过 |
| A22 | 真实填充旧库 Alembic 升级、幂等接管及原 evaluator 代码回退围栏通过 |
| A23 | 浏览器最终重跑待补，当前不标完成 |
| A24 | PG 裁剪/消费互斥、登记/采集、事务回滚、控制并发和跨dataset容量用例通过 |

## 复现命令

```bash
.venv/bin/python scripts/price_alert_acceptance.py seed \
  --config "$MW_ALERT_PRIVATE/acceptance.json" --output "$MW_ALERT_PRIVATE/seed.json"
MW_ALERT_ACCEPTANCE_CONFIG="$MW_ALERT_PRIVATE/acceptance.json" \
  node web/tests/price-alert-reliability.browser.cjs
.venv/bin/python scripts/price_alert_acceptance.py runtime-faults \
  --config "$MW_ALERT_PRIVATE/acceptance.json" --output "$MW_ALERT_PRIVATE/runtime-faults.json"
# 固定负载只在有可维持速率的资源时执行：
.venv/bin/python scripts/price_alert_acceptance.py perf --seconds 600 \
  --config "$MW_ALERT_PRIVATE/acceptance.json" --output "$MW_ALERT_PRIVATE/performance.json"
```

PG 测试从私有配置加载 URL，不在命令行或日志打印：

```bash
.venv/bin/python - <<'PY'
import json, os, subprocess
from pathlib import Path
cfg = json.loads(Path('/home/quant/.local/share/market-watch-private/price-alerts-v203rc1/acceptance.json').read_text())
assert cfg['project'] == 'mw-price-alerts-v203rc1'
assert '@127.0.0.1:25463/price_alerts' in cfg['database_url']
os.environ.update(TEST_POSTGRES_URL=cfg['database_url'], CHART_ALERT_TEST_DATABASE_URL=cfg['database_url'])
raise SystemExit(subprocess.call(['.venv/bin/python', '-m', 'pytest', '-q',
    'backend/tests/test_price_alert_reliability_postgres.py']))
PY
```

## 独立审查与停止边界

两路独立 Standards / Spec review 已运行，详见 [reviews.md](reviews.md)。不合并、不打正式 tag、不发布 Unraid/生产。进行中资源保留，不做全局清理或删除 volume。最终仍须补齐有效性能、浏览器/运行时最终结果及 CI/Draft PR，之后才可宣称任务完成。
