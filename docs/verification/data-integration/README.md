# Ubuntu 行情接入验收实例

实际环境：Ubuntu 22.04.5，本机 Docker Compose project `market-watch-data-integration`。
网页地址：http://127.0.0.1:16589/market-data 。API 与 PostgreSQL 不向宿主发布端口。
数据库为 PostgreSQL 14.24，独立网络、`integration-postgres` volume 和 `integration` 数据库。
`integration_restore` 也是本任务的备份恢复校验数据库。未使用 unraid。

## 启动与停止

命令从 `/home/quant/repos/market-watch-data-integration` 执行。
当前进程尚未继承新 Docker 组时使用 `sg docker -c`；新登录已继承组后可以直接使用 Docker。
`runtime.env` 用 raw 格式注入容器，不用于 Compose 插值，避免密码 hash 中的 `$` 被解释。

```bash
# 仅首次准备。只选择 OANDA/行情代理凭据，生成新的数据库和页面密码；不复制生产 DB 配置。
PYTHONPATH=backend .venv/bin/python scripts/prepare_data_integration.py --source-env /home/quant/repos/market-watch/.env

sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml up -d --build api oanda-worker history-worker aggregation-worker web'

# 实际 PostgreSQL 定向验收；测试使用独立临时 schema。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml run --rm verify'

# 只停止本实例，保留十年导入检查点、观测与不可变版本。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml stop'
```

管理员验收密码只保存在被忽略、权限 0600 的 `artifacts/data-integration/login.json`。
通知网络发送关闭，不运行通知投递 worker。MT4 实时行情按用户要求留到后续。
禁止广泛删除 Docker 资源；不要使用全局 prune。本实例 `stop` 不删除 volume。

## 可复现检查

```bash
# 创建幂等样本/固定十年任务，或输出无凭据当前报告。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml exec -T api python - report' < scripts/data_integration_acceptance.py

# Chromium 缺系统依赖时，可使用本机已有的隔离 Playwright 依赖目录。
cd web
LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu node tests/data-integration.browser.cjs
```

浏览器检查桌面/手机、三个浏览器、浏览器断连恢复、三品种共享采集、固定版本演练推进。
`scripts/fault_oanda_acceptance.py` 只暂停/重启本 project 的 OANDA worker，实际故障结果保存为 JSON。
验收期间的暂停/重启已记录，不从正常价龄统计中偷偷移除。

## 当前结果与限制

后端与 PostgreSQL 测试记录、截图、容器快照与故障 JSON 位于本目录。
十年导入仍在后台运行；当前源日历是 `ny17-candidate-v1`，保持未核实。
持续采集尚未达到两个交易日，价龄没有独立时钟偏差校准。
短样本与故障恢复结果不代表完整 P0–P2 验收已通过；最终状态见
[接续开发记录](../../market-data-integration-progress.md)。
