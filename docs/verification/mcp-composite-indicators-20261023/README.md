# Ubuntu R1：MCP 组合指标

2026-10-23 用户指定在 `$mw-acceptance` 验收后，实际复验使用已运行且包含本功能的长期实例，
未启动下述备用合成数据 project。真实版本、HTTP 响应、数据保留和独立测试数据库的 PG 结果见
[results.md](results.md) 与 [mwa-acceptance.json](mwa-acceptance.json)。
长期实例的运维/复验命令也记在 results.md；不要对其执行下面的 seed、migrate 或独立实例启停命令。

F0：兼容读取扩展；无新增 schema、持久格式、指标算法、后台调度。
任务/project：`mw-mcp-composite-indicators-20261023`。主机只允许 Ubuntu 本机。
`compose.yaml` 使用独立 internal 网络、PG14.24 volume/数据库/密码、API、网关。
仅 `127.0.0.1:18623` 发布 HTTP；无网页/许可图表镜像和常驻 worker。
API 显式启用 MCP、限定 Host/Origin，禁用 Yahoo、stream、投递和历史维护角色；没有供应商凭据。
资源上限：PG 512 MiB/0.3 CPU，API 512 MiB/0.3 CPU，网关 64 MiB/0.05 CPU。

从任务 worktree 执行。先检查 `docker ps`、`ss -ltn`、`free -h`、`df -h / /var/lib/docker`、
`uptime`；余量门槛沿用 `deploy/ubuntu/README.md`。冲突/高负载先由用户协调，不停止其他任务。
以下 `docker`/`mw-docker` 在需要 docker 补充组的 shell 中用 `sg docker` 执行。

```bash
# 任务 .venv 必须已按 requirements.lock 安装；不要使用缺少 MCP SDK 的系统环境。
source .venv/bin/activate
mw-docker build --repo . --component api \
  --tag market-watch-api:mcp-composite-indicators-20261023 \
  --task mw-mcp-composite-indicators-20261023 \
  --project mw-mcp-composite-indicators-20261023 --purpose acceptance

# 私有目录可更换；密码/登录 hash 和 MCP token 不提交仓库、不打印。
export MW_COMPOSITE_PRIVATE=/tmp/mw-mcp-composite-indicators-20261023-private
mkdir -p -m 700 "$MW_COMPOSITE_PRIVATE"
python - <<'PY'
import os, secrets, subprocess
from pathlib import Path
from argon2 import PasswordHasher
p = Path(os.environ['MW_COMPOSITE_PRIVATE'])
if (p/'compose.env').exists():
    raise SystemExit('Reuse existing private configuration; do not regenerate passwords')
image = subprocess.check_output(['docker','image','inspect',
    'market-watch-api:mcp-composite-indicators-20261023','--format','{{.Id}}'], text=True).strip()
# Compose env-file preserves single-quoted literal argon2 dollar signs.
(p/'compose.env').write_text(
    'MW_DB_PASSWORD=' + secrets.token_hex(24) + '\n' +
    "MW_ADMIN_HASH='" + PasswordHasher().hash(secrets.token_urlsafe(32)) + "'\n" +
    'MW_API_IMAGE=' + image + '\nMW_PRIVATE=' + str(p) + '\nMW_PORT=18623\n')
(p/'compose.env').chmod(0o600)
PY

# 下文使用此 shell 函数；固定镜像 ID 从私有 env-file 读取。
c() { docker compose --env-file "$MW_COMPOSITE_PRIVATE/compose.env" \
  -p mw-mcp-composite-indicators-20261023 \
  -f docs/verification/mcp-composite-indicators-20261023/compose.yaml "$@"; }
c config --quiet
c up -d --no-build --wait postgres
c run --rm --no-deps migrate
c up -d --no-build api gateway
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py seed
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py facts --output /private/before.json
python scripts/verify_composite_indicators_mcp.py cold --private "$MW_COMPOSITE_PRIVATE"
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py drain
python scripts/verify_composite_indicators_mcp.py ready --private "$MW_COMPOSITE_PRIVATE"
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py facts --output /private/after.json
cmp "$MW_COMPOSITE_PRIVATE/before.json" "$MW_COMPOSITE_PRIVATE/after.json"

# 本任务 DB 内每项测试新建独立 schema；不连接其他任务数据库。
c exec -T api python -c 'import os,pytest; os.environ["TEST_POSTGRES_URL"]=os.environ["ALERTS_DATABASE_URL"]; raise SystemExit(pytest.main(["-q","/fixtures/tests/test_series_access_postgres.py","/fixtures/tests/test_composite_chart_postgres.py","/fixtures/tests/test_fixed_indicators_postgres.py","/fixtures/tests/test_chart_reload_postgres.py"]))'

# 停止保留数据库和所有现场，不删 volume。
c stop
# 再次启动：复用同一 volume 和 fixture（seed 检查 marker，不覆盖已有数据）。
c up -d --no-build postgres api gateway
```

`cold.json`/`ready.json` 为脱敏协议证据（无请求 headers/token），`fixture.json` 无秘密。
`credentials.json`、`compose.env` 只保留在私有目录。`runs.json` 仅记录这次冷启动返回的任务；
`drain` 校验归属并用独立进程调用现有 `indicator_tick(run_id)`，不启动采集或历史维护。
固定本地合成价格、映射和周期聚合复用现有测试 fixture/离线构建入口。
新增/更新镜像后先更新私有 env 中的 image ID，再 `up --no-build`；不得依赖旧 tag 证明新源码通过。

实际长期实例的证据与用例映射见 `results.md`。合并前仍需对应 PR CI 和自审；不涉及生产发布。
