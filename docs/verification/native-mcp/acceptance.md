# 原生 MCP 验收记录

日期：2026-10-06。开发基线 `3c18f60`，worktree `/home/quant/repos/market-watch-native-mcp`，branch `feat/native-mcp`。**Ubuntu 本机真实验收已完成**，最终证据与实例信息见文末；前面保留实施时的历史检查与故障记录。没有生产发布。

## 已核实证据

| 要求 | 证据与结果 | 范围 |
| --- | --- | --- |
| 隔离 worktree/branch | `git worktree add -b feat/native-mcp ... origin/main`；HEAD 基线 `3c18f60` | 主工作树未提交修改与原设计工作树保留 |
| 成熟 SDK 固定版本 | `mcp==2.3.0` 和 `mcp-types==2.3.0`，`requirements.lock`；`pip check` 通过 | 发布包公开 low-level Server + ASGI lifecycle |
| 初始化、发现和调用 | `test_native_mcp.py`：官方 SDK `ClientSession/streamable_http_client` 通过 ASGITransport 初始化、tools/list/call；另有协议 POST 测试 | 内存/本机数据库测试，不是 Docker HTTPS 验收 |
| schema、注册自动开放 | 新注册业务动作通过协议发现/调用；新增指标注册后自动发现及计算；重复名称/ID 与冻结检查通过 | 不以直接函数调用替代全部协议证据 |
| 行情/指标与网页相同 | 相同数据库快照，quote、bars、EMA/RSI、history_revision 等一致；修订后结果变化 | 管理系列实存夹具；provider 合同为受控 mock |
| 无数据、限制、权限 | DATA_UNAVAILABLE、INSUFFICIENT_HISTORY、limit 2001 拒绝；无 token、无效、过期、撤销、缺 scope 均拒绝 | 测试检查隐藏工具仍不能直接调用 |
| 资源与生命周期 | 请求体、Host、Origin、配额、开关、重启不重复 worker、deadline、断连取消测试通过 | MCP 与网页共享查询；网页 deadline 回归已修复 |
| 告警幂等与审计 | 同 key 重试和 4 并发重试只创建一条；不同意图冲突；取消、notification ack 防重复以及 agent/resource 审计，无明文 token | 使用本机文件 SQLite 独立连接；PostgreSQL 并发仍待验收 |
| 原生画线事实 | [单图](browser-single.log)、[双图](browser-dual.log)；真实 v31 图表库创建水平线/趋势线/矩形，公开 API points 与保存投影一致，刷新和 raw/envelope 格式保留身份 | 数据/存储 RPC 是 fixture；图表库和 bridge 为真实代码，不能宣称数据库端到端完成 |
| 持久只读投影 | [真实库产生的投影](real-native-drawing-projection.json) 可由后端白名单解释；unknown/旧文档/missing/未保存改动测试通过 | time 为 native chart time，不冒充 UTC candle start |
| 迁移 | 隔离临时 SQLite 运行 `upgrade head → downgrade r19_native_history_loads → upgrade head` 全部成功；唯一 head `s20_agent_capabilities` | PostgreSQL 14 migration 仍待 Docker 验收 |
| 静态验证 | 本次修改文件 Ruff、compileall、JS parse、`git diff --check` 和 Compose `config --quiet` 通过 | 仓库其他现存文件全量 Ruff 有 29 项历史告警，未顺手修改 |
| Codex 配置 | 本机 CLI `0.160.0`，`mcp add --help` 和 `mcp get --json` 确認 URL/Bearer env 配置 | 配置读取不是实际 MCP 调用；官方页面 403 |

首次提取共享入口后完整后端回归：477 passed、38 skipped。新增 MCP 模块专门测试：14 passed；之后新增 notification ack/真实库投影协议测试均通过。后续完整回归曾发现网页超时等待回归（490 passed、1 failed、38 skipped）；已修复并通过原失败测试，最终完整回归 **491 passed、38 skipped**（158.49 秒）。两个之后新增测试单独通过，最后合并 MCP/provider/health 的针对性回归 **75 passed**（18.37 秒），覆盖最终的 16 项 MCP 测试。

浏览器运行环境：Ubuntu 22.04.5；Playwright 使用本机缓存 Chromium 与 `/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu` 中已有系统库。运行命令：

```bash
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu \
NODE_PATH=/home/quant/repos/market-watch/web/node_modules \
CHARTING_LIBRARY_ROOT=/home/quant/repos/market-watch-chart-sync/advanced-host/charting_library \
node web/tests/advanced-layout-refresh.browser.cjs --case=single-provider
# 将 case 换成 two-provider 运行双图检查。
```

这属于自动化浏览器测试夹具，不是验收部署实例。测试曾因夹具缺 history capabilities 初始化失败；补齐当前初始化合同后通过。保存投影使用真实库返回的稳定 ID `horizontal_line/trend_line/rectangle`，不使用猜测的显示名称。许可资源已复制到本任务的 `advanced-host/charting_library` ignored 目录，未修改其他工作树原件，没有提交。

