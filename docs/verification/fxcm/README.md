# FXCM 验证记录

2026-10-25：真实 native API、应用适配器与独立整栈原生历史读取通过；**本轮独立本机验收收口：浏览器、受管历史、日更、重启恢复和关闭后空闲观察通过**。
收口时间 `2026-10-25T04:01:00.152997+00:00`；本机验收为分阶段通过，远程 CI 尚未执行，当前仍为未提交候选。
用户提供了 Trading Station Demo，并确认提交 LTD EULA；后续真实读取证明账户本次目录/历史访问可用，不独立推断 EULA 审批状态。

## 候选与隔离

- 工作树 `/home/quant/repos/market-watch-fxcm-history-20261024`，分支 `feat/fxcm-platform-managed-20261024`。
- 基线 `v1.28.0` / `59ed3a3f3fc727da76d13149934d999ebee04218`。当前为未提交差异，无最终实现 SHA、PR、合并或生产发布。
- Ubuntu 主机 `quant-server`；用户最新要求自行建立独立实例，**不使用 $mw-acceptance**。长期 project `mw-issue75-v2-20261018` 未修改、重启、迁移或写入。
- 应用 project `mw-fxcm-history-20261024` 已独立启动，迁移成功、API healthy。UI `https://192.168.7.232:18910`、chart `https://192.168.7.232:18911`。
- 测试 PG project `mw-fxcm-history-20261024-tests`，仅 `127.0.0.1:18912`，独立 volume 和测试 schema。

## 已验证结果

| 检查 | 结果 | 边界 |
|---|---|---|
| 官方 Python 1.6.43 wheel | 无 Linux cp311 wheel/sdist | 未降级主服务，采用 native helper |
| Linux SDK 加载/C++ ABI | passed | 离线环境，不代表账户权限 |
| 真实 native session | passed，登录前 NoPrice，无 table manager，offer/account/trade/other 更新均为0 | 有限观察，非整栈五分钟验收 |
| 目录及 native history | 517 品种；EUR/USD、XAU/USD M1/H1/D1 和翻页通过 | BID/精度/UTC 起点/tick_count；不证明全历史覆盖 |
| 应用适配器真实读取 | passed，一次 session 复用，25秒空闲正常退出，49.26秒 | 生产适配代码，非完整 HTTP/UI 栈 |
| FXCM/平台/共享额度/workspace回归 | 最新41 passed，12.38秒 | 记录样本和模拟上游；含实际验收发现的回归 |
| FXCM/维护/共享缓存 PostgreSQL | 最新 22 passed，42.24秒 | 真实独立 PG，上游为记录样本/fixture |
| 其他来源目录/平台/历史兼容 | 63 passed，5.48秒 | fixture/契约回归，非其他来源账户实测 |
| C++ -Wall -Wextra | passed | helper 编译 |
| web/chart build | 本轮独立镜像构建通过 | web 既有 bundle >500KB 警告 |
| 全量后端 | 非单次全绿：2244 passed、622 skipped、35 warnings，另有38项因缺 `TEST_POSTGRES_URL` 无法收集 | 这38项已在任务专属 PostgreSQL 补跑，38 passed |
| 整栈原生读取 | 两品种 M1/H1/D1，各20柱及20柱翻页通过 | 真实HTTP读取 |
| 配置后五分钟无需求 | 306.15秒通过 | helper全程0，无新增FXCM slot准入，缓存条数不变；worker仍有DB写入 |
| browser/双图格/受管历史 | passed，分阶段复验 | 两个H1图格共用一个datafeed订阅/后台任务/缓存；120根M1、H4、增量、旧版本不变、重复request_id、均线 |
| 维护/重启恢复 | passed | 有序停 worker 后持久 queued 任务仍暂停，恢复后发布；不是运行中 kill |
| 自然到点日更 | passed，分阶段复验 | 原周末空区间失败已保留；修复后原任务发布，03:53 UTC 新到点任务也自动发布，最终计划 paused |
| 关闭后五分钟空闲 | 305.81秒通过，10个样本 | helper/活动需求/订阅/slot均为0；计划paused，无新增准入或缓存增长；DB仍有worker写入 |
| CI | 未远程执行 | 本地检查不代表远程CI绿 |

日更首次到点任务在周末全空区间连续失败；同账户对照证明 bounded 空时间段失败，而截止时间前的有限快照成功。受管 M1 改为最多300柱的 `to=end-1ms` 快照再过滤 [start,end)，保留空区间为 unknown，不将失败当空响应或认定闭市。同时避免 inclusive cutoff 占用满300柱页的一个位置。新增两项回归先红后绿，真实交易时段300根及空周末 checkpoint 通过。原失败记录 `evidence/schedule-before-weekend-fix.json`、对照 `weekend-window-differential.json` 与复验 `daily-resume-result.json` 均保留。

