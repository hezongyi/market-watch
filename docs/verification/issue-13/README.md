# Issue #13 方案阶段证据

源码：`0591e56fb4a59de8e847c43a37b2d015ec2d5cf1`。环境：Ubuntu quant-server，Python 依赖使用现有虚拟环境，数据库显式设置为进程内 SQLite。脚本直接调用当前源码，不启动 API、容器、上游采集或通知。

从本工作树根目录运行：

```bash
ALERTS_DATABASE_URL=sqlite:///:memory: PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python docs/verification/issue-13/idle_probe.py
ALERTS_DATABASE_URL=sqlite:///:memory: PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python docs/verification/issue-13/publication_semantics_probe.py
```

- [idle_probe.py](idle_probe.py)：固定时钟、30 根 M1、一个已登记品种，预先执行两轮周期轮转，再验证空闲发布。当前主线预期退出 1，失败断言为 `idle publication reports progress`。输出见 [idle-baseline.txt](idle-baseline.txt)。可见快照比较包含发布边界、计数、revision、初始化及 bar payload；不包含 updated_at，更新时间写入由 SQL 计数另外记录。
- [publication_semantics_probe.py](publication_semantics_probe.py)：当前主线预期退出 0；证明只更新观察时间不会生成现有修订任务，以及观察时间/价格修订已发布但 publish_frame 返回 False。输出见 [semantics-baseline.txt](semantics-baseline.txt)。这是现行行为证据，修复时应转为新合同测试，不要求优化后继续保持这些缺陷。

上述 SQL 数是 fixture 的确定性行为，不是生产吞吐或 CPU 测试。SQLite 不证明 PostgreSQL 行锁、并发事务、迁移或执行计划正确；这些在[方案 P0](../../issue-13-publication-performance-plan.md)补齐。方案阶段没有业务代码修改，故没有运行全量产品回归。

## 接续 P0（2026-10-07）

核心 P1–P3 等待三层 PR 合并，见[版本矩阵](versions.md)。[实例台账](inventory.md)和[原始实例数据](inventory.json)、[宿主短采样](host-baseline.txt)、[回归清单](regression-matrix.md)已经保存。覆盖差集与实际查询计划见 [results/coverage.json](results/coverage.json)，只针对本任务合成库。

实际运行环境：Ubuntu `quant-server`（192.168.7.232），Compose project `mw-issue13-p0`；网络 `mw-issue13-p0_default`，数据卷 `mw-issue13-p0_pgdata`，数据库 `issue13`。PG 地址 `127.0.0.1:19613`，没有本任务网页/API。PG 0.75 CPU/512MiB，探针 0.75 CPU/768MiB；探针只读挂载本工作树，结果挂载写入 `results/`。仅使用本机已有固定 image ID，无镜像构建或外部来源请求，无通知投递。

本机私有 env 文件：`/tmp/market-watch-issue13-local.env`（0600，不提交），含两种镜像 ID 和随机数据库密码；删除 env 后须自行恢复凭据或重建**本任务**空库，不能读取其他实例凭据。秘密不包含在文档、台账或输出中。

启动/停止：

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml stop postgres'
```

测量流程（首次 setup 只用于空库，已完成的库不要重复 seed/freeze；schema 使用真实 Alembic upgrade head）：

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml run --rm probe python docs/verification/issue-13/pg_baseline.py setup'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml run --rm probe python docs/verification/issue-13/pg_baseline.py warmup'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml run --rm probe python docs/verification/issue-13/coverage_probe.py'
python3 -u docs/verification/issue-13/run_suite.py > docs/verification/issue-13/results/suite.log 2>&1
```

