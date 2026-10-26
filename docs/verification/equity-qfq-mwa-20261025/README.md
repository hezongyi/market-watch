# 股票来源与 qfq：mwa 验收

当前交付：按用户最新确认的口径完成，原全量检查与严格逐行相等审计的失败保留为两项非阻断后续记录。决定及证据见 [交付口径](closure-decision.md)。下文按阶段保留历史状态，最终以本文末尾及最新状态JSON为准。

日期：2026-10-25～26。风险 F1：涉及不可变原始归档、复权依据、版本化计算产物和维护链路；沿用现有 schema，无新增迁移。最终状态以本文末尾收口记录及对应最终 JSON 为准。

## 行为与范围

平台行情：新浪 A 股、港股与腾讯 A 股直接请求供应商 qfq 日线；Yahoo 股票/ETF 沿用 yfinance `auto_adjust=True`。腾讯只提供平台入口。

自建行情：新浪 A/H 采集 none 与同源因子；Yahoo 使用 `auto_adjust=False`，保存同次上游响应的独立 Adj Close 依据。不可变版本保留原始数据，图表和固定计算产物使用本版本依据计算 qfq。新浪 A 股除以因子，港股乘以因子；Yahoo 乘以 Adj Close/Close，成交量保持来源口径。

未取得独立依据时保留 raw，明确产物不可用，不以 1 或其他来源因子代替。旧 Eastmoney 数据不改名，旧 v1 归档和产物不重解释。国内期货、FXCM 兼容行为有定向回归。本次未新增日线派生周/月线功能。

## 实际部署与来源

- 主机：Ubuntu `quant-server`，Docker Compose project `mw-issue75-v2-20261018`，逻辑实例 `mw-acceptance`。
- 主入口：<https://test.kookvv.com:8443>；图表：<https://chart-test.kookvv.com:8443>。
- 用户已明确同意验收，沿用长期实例并保留真实数据和私有配置；没有创建空库替代真实实例。
- 实施工作树 `/home/quant/repos/market-watch-equity-qfq-mwa-20261025`，分支 `integration/equity-qfq-mwa-20261025`，基线 `ba5407b218c0d5ffb5b946cb83bba4af67f3965e` 加本次工作树差异。原 history-modes 工作树保留。
- 构建使用 `mw-docker build`，task `mw-equity-qfq-20261025`，purpose `acceptance`。固定制品见 [candidate-images.json](candidate-images.json)，产品摘要见 [source-identity.json](source-identity.json)。基线提交不能单独代表构建源码；许可库不提交。
- 没有迁移、seed、清库、合并、远程推送或生产发布。未宣称远程 CI 已执行。

当前持久管理入口（只操作 13 个应用服务，PG/gateway 不替换）：

```bash
python3 /home/quant/repos/.mwa-equity-qfq-20261025/operate.py status
python3 /home/quant/repos/.mwa-equity-qfq-20261025/operate.py start
python3 /home/quant/repos/.mwa-equity-qfq-20261025/operate.py stop
python3 /home/quant/repos/.mwa-equity-qfq-20261025/operate.py audit
```

`stop` 是运维说明，任务结束后长期实例继续运行。私有目录为 0700，Compose 和备份不提交。整轮回退使用同目录 `rollback-compose.json`，仅对 `selected.json` 的 13 个服务执行 `up -d --no-deps --no-build --pull never`；不执行整栈 recreate、迁移或数据回滚。最终 manager 同步结果见收口记录；历史 rollback 保留。

## 验收矩阵

