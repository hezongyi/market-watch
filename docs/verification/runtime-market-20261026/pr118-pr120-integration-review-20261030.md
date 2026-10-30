# PR #118 / #120 处理建议与本地候选

日期：2026-10-30。项目：hezongyi/market-watch。

## 建议

以 #120 为主线，整合 #118 的业务代码和测试，修复 #120 的空采样回归，补齐可审查证据后再决定合并。#118 可以在其有效改动已进入 #120 且检查通过后关闭，不应仅凭编号较旧直接丢弃。

- 当前远端 main：`5dc2b98a`。
- #118：`d37f115e`，与 main 的 merge-base 为 `0eac4fe7`。GitHub 报告 `CONFLICTING / DIRTY`。
- #120：`f3c068f7`，基于当前 main；未包含 #118。
- #118 的三处业务修改分别在 monitor、alert worker、aggregate commit；#120 修改 aggregate scheduler、composite evaluation、input ingestion。两者互补。
- 三方比较发现 #118 的验收矩阵文档冲突：旧分支仍把已经完成的 Track C/A05 列为待完成。不能以旧文档覆盖 main 的新验收状态。
- 仅提取 #118 的八个 backend/tests 路径可干净应用到 #120；无需把旧历史文档整体迁入。

## Standards

#118 未发现明确仓库规范违规。其 `pr118-review-fix-20261029.md` 已提供 F1 分类、最小检查、实际环境及复跑入口，且保留 A08 偏差。

#120 存在证据交付缺口。正文引用的 `a08-ema-blind-window-20261029.md`、`a08-l2-handoff-20261029.md` 和 `scripts/acceptance/a08_retest*.py` 均未进入该 PR。原始报告和脚本在其他本机 worktree 存在，但其中包含未提交修改，不能直接认定为 #120 的可复现证据。本次未改动那些 worktree。

依据 AGENTS.md 的验收交付要求，更新远端 PR 前应补入脱敏报告、准确候选 SHA、实际运行预算及复跑入口。既有实测不能自动认证本次整合后的代码。

本轮远端更新采用本文件的 97 项局部行为/合同证据，不再把上述缺失材料和旧性能数字列为当前候选验收依据。原始文件保留在原工作树，未复制其分叉脚本或旧交接结论。完整性能装置修复及 A08 多场景测量继续作为待完成工作，不属于本次缺陷修复和复审的完成声明。

## Spec

#118 未发现新的明确阻断问题。健康且未超时轮可以提前唤醒；错误、部分失败、超时轮保持等待；所有权丢失继续向上传播。

#120 原始提交有 P1 回归：`composite_alerts.evaluate()` 在判断门控开关及样本可用性之前构造 gate key。盘中报价不可交易时，`sampled_observation()` 返回 None，`gate_key()` 读取 `sample["kind"]` 抛 TypeError。原有 stale/recovering 分支无法执行，关闭门控也不能规避。独立临时回归覆盖开关 0/1：原始 #120 两项失败；Spec 复审者在 #118 上跑同一行为回归，两项通过。

本地修复将 gate key 构造移入门控已启用且 gateable 检查通过的分支。新增仓库回归确认：开关 0/1 时不可交易报价均进入 stale/recovering；恢复后的第一次交叉只建立恢复基准，不发历史事件。整合后的候选经 Spec 再审，未发现剩余明确功能阻断项。

## 本地候选与验证

- 分支：`fix/pr118-pr120-integration-20261030`。
- 工作树：`/home/quant/repos/market-watch-pr120-audit-20261030`。
- 基线：#120 的 `f3c068f7`，叠加 #118 业务/测试和上述空采样修复。
- 业务代码与已验证测试提交：`0915344d`。后续复审说明只修改本文档；以 PR 当前 head 的源码 diff 核对业务文件未变。
- 风险：F1，告警重要后台链路；无 schema 迁移。本轮最小检查为相关行为回归、独立真实 PG 提交/回滚/水位/并发合同、ruff、自审及独立 Spec 复审。
- SQLite/组件回归：72 passed，0 failed，0 skipped，28.87 秒。
- Ubuntu PostgreSQL 回归：25 passed，0 failed，0 skipped，23.36 秒。
- ruff、git diff --check 通过；警告仅为现有依赖弃用提示。
- 本轮未重跑 A08 性能或完整五服务场景，也未运行完整仓库 CI。

组件回归：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_alert_monitor_cadence.py \
  backend/tests/test_alert_monitor_wakeup.py \
  backend/tests/test_composite_alerts.py \
  backend/tests/test_composite_aggregate_wakeup.py \
  backend/tests/test_composite_aggregates.py \
  backend/tests/test_publication_wakeup.py
