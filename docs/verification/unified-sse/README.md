# 统一行情订阅：开发验证记录（进行中）

本记录不构成验收交付。实施范围及完成门槛仍以 `../../market-data-unified-subscriptions-plan.md` 为准。

## 当前环境与实现

用户要求收口时统计本套实现新增开销。使用 `scripts/unified_sse_resources.py`
对本项目准确归属容器进行只读采样，记录累计 CPU 时间差、工作集平均/峰值、
网络字节差、块 I/O、PostgreSQL 扫描/读写/WAL 和表/数据库大小。
私有原始报告保存在 `artifacts/unified-sse/resources/`。须分别记录无订阅空闲、
单周期、八周期、EMA、多连接及多组合，并以相同输入速率/时长比较可用基线。
运行新实现一次不等于已测得相对旧实现增量；镜像逻辑大小也不等于物理磁盘新增占用。
首次历史加载与稳定报价窗口分开，fixture 写入和本项目其他 worker 成本需说明。
收口报告给出实测值、测量规模及未完成比较，不承诺零负荷或生产容量。

```bash
sg docker -c 'python scripts/unified_sse_resources.py --scenario idle --seconds 60 --interval 5'
```

场景标签必须与实际负载一致；上例只有在没有消费者/验收进程时才可记为空闲。
已完成本版本轮询回退/SSE的单周期、八周期60秒同输入对照，以及双连接/双API共享、
无消费者worker启停、组合EMA初始化与稳定报价采样。
实测与限制见 [resource-cost-report.md](resource-cost-report.md)；原始哈希及计数见
[resource-probe-summary.json](resource-probe-summary.json)。比较不是旧发布版本净增量。

当前运行API/chart/web源码为 `95d501e`，均经mw-docker重建。
同镜像PG gates58 passed in222.30s（38统一订阅、7组合成本、13固定指标），
测试schema残留0。本机选定统一/组合套件139 passed、45 PG skipped，PG另证；
fixture10项通过，web构建及Node桥接检查通过。
固定首屏/分页/EMA/M5及workspace切换整组许可浏览器通过；真实网关断开130027ms
跨三柱恢复通过，正常回调P95 867ms。95修复后的八周期/隐藏布局释放恢复复核通过，
八周期P95 965ms；EMA/worker接管/API重启组合复核P95 1239ms。
组合EMA四周期真实native回调/资源复测P95 1711ms。
后续未提交修改是验收入口和证据文档，业务运行版本仍95d501e。

2026-10-09按用户授权从原market-watch本机.env获取Practice配置，私有保存，未输出凭据。
本机直连失败，已有代理实测REST127品种、EURUSD/XAUUSD各5根确认M1；
20秒单价格流有两品种报价与心跳。已配置本任务隔离API及pricing-worker，
通知关闭、默认resident为空，供应商浏览器验收进行中。

Ubuntu worktree `/home/quant/repos/market-watch-unified-sse-20261008`，分支 `feat/unified-market-sse-20261008`，基线 `6fd9273`。前置核对见 `../../unified-sse-implementation-preflight.md`。本地 `.venv` 按 requirements.lock 安装；web 按 package-lock 安装。许可图表复制到忽略目录，未进入 git。

已有实现：组合单 bucket 替换聚合及确认 delta 更新；数据库共享任务、结果序号、有界回放和世代取消；会话认证及 CSRF；统一 worker 的有界并发、归属租约/接管与持久输入凭据；前端复用订阅生命周期、统一 bar/quote 回调和按需 reset；默认停用行情 tick，`?marketPolling=1` 保留迁移回退。

历史页仍走 HTTP；加载范围、固定版本/修订与指标依赖参与消费者修订判断。quote 任务后台按来源节奏读取既有报价路径，组合引用独立需求，不隐式创建定义。预警与策略原有内部入口不改为 SSE。

## 已执行验证

