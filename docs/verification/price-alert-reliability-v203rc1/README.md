# 实施与验收记录（进行中）

本文件记录当前证据，不是完成声明。全部 A01–A24、10 分钟性能负载、浏览器和独立 review/CI/Draft PR 仍按原任务书交付。

## 基线与环境

- 已 `git fetch origin --tags` 核实 `v2.0.3-rc.1 = ef57bed61f66715a4c5ec2797f9abd67cb23d2fb`。
- 工作树 `/home/quant/repos/market-watch-price-alerts-v203rc1`，分支 `feat/price-alert-reliability-v203rc1`。
- 本机 Ubuntu 主机 `quant-server`；Compose project `mw-price-alerts-v203rc1`。
- 当前仅启动 PostgreSQL，实际 `server_version_num=140024`；访问 `127.0.0.1:25463`。**尚无本任务可验收的网页地址。**
- PG 镜像固定 `postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`。
- 首次启动前：可用内存约 4.5 GiB、磁盘 7.9 GiB；依赖与 PG 准备后磁盘约 7.3 GiB。PG 限制 512 MiB / 1 CPU。完整栈构建前须重新检查余量。
- 私有配置在 `/home/quant/.local/share/market-watch-private/price-alerts-v203rc1`，目录 0700、文件 0600；不纳入 Git。
- `compose.yaml` 目前只含 PG；后续须补全 migrate、api、market-runtime、data-worker、notification-worker、web/网关和本地通知 fixture。
- 本 Docker 版本对仅 internal 网络未发布 host 端口；已为本任务 PG 增加独立 `host_access` 网络，端口实际绑定回环。未操作其他 project。

## 当前检查

| 检查 | 实际结果 | 范围限制 |
|---|---|---|
| 锁定依赖 + 本工作树 editable install | 成功 | Python 3.11，本任务 `.venv` |
| 首轮新行为用例 | 3 failed / 10 passed | 正确复现覆盖、跳柱及执行状态问题，保存于本机 `/tmp/mw-price-alerts-v203rc1-first-tests.log` |
| 接通触价后新用例 | 1 failed / 12 passed | 收盘跳柱仍失败；输入日志及两条触价回归通过 |
| live_pricing/service/domain/input 单元检查 | 62 passed | 未代表全套计划通过 |
| PG 日志/回滚/并发/迁移初轮 | 7 passed，0 skipped | 使用独立临时 schema；完整生命周期迁移/回退尚未验收 |
| PG 补充首条登记并发、信号/计数/游标回滚 | 9 passed，0 skipped | 最终本轮 PG 结果；通知 Outbox 回滚还须补手机偏好用例 |
| 扩展 composite + 新行为回归 | 7 failed / 24 passed | 未隐藏或跳过；详见下文 |
| Ruff（当前全部修改的 Python） | 通过 | 后续修改需重跑 |
| `git diff --check` | 通过 | 后续修改需重跑 |
| 空任务库完整升级链 | 成功 | 空库→`bb55_provider_catalog_indexes`→`bc56_price_alert_inputs`，每步查询真实 revision；不是已有事件/Outbox 兼容迁移用例 |

本机日志：`/tmp/mw-price-alerts-v203rc1-{unit,pg-inputs,composite,migrations,touch-tests}.log`。测试使用 fixture 账户、fixture 价格，不向真实通知 topic 发消息。

## 下一步与未完成项

1. **输入连续性和保留**：`prune` 已有同事务裁剪边界和有限批次测试，但尚未接入循环；全局 1,000,000 上限尚未实现，不能宣称日志已经有界。需优先回收已消费记录，再实施 24h/100k/1m 硬限制，覆盖未消费裁剪。补齐超过 15s 的实际采样缺口、异常退出/epoch、已知拒收和正常休市的区分。REST 日志仍依赖 display 接收成功，须解除 display 容量对告警输入的无关限制。
2. **收盘**：尚未分流，仍使用旧 latest-only 路径。需固定 revision 分页、确认窗口事实、稀疏 M1、首个未决柱阻挡、历史修订/跨源/DST/W1/MN/闭市末柱语义。
3. **到期**：worker/consume 仍有旧 detected_at 到期前置检查。必须实现 price-v2 固定范围结算、有限批次 expired 选择和不能补判的最终结论。
4. **执行故障**：已有 runtime、Audit、notice_source 初版；手机 60 秒延迟、永久错误立即通知、独立 notification runtime 巡检、发送配置校验和 health 汇总尚未完成。错误原因还须统一稳定 reason_code，页面文案与 code 分开。
5. **兼容与 UI**：React/原生入口、API 能力分模式、通知深链接及状态文案尚未修改。旧 active/paused/expired/completed、信号与 pending Outbox 的升级及代码回退用例尚未完成。
6. **当前回归失败**：`test_close_consumes_intermediate_confirmed_bar`；旧 sampled-quote 用例；旧 intrabar gap 用例的 15001/30000 参数；旧 intrabar input gate 用例；旧 untradeable 用例的两个参数。部分断言应从 timestamp/CompositeJudgment 改为 price-v2 日志/审计，部分是上述真正缺失的连续性处理。不得仅改断言掩盖缺口；复杂规则关键保护仍须保留。
7. **验收资产与交付**：补齐 `scripts/price_alert_acceptance.py`、browser 脚本、完整 Compose、矩阵逐项结果、固定性能负载、自审、独立 Standards/Spec review、CI 和 Draft PR。

## 当前可复现命令

```bash
cd /home/quant/repos/market-watch-price-alerts-v203rc1
.venv/bin/python -m pytest -q backend/tests/test_price_alert_inputs.py
.venv/bin/python -m pytest -q backend/tests/test_price_alert_reliability.py
# 第二条目前会明确报告未完成的 close 回归失败。

export MW_ALERT_PRIVATE=/home/quant/.local/share/market-watch-private/price-alerts-v203rc1
export MW_ALERT_PROJECT=mw-price-alerts-v203rc1
export MW_ALERT_COMPOSE=docs/verification/price-alert-reliability-v203rc1/compose.yaml
docker compose --env-file "$MW_ALERT_PRIVATE/compose.env" -p "$MW_ALERT_PROJECT" \
  -f "$MW_ALERT_COMPOSE" up -d --no-build postgres
docker compose --env-file "$MW_ALERT_PRIVATE/compose.env" -p "$MW_ALERT_PROJECT" \
  -f "$MW_ALERT_COMPOSE" stop
```

PG 测试从私有配置读取 URL，不在命令行/报告输出凭据：

```bash
.venv/bin/python - <<'PY'
import json, os, subprocess
from pathlib import Path
config = json.loads(Path('/home/quant/.local/share/market-watch-private/price-alerts-v203rc1/acceptance.json').read_text())
assert config['project'] == 'mw-price-alerts-v203rc1'
assert '@127.0.0.1:25463/price_alerts' in config['database_url']
raise SystemExit(subprocess.call([
    '.venv/bin/python', '-m', 'pytest', '-q',
    'backend/tests/test_price_alert_reliability_postgres.py',
], env={**os.environ, 'TEST_POSTGRES_URL': config['database_url']}))
PY
```

停止保留 volume。进行中任务未退役；未合并、未打正式 tag、未发布生产。