```

## Ubuntu PostgreSQL 环境与复跑

实际主机为 Ubuntu `quant-server`。启动前只读盘点：已有一套 chart-live-fix project 和 BuildKit；约 8 GiB 可用内存、25 GiB 磁盘余量。本轮只新增独立 PostgreSQL，不构建应用镜像，不共享其他任务的可写数据库。

- project/task：`mw-pr118-pr120-audit-20261030`。
- 固定镜像：`postgres@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`（PG14.24）。
- 资源：0.5 CPU、512 MiB 内存、384 MiB tmpfs PGDATA；独立 internal 网络。
- 没有 HTTP/UI 地址或宿主发布端口；测试使用本任务容器在专属网络上的动态 IP:5432。
- Compose 和独立凭据保存于本工作树 `artifacts/pr118-pr120-audit/`，目录 0700、凭据 0600，不提交。
- PG 日志：同目录 `postgres-regression.log`。该容器已停止，tmpfs 不保留数据；未删除其他资源或任何持久卷。

首次准备配置（在本任务工作树执行；已存在的凭据不覆盖，不输出连接串）：

```bash
python3 - <<'PY'
import json, os, secrets
from pathlib import Path
root = Path('artifacts/pr118-pr120-audit')
root.mkdir(parents=True, exist_ok=True)
root.chmod(0o700)
credential = root / 'pg.env'
if not credential.exists():
    fd = os.open(credential, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write('POSTGRES_USER=review\nPOSTGRES_DB=review\nPOSTGRES_PASSWORD=' + secrets.token_hex(24) + '\n')
service = {
    'image': 'postgres@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872',
    'env_file': ['pg.env'], 'tmpfs': ['/var/lib/postgresql/data:size=384m'],
    'cpus': 0.5, 'mem_limit': '512m',
    'command': ['postgres', '-c', 'jit=off', '-c', 'max_connections=40'],
    'labels': {'io.market-watch.task': 'mw-pr118-pr120-audit-20261030', 'io.market-watch.purpose': 'acceptance'},
    'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U review -d review'],
                    'interval': '1s', 'timeout': '3s', 'retries': 30},
    'logging': {'driver': 'json-file', 'options': {'max-size': '5m', 'max-file': '2'}},
}
(root / 'compose.json').write_text(json.dumps({
    'services': {'postgres': service}, 'networks': {'default': {'internal': True}},
}, indent=2) + '\n')
PY
```

独立 schema 测试会创建、删除本任务临时测试 schema，不触碰其他任务数据库。固定 PG 镜像和 Python 依赖须已就绪；新 checkout 可按 `requirements.lock` 安装依赖并将解释器路径换为其本机 venv。

启动：

```bash
docker compose -p mw-pr118-pr120-audit-20261030 \
  -f artifacts/pr118-pr120-audit/compose.json up -d --no-build --pull never --wait
```

运行合同测试，不打印凭据：

```bash
python3 - <<'PY'
import json, os, subprocess
from pathlib import Path
root = Path('artifacts/pr118-pr120-audit')
project = 'mw-pr118-pr120-audit-20261030'
info = json.loads(subprocess.check_output(['docker', 'inspect', project + '-postgres-1']))[0]
ip = info['NetworkSettings']['Networks'][project + '_default']['IPAddress']
values = dict(line.split('=', 1) for line in (root / 'pg.env').read_text().splitlines())
url = 'postgresql+psycopg://review:' + values['POSTGRES_PASSWORD'] + '@' + ip + ':5432/review'
env = dict(os.environ, TEST_POSTGRES_URL=url, CHART_ALERT_TEST_DATABASE_URL=url, PYTHONPATH='backend')
files = ['test_publication_wakeup_postgres', 'test_composite_aggregates_postgres', 'test_chart_alert_postgres']
raise SystemExit(subprocess.call(['/home/quant/repos/market-watch/.venv/bin/python', '-m', 'pytest', '-q',
    *['backend/tests/' + name + '.py' for name in files]], env=env))
PY
```

停止：

```bash
docker compose -p mw-pr118-pr120-audit-20261030 \
  -f artifacts/pr118-pr120-audit/compose.json stop
```

## 远端处理顺序与停止边界

1. 将本地候选作为 #120 的后续更新，保持 main 的 Track C/A05 新验收状态。
2. 补入与准确代码版本匹配的脱敏报告、脚本和必要原始证据索引；修正长场只喂 1088 秒输入的问题。
3. 运行更新后 CI，按 F1 范围保留相应验收；本次 97 项局部检查不能替代完整 A08。
4. 保留 A08 偏差。busy、candidate、slow-source、短停 data-worker、provider 前台请求尚未由本候选认证；price close p95 也未被本轮重新认证为达标。
5. #120 已覆盖 #118 有效改动且证据齐全后，再关闭 #118；合并 main 按 AGENTS.md 合并检查点取得用户决定。

`0915344d` 阶段仅完成本地候选。此次后续按用户要求更新 #120 并复审，结果随 PR 正文记录；保持 Draft。未关闭 #118，未合并 main，未创建正式 tag，未操作 Unraid。
