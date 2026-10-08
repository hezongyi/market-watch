# 统一行情订阅：开发验证记录（进行中）

本记录不构成验收交付。实施范围及完成门槛仍以 `../../market-data-unified-subscriptions-plan.md` 为准。

## 当前环境与实现

Ubuntu worktree `/home/quant/repos/market-watch-unified-sse-20261008`，分支 `feat/unified-market-sse-20261008`，基线 `6fd9273`。前置核对见 `../../unified-sse-implementation-preflight.md`。本地 `.venv` 按 requirements.lock 安装；web 按 package-lock 安装。许可图表复制到忽略目录，未进入 git。

已有实现：组合单 bucket 替换聚合及确认 delta 更新；数据库共享任务、结果序号、有界回放和世代取消；会话认证及 CSRF；统一 worker 的有界并发、归属租约/接管与持久输入凭据；前端复用订阅生命周期、统一 bar/quote 回调和按需 reset；默认停用行情 tick，`?marketPolling=1` 保留迁移回退。

历史页仍走 HTTP；加载范围、固定版本/修订与指标依赖参与消费者修订判断。quote 任务后台按来源节奏读取既有报价路径，组合引用独立需求，不隐式创建定义。预警与策略原有内部入口不改为 SSE。

## 已执行验证

- `unit-tests.txt`：120 passed、12 skipped（2026-10-09 指标与加载范围修复检查点；跳过项均为未运行的 PostgreSQL gates）。覆盖九个周期、UTC/NY17/DST、极值缩小、临时撤回、差分聚合、固定历史与组合报价、共享任务、租约、恢复和 HTTP 权限。
- `regression-tests.txt`：105 passed，既有 provider_service、market_data、managed_dataset、fixed_indicators 回归。
- `node tests/advanced-market-stream.cjs`：实际 bridge 回调的世代/序号拒收、确认后极值缩小、报价交付、取消迟到回调与常态 tick 无行情请求；新增空首屏准备、HTTP 历史接受后的单次重注册、尾部撤回、拒收及窗口过滤凭据检查、Python 指标值交付。
- `node tests/advanced-fixed-series.cjs` 与 `advanced-provider-subscriptions.cjs`：既有身份、首用边界、连接共享和取消顺序通过。
- `npm run build`：TypeScript/Vite 构建通过；既有 chunk size 提示仍存在。
- `test_market_stream_postgres.py`：12 skipped，未配置隔离 TEST_POSTGRES_URL；未运行的并发检查不算通过。
- 新模块 Ruff、`node --check advanced-host/bridge.js`、`git diff --check` 通过；Alembic 单 head 为 `ar45_market_stream`。

## Ubuntu Docker 验收入口（尚未运行）

2026-10-09 再次检查，`docker info` 对 `/var/run/docker.sock` 返回 permission denied；quant 未加入 docker 组，`sudo -n true` 要求密码，没有可用的非交互提权入口。已请求配置本机 Docker 权限，尚未收到确认。尚未创建本任务 Docker 实例、镜像或 volume。以下地址是配置预留，**尚不可作为已部署访问地址**。

Compose：`compose.unified-sse.acceptance.yaml`，task/project `mw-unified-sse-20261008`。独立 PG volume/network；API 15641、第二 API 15642、web 15643、chart 15644，全部绑定 127.0.0.1。

准备仓库忽略目录 `artifacts/unified-sse/acceptance.env`，只写开发凭据和供应商测试配置；另准备 private compose env，包含 POSTGRES_PASSWORD、MW_ACCEPTANCE_ENV 及三个 MW_*_IMAGE。不得使用生产数据或目录。构建示例：