| 项目 | 证据与结论 |
| --- | --- |
| Q01 新浪 A raw/factor | 两个 A 股实源样本，2024 年以来各 2712 项 OHLC 对照；最大误差约 0.005，小于来源两位小数舍入容差。见 [sina-factor-live.json](sina-factor-live.json)。 |
| Q02 新浪 H raw/factor | 00700 实源 raw、qfq、factor 对照 2764 项 OHLC，最大误差 0.0000499991；归档 sentinel 与事件日期规则另有测试。 |
| Q03 缺失/冲突/修订 | provider/history/archive 测试覆盖缺失、冲突和依据修订；raw 留存、失败产物不会饿死后续维护；旧产物规则继续保持。 |
| Q04 腾讯平台 | 真接口 qfq、缓存重复请求相等；腾讯自建入口受能力约束。最终平台证据见收口记录。 |
| Q05 新浪平台 | 新浪 A/H 真接口 qfq、原生图表已渲染；来源身份与旧 Eastmoney 分离。 |
| Q06 Yahoo 平台 | 原平台 auto-adjust 路径、实际 AAPL 原生图表与重复读取验证。 |
| Q07 Yahoo 自建 | 实际创建 AAPL 数据集，706 行 raw 与独立 ratio 入库；652 行收盘与 qfq 不同。见 [stored-evidence.json](stored-evidence.json)。 |
| Q08 Yahoo 缺 basis | 测试直接模拟上游无独立 adjclose：丢弃 yfinance 自动伪补的 Adj Close，raw 可保留，qfq 明确不可用。 |
| Q09 版本/指标 | qfq-v2 内容身份；旧 v1 pending 继续 raw；不可变版本和固定指标/PG 契约回归。 |
| Q10 来源边界 | 腾讯仅平台、同源因子校验、旧 Eastmoney 与新浪期货兼容测试。 |
| Q11 UI | 真实数据中心创建 A/H/Yahoo；平台四源及自建三源原生图表、qfq 标签、日线报价最终复验见收口记录。没有拦截行情响应。 |
| Q12 部署/旧数据 | PostgreSQL 25 项通过；应用库备份实际恢复 103 表；配置、schema、PG/gateway 与保护浏览器保持。严格原有行审计未通过：1 个工作区及 3 条图表偏好变更，归因未知，无原行删除，详见保护段。 |

## 确定性检查

- 299 项后端定向回归通过，56.69 秒；25 条 Alembic 已有弃用提示。覆盖股票 provider、图表、历史模式、归档、source store、固定产物、创建、迁移兼容、FXCM、后台维护。见 [local-tests.log](local-tests.log)。此轮在最后报价补丁之前完成。
- 日线报价补丁后，124 项 AKShare/provider-chart 回归通过，7.74 秒。见 [daily-quote-tests.log](daily-quote-tests.log)。
- 独立 PostgreSQL 的 25 项契约测试通过，54.36 秒；与长期实例不同数据库。见 [postgres-tests.log](postgres-tests.log)。
- Ruff、`git diff --check`、Web 构建通过；`node web/tests/fxcm-series.cjs` 包含 AKShare 大写 hash 规范化回归并通过。API/Chart 镜像构建执行所需资产检查。
- 曾在重负载并发构建/浏览器期间出现已有 `completed.wait(1)` 时序测试失败；隔离重跑通过，后续完整 299 项通过。保留 [deadline-recheck.log](deadline-recheck.log)。
- `advanced-series.cjs` 旧 VM harness 在加载现有 bridge 时缺少 `document`，断言未执行；未将其计为通过。最终相关行为通过真实浏览器复验。
- 独立 Standards/Spec 复核及三项返工均已关闭，最后报价/session 小范围复核无阻断。见 [reviews.json](reviews.json)。

## 实际持久化检查

使用只读 [equity_stored_evidence.py](../../../scripts/acceptance/equity_stored_evidence.py) 逐行读取三个已发布版本的原始归档、依据与产物：

| 来源 | 原始行数 | qfq 收盘发生变化 | 依据 |
| --- | ---: | ---: | --- |
| 新浪 A / 000001 | 678 | 662 | `sina_qfq_factor` |
| 新浪 H / 00700 | 691 | 580 | `sina_qfq_factor` |
| Yahoo / AAPL | 706 | 652 | `yahoo_adj_close_ratio` |

每行 raw 保持 none；每项 OHLC 按版本依据复算，与 qfq 产物在 1e-20 内一致。港股 7 行保留原始 SDK OHLC 和精度规范化说明。具体 dataset/version ID 见 stored-evidence.json。

## 数据保护与恢复

实际应用库备份 `application-before.dump` 为 403397226 字节，SHA256 `da6b7dc792e66493ef15e9850a14d631f8245ff1420c1a0abe8dcbe604c995cc`。已在任务独立 PostgreSQL14.24 容器 `mw-equity-qfq-pg-20261025` 的 `application_restore` 数据库实际恢复，public schema 共 103 表，Alembic `ay52_history_modes`；恢复后核对工作区、告警、数据集、版本、chunk、artifact 行数。见 [backup-restore.json](backup-restore.json)。早先 default database 的 before.dump 不作为应用库备份证据。