套件串行执行 4 场景 × 3 次 × 300 秒，测量前 reset 恢复已保存的初始发布；失败不自动重试，结束自动 stop 本任务 PG。每次 JSONL 保留逐轮 SQL/时间/目标，JSON 保留前后状态、可见延迟、未发布事件与容器限流；`*-sql.json` 是 PG 查询执行统计（包含输入及验证，非纯 worker）；`suite-host.jsonl` 记录宿主负载/CPU/swap/其他容器及磁盘。0 号为 20 秒 smoke，不用于最终 5 分钟基线。重跑前须归档已审核的输出，不覆盖基线。

fixture：EURUSD/XAUUSD/BTCUSDT 及 7 个显式合成身份，每身份 64,000 根 M1，总 candles 824,418、audit_events 388,895、预热 published 26,290。价格常数、固定时间，完整源窗口预存；不等同于真实供应商历史。当前覆盖统计为区间有效性；缺口、稀疏观察和完整消费者正确性仍按回归清单补齐。

时钟口径：虚拟源时钟每输入前进60秒，每个身份的新bar每10次输入推进一分钟；实际输入间隔为上一输入完成后10秒，因此有处理时间漂移。延迟以真实monotonic输入提交到published M1匹配测量，不是供应商确认或告警新鲜度SLA。新bar摄入received_at为虚拟worker时钟+65秒，这种人工时序不能用于证明消费者的“观察时间不在未来”合同；独立消费者验收必须采用一致的时钟/事件顺序。实时身份的奇偶分配固定为新分钟或同价观察，完整身份×两种输入覆盖尚待补测；保留原套件不在运行中改变输入，以保证三次可比。

12份长测已完成且门槛已冻结，报告和限制见下文。原样本宿主竞争较高且不一致，不能由CPU高低或SQL次数宣称性能改善；三层合并后复测同样负载。

API开销已另做三次5秒只读线程采样和60秒access数量统计，见 [api-observation.md](api-observation.md)。热点集中在后台线程，具体业务函数尚未通过堆栈定位；没有把健康请求或无页面访问直接认定为根因。

完成报告前运行 `python3 docs/verification/issue-13/audit_measurements.py --complete`。该命令逐项核对12份正式结果、JSONL轮数/单调时间/SQL计数、PG统计、目标身份与事件时间，并要求套件已完成；省略 `--complete` 可审核已完成样本，输出明确列出缺少项，不作为完整基线。汇总脚本也执行同一审计。源返回行数不是扫描行数；事件最后30秒的观测截尾与更早仍未可见事件分别保留。

正式实例实际覆盖差集已只读导出并在Ubuntu本地计算，见 [production-coverage-comparison.md](production-coverage-comparison.md)。`export_coverage.py` 在现有生产worker中只执行read-only repeatable-read SELECT，有statement/lock timeout，只输出明确白名单覆盖字段、不输出env/凭据；在unraid不创建任何文件、实例或迁移。`compare_coverage.py` 完全本地离线计算，不访问数据库。已有原始快照保留，export拒绝直接覆盖；重采必须先明确归档，避免混合时刻数据。这是正式数据核对，开发/验收实例仍全部在Ubuntu，性能长测没有使用生产数据库。

实测数据对P3的判断和切换关卡见 [coverage-readiness.md](coverage-readiness.md)。每身份约1.4万行重叠结构化覆盖的有效并集仅1个区间，读优化还需考虑规范化投影/版本；单纯停读审计既丢旧证明，也未控制结构化范围增长。

准备期小修复：published告警避免先读并丢弃staging，真实调用链probe先红后绿，28个既有回归通过；见 [alert-read-fix.md](alert-read-fix.md)。当前仅本地源码变更，未部署或测得现有API CPU收益；发布调度/增量/覆盖核心改造仍等待三层合并。

`consumer_probe.py`已在四场景结束后执行：reset并显式扩大历史起点，使40个身份/周期输入非空，再串行测量10身份×4周期×3次真实ASGI认证路由和发布告警求值；不启动API lifespan/供应商线程、通知或网页/浏览器。输出consumer-microbaseline.json，测的是服务调用耗时，不能代替网络API、后台线程、输入到告警延迟或并发验收。执行前启动自己的已停止PG，完成后已停止；没有与suite并行。

