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

长测与数值门槛尚未完成；当前宿主 CPU 接近满载，时间样本标记竞争污染，不能用短测或 SQL 次数宣称 CPU 改善。完成汇总后在核心代码变动前冻结门槛，三层合并后再跑同样负载。

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
