# Issue #13：v1.14.0 后实施进展

2026-10-07 23:14 SGT 后续：PR #21已提交；退役工具52项ops测试通过，10个本任务项目20个数据库749业务表实际恢复校验后，22容器/10卷/13网络全部退役；其他17容器ID/镜像/状态未变，共享镜像保留。应用175产品/迁移字节仍与r6一致。详见 [资源退役](resource-retirement.md)，未合并主线、未生产部署。

2026-10-07 22:27 SGT 终态：r6 `bcaefcf` 全后端 1389 passed/2 skipped、全部消费者与恢复/回退/覆盖通过，79 数值关卡全通过、missing 空；同价50/50/50与正常310/310/310，告警保守 p95 0.723/0.805秒。产品已整合 `63bad46`，175 产品及迁移文件与冻结源字节相等。Ubuntu 本任务全部服务已停止，保留证据卷；自动退役工具拒绝识别 digest 固定的 PG 镜像，未执行删除，作为基础设施后续记录。未推送、未生产部署。最终要求映射见 [r6收口记录](r6-closeout.md)，以下为历史检查点。

2026-10-07 22:05 SGT 最新：r5 全部分母完整，但同价/正常告警保守 p95 为 1.001389/1.018657 秒，超过 1 秒，未收口。已按授权冻结 r6 `bcaefcf`，共享 monitor 默认 1→0.75 秒，其他产品及迁移字节一致。Ubuntu 独立 project `mw-issue13-optimized-r6` 正在串行验收：完整后端 1389 passed/2 skipped，90 目标持续最长等待 4.769 秒，微测、300 秒混合输入 20/20、120 项高周期 oracle 已通过。同价 330 秒正在运行，正常 310 输入、TCP、浏览器及最终恢复/覆盖尚未完成。主工作树尚未整合 r6；未推送、未生产部署。预计 22:25–22:40 SGT，以全部关卡通过为前提。当前证据及适用性见 [r6 验收报告](optimized-r6-performance-report.md)。以下为历史检查点，不代表当前状态。

2026-10-07 20:02 SGT。实现候选，尚未完成 Issue #13。

两份深入方案已实施并冻结第五候选ccb2a12：保留r4固定origin优化，验收采样11→2SQL/轮、明确runnable队列20→5ms等待、原事务提交后跨进程PG唤醒及2秒兜底。生产与主要探针共用唤醒入口，历史/聚合完整片与进展保证保留，一秒monitor暂不改。32项小型集成通过；Ubuntu独立project `mw-issue13-optimized-r5`、PG127.0.0.1:19693已启动真实相关回归，其后完整回归/新12×300秒性能/全部消费者与浏览器自动串行执行。详见 [第五候选实施](r5-implementation.md)，原r4已停止、正常310/309失败证据归档。预计22:00–22:30 SGT完成剩余验收，以实测通过为前提，不宣称收口。

最新卡点与跟进：r3c完整micro evaluate p95/p99 399.7/466.2ms超过200/350ms；330秒同价认证上界p95 1.107秒超过1秒。正常输入310中309可见/判断，EURUSD一条同价marker在提交10.958秒后才获发布服务，已被下一输入覆盖；不能删分母或只改采样宣称修复。已停止r3c PG并保留原证据。8f67b80减少published热态告警固定起点之前的重复读取，保留合法前驱及修订指纹，36项相关SQLite通过；新冻结r4已在Ubuntu独立project `mw-issue13-optimized-r4`、PG127.0.0.1:19683启动相关回归，其后完整后端、同负载消费者/310输入、TCP/浏览器尚未运行。详见 [告警跟进](r3-alert-read-followup.md)。目标20:15–20:45 SGT以复验通过为前提；若仍缺marker或超阈值继续修复。

最新第三候选已实现两份专项方案。完整后端1371 passed/2 skipped、真实PG相关140 passed；实际进程崩溃恢复与旧应用接续通过。12×300秒性能样本与一致性审计完成：回填最长等待6.975–7.214秒、吞吐2712.81–2725.15 bars/s；空闲CPU0.275–0.309%、SQL1.543–1.544/s。产品/回归/测量源码173个backend及迁移文件逐字节一致。

原实时live-2/3在300秒窗口末尾仍有21/6个刚就绪目标，保留右删失分母，不能当作完整通过。补充300秒同场景输入后停流排空：live-2已完成，最长等待1.622秒、终态就绪与未发布输入均0；live-3正在运行。随后串行执行持续90目标、混合输入、独立高周期oracle、330秒同价/正常输入、120秒TCP及实际浏览器。告警p95≤1秒仍待实测，未声明全部达标。

当前环境Ubuntu quant-server，独立project `mw-issue13-optimized-r3c`，PG `127.0.0.1:19673`。浏览器计划地址 `https://192.168.7.232:19635`，尚未启动，不能当作在线交付地址。详细冻结、证据与局限见 [第三候选性能报告](optimized-r3-performance-report.md)。以下保留历史进展，历史候选通过不替代最终候选验收。未推送、未生产部署；目标19:15–20:00 SGT取决于剩余验收通过。