已启动 `finish_p0.py --suite-pid 2584143` 接续器：实际核对指定Linux进程的cmdline、PID与start ticks，等待套件终止后要求12份完整artifact审计及SUITE COMPLETE，再汇总、启动自己的PG、执行消费者探针，finally停止PG。不从日志猜测活跃，不重启套件。状态和非秘密运行日志位于results/finish-state.json、finish.log；各步骤详细输出默认0600保存于`/tmp/mw-issue13-p0-<step>.log`，错误时先检查并脱敏，不直接提交可能包含DB参数的异常。已有finish-state拒绝重复启动接续器；跨会话以实际进程状态为准。

正式覆盖原始JSONL归档为 [production-coverage.jsonl.gz](production-coverage.jsonl.gz)，解压往返与SHA256见 [production-coverage-manifest.json](production-coverage-manifest.json)。未压缩副本仅本地保留并显式gitignore，避免重复提交23MB；compare直接读取归档，已重跑确认差集一致。

台账刷新与早期记录限制见 [inventory-lifecycle.md](inventory-lifecycle.md)；早期完整inspect记录已被覆盖，不能以最新17容器台账替代初次66容器的详细字段。各文件哈希见evidence-manifest.json（内容证据保全，不代表全任务完成）。

最新状态：12份长测和完整artifact审计已结束，见 [PG报告](pg-baseline-report.md)；非空四周期消费者微基线已完成，见 [消费者报告](consumer-report.md)。[冻结门槛](acceptance-thresholds.md)包含实测口径与尚未测的网络/告警/并发要求。此前进行中/PID是历史记录；suite与finisher均已结束，PG最后核验exited0、running false。合成volume保留；P1–P3仍等待三层合并。


## 接续保存与补充验证

方案、脚本、原始测量及published告警小修复已由本地提交 `d362766` 保存，未推送、未开PR、未部署。2026-10-06T23:49:24Z main仍为`0591e56`且开放PR为0，P1–P3保持等待。

`run_supplemental.py` 串行启动本任务PG、执行300秒idle与300秒mixed，finally停止自己的PG；已存在补充输出时拒绝重跑。`supplemental_probe.py`采用fixture epoch加monotonic实际经过时间推进发布/观察时钟（bar_batch内部received_at仍取系统wall clock，保留此限制）；完整published bar指纹含payload和行revision，可见元信息与updated_at分开比较。mixed向十身份各提交一个新分钟和一个同价观察，两个身份同时扩展历史；源M1字段独立构造预期payload。每500ms通过独立PG连接采样等待；不存在外部持锁者且短等待可能漏采，不能从零Lock样本宣称无锁争用。

```bash
python3 -u docs/verification/issue-13/run_supplemental.py
```

补充原始输出保存于 `results/supplemental/`，不覆盖原12份长测。单份补测不能替代三重复性能基线或高周期完整正确性证明；网络API、告警线程、供应商、网页/浏览器并发仍不在此探针范围。


`run_network_alert.py`在补充idle/mixed完成且容器已退出后运行；使用同project独立PG，probe映射Ubuntu `127.0.0.1:19614` 到真实Uvicorn。运行期含十个published收盘告警、实际发布循环与每秒alert step；网络客户端串行读取10身份×4周期×3次。关闭provider lifespan，无供应商采集/预热和通知投递；完成后probe移除、PG停止，地址不再在线。主机端实际检查受保护API返回401，认证请求在容器内TCP完成。完整网页/浏览器与全应用线程仍需另测。

```bash
python3 -u docs/verification/issue-13/run_network_alert.py
```

输出在`results/network-alert/result.json`，宿主采样`results/network-alert-host.jsonl`。进程输出先私有检查，不自动提交未脱敏异常。脚本拒绝覆盖现有输出；发生失败应保留并诊断，不自动重新reset数据库或重跑。该探针在开始输入前将按值导入的写入/聚合/发布now_ms统一为fixture epoch加实际经过时间，核验新源received_at和observed_at均不在消费者时钟之后。