浏览器最终图表检查单独续跑：原脚本误用 legacy managed instrument，已改成产品实际使用的 `MWH:<version>`。原生、双图、目录和导入结果保留，续跑成功记录于 `evidence/managed-chart-result.json`；`browser-result.json` 标注了拼接阶段，不表示原命令一次全绿。

## 数据与管理复用

`fxcm_history.py`、`provider_fxcm.py` 已实现。默认关闭，构造/列表/搜索不登录；仅显式目录刷新或历史需求启动私有 helper，20秒无命令退出。不交易、不订阅报价，不接 live-pricing/组合/备用源。

EUR/USD 精度5，XAU/USD精度2；volume 是价格变动次数 `tick_count/price_changes`。原生 M1/H1/D1 保留 UTC bar start，最大300柱，SDK `to` 在黄金D1翻页时观察到 inclusive 边界；先校验每根柱，再过滤为应用 [from,to)。没有来源 completion 标记；elapsed 与 source_confirmed 分开。D1 使用下一观测柱或保守25h，完整 DST 相位待核实。短页/空页不代表历史起点。

自建使用同源 BID M1，复用既有缓存、不可变版本、聚合、维护和 worker，无新 schema/专用管理器。PG 回归发现 `source_history_store.shared_page` 将所有非 OANDA volume 当 quantity，导致 FXCM `invalid_payload`；最小修复 fresh/cache 校验，改读既有 capability。FXCM source/version lease70秒覆盖65秒适配预算。

独立 Standards/Spec 审查发现：异常清理应留在共享 slot 内；冷登录后跨进程需从完成时刻间隔1秒；嵌入数据中心的 FXCM 目录刷新需匹配70秒预算。均已修复并独立复核，无未关闭发现；见 `review.md`。

## 证据

- [可用性](../../fxcm-api-feasibility.md)、[任务书](../../fxcm-platform-managed-agent-task.md)、[机器契约](api-contract.json)。
- [官方核查](official-api-research.md)、[历史语义](official-history-semantics.md)、[账户指南](demo-account-guide.md)。
- [日更与恢复续验](evidence/daily-resume-result.json)、[关闭后五分钟空闲](evidence/post-close-idle-five-minutes.json)、[资源汇总](evidence/resource-summary.json)。
- [浏览器阶段报告](evidence/browser-result.json)、[固定历史图表续验](evidence/managed-chart-result.json)、[双图截图](evidence/fxcm-dual-chart.png)、[受管图表及均线](evidence/fxcm-managed-chart.png)。
- `evidence/native-session-probe.json`、`native-history-probe.json`、`native-history-samples.jsonl`。
- `evidence/application-adapter-probe.json`、`application-adapter-probe.samples.jsonl`；样本 SHA256 `a4d1710157eab3958947d6263ff0f89ba4a26707bee99766b82e07cdef928fb3`。
- `evidence/account-preflight.json`、`sources.json`、`forexconnect-pypi.json`、`python311-probe.json`、`native-loading-probe.json`、`native-abi-probe.json`。
- `evidence/checks.json` 和 `preflight.json` 为早期原始记录，不代表当前状态。最新检查汇总至 `implementation-checks.json`。

SDK 固定commit `4c536d29fc722996d4a4bc40be247376f8c83eb9`，Linux1.6.5 archive SHA256 `a4c1ec512f0ede326afd0d63eb587c578b986b382cdd1e63900ce11a8c28f696`。SDK/helper只读私有挂载，未将 SDK bytes、凭据、env、私钥、完整浏览器状态或许可图表库提交 Git。再分发未获确认，未把SDK打入应用镜像。

## 复现

在任务 Ubuntu Docker 内按 `.env.example` 注入私有 FXCM settings/helper/SDK mount，只用临时 slot SQLite，不接应用DB：

```bash
PYTHONPATH=/app/backend python /app/scripts/verify_fxcm_history.py \
  --symbol EUR/USD --symbol XAU/USD \
  --start 2026-10-22T00:00:00Z --end 2026-10-24T00:00:00Z \
  --output /evidence/application-adapter-probe.json
```

