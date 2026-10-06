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

```bash
# 本地响应/过滤接缝；其他请求仍用真实 OANDA。结束恢复本 project 的常规 worker。
.venv/bin/python scripts/fault_oanda_responses.py unauthorized
.venv/bin/python scripts/fault_oanda_responses.py rate_limited
.venv/bin/python scripts/fault_oanda_responses.py single_symbol

# 十品种需求约 7 分钟，结束后本次需求自然过期；常驻两品种保留。
.venv/bin/python scripts/load_oanda_acceptance.py

# 真实报价生成本地信号/通知，外部投递仍关闭。
.venv/bin/python scripts/verify_live_signal_acceptance.py

# 原始已发布版本内容/精度/unknown 分区审计；十年版本发布后可加 --minimum-years 9。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml exec -T api python -' < scripts/verify_history_snapshot.py
```

API 镜像更新会短暂中断 HTTP；在开始正常负载/长观测窗口前完成部署并等待 readyz 与采集恢复。
中断窗口单独记录，不把重新运行的成功结果覆盖成第一次就通过。

## 持续浏览器观测

`web/tests/data-integration.observe.cjs` 是 Ubuntu Chromium 验收工具，从现有本地登录文件认证，
只把时间分桶、状态和错误计数写到忽略的 `artifacts/data-integration/browser-sustained.jsonl`。
两个交易日窗口默认观察 48 小时，覆盖开市、维护与跨日；仅开始进程不能证明验收已达标。
页面正常订阅与工具 SSE 都不创建上游 stream。源时钟误差仍单独说明。

从 worktree 根目录可安装/启动本任务专用用户 service：

```bash
mkdir -p ~/.config/systemd/user
cp docs/verification/data-integration/browser-observation.service ~/.config/systemd/user/market-watch-data-integration-browser.service
systemctl --user daemon-reload
systemctl --user start market-watch-data-integration-browser.service
systemctl --user status market-watch-data-integration-browser.service

# 停止只结束本任务浏览器观察，不停止其他任务或行情实例。
systemctl --user stop market-watch-data-integration-browser.service

# 输出当前真实窗口摘要，保留所有 SSE 错误及不健康状态。
.venv/bin/python scripts/summarize_browser_observation.py artifacts/data-integration/browser-sustained.jsonl
```

最终窗口起点/代码版本/状态见 `sustained-observation-window.json`；每次中断或重启都在 JSONL 追加
事件，不能拼接成没有中断的窗口。此 service 不设置自动重启或开机启用。实例停止前也应停止观察。
小时版本再导入固定 replay 的证据、生产备份 Ubuntu 恢复与源日历适用性研究都在本目录，私密
原始备份只存忽略目录，生产机器只读检查，不在那里创建验收实例。

## 当前结果与限制

后端与 PostgreSQL 测试记录、截图、容器快照与故障 JSON 位于本目录。
十年导入仍在后台运行；当前源日历是 `ny17-candidate-v1`，保持未核实。
持续采集尚未达到两个交易日，价龄没有独立时钟偏差校准。
短样本与故障恢复结果不代表完整 P0–P2 验收已通过；最终状态见
[接续开发记录](../../market-data-integration-progress.md)。