- `unit-tests.txt`：142 passed、37 skipped（2026-10-09 快照成本/慢消费者检查点；跳过项均为未运行的 PostgreSQL gates）。覆盖九个周期、UTC/NY17/DST、极值缩小、临时撤回、差分聚合、固定历史与组合报价、共享任务、租约、恢复、HTTP 权限及验收fixture保护。
- `regression-tests.txt`：105 passed，既有 provider_service、market_data、managed_dataset、fixed_indicators 回归。
- `node tests/advanced-market-stream.cjs`：实际 bridge 回调的世代/序号拒收、确认后极值缩小、报价交付、取消迟到回调与常态 tick 无行情请求；新增空首屏准备、HTTP 历史接受后的单次重注册、尾部撤回、拒收及窗口过滤凭据检查、Python 指标值交付。
- `node tests/advanced-fixed-series.cjs` 与 `advanced-provider-subscriptions.cjs`：既有身份、首用边界、连接共享和取消顺序通过。
- `npm run build`：TypeScript/Vite 构建通过；既有 chunk size 提示仍存在。
- `test_market_stream_postgres.py`：Ubuntu隔离PostgreSQL上34 passed，见 `postgres-tests.txt`。包含独立进程注册/领取、worker、报价与HTTP契约；这次使用本机.venv连接本项目15645端口。初次容器运行31 passed、3 failed，原因是测试schema缺少基础品种；补齐fixture后重跑通过，`c251b9d` 容器内34项复核通过（postgres-container-tests.txt）；最新快照成本和慢消费者检查加入下次镜像 gates。
- 新模块 Ruff、`node --check advanced-host/bridge.js`、`git diff --check` 通过；Alembic 单 head 为 `ar45_market_stream`。

## Ubuntu Docker 验收实例（已运行，整体验收进行中）

2026-10-09 用户授权并配置Ubuntu Docker权限，docker组已包含quant；旧进程附加组未刷新，使用 `sg docker -c 'COMMAND'` 成功访问本机Docker29.1.3。API/web/chart均通过mw-docker及market-watch-ubuntu构建。已创建本项目独立network和postgres-data volume并启动服务，主API健康检查通过；查询数据库alembic_version确认 `ar45_market_stream`。没有访问或修改unraid。

Compose：`compose.unified-sse.acceptance.yaml`，task/project `mw-unified-sse-20261008`。provider-history-worker（alerts.native_history_loads）已补齐：平台首次历史分页任务需要此进程；
原native-history-worker只运行固定历史/指标版本处理，两者职责不同。

Ubuntu本机实际地址：网页 http://127.0.0.1:15643，chart http://127.0.0.1:15644，主API http://127.0.0.1:15641，第二API http://127.0.0.1:15642，PG 127.0.0.1:15645，第二网页 http://127.0.0.1:15646 指向第二API；全部仅绑定loopback。凭据在私有 `artifacts/unified-sse/login.json`。启动/停止命令如下；旧进程使用sg docker包装。

已运行 `.venv/bin/python scripts/prepare_unified_sse_acceptance.py`，在仓库忽略目录 `artifacts/unified-sse` 创建独立随机开发凭据、acceptance.env、compose.env、tests.env、login.json。目录 0700、文件 0600，重复运行拒绝覆盖。认证哈希经 dotenv/Compose 导出转义核对与 Argon2 校验通过；不含真实供应商配置。随后已构建并启动上述实例。新增供应商测试配置也必须留在该私有目录；不得使用生产数据或目录。构建示例：

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
  -p mw-unified-sse-20261008 -f compose.unified-sse.acceptance.yaml \
  --profile verification run --rm --no-deps postgres-gates
docker compose --env-file artifacts/unified-sse/compose.env \
  -p mw-unified-sse-20261008 -f compose.unified-sse.acceptance.yaml stop
```

停止不删除 volume。结束验收后按 mw-docker retire 预览/归档/恢复核验/精确退役流程操作；当前任务未结束，不标记完成。生产发布未授权。

`postgres-gates` 仅在 migrate 成功后运行，使用同一 task API 镜像，每个测试创建独立随机 PostgreSQL schema 并精确清理该 schema。其环境变量设置 TEST_POSTGRES_URL，避免把跳过当成通过。若直接使用本机 .venv 跑该套检查，载入私有 tests.env 后设置环境变量，连接仅限本项目的 127.0.0.1:15645。

### 原生浏览器合成行情入口（基础/指标/恢复已实测）

完成上述构建、迁移和启动后，从 worktree 根目录运行：

```bash
LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu \
  node web/tests/unified-sse.browser.cjs
