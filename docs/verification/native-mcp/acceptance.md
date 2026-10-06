# 原生 MCP 验收记录

日期：2026-10-06。开发基线 `3c18f60`，worktree `/home/quant/repos/market-watch-native-mcp`，branch `feat/native-mcp`。**整体验收未完成，不是已部署交付。**

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

## 未满足的真实环境 gate

- 本机 `docker info` 返回 `permission denied ... unix:///var/run/docker.sock`；当前会话禁止提权。已向用户请求配置 quant 本机 Docker 权限，尚未获得完成通知。不能转 unraid 绕过。
- 尚未 build/start `mw-native-mcp-acceptance`；无可用访问地址。计划使用 `https://localhost:18543` 和独立 chart origin `:18544`，仅为预留配置。
- PostgreSQL 14 migration、4 并发首次告警创建、notification ack 和审计持久验证仍需在该 Compose project 完成。
- `scripts/native_mcp_acceptance.py` 必须通过真实 HTTPS SDK transport 完成 initialize/list/call 及同快照网页结果比较，保留 JSON 报告。与真实原生画线保存路径串联的数据库读取还需验收。
- `scripts/native_mcp_codex_acceptance.py` 必须证明实际 Codex 调用工具，完成引用 H1/H4/价格/画线证据、区分推断并征询用户意见的分析；CLI 配置读取和 SDK 测试均不能代替。
- 真实 provider 来源不可用/陈旧/缺口及已存画线 revision 验收，不以 synthetic 数据冒充 live source。
- 交付启动/停止命令已在 [使用文档](../../native-mcp-usage.md) 列出，但须启动成功后记录主机、实际地址、container labels 和状态，才能声称部署交付。

未 commit 凭据、TLS 私钥、浏览器完整状态或许可库。没有操作 unraid、没有生产发布、没有实盘交易。