补充验证均已实际结束并通过原始artifact审核：[时钟/快照/混合报告](supplemental-report.md)、[TCP/告警报告](network-alert-report.md)。网络API p95/p99=450.18/524.08ms；告警判断观测p95=1.657秒超目标，十个输入均可见且各一个signal。API SQL初次归因只含认证线程，数据路由线程未独立计数；脚本已修正而原结果未重写。PG再次核验停止为exited0，两个probe已移除；19614不再在线。合并前必要准备已收口；P0整合主线复测与P1–P3仍未完成。


## 真实产品网页并发补测

真实React网页与许可原生图表、完整API lifespan、真实publisher、单Chromium已在Ubuntu独立project实际运行并完成六步骤：M1空闲、M5切换、EURUSD切换、EURUSD/XAUUSD双图、Ctrl+S持久保存、刷新恢复两图。报告见[browser-report.md](browser-report.md)。约96.61秒短窗口、12个数据请求p95/p99=183ms、无pageerror。API/publisher仅在本任务internal网络，合成固定历史与stale收盘告警；不证明成功供应商I/O、持续新输入、三重复完整容量或核心优化达标。

实际运行过：Ubuntu `https://192.168.7.232:19615`（网页）及 `https://192.168.7.232:19616`（独立图表），自签验收证书。服务现已全部停止，浏览器已退出；PG exit0/无OOM，publisher由init转发TERM退出143。1.45CPU应用+浏览器配置上限，PG另0.75CPU/512MiB，实际采样及mount/project归属见报告原始证据。

准备和执行（只操作本任务）：

```bash
/home/quant/repos/market-watch/.venv/bin/python docs/verification/issue-13/prepare_browser.py
python3 -u docs/verification/issue-13/run_browser.py
python3 docs/verification/issue-13/summarize_browser.py
```

准备依赖已有本机npm模块、基础P0私有env、允许使用的本地charting_library和本机mw-docker。构建固定本机Node rootfs与专用Chromium依赖镜像，登记task `issue13-browser-baseline`；许可静态build仅在`/tmp/mw-issue13-browser-assets`，随机登录、hash、证书私钥在`/tmp/mw-issue13-browser-private`（目录0700/秘密0600）。已有私有配置不重置，已有结果不覆盖。初次启动配置失败逐份保留，不以失败或计划冒充通过。