# 可独立运行，也可组合：
# node web/tests/unified-sse.browser.cjs --indicators
# node web/tests/unified-sse.browser.cjs --takeover
# node web/tests/unified-sse.browser.cjs --sharing
# node web/tests/unified-sse.browser.cjs --matrix --visibility
# node web/tests/unified-sse.browser.cjs --indicators --restart-api
```

脚本先核对 Ubuntu、本机 Docker socket、各参与服务的 Compose project 与 mw-docker 镜像 task/project/purpose/commit。只接受当前 HEAD 的 acceptance 镜像。经 `compose exec -T api python -` 发送 `scripts/unified_sse_acceptance_fixture.py`，无需修改生产镜像的 Dockerfile 或复制许可资源。写入前再次核对数据库 application_name、host/name/user 和 delivery_disabled；迁移必须已完成，不自动建表。

fixture 仅创建本任务的 `SSEFIXTURE`/`unified-sse-synthetic`，九周期合成发布柱：M1/M5/M15/M30/H1/H4/D1各1400柱、W1 300柱、MN 120柱，无供应商行情响应模拟，也不启用采集。重复 seed 保留数据，更新指定尾柱或追加完成柱；无效 OHLC 会回滚。初始尾部留出30分钟，重复追加耗尽后明确失败，不伪造未来完成柱。

脚本通过正常UI登录及许可图表打开合成工作区，记录原生subscribeBars真实回调（先调用图表库回调，再记录成功接受）、HTTP首屏及实际EventSource消息。等待首屏有限报价请求结束后测量12次同柱更新/高值缩小，停止本任务web网关断开实际TCP连接，期间追加3柱，恢复后逐柱回放；跨15秒tick的常态窗口无行情轮询/历史重读。Chromium setOffline在本机不会断开既有localhost SSE，不能据此宣称已断线。

`--takeover`实际启动本任务successor，停止主worker，确认同一task换owner并继续原生交付，再重启主API检查重连；finally恢复主worker并停止successor。`--indicators`通过原生createStudy创建period31的Python EMA，逐次核对worker指标值与原生研究callback。两个场景实测通过，摘要 `browser-runtime-summary.json`；P95分别835ms和1057ms。仅12个串行合成managed M1输入，不代表正式负载矩阵、组合增量成本或供应商验收。没有测量worker/API故障期间的正常负载P95。

结果与截图写入忽略且私有的 `artifacts/unified-sse/unified-sse-browser*`；不保存 cookie、完整浏览器状态或密码。失败退出非零；preflight 失败会覆盖结果为 passed=false，避免误用上次成功记录。脚本未修改业务代码加入验收专用回调钩子。

早期2026-10-09首次运行该命令：在 `compose ps -q api` 阶段遇到 Ubuntu Docker socket permission denied，浏览器未启动、fixture 未写入。`test_unified_sse_acceptance_fixture.py` 的6项SQLite检查通过，仅证明保护和fixture→真实Calculator/持久事件的输入契约。该早期权限失败已被后续Ubuntu实测取代；fixture现有7项检查通过。

完整统一Python套件本地142 passed、37 skipped，随后在实际隔离PostgreSQL上补跑34项全部通过；两个结果证据分开保存。Node脚本语法、新增Python文件Ruff及diff check通过。Docker权限阻塞已解除。真实OANDA测试配置路径已向用户询问，尚未配置token/account，不能将合成fixture当作供应商验收。

## 完成审计

逐项证据及余项统一记录于 [completion-audit.md](completion-audit.md)。
当前尚缺真实供应商的原生回调、仅报价/独立预警、来源或账户切换和过期恢复直接证据；
正在使用找到的Practice配置补验收。连通性探针不能代替这些行为通过。
多组合共享计算有真实PG成本证据，独立稳定容器CPU/内存对照尚未测量。
资源与证据已整理，整体目标仍active，未发布生产，不finish/retire。

可见性修复先红后绿见 `invisible-period-red.txt` / `invisible-period-green.txt`：
原生缓存保留旧组合M1，切品种/周期后迟到reset反复恢复。95d501e同步symbol/interval
及workspace可见性，处理bar/reset前拒收不可见来源；许可浏览器生命周期及八周期复核通过。

OANDA真实入口（只操作本任务）：

```bash
sg docker -c 'env LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu node web/tests/unified-sse-oanda.browser.cjs'
```

脚本核对Ubuntu、本机Docker及运行镜像commit/task/project/purpose，使用专属workspace/watch
和实际supplier输入，不生成价格；finally精确释放自身浏览器需求并暂停自己的watch。
`--resources`可用于组合合成浏览器EMA稳定采样，但该synthetic入口明确拒绝已有供应商凭据的
实例，不要在supplier配置下伪造pricing owner。若需复跑合成场景，先精确停止本项目pricing-worker
并恢复私有acceptance-before-oanda.env，重建本项目容器；不得混用真实和合成来源。

真实OANDA只报价场景复现统一worker读取不存在的ChartHistoryPlan.error：
该品种已形成历史计划后Calculator直接抛AttributeError，不交付managed报价。
已加入先红后绿回归（managed-history-plan-red.txt/green.txt），20项quote/worker检查通过；
3956df2改为读取模型实际存在的status/cursor/边界/realtime字段。
新API镜像重建和真实supplier复跑尚待完成，不能以此unit结果宣称真实验收通过。
真实OANDA三天M1固定历史已下载并发布，独立专属composite已建立；实际stream组合回调待验。
