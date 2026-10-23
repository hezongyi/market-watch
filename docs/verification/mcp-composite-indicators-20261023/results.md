# 验证记录

2026-10-23：用户指定“在 `$mw-acceptance` 进行验收”，本轮使用既有 Ubuntu 长期实例，保留真实数据、配置和浏览器现场。
不再要求另启合成数据实例。本轮没有构建、换版、重启、seed/reset 或真实库迁移；未合并、未发布生产。

## 实际候选与边界

- 主机 `quant-server`，逻辑实例 `mw-acceptance`，实际 Compose project `mw-issue75-v2-20261018`。
- 网页 `https://192.168.7.232:18280`，Chart origin `https://192.168.7.232:18281`；原生 MCP `http://127.0.0.1:18275/mcp`。
- 本任务产品源码 `9770d5d`，分支 `feat/mcp-composite-indicators-20261023`，Draft PR [#94](https://github.com/hezongyi/market-watch/pull/94)。
- 实际 API 已运行干净源码 `2a943eec6717e25e7a5c9b5cf236c19a0f2a6b91`，镜像 `sha256:9ca7a217ecf1b12a7de53d0dfb764019191e11ffddf4eeeeb7a62151595fc67f`。
  `git merge-base` 证明它直接继承本任务 `9770d5d`，并额外开放固定历史指标；本轮没有把旧候选覆盖到较新实例。
  actions/models/series_access 及所执行 PG 测试的容器文件 SHA256 均与该提交一致；PG 测试与本任务分支文件相同。
- 15 个服务运行，API/PostgreSQL healthy。worker/Web/Chart 沿用既有版本，本轮不调整供源、网络、端口、TLS、凭据或浏览器。
  本次验证组合指标；新增的 history 能力来自另一任务，不扩大本 PR 产品范围。

## 真实 HTTP MCP 结果

使用现有只读 token，经真实 HTTP MCP 进行协议发现和工具调用；用独立 cookie jar 登录网页接口比较，没有读取或覆盖受保护浏览器存储。
脱敏工具 schema、cold/ready/default/provisional 响应、错误及前后事实见 [mwa-acceptance.json](mwa-acceptance.json)。

- 现有四个只读 scope 可见 **28 个工具**，均为只读；原工具集合未新增。此前合成 fixture 的完整权限为 31、两个 scope 为 24，数量差异来自 scope。
  `indicators_calculate` 的组合参数、计算依据和质量字段可发现；当前运行版还公开另一任务的 `history` 类型。
- 使用已有 EURUSD 组合 `8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb`，
  组合修订 `4c239291-470a-4554-90b1-ba13b2c7d331`、已保留输入修订 **1899**。
- 首次用新参数 EMA3/RSI3 请求：价格保留、任务 pending、从既有完整历史起点 `1767218400000` 初始化。
  现有后台自然推进，约 4.6 秒观察到两项 complete/visible_complete，未调用人工 tick 或创建前台租约。
- 返回 **7 根 K 线、14 个有效值**；价格与 `composite_get_bars` 相同，数值、依赖、run_id、计算起点及 input_evidence 与真实网页 `/api/charts/data` 相同。
  每个指标的组合修订、输入修订及历史版本与 page 一致，数值时间属于返回 K 线的真实 start。
- 默认修订选择、MWC 规范化、UTC 排他分页均通过；默认与临时响应此次选择输入 1936。
  临时响应的 `display_snapshot_id` 与每个指标依据相同；此处查询的是已有历史窗口，不伪称观察到未收盘点的临时数值。
  未收盘临时值和不推进确认状态的断言由已通过的协议及 PG fixture 覆盖。
- **8 组错误请求**返回预期结果：published、布尔输入修订、临时与固定输入冲突、错误类型、未知修订、越界输入、未知组合、无效第二指标。
- 前后组合及活动修订、数据集、历史版本/产物、工作区、偏好哈希一致；MarketDemand 身份和目标一致。
  原浏览器继续运行，需求比较排除了 expires/updated_at，不将心跳时间不变作为要求。
  SourceFetch **219→219**、HistoryRun **12→12**，FixedIndicatorRun **4833→4837**；确认模式与临时模式可登记既有计算任务。

## Ubuntu PostgreSQL 定向与并发验证

真实 PG 为 **14.24**。复用用户指定的已有 PG 服务，新增任务专用数据库 `mw_mcp_composite_validation_20261023`，
以归属 comment 检查后使用；测试进程在导入应用前将业务与测试 URL 同时指向该数据库，并关闭该进程供源/投递开关。
每个 fixture 再建立唯一 schema。真实业务数据库不用于测试造样、切换修订、故障注入或迁移。
没有新增容器、网络或 volume，也没有增加既有容器 CPU/内存上限。

以下容器内测试实际执行结果：**70 passed、0 skipped、0 failed**（611.06 秒）。
包括非活动修订元数据、并发修订/输入选择、固定引擎和临时快照/重试。
仅一个 pytest cache 警告：非 root 应用用户不能写镜像内 `/app/.pytest_cache`，不影响执行。
完整脱敏输出见 [postgres-checks.txt](postgres-checks.txt)。

```text
backend/tests/test_series_access_postgres.py
backend/tests/test_composite_chart_postgres.py
backend/tests/test_fixed_indicators_postgres.py
backend/tests/test_chart_reload_postgres.py
```

私有日志：`/home/quant/repos/.mwa-mcp-composite-indicators-20261023/pg-checks-private.log`。
测试数据库保留归属标记；结束后核对临时 schema 全部按 fixture 清理，public 无业务表。
15 个服务的身份/镜像/重启次数、环境哈希、挂载、端口和网络均与本轮观察一致，API/PG healthy。
没有删除长期实例的数据卷或其他永久数据。

## A1–A12 审计

| 用例 | 直接证据 |
|---|---|
| A1 | 实际 tools/list 的组合参数和依据 schema；本任务协议/完整 CI 断言原集合、权限及普通 quote/bars 边界 |
| A2 | 真实默认查询与显式固定输入均返回价格/指标，每项依据与页面相同 |
| A3 | `test_selected_nonactive_revision_supplies_all_metadata`、MCP 显式非活动修订协议用例；本机 PG 通过 |
| A4 | 实际 EMA3/RSI3 逐项依据/时间；不同参数缓存隔离由协议 fixture 和完整 CI 覆盖 |
| A5 | 实际 MCP 与网页 bars、series、dependencies 和 calculation 依据逐项相同；沿用既有数值算法断言 |
| A6 | 本轮真实 pending→complete、完整初始化起点与可读价格；partial/retry/可见范围提前可读由协议和固定引擎 fixture 覆盖 |
| A7 | 长周期 null、缺口重置、稀疏信号和未收盘尾根在协议及既有算法测试通过；本机 PG 通过 |
| A8 | 本轮临时快照逐指标同源；临时值标记/确认状态不推进/冲突拒绝由协议及 PG fixture 覆盖，本机 PG 通过 |
| A9 | 本轮 8 组错误；外来修订、回收、空准备、固定算法先验校验、容量、预算、取消及审计在完整 CI 通过 |
| A10 | 实际库前后组合/活动修订/需求身份不变，SourceFetch/HistoryRun 不增；协议测试把需求/供应商入口替换为直接失败 |
| A11 | 输入选择后另一事务切换活动修订并追加确认尾部，强制 ORM 缓存过期，断言仍用旧输入；本机 PG 通过 |
| A12 | 本任务 managed/provider、动态依据与质量透传、行情流/网页 reload 回归和完整 CI 通过；本机 PG 通过 |

## 自动化与 CI

- 72 个 requirements.lock 包版本逐项一致；独立 `.venv` 包含 MCP 2.3.0。
- 最新本任务协议/共享读取 **45 passed**；时钟观察边界原断言修复复跑通过；行情流、固定指标、展示与 reload 相邻回归 **102 passed**。
- 源码 `9770d5d` 的 [CI 39933990391](https://github.com/hezongyi/market-watch/actions/runs/39933990391) 成功：
  后端 **2846 passed、18 skipped**；额外 PG 映射迁移 **1 passed**、observed 策略兼容 **8 passed**；Web 与 Compose 检查通过。
- 文档提交 `c63422e` 的 [CI 39936739985](https://github.com/hezongyi/market-watch/actions/runs/39936739985) 成功。
- 所有修改 Python 的 Ruff 及 diff --check 通过。
- 首次未配置 PG 的本地全量运行曾有 2202 passed、619 skipped、1 failed、38 errors。
  单失败为 metadata 观察边界，已保留原断言修复并通过完整 CI；38 个错误为既有 PG fixture 缺少 TEST_POSTGRES_URL。
  不将首次本地全量写成通过，配置 PG 的完整 CI 已补证。

## 运维与复验

本轮不启停服务。原长期管理命令仍为：

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py stop
```

完整协议、前后观察、复验脚本及测试日志保留在仓库外私有目录 `.mwa-mcp-composite-indicators-20261023/`。
`python3 /home/quant/repos/.mwa-mcp-composite-indicators-20261023/accept_composite.py` 可复验现有组合；重复执行可能直接命中已完成缓存，不能要求再次出现 pending。
`python3 /home/quant/repos/.mwa-mcp-composite-indicators-20261023/pg_checks.py` 仅对任务归属数据库执行上述 PG 检查。
旧独立合成实例的备用 build/start/stop/seed/drain 命令仍见 [README](README.md)，本次未启动该实例。