单独启停已有服务（不reset数据）：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-issue13-browser-private/compose.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/browser.compose.yaml up -d postgres api publisher web chart-origin'
sg docker -c 'docker compose --env-file /tmp/mw-issue13-browser-private/compose.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/browser.compose.yaml stop api publisher web chart-origin postgres'
```

三层仍未合并。完整网页/双图短并发、连续观察时间到告警、高周期payload全量oracle、外部锁争用已补实际证据；可比重复基线、世代/迁移/回退等仍未完成。核心P1–P3继续按用户已定顺序等待整合主线。

## 外部品种持锁补测与证据校验

2026-10-07 00:39UTC已完成[外部品种锁争用](lock-contention-report.md)：独立PG事务持锁3.066秒，真实发布调用3.275秒、30个明确blocker样本；锁期间另一个身份的10行快照读取15.53ms。释放后原轮转恢复、26,290行完整bar与可见元信息稳定。人工锁不证明生产锁频率或新调度验收，原补充场景的零Lock样本限制仍保留。首次共享连接池失败独立归档；成功probe已移除、PG已停止。

执行：`python3 -u docs/verification/issue-13/run_lock_contention.py`。仅本任务服务全部停止时允许reset；拒绝覆盖已有证据，runner结束自动停止PG，单独启停见上文。连续新鲜度、高周期独立oracle和同口径消费者旧链路补测已见后文；尚待合并后的完整正确性、可比重复与迁移/回退。

证据校验：`python3 docs/verification/issue-13/audit_evidence.py`。路径始终相对证据目录解析，失败列出具体文件且不改写manifest。浏览器审核输出已按容器名排序；修复前不同PYTHONHASHSEED使统计值相同但JSON字节不同，修复后三种seed输出哈希相同。证据哈希通过不等于Issue #13完成。

## 独立高周期计算与图表/CSV/MCP/告警读取

2026-10-07 00:54UTC完成[高周期独立计算](high-period-report.md)：十身份×M30/W1/MN×原始/修订/同价观察/重复四阶段120案例，各阶段20,014行全量快照；图表data、CSV export、官方MCP SDK tools/call各152页真实认证ASGI请求一致，告警stored_rows120次一致。独立预期只用归档M15/D1和明确日历算术，不调用产品聚合或快照读取。最终20,014行PG实际快照另行只读归档；离线重算四阶段，并拒绝12种副本破坏。首次未改变高周期open的范围缺口已独立保存，增强首/末成员后才计作开盘价修订覆盖。

执行及离线审核（已有结果拒绝覆盖，重跑先明确归档）：

```bash
python3 -u docs/verification/issue-13/run_high_period.py
python3 docs/verification/issue-13/audit_high_period.py
python3 docs/verification/issue-13/summarize_high_period.py
```

runner只启动Ubuntu本任务PG和一个probe，finally定向停止。完成后启动PG，保存最终快照（不reset/写库）：

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml run --rm --name mw-issue13-p0-high-period-capture probe python docs/verification/issue-13/capture_high_period_final.py'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-local.env -p mw-issue13-p0 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/compose.yaml stop postgres'
```

审核要求最终快照已归档；runner成功不单独等于离线审核通过。两份探针均已移除，PG再次停止exit0/OOM=false，Ubuntu127.0.0.1:19613不再在线。此范围不包含M1生成高周期源、DST/节假日、覆盖撤回、并发世代、网络/MCP部署、evaluate/信号/通知或SLA；其余正确性和核心P1–P3按三层合并后的合同继续推进。

## 持续同价观察与告警新鲜度

330秒实测已完成并审核，见[观察新鲜度报告](observation-alert-report.md)：十身份五批50个同价新观察，50/50准确published marker、50/50准确告警sequence；十个告警在超过120秒观察年龄后stale，恢复输入后ready，最终源/发布/判断标记一致。价格、量、源price/volume revision均未改变，新增signal为0。提交→可见p95/p99=36.234/40.406秒，可见→判断观测p95/p99=1.840/2.400秒，均超冻结目标；功能链路通过不计性能验收通过。

```bash
python3 -u docs/verification/issue-13/run_observation_alert.py
python3 docs/verification/issue-13/audit_observation_alert.py
python3 docs/verification/issue-13/summarize_observation_alert.py
```

仅本任务无运行服务时允许reset；已有结果拒绝覆盖，重跑先明确归档。runner实际停止probe与PG（exit0/OOM=false），Ubuntu127.0.0.1:19613当前不在线；PG启停见上文。每批目标为10/55/100/235/280秒，时钟随实际monotonic推进，全部1187份PG状态记录保留；采样/池等待误差明确列出，不是精确commit-to-commit SLA。没有新分钟、供应商、API/lifespan/网络服务、浏览器或通知投递，不能替代完整容量或核心优化验收。

## 合并前准备收口

[逐项收口审计](premerge-closeout.md)记录已完成范围、性能红灯与P1–P4剩余关卡。固定Ubuntu probe中的五文件回归85 passed；宿主缺yfinance的失败明确保留，未修改共享环境。合并前必要准备已收口，不继续追加可选旧基线实验；P0整合主线复测和Issue #13仍未完成。三层合并后再整合main、同fixture复测及实施核心改造。当前本任务服务全部停止，卷保留；本地提交未推送、未部署。