```bash
mw-docker build --repo . --component api --tag market-watch-api:unified-sse-20261008 \
  --task mw-unified-sse-20261008 --project mw-unified-sse-20261008 --purpose acceptance
mw-docker build --repo . --component chart --tag market-watch-chart-origin:unified-sse-20261008 \
  --task mw-unified-sse-20261008 --project mw-unified-sse-20261008 --purpose acceptance
mw-docker build --repo . --component web --tag market-watch-web:unified-sse-20261008 \
  --task mw-unified-sse-20261008 --project mw-unified-sse-20261008 --purpose acceptance \
  --build-arg VITE_ADVANCED_CHART_ORIGIN=http://127.0.0.1:15644
docker compose --env-file artifacts/unified-sse/compose.env \
  -p mw-unified-sse-20261008 -f compose.unified-sse.acceptance.yaml up -d --no-build
docker compose --env-file artifacts/unified-sse/compose.env \
  -p mw-unified-sse-20261008 -f compose.unified-sse.acceptance.yaml stop
```

停止不删除 volume。结束验收后按 mw-docker retire 预览/归档/恢复核验/精确退役流程操作；当前任务未结束，不标记完成。生产发布未授权。

## 完成审计：尚缺的证据和工作

- Ubuntu 真实 PostgreSQL 迁移、双 API、双 worker 并发和进程故障接管；不能用 SQLite 行为测试替代。
- 原生许可图表在浏览器中的首屏与实时竞争、分页范围更新、隐藏布局释放/恢复、切周期/工作区、跨多个 bucket 断线和重启；VM bridge 测试只证明回调处理代码。
- 所有供应商仅自选表需求及身份切换、固定组合报价绑定、预警独立需求保持，需真实路径检查。
- 指标初始化、修订、临时递归更新及同规格跨连接共享，需实际 worker/数据库运行验证。
- SQL/扫描/写入、CPU/内存、发送量/队列、1/多图、4–8 周期 W1/MN、含/不含指标、多组合和多连接基线/对比；提交到原生回调 P95≤3秒尚未测量。
- worker 检查节奏、负载预算、发送合并窗口及流队列预算需由测量确认；目前500ms是待验收的实现参数，不是性能承诺。
- 历史准备职责、reset 时首屏接受与新游标的实际协调、长期有界任务/缓存回收，仍需进一步核查。
- 构建前重新核对 Docker 权限与 mw-docker 生命周期登记目录的写权限；遵守现有入口，不能直接构建绕过。

任务继续开发；上述全部证据齐备后再修改方案状态和交付结论。

## 2026-10-09 恢复与取消竞争修复

本轮先运行可失败的回调/持久任务测试，再应用修复。诊断及重跑入口见 `recovery-fixes-20261009.md`。空首屏订阅保持准备通知，但 bars 在原生 HTTP 历史接受前不交付；managed 准备条件复用原有 dataset status 和图表几何/指标历史需求，不以少量已发布柱代替首屏准备完成。恢复清理旧游标并隔离旧世代，避免尾部撤回后重新绑定旧位置。首读凭据只记录原生接受的窗口内柱。

回放历史检查使用各条持久结果的尾部证据；完整保留窗口以外的断线游标要求 reset。最后订阅取消后，已领取任务的迟到提交会复核有效消费者并精确释放自己的需求；再次订阅时核对持久需求是否仍存在，避免续期节流阻止恢复采集。预警需求保留测试仍通过。

这些测试使用本机 Python/Node 和 SQLite，不是 Docker 部署或真实图表/供应商验收。尚缺证据的清单仍有效。

## 指标值与加载范围修复检查点

OHLC 没有变化时，指标变化对应的柱仍进入增量事件，原生指标数据源由该柱驱动回调。实时加载范围随 SSE 追加推进，前缀修订凭据同步推进并由前端保留用于重连；历史窗口仍固定边界。实测复现/修复见 `indicator-range-fixes-20261009.md`。

`advanced-fixed-indicators.cjs` 使用 Python 实际共享 worker 发布的指标完成 reset，驱动 bridge 重读并接受历史指标值；不是手写完成事件。`advanced-fixed-revisions.cjs`、`advanced-managed-revisions.cjs` 显式开启 `marketPolling=1` 验证保留的回退链路。上述三个测试，以及 `advanced-managed.cjs`、`advanced-python-indicators.cjs`、原有三个 SSE 测试均通过。前端构建、Ruff、JS syntax、diff check 通过；实际浏览器和 PostgreSQL 尚未运行。
