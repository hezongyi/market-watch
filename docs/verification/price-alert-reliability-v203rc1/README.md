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

## 检查历史与当前结果

| 检查 | 实际结果 | 范围限制 |
|---|---|---|
| 锁定依赖 + 本工作树 editable install | 成功 | Python 3.11，本任务 `.venv` |
| 首轮新行为用例 | 3 failed / 10 passed | 正确复现覆盖、跳柱及执行状态问题，保存于本机 `/tmp/mw-price-alerts-v203rc1-first-tests.log` |
| 接通触价后新用例 | 1 failed / 12 passed | 收盘跳柱仍失败；输入日志及两条触价回归通过 |
| live_pricing/service/domain/input 单元检查 | 62 passed | 未代表全套计划通过 |
| PG 日志/回滚/并发/迁移初轮 | 7 passed，0 skipped | 使用独立临时 schema；完整生命周期迁移/回退尚未验收 |
| PG 补充首条登记并发、信号/计数/游标回滚 | 9 passed，0 skipped | 最终本轮 PG 结果；通知 Outbox 回滚还须补手机偏好用例 |
| 首阶段扩展 composite + 新行为回归 | 7 failed / 24 passed | 历史结果；本轮已解决触价相关 6 项，close 仍未实施 |
| 核心回归（原计划 11 个模块 + input/session） | 179 passed | 在本轮最后的年龄边界/恢复基准补充前运行；补充改动另有定向验证 |
| 输入日志 + 新可靠性用例 | 21 passed / 1 failed | 加入手动恢复边界后；唯一失败仍是 close 顺序消费 |
| 本轮最终 input/composite/session 定向回归 | 53 passed | 覆盖最后的年龄边界和手动恢复改动 |
| 本轮最终真实 PG 输入/保留/并发回归 | 17 passed，0 skipped | 包括全局/单品种硬上限、消费与裁剪互斥、创建登记、手动恢复、REST 容量和正常闭市 |
| Ruff（当前全部修改的 Python） | 通过 | 后续修改需重跑 |
| `git diff --check` | 通过 | 后续修改需重跑 |
| 空任务库完整升级链 | 成功 | 空库→`bb55_provider_catalog_indexes`→`bc56_price_alert_inputs`，每步查询真实 revision；不是已有事件/Outbox 兼容迁移用例 |

本机日志：`/tmp/mw-price-alerts-v203rc1-{unit,pg-inputs,composite,migrations,touch-tests}.log`。测试使用 fixture 账户、fixture 价格，不向真实通知 topic 发消息。

本轮新增日志：`/tmp/mw-price-alerts-v203rc1-{core,price-current,final-continuity,pg-continuity}.log`。

## 下一步与未完成项

1. **输入连续性和保留已推进**：每 dataset 100,000 / 全局 1,000,000 条在采集提交事务中强制生效，优先回收有效 consumer 已处理数据；24h 过期前缀在追加/消费前回收。既有 worker 每 60 秒执行有限批次清理，停止行情后仍可清理；停止 evaluator 时采集仍执行硬上限。裁剪边界与删除同事务。默认上限的容量/延迟实测仍未完成，当前上限测试采用缩小常量覆盖边界。
   - 已覆盖同毫秒、重复输入、回滚、超过 15s 的实际采样缺口、连续积压的迟到投递、无连续性证据的 epoch 切换、明确拒收、REST 显示容量独立性和手动恢复首个新穿越。
   - 已覆盖有依据的休市区间（跨连接恢复仍比较开盘）及 DST 关闭时长；未知日历仍保守留缺口，不能冒充闭市。
   - 锁顺序为既有 dataset/LiveState/display → 日志保留 advisory mutex → Stream。全局裁剪只触碰日志，不反向获取 dataset/LiveState/ChartAlert 行锁。消费与裁剪使用同一 mutex；固定负载下的锁成本必须由性能验收确认。
2. **收盘**：尚未分流，仍使用旧 latest-only 路径。需固定 revision 分页、确认窗口事实、稀疏 M1、首个未决柱阻挡、历史修订/跨源/DST/W1/MN/闭市末柱语义。
3. **到期**：worker/consume 仍有旧 detected_at 到期前置检查。必须实现 price-v2 固定范围结算、有限批次 expired 选择和不能补判的最终结论。
4. **执行故障**：已有 runtime、Audit、notice_source 初版；手机 60 秒延迟、永久错误立即通知、独立 notification runtime 巡检、发送配置校验和 health 汇总尚未完成。错误原因还须统一稳定 reason_code，页面文案与 code 分开。
5. **兼容与 UI**：React/原生入口、API 能力分模式、通知深链接及状态文案尚未修改。旧 active/paused/expired/completed、信号与 pending Outbox 的升级及代码回退用例尚未完成。
6. **当前明确失败**：`test_close_consumes_intermediate_confirmed_bar`。旧触价用例已改为穿过真实 publish 接口并断言日志序号/永久缺口审计；原复杂指标规则的 fixtures/保护继续保留。关闭上游输入时必须先消费已提交合法日志，不能再靠“当前 owner 失效”丢弃它们。
7. **验收资产与交付**：补齐 `scripts/price_alert_acceptance.py`、browser 脚本、完整 Compose、矩阵逐项结果、固定性能负载、自审、独立 Standards/Spec review、CI 和 Draft PR。

## 收盘接续前的证据检查

- `CompositeAggregateTask.applied_input_revision` 是已发布固定输入水位；读取新 price close 分页应固定这一版本，不要求全局 prep 已完全追平。
- `CompositeAggregateBar` 可分页按 start 读取各桶最近的 `input_revision <= 固定水位`，无需反复 `chart_page(count=2000)`。
- 现有聚合 reader 因旧 seam 年龄整体返回 None；新价格 reader 需要检查具体物化柱的构建输入边界，尤其 MN 的 31 天跨度，不能单纯去掉 guard。
- `LiveState.confirmed_end`/`source_confirmed` 只证实已有分钟。`CompositeReadAttempt` 有准备请求的 accepted/checkpoint 事实，`LiveMinute` 有实际失败/已观察未确认的证据；目前没有覆盖所有实际 `confirmed_minutes.record` 入口的紧凑成功查询区间事实。
- 下一步先在成功 checkpoint 的同事务入口补最小确认窗口事实（含空成功、有界 checkpoint；失败继续保留现有窗口证据），再实现稀疏收盘准入与顺序消费。不改变图表 coverage 真值，不扩大历史窗口。

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