已整合 v1.14.0（ec00080），独立冻结基线 131bf3c 的 4 场景 × 3 次 × 300 秒已结束；12 个原始样本审计通过，本任务基线 PG 已正常停止。空闲平均 CPU 41.438% 单核、worker SQL 67.274/s，实时样本 p95 19.551–23.347 秒；修订 p95 24.080–24.456 秒。原始 P0 证据保留。期间 Ubuntu 其他任务及本任务逻辑回归负载由 host.jsonl 记录；这些是实际宿主条件，不当作生产指标或无竞争实验。

## 当前实现

- 持久请求/处理世代及原因，事务内触发；已完成目标等待、目标级重试、60 秒有界纳管与遗漏 bucket job 恢复。Instrument 先锁、状态后锁；被锁身份通过 SKIP LOCKED 跳过，避免拖住其他品种。
- 明确区分快照变化、任务消费、仍可运行及等待。worker 每次一个目标，忙时等待 0.02 秒、空闲 2 秒；不将检查当进展。新输入立即就绪，来源观察时间不控制任务到期时间。
- 按发布尾部、历史未复制页和精确修订窗口读取，计数增量维护；M30/W1/MN 依日历读取完整源成员，同时将源页预算控制在约 2000 行。
- 新观察时间进入脏桶和持久调度；同价 M1 以 observed 聚合任务刷新匹配的高周期。任务优先级 price > volume > observed，元信息传播使用来源成员的观察时间，拒绝配对不同价格及重复价格/量修订。
- an41 请求状态、ao42 覆盖投影均为 additive 迁移。覆盖原始表与审计保留；whole-minute 安全边界及旧 received_at 五秒余量不变。分批 checkpoint、运行时双写、错误记录隔离。普通发布 tick 到 verify 即结束迁移推进，继续兼容读取；最终锁内全量区间核对只能由明确维护入口 `coverage --verify` 执行。证明撤销 rebuild 是维护操作，在事务内撤回相交高周期 source/published 的 complete/volume_complete、增量计数和 revision，审计撤销范围，持久排队重算；原始 M1 保留。
- publication_admin 提供覆盖分页和回退前旧 bucket jobs 分页补建。应用回退保留新表与原始证据，不能同时运行两个版本的发布拥有者；schema downgrade 遇到 pending generation 拒绝执行。

## 已有验证

- 相关回归 95 passed；增加及修正触发/预算后相关回归 80 passed（51.80 秒）。这些覆盖 SQLite 快速逻辑与真实 PG 修订、成交量、迁移及并发。
- PG 世代/锁/回滚及覆盖合同 8 passed；实际 am40 → head → 被拒绝的 pending downgrade → am40 → head 1 passed。
- 同价 H1 传播及延迟 worker 不制造新鲜度用例先红后绿；遗漏请求恢复先红后绿。
- 保存的正式覆盖白名单快照在 Ubuntu 隔离 schema 重放：62,522 audit / 27,939 structured；两个身份各 92 页，约 8.9 秒。与此前独立兼容 union 完全一致，完成后 audit 查询为 0。原候选最终一次验证页最大约 1.8 秒。审查指出原实现在 tick 内执行且 examined 未计全量扫描；当前已改为显式维护入口、计入真实扫描记录数，普通 tick 禁止调用。最终 682818d 重放再次通过；explicit maintenance 最后一步 examined 记录真实原始证明数，常规页面仍有界。
- 第一轮边开发边跑的全量：1316 passed / 10 failed / 10 skipped，806.99 秒。旧 migration HEAD、源预算缩小后的分页次数假设、硬编码 .venv 路径及不完整 fixture 已修正；修正相关回归通过。冻结 6fc5896 全量已完成：1344 passed / 2 skipped / 65 warnings，768.75 秒。两项 skip 分别为缺可选日历依赖和匹配的 PG dump/restore 工具。审查后又修改核心实现，最终核心冻结 e529bb1 全量已完成：1352 passed / 2 skipped / 65 warnings（758.70 秒、exit0）。最终性能/验收冻结 682818d 与 e529bb1 的 backend/alerts 字节完全一致，后续只增加验收脚本。
- backend 与新增迁移 ruff 已通过；不涉及前端代码变更。

## 仍未完成的关卡

冻结候选完整后端回归、优化后 12 次 PG 长测及与冻结基线对比、10 身份 90 周期公平性、同价观察到告警、独立高周期 oracle/消费者对照、真实 API/浏览器并发、审查后候选应用回退接续复核、运行交付台账与最终证据审计。最终性能门槛保留 acceptance-thresholds.md，不因结果放宽。未推送、未生产部署。

## 当前实际环境与命令

Ubuntu quant-server Docker project `mw-issue13-optimized`，独立网络 `mw-issue13-optimized_default`、volume `mw-issue13-optimized_pgdata`、PG14 数据库/用户 `issue13`；PG 本机监听 `127.0.0.1:19633`。当前是数据库验证实例，尚未提供新网页/API 地址。私有 env 为 `/tmp/market-watch-issue13-optimized.env`（0600），不进仓库。

