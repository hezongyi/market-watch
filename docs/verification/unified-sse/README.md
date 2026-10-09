# 统一行情订阅：开发验证记录（进行中）

本记录不构成验收交付。实施范围及完成门槛仍以 `../../market-data-unified-subscriptions-plan.md` 为准。

## 当前环境与实现

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

Compose：`compose.unified-sse.acceptance.yaml`，task/project `mw-unified-sse-20261008`。Ubuntu本机实际地址：网页 http://127.0.0.1:15643，chart http://127.0.0.1:15644，主API http://127.0.0.1:15641，第二API http://127.0.0.1:15642，PG 127.0.0.1:15645，第二网页 http://127.0.0.1:15646 指向第二API；全部仅绑定loopback。凭据在私有 `artifacts/unified-sse/login.json`。启动/停止命令如下；旧进程使用sg docker包装。

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

## 完成审计：尚缺的证据和工作

- 已有真实PostgreSQL迁移、独立进程竞争、双API运行、worker接管及API重启证据；双浏览器实际经15643/15646连接两API，同周期四图保持一共享bar任务；最新代码容器gates待重建复核。
- 原生首屏、同柱更新、三bucket断线、worker/API重启及managed EMA已实测；八周期及隐藏布局释放/恢复已实测；分页范围更新、切周期/工作区和更长断线仍待扩展。
- 所有供应商仅自选表需求及身份切换、固定组合报价绑定、预警独立需求保持，需真实路径检查。
- managed EMA逐次回调已实测；固定/组合指标初始化、修订、临时递归更新及同规格跨连接共享仍需实际worker/数据库验证。
- 已记录managed同周期多图、八周期、双连接双API、EMA的原生P95（均≤3秒）；组合W1/MN在1/8消费者的真实PG成本见 composite-cost-summary.json。仍缺组合浏览器、多组合/指标完整矩阵、长期队列/发送成本。
- worker 检查节奏、负载预算、发送合并窗口及流队列预算需由测量确认；目前500ms是待验收的实现参数，不是性能承诺。
- 历史准备职责、reset 时首屏接受与新游标的实际协调、长期有界任务/缓存回收，仍需进一步核查。
- 继续通过sg docker及mw-docker入口构建，标签commit与运行服务核对；不直接构建绕过。

任务继续开发；上述全部证据齐备后再修改方案状态和交付结论。

## 2026-10-09 恢复与取消竞争修复

本轮先运行可失败的回调/持久任务测试，再应用修复。诊断及重跑入口见 `recovery-fixes-20261009.md`。空首屏订阅保持准备通知，但 bars 在原生 HTTP 历史接受前不交付；managed 准备条件复用原有 dataset status 和图表几何/指标历史需求，不以少量已发布柱代替首屏准备完成。恢复清理旧游标并隔离旧世代，避免尾部撤回后重新绑定旧位置。首读凭据只记录原生接受的窗口内柱。

回放历史检查使用各条持久结果的尾部证据；完整保留窗口以外的断线游标要求 reset。最后订阅取消后，已领取任务的迟到提交会复核有效消费者并精确释放自己的需求；再次订阅时核对持久需求是否仍存在，避免续期节流阻止恢复采集。预警需求保留测试仍通过。

这些测试使用本机 Python/Node 和 SQLite，不是 Docker 部署或真实图表/供应商验收。尚缺证据的清单仍有效。

## 指标值与加载范围修复检查点

OHLC 没有变化时，指标变化对应的柱仍进入增量事件，原生指标数据源由该柱驱动回调。实时加载范围随 SSE 追加推进，前缀修订凭据同步推进并由前端保留用于重连；历史窗口仍固定边界。实测复现/修复见 `indicator-range-fixes-20261009.md`。

`advanced-fixed-indicators.cjs` 使用 Python 实际共享 worker 发布的指标完成 reset，驱动 bridge 重读并接受历史指标值；不是手写完成事件。`advanced-fixed-revisions.cjs`、`advanced-managed-revisions.cjs` 显式开启 `marketPolling=1` 验证保留的回退链路。上述三个测试，以及 `advanced-managed.cjs`、`advanced-python-indicators.cjs`、原有三个 SSE 测试均通过。前端构建、Ruff、JS syntax、diff check 通过；实际浏览器和 PostgreSQL 尚未运行。

## 已发布 managed 状态检测成本

SQL 观察测试先复现 published 图表的状态检查仍扫描原始 candles 统计，再改为按 instrument/timeframe 主键读取 ChartPublication 的边界、修订、完整数量和初始化证据。发布修订仍使输入信号变化；该路径不再查询原始 staging 历史。未发布与报价路径保留既有检测。

统一套件 121 passed、25 PostgreSQL skipped；market_data/managed_dataset 本轮回归 78 passed。Ruff、diff check、Alembic 单 head 检查通过。没有据此推断实际 PostgreSQL 扫描量、CPU、容量或 P95，完整 Docker 性能矩阵仍待运行。

## 报价绑定与需求释放检查点

