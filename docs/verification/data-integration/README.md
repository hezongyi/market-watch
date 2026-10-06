# Ubuntu 行情接入验收实例

实际环境：Ubuntu 22.04.5，本机 Docker Compose project `market-watch-data-integration`。
网页地址：http://127.0.0.1:16589/market-data 。API 与 PostgreSQL 不向宿主发布端口。
数据库为 PostgreSQL 14.24，独立网络、`integration-postgres` volume 和 `integration` 数据库。
`integration_restore` 也是本任务的备份恢复校验数据库。未在 unraid 创建验收实例。

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

原 03:06 UTC 窗口因 API 部署触发观察工具 EventSource CLOSED 而中断，保留
[原窗口](sustained-observation-window-interrupted.json)及原 JSONL。工具补齐 15s 心跳超时重连，
真实 Chromium 本地 502→恢复验证见 [重连证据](observer-reconnect.json)。新完整窗口于
**2026-10-06 03:50:58.841 UTC** 启动，计划至 **2026-10-08 03:50:58.841 UTC**。
窗口起点/代码版本/状态见 [窗口记录](sustained-observation-window.json)；每次中断或重启都在 JSONL 追加
事件，不能拼接成没有中断的窗口。此 service 不设置自动重启或开机启用。实例停止前也应停止观察。
小时版本再导入固定 replay 的证据、生产备份 Ubuntu 恢复与源日历适用性研究都在本目录，私密
原始备份只存忽略目录，生产机器只读检查，不在那里创建验收实例。

当前窗口摘要使用 `summarize_browser_observation.py ... --since 1791258658841`，
后端 M1 完整分钟起点为 `1791258660000`。不将原窗口空白或部署迟到混成新窗口正常样本。

## 当前结果与限制

后端与 PostgreSQL 测试记录、截图、容器快照与故障 JSON 位于本目录。
十年导入仍在后台运行；当前源日历是 `ny17-candidate-v1`，保持未核实。
持续采集尚未达到两个交易日，价龄没有独立时钟偏差校准。
短样本与故障恢复结果不代表完整 P0–P2 验收已通过；最终状态见
[接续开发记录](../../market-data-integration-progress.md)。

## 来源会话与不可变元数据

`ny17`/`utc0` 只定义聚合相位。显式数据集没有经过核实的来源会话时，未观测分钟保持 unknown，
周末或黄金暂停不能仅凭相位判成闭市。真实来源 M1 与会话冲突时保留原值、记录审计，并阻止
用冲突会话证明该聚合桶完整。旧非显式品种保持既有规则。

OANDA 配置 `ALERTS_OANDA_CALENDAR_PROFILES` 是按 `EUR_USD`/`XAU_USD` 索引的 JSON 对象。
每个 profile 的 `revision` 必须与新的 `ALERTS_OANDA_CALENDAR_VERSION` 一致。profile 含
`source_session`，字段如下；凭据和账户完整 ID 均不属于 profile：

| 字段 | 要求 |
| --- | --- |
| source/channel/environment/provider_symbol | 精确匹配数据集，如 oanda/v20/practice/XAU_USD |
| account_scope | public 或既有数据集的 sha256 指纹，不能借另一账户的会话 |
| timezone | IANA 时区，例如 America/New_York；按当地周规则跟随 DST |
| reviewed_start/reviewed_end | 有限、含时区的整分钟日期范围；范围外继续 unknown |
| evidence_url/applicability | HTTPS 一手来源和该账户产品、地区、期间的适用性说明 |
| weekly_closures | 有序且不重叠的 `{start,end}`，当地周一 00:00 起算分钟，范围 0–10080 |

`weekly_closures` 应只包含已经核实的完整闭市分钟内部，公告边界与已有真实柱冲突时保留边界。
跨周区间拆为两个区间。额外 `closures` 也必须有来源适用证据且位于 reviewed 日期范围内。
当前账户地区/法律实体及十年历史例外仍未核实，实际运行未启用经过认证的 source_session。

身份、精度、volume 和 profile 一经绑定不能原位改写。得到新证据后注册新 calendar_version；
历史修正可用 `history_derivation.derive_version/derive_page` 从已校验的不可变原分块派生，禁止
从可修订 staging Bar 复制。未完成父任务必须停止写入、等待租约结束并带明确原因隔离。
分块、M1、观测覆盖与检查点逐页提交，崩溃后从提交位置恢复；发布保留 parent/checksum provenance。
精度溢出明确为 `price_precision_overflow` 配置故障，不取整、跳页或无限网络重试。

本实例 EURUSD 六位精度修正脚本是幂等工具，运行后保留原五位任务与已发布小时版本：

```bash
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml run --rm --no-deps -T api python -' < scripts/derive_precision_acceptance.py

# 撤销既有候选聚合中缺乏观测证据的 complete；保留 M1、价格、历史分块和固定回放。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml run --rm --no-deps -T api python -' < scripts/revalidate_candidate_acceptance.py
```

长观察期间部署必须在 `sustained-observation-window.json` 添加分段和实际恢复时间；浏览器
原进程继续采集 SSE 断连与状态，不能把部署前后拼成同一代码版本的无中断验收。