严格保留审计 **未通过**，见 [runtime-audit.json](runtime-audit.json) 与 [preservation-diff-summary.json](preservation-diff-summary.json)。部署前 17 个工作区中一个旧任务工作区于 2026-10-25 13:56 UTC 从 FXCM USDOLLAR 日线切换至 BTCUSDT，revision16→17；30 条原图表偏好中 3 条（两个自选列表相关设置及 widgetbar.layout-settings）发生变化。尚未确认操作归因，已询问用户，保留当前现场；不恢复、不重置、不替换基线、不将差异列为豁免以制造通过。

没有发现原行删除。19 条原告警、原模板和 8 条原通知行保持；schema、全部有效服务配置、数据库/网关及保护浏览器身份保持。audit 检查逐行摘要、允许新增任务样本，但不宣称所有业务表或混合运行状态的 generic preferences 整表字节静止。验收浏览器使用独立 context、可信 TLS，脚本拦截既有工作区/偏好写入；这不能反向证明此前变化来自哪一会话。样本工作区和数据集真实创建并留存。

## 实源限制及验收中修正

- 验收是选定标的、2024 年以来窗口的现场证据，不等于全市场完整性或上游 SLA。港股更早的两个异常交易日存在真实非法 OHLC，仍拒绝；没有通过扩大容差伪造全历史成功。
- 港股 SDK 7 行十万分之一尾差，仅新 v2 来源允许规范到四位小数，并保留原值；超出范围的异常仍失败。旧 v1 来源不重解释。
- 平台覆盖区间保留毫秒截止，避免缓存重复下载；AKShare 图表和 Yahoo 归档采用匹配实源耗时的请求预算。
- 图表库会大写 ticker，新增新浪 hash 规范化；来源日期型日线使用图表可识别的展示 session，保留时段未核实标记。
- 日线源不建立分钟行情/报价订阅；报价读取最新 D1 和同源前一根日线，标记 `source_d1`，不是实时逐笔报价。
- 三浏览器并发曾导致现有小连接池超时；之后串行复验，不修改实例数据库资源配置。旧失败报告保留，不作为最终通过依据。
- 既有 FXCM 首次冷加载慢及全源并发性能不是本次股票接入的解决范围。

## 最终验证记录（整体未收口）

当前运行 API r12 / Chart r10 / Web r1。181 个部署后端模块与本地源码完全一致；Chart bridge 原文及实际 host bundle 包含关系校验通过。见 [部署后端](deployed-backend-source.json)、[部署图表](deployed-chart-source.json) 与 [来源摘要](source-identity.json)。长期 manager 已只同步 13 个应用镜像，全部非镜像配置、PG/gateway、保护浏览器及原 rollback 保留，见 [manager-sync.json](manager-sync.json)。

- 平台新浪 A/H、腾讯 A、Yahoo 四源真实原生图表全部通过：[platform-browser-r11/report.json](platform-browser-r11/report.json)。无脚本异常、无股票源分钟订阅；另记录既有 signals pending-count 500，不宣称实例零错误。r12 相对 r11 唯一产品变化为自建 metadata 查询复用，平台路径与腾讯修复保持一致；四平台未在 r12 重复运行。
- 最终 r12 自建新浪 A/H/Yahoo 三图及 Yahoo 数据中心日线详情通过：[managed-render-r12/report.json](managed-render-r12/report.json)。各图均标前复权，无脚本异常；另记录既有 chart-alerts 500。raw/依据/产物逐行复算继续使用 [stored-evidence.json](stored-evidence.json)，未重复创建原始样本。
- 腾讯原生后台加载曾把共享来源 AcquisitionBusy 当作终止失败，且 AKSHARE/TENCENT 沿用默认 8 秒预算。现共享采集忙保持 waiting、1 秒后重试、不加 stall，采用已有来源 30 秒预算，并保留绝对期限及 generation/lease/取消校验。先红 3 项，随后 141 项定向与 1 项真实 PG 回归通过；r11 腾讯实图独立通过，见 [腾讯实图](tencent-platform-r11/report.json)、[红例](native-busy-red.log)、[定向](native-busy-green.log)、[PG](native-busy-pg.log)。
- 自建 qfq metadata 曾额外增加一次 SQL；改为 timeframe/manifest 同次读取，恢复原分页预算，保留 qfq/raw 判定。34 项相关回归与 PG 失败节点重跑通过，没有放宽预算。
- 前端 CI 同命令 75/75 与 5 份 Compose 静态检查通过；未运行远程 CI。Compose 在私有目录用逐字一致的文件和 dummy env 验证，没有覆盖工作树 .env 或操作生产。最新变更 Python Ruff、8 项 JS 语法与 diff 检查通过。
- 后端全量首轮实际 **3120 passed、20 failed、3 skipped**，耗时 3655.08 秒。随后修正并重跑原失败节点及 4 项新增后台回归，实际 **16 passed、8 failed**：原 20 项中的 12 项已通过，新增 4 项通过。剩余 8 项在改动前基线、同一环境和独立 PostgreSQL 逐项复现，失败节点完全一致。它们为 5 项已有 RRS 缺口语义用例与 3 项过时目录替身用例。本轮没有干净的完整全量结果，没有把旧全量改写为 r12 全量通过。见 [完整机器结果](backend-final-checks.json)、[基线失败说明](baseline-failures.md) 及所链接原始日志。
- Standards/Spec 对共享采集等待、来源预算、metadata 查询复用及历史夹具修正均无阻断；最终证据限制作了明确披露，见 [reviews.json](reviews.json)。