```bash
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized.env -p mw-issue13-optimized -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized.compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized.env -p mw-issue13-optimized -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized.compose.yaml stop postgres'
```

性能测量与浏览器、真实告警等重型验收串行，避免同库重置及互相争抢。只停止明确本任务实例；不在 unraid 建开发/验收环境。


## 收口审查修复（当前尚未冻结）

审查复现四个问题：停机后超单页追赶会清空请求并停住；移除证明后稀疏高周期完整性仍保留；聚合加载全队列且焦点新任务使旧任务饥饿；覆盖 verify 全量扫描在发布 tick 内运行。已分别补连续边界追赶、撤销传播/恢复排队、SQL 单候选选择与十秒老化服务、显式维护验证入口。新增针对这些业务不变量的 SQLite / PostgreSQL 验证；首轮 16 项通过，扩大回归 84 passed / 6 warnings（90.16 秒、exit0），含 PostgreSQL 撤销/恢复、超页追赶、聚合旧任务服务及实际 schema 迁移。前端 chart 构建缺少 series-picker 的 .dockerignore 白名单已修正，本任务 chart 镜像实际构建通过。当前未启动网页/API，682818d 冻结候选优化后 12×300 秒长测已启动。覆盖重放首次两个身份区间等价检查均通过，但输出 bind 目录被 Docker 自动创建为 root，保存报告失败；已仅修复明确本任务结果目录归属，保留失败日志后复测通过。旧二进制 131bf3c/v1.14.0 against additive 新表、新候选接续再次通过，独立证据见 results/reviewed-contracts。

维护覆盖命令（最终验证会扫描全部原始证明并持有身份锁，需维护窗口；不受 --limit 页大小约束）：

```bash
python -m alerts.publication_admin coverage --instrument EURUSD --limit 500 --until-complete --verify
```

不带 `--verify` 只执行有界页面，到 verify 返回 `maintenance_required`，不会忙循环。优化基线 warmup 在计时前执行维护验证并确认持久请求、聚合和修订队列已排空。性能数字门槛保持不变。

当前长测实际于 14:45:03 SGT 启动，预计约 65 分钟，启动时间与冻结源由 results/optimized-baseline/source.json 和 state.json 记录；当前不作为通过结论。完整 Issue13 收口仍以全部冻结门槛和消费者/浏览器实际结果为准，目标窗口 18:00–20:00 SGT。


15:03 SGT 首轮性能：idle-1 CPU 0.265% / SQL 1.046/s、无历史/审计读取；live-1 M1 p95 0.344 秒，但可运行最长等待 11.351 秒超 10 秒门槛、CPU 49.299% / SQL 497.598/s。原始轮次完整保留并继续 serial suite，不作为完成。live-1 XAUUSD M30 被选择 4648 次，源前缀存在但无法生成完整目标桶仍声明 runnable，固定观察时钟 served_at 同值放大饥饿。工作树已补“确实前移历史边界才继续页”和 served_at 同时钟递增的修复及用例；未跑、未冻结，不进入当前测量。

warmup 实际对照：90 目标的 start/end/count 与 26,290 published bars 全部相同，聚合/修订队列均为空。EURUSD/XAUUSD M30 新候选初始化为 true、revision 2，旧基线 false、revision 1；新候选计时前排空所有持久请求，不能宣称元数据全等。见 results/optimized/warmup-comparison.json。

15:07 SGT 工作树修复已通过两项 SQLite 逻辑用例（0.90 秒）：不完整旧源桶不会保持 runnable；固定时钟连续请求每轮公平遍历全部目标。该小测试在独立 mw-issue13-optimized-r2 probe 与原候选 revision-1 采样重叠，未创建第二 PG 或并跑重型回归，宿主证据仍记录竞争，不声明无争抢。真实 PG、全量及新长测仍未运行。新 r2 project/port19643/独立网络配置和 private env 已准备，未启动 PG。

15:29 SGT：当前候选完成8/12样本、运行idle-3。两次idle CPU约0.26%、SQL约1.046/s；两次live M1 p95约0.34s但最长等待11.35/11.44s失败；两次backfill吞吐2713.73/2717.31bars/s但最长等待136.82/146.55s失败；两次revision p95约0.42s、最长等待约0.66s。输入未发布0，不因可见延迟通过忽略公平性失败。599b043已冻结两项修复，独立r2 driver等待当前完整结束并确认原PG停止后串行PG相关回归、完整后端、12次新长测；不替换原证据。目标窗口当前更靠近19:00–20:00 SGT，结果不达标则继续修复。

16:49 SGT：用户明确要求实施两份专项方案。r3实现全局服务序号、失败隔离/到期等待、共享合作式预算与完整桶小片，以及生产/探针共用固定截止时间监控、逐条提交时刻和保守延迟区间。完整实现/验证范围见 [r3-implementation.md](r3-implementation.md)。相关SQLite87项及新增恢复/调度25项通过（有重叠），PG/全量/新性能未运行。r2完整1356 passed/2 skipped，首两回填公平22.794/28.924s仍失败。保持进行中原证据，新候选串行验证；19:00–20:00目标仍取决于实测达标。