## 初次实施时未满足的真实环境 gate（历史记录）

- 本机 `docker info` 返回 `permission denied ... unix:///var/run/docker.sock`；当前会话禁止提权。已向用户请求配置 quant 本机 Docker 权限，尚未获得完成通知。不能转 unraid 绕过。
- 尚未 build/start `mw-native-mcp-acceptance`；无可用访问地址。计划使用 `https://localhost:18543` 和独立 chart origin `:18544`，仅为预留配置。
- PostgreSQL 14 migration、4 并发首次告警创建、notification ack 和审计持久验证仍需在该 Compose project 完成。
- `scripts/native_mcp_acceptance.py` 必须通过真实 HTTPS SDK transport 完成 initialize/list/call 及同快照网页结果比较，保留 JSON 报告。与真实原生画线保存路径串联的数据库读取还需验收。
- `scripts/native_mcp_codex_acceptance.py` 必须证明实际 Codex 调用工具，完成引用 H1/H4/价格/画线证据、区分推断并征询用户意见的分析；CLI 配置读取和 SDK 测试均不能代替。
- 真实 provider 来源不可用/陈旧/缺口及已存画线 revision 验收，不以 synthetic 数据冒充 live source。
- 交付启动/停止命令已在 [使用文档](../../native-mcp-usage.md) 列出，但须启动成功后记录主机、实际地址、container labels 和状态，才能声称部署交付。

未 commit 凭据、TLS 私钥、浏览器完整状态或许可库。没有操作 unraid、没有生产发布、没有实盘交易。

## 第二次继续核对（2026-10-06）

上一次为实施和测试进展。本轮再次 `docker info` 仍确认 Docker socket 权限拒绝，没有已运行的验收实例或可轮询部署句柄。

- 新的 protocol 回归先复现三处问题：Yahoo exchange-calendar 间隔返回 INTERNAL_ERROR；published 指标预算错误统计 candles；provider D1 分页错误返回 UTC start 而非 native chart label。现已修正并保留显式 calendar/cursor 合同。
- 相关 MCP/provider/Yahoo/managed 回归 **141 passed**（36.73 秒）；随后全量后端回归 **496 passed、38 skipped**（134.25 秒），日志 `/tmp/native-mcp-followup-full.log`。新增合同修复全部纳入该次全量结果。
- `scripts/seed_native_mcp_acceptance.py` 增加 H1/H4 已发布快照；只在临时隔离 SQLite 验证 published bars/EMA 与 dataset readiness，未部署。
- 新 `web/tests/native-mcp-drawings.browser.cjs` 定义真正网页/原生对象保存/PostgreSQL/HTTP MCP 验收路径，检查对象身份、保存 revision、锚点、未保存不可见、随后保存可见及刷新；只完成语法检查，尚未运行。
- Codex trace verifier 现在拒绝失败调用、工具业务错误、缺 H1/H4 数据、缺指定已存画线与缺征询问题；本轮仅对合成事件检查 verifier 正反例，未冒称实际 Codex 接入通过。诊断 stderr 与 trace 以 0600 保存。
- HTTPS script 的取消幂等键改为与本次新建 watch 绑定，避免重复验收时同键不同对象冲突。

仍须用户恢复 Ubuntu 本机 Docker 权限才能开始 PostgreSQL/HTTPS/Codex 验收。原 `b16cf81` 后的修复提交不代表整体目标完成；不变更 unraid。

## 第三次继续核对（2026-10-06）

全量回归进程已正常结束（496 passed、38 skipped）。复核实际网页保存事件后，浏览器验收脚本改用真实 Ctrl+S 保存路径，同时等待持久化响应和 dirty 状态清除；JS 语法检查、修改文件 Ruff 和 `git diff --check` 通过。该脚本仍未在部署实例运行。

再次核对 Ubuntu 本机 Docker，socket 为 `660 nobody:nogroup`，当前 `quant` 会话虽列出 `nogroup`，`docker info` 仍返回 permission denied。18543/18544 没有监听，尚未启动本任务 Compose 服务。之前请求的 Docker 权限配置尚未完成；剩余 PostgreSQL、HTTPS、浏览器和实际 Codex gate 均依赖该环境，目标因此阻塞，不能标记完成。

## 最终 Ubuntu 真实验收（2026-10-06）

用户授权后，本机 socket 已为 `root:docker`，`quant` 已加入 docker 组。当前进程尚未刷新组身份，使用 `sg docker -c 'docker ...'` 成功连接本机 daemon。验收环境是 **Ubuntu 22.04.5 / quant-server / Docker 29.1.3**，default context 的本机 Unix socket。独立 project `mw-native-mcp-acceptance`、网络 `mw-native-mcp-acceptance_default`、volume `mw-native-mcp-acceptance_native-mcp-pg`；实际容器、镜像与所属 labels 见 [环境记录](environment.json)。API/PG healthy，migration 容器正常退出 0。