本次股票来源与复权业务场景验证已完成，**整体仍未收口**：严格保留审计未通过，原 1 个工作区及 3 条偏好变化归因未确认；最新剩余 5 项 RRS 基线测试失败也未被隐去。没有原行删除，未恢复、重置或替换审计基线。当前现场、全部备份和回退配置保留。未创建 PR、推送、主干合并或发布生产，mwa 继续运行。


## 最新补验：目录夹具与原方案检查

上述16通过/8失败为首次重跑记录。之后仅修正目录测试替身接受现有关键字参数，保留原断言：SQLite与PostgreSQL两份目录测试 **11通过**，原失败节点与新增4项回归最新 **19通过、5失败**。剩余全部为原基线同样失败的RRS用例，尚未得到干净的后端全量结果。见 [最新检查结果](backend-final-checks.json) 与 [目录修正审查](reviews.json)。

原方案§9.2五个PostgreSQL文件单独执行 **62通过、0跳过**。实际恢复副本上，未修改旧版与当前代码读取同一旧M1版本的256原始行、100根图表数据一致；该证据不代表旧版支持新模式写入或完整可写回退。见 [原方案完成审计](plan-completion-audit.md) 与 [兼容边界](rollback-compatibility.md)。

网关日志调查找到了对应时间的保存请求，但缺少请求体与操作身份，仍不能确认1个工作区、3条偏好变化的归因。见 [调查范围与限制](preservation-write-window.json)。整体状态仍为未收口：原方案同时要求CI通过和不修改独立RRS任务，已请求用户确认是否将RRS修复纳入；严格保留审计差异保持原样。

本次补验只修改测试与文档，产品代码和运行r12/r10/r1镜像不变，没有重新部署。原始计划逐字保留，新的检查结果不覆盖历史失败记录。


## 用户确认后收口

用户明确回复“认可你的建议，执行”，同意接入按业务验收交付、RRS单独处理、工作区/偏好差异继续留证。本轮据此收口，原方案实施范围和A01—A17证据保留，详见 [交付决定](closure-decision.md) 和 [逐项审计](plan-completion-audit.md)。

已创建两个本地后续记录：[RRS稀疏历史](followups/rrs-native-sparse-history.md) 与 [现场差异归因](followups/workspace-preference-attribution.md)。RRS的5项失败未修复，后端全量未取得绿色；严格逐行相等audit仍false，1工作区及3偏好归因仍未知。它们按用户决定不再阻断接入交付，未删除红例、修改审计基线或覆盖现场数据。

最终只读核对638项源码/测试摘要匹配，mwa仍为API r12 / Chart r10 / Web r1，15服务运行、API/PG健康，配置与基础设施保持。此次仅更新交付记录，无重建、部署、数据恢复或清理。源平台与自建实图、原始数据/依据/qfq逐行对照、62项计划PG、75项前端命令及备份恢复证据均按原执行范围保留。

交付分支integration/equity-qfq-mwa-20261025，工作树/home/quant/repos/market-watch-equity-qfq-mwa-20261025。没有创建PR、推送、合并main或发布生产；长期实例和数据、私有备份、原回退材料保留。
