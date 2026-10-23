# Ubuntu R1：MCP 固定历史版本指标

独立 task/project：`mw-mcp-history-indicators-20261023`。只在 Ubuntu 本机运行。
PG14.24、API、Nginx 共用任务专用 internal 网络；数据库、volume、密码和端口独立。
资源上限合计 1088 MiB / 0.65 CPU，无常驻 worker。MCP 入口预定为
`http://127.0.0.1:18633/mcp`，HTTP 仅绑定本机；未启动前该地址不可用。
禁用 Yahoo、OANDA stream、投递和历史维护角色，不提供供应商凭据。

启动前检查 `docker compose ls`、`ss -ltn`、`free -h`、`df -h / /var/lib/docker`、`uptime`。
沿用 `deploy/ubuntu/README.md`：磁盘至少 23 GiB、内存至少 3.25 GiB，五分钟负载不超过 4。
不满足时由用户协调其他任务；不得停止或复用其他项目。

从本任务 worktree 执行，先使用标准构建入口更新候选镜像：

```bash
mw-docker build --repo . --component api \
  --tag market-watch-api:mcp-history-indicators-20261023 \
  --task mw-mcp-history-indicators-20261023 \
  --project mw-mcp-history-indicators-20261023 --purpose acceptance
```

私有配置在仓库外生成，以 0700 目录和 0600 env 文件保存。
固定本次构建的 image ID；密码和 MCP token 不打印、不提交。已有配置不覆盖。

```bash
export MW_HISTORY_PRIVATE=/tmp/mw-mcp-history-indicators-20261023-private
python3 - <<'PY'
import os, secrets, subprocess
from pathlib import Path

p = Path(os.environ['MW_HISTORY_PRIVATE'])
p.mkdir(mode=0o700, exist_ok=True)
assert not (p / 'compose.env').exists(), 'reuse the existing private config'
image = subprocess.check_output(['docker', 'image', 'inspect',
    'market-watch-api:mcp-history-indicators-20261023', '--format', '{{.Id}}'], text=True).strip()
admin_hash = subprocess.check_output(['docker', 'run', '--rm', '--network', 'none',
    '--name', 'mw-mcp-history-indicators-20261023-config',
    '--label', 'com.market-watch.task=mw-mcp-history-indicators-20261023',
    '--memory', '192m', '--cpus', '0.3', image, 'python', '-c',
    'import secrets; from argon2 import PasswordHasher; print(PasswordHasher().hash(secrets.token_urlsafe(32)))'],
    text=True).strip()
# Single quotes preserve literal dollar signs in the Argon2 hash.
(p / 'compose.env').write_text('MW_DB_PASSWORD=' + secrets.token_hex(24) + '\n' +
    "MW_ADMIN_HASH='" + admin_hash + "'\nMW_API_IMAGE=" + image + '\n' +
    'MW_PRIVATE=' + str(p) + '\nMW_PORT=18633\n')
(p / 'compose.env').chmod(0o600)
PY
c() { docker compose --env-file "$MW_HISTORY_PRIVATE/compose.env" \
  -p mw-mcp-history-indicators-20261023 \
  -f docs/verification/mcp-history-indicators-20261023/compose.yaml "$@"; }
c config --quiet
c up -d --no-build postgres
c run --rm migrate
c up -d --no-build api gateway
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py seed
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py facts --output /private/before.json
python3 scripts/verify_history_indicators_mcp.py cold --private "$MW_HISTORY_PRIVATE"
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py step
python3 scripts/verify_history_indicators_mcp.py partial --private "$MW_HISTORY_PRIVATE"
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py drain
python3 scripts/verify_history_indicators_mcp.py ready --private "$MW_HISTORY_PRIVATE"
c exec -T --user "$(id -u):$(id -g)" api python /fixtures/verify.py facts --output /private/after.json
cmp "$MW_HISTORY_PRIVATE/before.json" "$MW_HISTORY_PRIVATE/after.json"

# 停止并保留数据及现场。
c stop
# 再启动复用同一数据库和 fixture，不覆盖已有版本。
c up -d --no-build postgres api gateway
```

fixture 为离线合成版本：先发布 2107 根分钟数据，再发布不同的新版本，并保留一个未发布版本。
请求较早的七根可见 K 线，验证版本没有被最新发布替换、与 history_get_bars 相同、指标使用完整
历史前缀，且从 pending 到 partial（可见区间已完成）再到 complete。验证 UUID/MWH、价格校验和、
逐指标依据，以及不存在/未发布版本、未发布周期和冲突参数的错误。

`step`/`drain` 校验运行归属后调用现有 `indicator_tick`，不启动供应商或共享 worker。
`facts` 比较前后版本、数据集、产物、供应商读取和实时需求；仅允许指标任务/结果和审计发生变化。
协议证据不含 headers/token；`credentials.json`、`compose.env` 仅保留在私有目录。
实际运行状态和结果以 results.md 为准，不能仅凭此配置宣称验收完成。