实际地址仅绑定 Ubuntu 回环：应用 `https://localhost:18543/`，MCP `https://localhost:18543/mcp`，图表独立 origin `https://localhost:18544/`。已实际执行整个 project 的 stop/start，恢复后 readyz、凭据、审计、写入操作、通知状态和已保存图表仍可用。启停命令及 CA 信任、凭据有效期见 [使用文档](../../native-mcp-usage.md)。

| 真实 gate | 最终证据 | 结果与边界 |
| --- | --- | --- |
| PG migration 与并发幂等 | [PG 报告](postgres-report.json)、[HTTPS 报告](https-report.json) | PostgreSQL 14 到 `s20_agent_capabilities`；4 并发首次创建 + 重试只有一个资源，同键不同意图拒绝；取消与 notification ack 持久化；项目启停后仍保留 |
| 真实 HTTPS 官方 SDK | [HTTPS 报告](https-report.json) | 初始化、13 个工具发现与 schema、调用、网页/MCP quote/OHLC/EMA/RSI/revision 一致；无效/缺少 token 拒绝 |
| 真实认证与 scope | [认证报告](auth-report.json) | 过期、撤销返回 401；market-only 凭据只发现行情与 status；直接调用隐藏画线工具返回 FORBIDDEN |
| 真实浏览器 → PG → HTTP MCP | [浏览器报告](browser-report.json)、[运行日志](browser-runtime.log) | 真实许可库通过公开 API 创建水平线/趋势线/矩形，保存后 ID/锚点/revision 一致；未保存改动不可见，再保存后可见；刷新恢复身份 |
| 来源、质量与修订 | [质量报告](quality-report.json) | 实际 Binance `BTCUSDT provider` 与网页同快照/同 cache revision；不存在的上游符号明确 DATA_UNAVAILABLE/retryable；独立合成数据删除一根后 gap 可见，同步修订导致 history revision 改变；旧报价显式 stale |
| 实际 Codex 0.160.0 | [Codex 报告及分析](codex-report.json) | 启停后真实 HTTPS 成功调用 H1、H4、后端 EMA、alerts、saved drawings；非空数据，引用时间/价位/保存版本，区分事实、计算与推断，并在结尾征询意见；相应动作已在 PG audit 核对 |
| 回归与静态检查 | [全量回归](backend-final.log)、[相关回归](revision-tests.log) | 最终 **497 passed、38 skipped**（206.28 秒）；MCP/图表相关 **40 passed**；修改文件 Ruff、JS parse、diff 检查、Compose config、临时 SQLite 完整 seed、独立 CA/server leaf 验证通过 |

验收数据分开标识：EURUSD 为 `acceptance-fixture`；网页对象验收用 `MCPFIXTURE` 已发布合成快照，名称明确 SYNTHETIC，无上游品种映射，其 `binance` 配置仅供既有路由识别。浏览器报告显式声明 `data_source=acceptance-fixture`、`synthetic_market_data=true`。实际 Binance 上游检查使用不同的 `BTCUSDT provider`，标记 `synthetic=false`。未将合成样本解释为可交易行情或跨周期聚合算法验收。OANDA 凭据与 Yahoo 开关未配置，不声称已对它们进行 live-source 验收；相关 cursor/calendar/provider 合同已有协议回归。

实际部署反馈修正了三处问题：

- Docker 构建白名单漏包含 `drawing-projection.js`，补齐后真实图表镜像构建通过。
- 原自签 `CA:TRUE` 证书被 Codex rustls 拒绝充当服务端；改为独立 CA 签发的 `CA:FALSE` leaf，官方 SDK 和实际 Codex 均成功连接。未关闭 TLS 校验。
- 共享查询原 revision 求和在删除与修订抵消时不变；先用协议测试复现，再改为包含行数、修订、时间边界和日历的指纹，网页与 MCP 共享。PG 复验通过。

浏览器脚本的首次复核曾过早取 frame，以及等待图表库延迟 dirty 标记导致超时；最终等待真实 frame URL、持久化保存响应及 native 保存结束，以返回文档和 MCP 投影验证实际内容，显式处理刷新前的 beforeunload。最终运行通过，没有靠清除产品 dirty 状态或伪造保存来通过验收。

Codex 完整 JSONL/stderr trace 保持在 `/tmp/native-mcp-codex-delivery-events.*`，权限 0600；仓库只保留白名单结果摘要、最终分析和 trace SHA-256，没有凭据或完整浏览器状态。Codex 提示现有用户配置 `disable_response_storage` 未识别；未修改该用户配置，实际工具与完整 turn 仍成功。

所有服务为本任务 Ubuntu 隔离验收实例，保留运行供检查；没有操作 unraid，没有生产发布、实盘交易、内部计划 CRUD 或形态扫描引擎。后续交付连接信息和证据现已具备。