输出脱敏摘要和样本校验和；空闲默认25秒。不在命令行放凭据。重测使用新artifact路径，保留原证据。

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q backend/tests/test_fxcm_history.py backend/tests/test_provider_fxcm.py backend/tests/test_market_resources.py
# TEST_POSTGRES_URL 从任务私有文件注入环境，不打印
PYTHONPATH=backend python -m pytest -q backend/tests/test_fxcm_managed_postgres.py backend/tests/test_history_maintenance_postgres.py backend/tests/test_source_history_store_postgres.py
PYTHONPATH=backend /home/quant/repos/market-watch-history-modes-20261024/.venv/bin/python -m pytest -q
```

## 独立应用验收

镜像构建走 `deploy/ubuntu/mw_docker.py build`，task `mw-fxcm-history-acceptance-20261024`、project `mw-fxcm-history-20261024`、purpose `acceptance`；精确命令见任务书§8。API/web/chart均使用当前任务候选；最终镜像ID见机器契约。

私有 env/应用登录/TLS 在 `~/.local/share/market-watch-docker/fxcm-history-20261024/`，目录0700、敏感文件0600。首次创建后复用，勿重生成密码。

```bash
docker compose --env-file "$HOME/.local/share/market-watch-docker/fxcm-history-20261024/acceptance.env" -p mw-fxcm-history-20261024 -f deploy/ubuntu/fxcm-history.acceptance.yaml config --quiet
docker compose --env-file "$HOME/.local/share/market-watch-docker/fxcm-history-20261024/acceptance.env" -p mw-fxcm-history-20261024 -f deploy/ubuntu/fxcm-history.acceptance.yaml up -d --no-build
docker compose --env-file "$HOME/.local/share/market-watch-docker/fxcm-history-20261024/acceptance.env" -p mw-fxcm-history-20261024 -f deploy/ubuntu/fxcm-history.acceptance.yaml ps
docker compose --env-file "$HOME/.local/share/market-watch-docker/fxcm-history-20261024/acceptance.env" -p mw-fxcm-history-20261024 -f deploy/ubuntu/fxcm-history.acceptance.yaml stop
```

PG14.24仅内部网络，应用/必要历史worker有受限出网网络。通知/OANDA pricing关闭。停止保留volume，不自行删除数据。

浏览器只接受三个输入；私有登录JSON仅含本实例应用登录，不含FXCM账户：

```bash
MW_FXCM_BASE_URL=https://192.168.7.232:18910 \
MW_FXCM_CREDENTIAL_FILE="$HOME/.local/share/market-watch-docker/fxcm-history-20261024/acceptance-login.json" \
MW_FXCM_ARTIFACT_DIR=/tmp/mw-fxcm-browser-20261024 \
node web/tests/fxcm-platform-managed.browser.cjs
```

脚本包含 native 周期/翻页、iframe 截图、目录 UI、有限 managed 导入/增量/旧版本不变/重复 request_id 和计划暂停恢复。固定历史图表可用 `web/tests/fxcm-managed-chart.browser.cjs` 续验（依赖此前已通过的导入等证据）。维护恢复入口为 `web/tests/fxcm-maintenance.browser.cjs`，使用同样三个参数；本次日更修复续验使用 `web/tests/fxcm-daily-resume.browser.cjs`，消费原失败阶段报告并恢复原任务，再验证新自然到期任务；各阶段结果须以实际生成报告为准。

## 资源与剩余边界

用户已明确授权按当前主机资源直接验收。保留各阶段资源样本，不停止其他任务、不全局清理；主机约15GiB可用磁盘，存在宿主竞争，不能声称开销可忽略。

阶段资源见 `evidence/resource-summary.json`。九个运行应用容器在配置后空闲采样合计约661–665 MiB、CPU合计7.51%–32.13%；双图共享点约779 MiB/40.58%；首次发布点约793 MiB/38.17%，首次创建到发布38.23秒，DB插入/更新/删除计数增202/535/41；增量点约796 MiB/17.48%，从首版发布至增量发布49.88秒（含脚本检查），DB增117/541/21。CPU是稀疏瞬时值，不是耗时或FXCM独占增量成本；DB写入包括所有本实例worker，宿主存在并发竞争。需求采样最多3个helper会话共存、最多1个活动slot；并存会话可能空闲或等slot，不代表3个同时请求。需求观察含cooldown，未将其隐去；修复后空闲另行报告。

完整 DST 相位、官方账户配额和 SDK 再分发仍未确认；CI 未远程执行。独立双审范围早于后续真实验收修复，见 review.md。没有创建 PR、合并或发布生产。

关闭后最终空闲样本：CPU合计8.85%–28.86%，内存合计684.82–723.77 MiB，DB插入/更新/删除增量{'tup_inserted': 0, 'tup_updated': 866, 'tup_deleted': 0}。这些为本实例全部运行容器/worker的稀疏采样。实例与数据保留供检查，日更计划 paused，无活动维护任务。账号换用仅离线测试，真实取消与运行中kill未做；不扩大 queued有序重启、有限NoPrice观察或本次历史区间的结论。