`test_market_stream_quotes.py` 九项检查通过：仅报价客户端共享计算/需求，无新价格的过期通知，固定输入不采用实时 bid，显式固定修订不跟随活跃切换，平台报价保持来源检查节奏且不创建周期历史需求，订阅替换/迟到取消/最后消费者释放，活跃修订切换前后精确释放本任务需求并保留独立预警。

修复前已复现：跟随修订切换留下旧 revision demand；同监听器替换系列留下旧 task demand；报价绑定改变直接交付新报价而未 reset；前端重连未保存已交付 binding。修复按任务派生的准确 demand ID 释放，注册替换/取消与提交使用 task 行锁协调，报价切换先 reset 并重注册，传输保存 binding 用于重连。SQLite 行为通过不证明 PostgreSQL 行锁并发通过。

完整统一套件含报价入口：130 passed、34 PostgreSQL skipped；既有回归105 passed。Node bar/quote 世代及订阅重连测试、web 构建、Ruff和diff check通过。平台 cadence 检查使用模拟 OANDA quote reader，尚未运行真实供应商或许可浏览器；不能由该检查宣称各供应商已验收。

## 2026-10-09 实际成本与恢复检查点

`browser-runtime-summary.json`汇集经过核验的历史成功记录，每条标注运行镜像和私有证据SHA256。最新fresh-callback八周期样本P95 1129ms，12次M1样本P95 1375ms，隐藏布局释放/恢复通过；一轮释放超时仍缺完整现场，之后显式选择原生M1活动图并增加恢复后的实际历史价格断言。旧负延迟样本不纳入通过或性能统计。

API重启复现Nginx connect等待约60秒后504；运行实例临时配置proxy_connect_timeout 3s后，同场景EMA/API重启通过，重连14434ms、正常更新P95 1227ms。repo配置已包含修复，需重建后验证；不将故障恢复时间计入正常负载P95。

组合成本探针在实际独立PG随机schema运行4项全部通过：W1/MN、1/8消费者、5000确认M1。每场景1共享任务、8有效计算、1 bucket build；6次warm报价不读取历史M1，1次确认修订仅yield 1条变化分钟且delta_reads=1。初建需要扫描，idle仍有17 SELECT和1 UPDATE；8消费者增加投递SQL。探针冻结synthetic来源时钟，不是供应商或浏览器验收。

八周期Docker资源记录发现大量DB输出。最小SQL回归先失败：空闲保活/领取/提交/投递读取market_stream_tasks.payload，即完整2000柱快照。该列改为按需延迟读取，首次绑定和发布差分保留权威快照；32项相关检查及实际PG的单项回归通过。另加快消费者持续读、慢消费者停止读133结果的检查：保留结果上限128，慢消费者收到明确reset，快消费者持续交付。最新全部代码待提交/镜像重建与实际资源复测。

上述日期早期的SQLite/无Docker段落是历史检查点；当前真实部署与未完成门槛以本文件开头和完成审计为准。任务未完成，不退役实例。

## 2026-10-09 重建后复核与组合EMA预算修复

`5347299` API/chart/web全部经mw-docker重建并实际启动，API healthy。镜像中的Nginx配置测试成功，确认proxy_connect_timeout 3s。容器内53项PG检查通过（36共享订阅、4组合成本、13固定指标）。重建后八周期P95 1036ms、M1 971ms；隐藏期间M5值105.19经实际native getBars回调接受。managed EMA/API重启P95 1028ms、重连17375ms；双页面双API四同周期图一共享任务，P95 1275ms；EMA+真实worker停止/接管/API重启P95 2455ms。所有值仅正常synthetic输入窗口，故障时间另记。

相同八周期场景Docker累计网络计数差分：API入站约23MB、worker约38MB；旧轮约560MB/750MB。运行时长与后台输入存在差异，不能把此比例当容量保证，但与SQL回归排除空闲快照读取一致。CPU/内存前后快照保存在每轮摘要。

新增组合M1+EMA31、1/8消费者成本探针通过：每场景一共享任务、1 bucket build，6次warm报价不读取M1；warm计算约162–321ms。2000柱首次计算约6–8秒，初始化成本不隐藏。确认修订发reset，等待固定指标修复后再发进度reset，新指标与权威读取一致；idle不重复计算。

探针先复现组合EMA结果2228241 bytes超过2MiB保存预算，持续发布只能result_budget reset。新增原生窗口过滤回归先失败，再将保存快照预算调为8MiB；单次投递预算保持4MiB、结果条数上限128。SQLite与实际PG预算回归通过。此业务修复仍待再次镜像重建。

新增受同一guard保护的合成组合fixture，通过真实注册、固定history blob/checksum、first_use、confirmed_minutes/apply_minutes和pricing owner输入，使用专属身份与workspace；无supplier凭据时才允许，拒绝接管其他owner。两项输入回归通过；后续许可浏览器将验证组合M1/D1/W1/MN，不能把该合成输入称为OANDA验收。仅报价真实原生回调场景已通过（P95 916ms），最新harness按本client核对消费者，避免前一浏览器租约宽限污染释放断言；新镜像重跑时归档完整报告。
