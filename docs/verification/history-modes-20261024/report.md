# History modes 验证记录

历史记录至 2026-10-25 UTC。下文保留各阶段当时的结果，旧“待批准 / 未执行 / Eastmoney 受阻”不代表当前状态。2026-10-26 的替代来源、迁移恢复、最终检查和剩余限制见本文末尾追加记录及 [股票 qfq 验收报告](../equity-qfq-mwa-20261025/README.md)。不提交 PR、不合并、不发布生产。

基线：`7fc4fbb84e613e12e4540d7582ea78d137bfcdbd`。实际开发主机：Ubuntu `quant-server`。

工作树 `market-watch-history-modes-20261024`，分支 `feat/managed-history-modes-20261024`。Yahoo 复用现有 yfinance 读取与资源控制，不重新实现适配器。风险 F1：新增 schema、持久多周期原块及后台维护链，需要迁移兼容性及真实 PG 验证。

2026-10-24 开工资源只读检查：内存 15 GiB，available 7.2 GiB；磁盘剩余 29 GiB；swap 已使用约 3.7 GiB。提权与 Docker 可执行已验证。验收开始前须重新读取 Docker、端口及实时资源情况。

候选已整合到独立工作树 `market-watch-history-modes-integration-20261024`、分支 `integration/history-modes-mwa-20261024`，以当前图表 commit `4e5351cfd40b59914174119222e2f1786cba2abc` 为父基线（包含后端/网页 commit `3ac6f743f947a1ae33bcdf55bb15efa031a7f760`）。2026-10-24 11:20 UTC 只读核对：长期实例应用镜像实际 commit 为 `3ac6f743f947a1ae33bcdf55bb15efa031a7f760`（squeeze 会话），约两分钟前更新。当前 `main` 已包含于实施基线；实例另行更新的功能已纳入整合候选。更换前仍须确认实例未被再次换版并协调使用；已核对保留 `3e674dd752de366c334702b2673a4c1be9cd0443` 与 `59f07cddcab83b8753689809f150562ed7709b14` 对应修复。换版前重新核对唯一候选与实际实例。

## 本轮实际检查

| 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| 原生归档 + 请求证据 | 22 passed | 两个 test 文件完整执行，SQLite fixture；4 个 review 缺陷修复后由红转绿 |
| 创建 API + 原生回收 | 7 passed | 显式保存新增周期、冻结任务输入、跨数据集共享 checkpoint、固定指标图表引用 |
| 港股默认起点补充 | 6 passed | 创建 API 全文件；未验证港股不预设虚构的 2010 可用起点 |
| 图表周期专项 | 通过 | `node web/tests/history-mode-frames.cjs`：生产 datafeed 真实 frames、source_date、有效周期 fallback |
| 变更 Python Ruff | 通过 | 变更 backend/migrations 文件，含新增未跟踪文件 |
| 后端 local-only 全量 | 2279 passed、675 skipped | 724.67s；`/tmp/mw-history-modes-local-final.log`；PG 未执行，不算通过。收集后补充变更另跑 82 项通过 |
| CI 的 Node 命令 + 专项 | 57/57 通过 | `/tmp/mw-history-modes-node-ci-final.log`，包括新增周期专项 |
| 前端 build | 通过 | `/tmp/mw-history-modes-web-final.log`，仅既有 chunk 大小提示 |
| 真实 PG14.24 / 恢复 / 浏览器 | 未执行 | 未开始本任务验收 |
| 远程 CI | 未执行 | 未创建提交或 PR，本地同命令检查不冒充远程 CI |

之前全量 1884 passed、549 skipped、20 errors；20 个 error 为缺 `TEST_POSTGRES_URL` 的 fixture 环境错误，不能称全量通过。新的 local-only run 使用临时 plugin 明确列出 PG 未执行，不修改业务测试掩盖错误。

独立 Standards/Spec review 的 4 项发现已修复并复核关闭，见 [review-notes.md](review-notes.md)。

整合验证：170 项重点 Python 回归通过（包含 fixed/observed indicators）、63/63 项 Node 命令通过、前端 build 与变更 Python Ruff 通过。只发生两个已有文件的重叠（`bridge.js`、`fixed_indicators.py`），三方补丁均干净应用；原确认快照与预警 UI 提交仍是候选祖先。完整机器记录见 [local-checks.json](local-checks.json)。上述套件范围重叠，不累加通过数。

已准备 `web/tests/history-modes.browser.cjs` 与 `deploy/ubuntu/history-modes.acceptance.yaml`，分别通过 Node 语法和 Compose 静态检查；未实际运行。PG 专项现有 20 项全部因未启用验收 PG 跳过，仍是待验收项。

## A01–A17

“本地通过”仅指实际 fixture/命令，不代表真实 PG、live 或浏览器通过。

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| A01 旧 M1 升级兼容 | 本地已验证，PG 待执行 | 旧七字段 canonical bytes/key、迁移旧记录、原 FIELDS 审计 checksum；PG 旧表 shape 与原内容保持待执行 |
| A02 D1 不依赖 M1 | 本地通过，浏览器待执行 | D1/W1/MN 和固定 SMA 可读；请求仅 D1，无 M1 原块 |
| A03 日周月边界 | 本地通过 | 跨年稀疏 fixture、OHLCV、进行中与闭合；不造缺日柱 |
| A04 能力交集 | API 本地通过，浏览器待执行 | M3/M5/M15 只准 M5/M15；新增验证周期须显式保存才建 binding，已有任务输入冻结 |
| A05 独立范围 | 本地通过 | D1/M5 独立范围；早于顶层 frame 起点生效；显式补数精确区间；图表声明真实周期 |
| A06 滚窗与修订 | 本地通过 | 旧段保留、时间键去重；M5 第 3 根修订可发现；旧固定版本仍原值 |
| A07 部分失败 | 本地通过 | M5 超时保留 stale/旧 freshness；只重试失败周期；未到期失败周期继承仍 partial，active 正常清除 |
| A08 全失败/首次失败 | 本地通过 | 全失败不推进有效版本；无内容 unavailable；不造空产物成功，失败周期单独安排重试 |
| A09 恢复与 fencing | 本地通过，PG 待执行 | lease 接管、IO 中取消丢弃、分页 checkpoint、pause/resume；PG 并发另验 |
| A10 调度/配置编辑 | 本地通过，浏览器待执行 | 只取到期周期，进度不影响 configuration revision，旧编辑冲突；继承不再永久 deriving |
| A11 原生与派生周线 | 本地通过 | 原生 W1 保留供应商不同结果及 native provenance，D1 按 reducer 派生 |
| A12 远期复权修订 | fixture 通过，live 待执行 | none/qfq/hfq D1 全维护范围复查、旧快照不变；无真实远期复权事件证据 |
| A13 四市场真实来源 | 部分通过 | A 股 D1 6333；期货 D1 4266、M5 1023（1022 confirmed）；Yahoo AAPL D1/M5/W1/MN 成功；HK 仅最近两条通过，多年非法 OHLC 拒绝。分钟标签进一步来源对照待验 |
| A14 按需共享/限流 | 本地部分通过 | 同身份同窗口重复读取仅一次来源调用；SDK 子进程超时 TERM/KILL/reap；图表与维护部署并行待验 |
| A15 回收与引用 | 本地通过，PG 待执行 | 删除自身 checkpoint/产物，保留另一 pending frame 的共享 blob；固定指标图表保护版本，清短缓存后数值不变 |
| A16 非法观测隔离 | 本地与真实负例已验证 | 非正/非数 OHLC、负量、错代码拒绝；HK 原始 OHLC 失败不 round/clamp 修源；其他有效周期可发布 |
| A17 PG 隔离/成本 | 未执行 | PG14.24 独立 project/port/volume、真实迁移恢复、部署成本仍待批准后实际记录 |

## 真实来源观察

机器可读矩阵：[provider-capabilities.json](provider-capabilities.json)。原始时间、条数、标签样例位于同目录 `akshare-*.json`、`yahoo-development-probe.json`，只代表开发期特定品种/接口/口径/周期，不承诺永久留存或全市场能力。

港股 Sina 多年响应含非法 OHLC；其他候选与东财替代接口未通过。2026-10-22 起两条成功不能外推多年；seed 不标记 HK D1 verified，用户需要按选定起点显式 probe。

所有未执行项不得视为通过。验收主机、地址、启动/停止命令及真实资源使用在获准开始验收后据实补齐，不用 skip 或 HTTP 200 替代业务结果。

后来更新的图表修复：11:55 UTC 核对图表实际镜像 commit 为 `4e5351cfd40b59914174119222e2f1786cba2abc`。已纳入候选，独立执行 squeeze contract、history frame datafeed 与 JS syntax 均通过。整合 170 项 Python 与 63 项 Node 的完整结果来自此前 3ac6f743 基线；4e5351cf 仅增加这一图表修复及其专项测试，不把两次 scope 混写。

## 2026-10-24 NR4/NR7 实例更新整合

截至该段记录时验收授权仍未收到，尚未启动或更新实例。12:01 UTC 只读复核发现 API 与图表已由其他会话更新至 `8b7ee3eea8467866da89c0f3fc53989da5cc94e1`，网页仍为 3ac6f743。将该后续提交完整纳入本地候选，保留原有修复及 NR4/NR7；87 个本任务文件的差异保持独立。

新基线重点回归 **230 passed**（新增 NR4 与 provider indicator/snapshot 范围），**64/64 Node 命令通过**，前端 build、变更 Python Ruff、浏览器验收脚本语法检查通过。先前 2279/170 项结果保留各自 scope，不冒充新基线全量；PG 与部署业务浏览器在该时点仍未执行。

## 2026-10-25 `$mw-acceptance` 真实验收

用户已授权开始验收，目标为现有 `mwa`（Ubuntu `quant-server`，Compose project `mw-issue75-v2-20261018`）。候选实际运行身份：

- API/worker：`market-watch-api:history-modes-20261024`，迁移 head `ay52_history_modes`
- Web：`market-watch-web:history-modes-20261024`
- Chart：`market-watch-chart:history-modes-20261024`
- API readiness：`https://192.168.7.232:18280/readyz` 返回 200 / `status=ready`
- PostgreSQL 14：长期实例容器 healthy，未清库、未重置 seed、未替换 TLS、网关或浏览器现场

真实来源探针已单独完成并保存：AkShare `SHFE:RB0` 的 `M5` 为 1022 条闭合记录，`D1` 为 275 条闭合记录；Yahoo 继续复用既有 `yfinance`，本轮没有重新实现或替换适配器。

真实浏览器报告保存在本机私有验收目录：`/home/quant/repos/.mwa-history-modes-20261024/browser-futures-skip-probe/report.json`。结果为 `passed=true`：UI 创建 `SHFE:RB0` 原生多周期 `M5/D1`，任务状态完成，两个周期产物 freshness 为 `success`，请求数为 2 且无 M1 请求，M5 图表读取 100 根 bars。数据集 `5f440ae8fddd094eb6860913491561e450333683af2e1344bc5fa5f138dea6c3`，版本 `930cb6ad-1a3d-4018-89ab-8c7935feb307`。

本次浏览器脚本使用 `MW_HISTORY_MODES_SKIP_PROBE=1`，只跳过重复的上游探针；创建、后台任务、周期产物、请求证据和图表读取仍通过真实 API/UI 完成。此前未跳过探针的三次运行因 AkShare/长期实例连接池等待超时失败，不能作为功能失败结论，但已保留其报告。

### 收口边界与剩余卡点

- `SZSE:000001` 的 AkShare `stock_zh_a_hist` 在当前代理和直连均为 `ConnectionError`，所以 A 股 `D1/W1/MN` 派生场景没有真实上游证据；A13 仍标记为部分通过。
- 长期实例的其他图表后台流量仍会间歇触发 API `QueuePool limit of size 2 overflow 0`；重启候选 API 后本次期货验收已成功，但实例整体日志不能宣称无连接池异常。这是运行环境噪声/资源竞争卡点，不是本次 `SHFE:RB0` 任务失败。
- 结论：期货原生多周期验收可收口；若验收标准要求四市场全绿或实例零错误日志，则当前仍未完全收口，需要上游 A 股可用性和连接池资源窗口。


## 2026-10-26 当前集成验收（覆盖此前待执行状态）

用户已授权现有 mwa 验收，真实主机 Ubuntu quant-server，project `mw-issue75-v2-20261018`。现用工作树 `market-watch-equity-qfq-mwa-20261025`，分支 `integration/equity-qfq-mwa-20261025`，基线 `ba5407b218c0d5ffb5b946cb83bba4af67f3965e` 加任务差异。此后用户确认股票本期仅日线、不新增周月派生：通用 base_d1 / native_periods 引擎继续保留，股票新接入按该后续范围验证 D1。

先前 Eastmoney A 股受限没有靠重试掩盖：平台改接新浪 A/H 与腾讯 A 的独立 qfq 来源；自建仅新浪 A/H 和 Yahoo，保留 none 与同源复权依据，固定产物 qfq。旧 Eastmoney 数据身份与已发布内容保留。真实原始/复权独立复算见 [stored-evidence.json](../equity-qfq-mwa-20261025/stored-evidence.json)，供应商对照见 [sina-factor-live.json](../equity-qfq-mwa-20261025/sina-factor-live.json)。只代表所验标的/区间，不宣称全市场通过。

| 原计划 | 当前证据与范围 |
| --- | --- |
| A01 旧 M1 升级 | 真实独立 PG 的 `test_postgres_pre_modes_migration_keeps_m1_payload`：旧 chunk ID/内容/checksum 不变，补 M1、无新 frame run，重复升级及降级保护；已通过。 |
| A02 D1 无 M1 | PG 契约验证 D1/W1/MN 与固定指标无 M1；本期股票真实 UI 验新浪 A/H/Yahoo D1。新增股票周月展示按后续用户决定延期。 |
| A03 日周月边界 | PG 执行跨年/稀疏 fixture 与进行中、闭合、OHLCV 断言，通过。 |
| A04 能力交集 | 创建/归档 fixture 验证 M3 不开放；真实 bridge 专项验证 exact frames 与 fallback。修正 has_intraday/has_daily/has_weekly_and_monthly，不让图表库误推导未支持周期。 |
| A05 独立范围 | PG 原生多周期与 backfill 契约通过；既有期货真实 UI 的 M5/D1 起点分别保存。 |
| A06 滚窗与修订 | PG rolling-window、native update、raw/factor revision 契约通过，旧固定版本保持。 |
| A07 部分失败 | PG one-period timeout、partial retry 和 inherited failure 契约通过，保留旧有效周期并标 stale。 |
| A08 全失败 | PG first/all-failure 契约通过，不推进有效版本、不将无数据产物伪报成功。 |
| A09 恢复/fencing | PG 取消 IO、过期 owner、checkpoint 接管及 retry 契约通过。 |
| A10 调度/编辑 | PG only-due-frame 与 configuration revision 契约通过；设置 UI 已随原任务实现。 |
| A11 原生/派生 | PG native-period 独立来源契约故意返回不同 W1，与 reducer 输出区分，通过。 |
| A12 远期修订 | PG none/qfq/hfq 远期修订及同源 factor revision 契约通过；真实远期公司行动发生后的长期观察未执行，不冒充 live 事件证明。 |
| A13 四市场 | 新浪 A/H、期货 RB0、Yahoo AAPL 实源成功；端点/单位/时区/标签/精度记录见当前 capability matrix。RB0 M5 边界标签另有实源与交易所官网对照，通过；不外推所有合约/夜盘交易日。 |
| A14 共享/按需 | 平台真实重复读取相等；源缓存/限流/并发及维护由本地和真实 PG 契约验证。全源并发长期性能仍未通过；既有 pool2/overflow0 可产生 500，保留失败。 |
| A15 回收/引用 | PG reclaim 与固定指标/图表保护引用契约通过，清平台缓存不删除固定归档。 |
| A16 非法观测 | provider 和 PG 契约、港股真实负例通过：大幅非法 OHLC 拒绝。仅 v2 十万分之一 SDK 尾差规范为四位，保留原值与说明；旧 v1 不重解释。 |
| A17 隔离/成本 | task-owned PG14.24 与应用库实际恢复 103 表通过。真实股票请求耗时/条数在 live JSON；期货创建2次来源请求，M5图表100根。mwa沿用长期服务，测试PG独立，未触碰生产。 |

原期货浏览器证据脱敏副本：[futures-browser.json](futures-browser.json)。原期货 dataset/version 不重建；此记录是该次真实验收，不假称最新图表镜像重跑。最新实例镜像、前端75项、Compose5项、后端全量结果、独立复核和数据保留异常统一以 [当前报告](../equity-qfq-mwa-20261025/README.md) 及其最终 JSON 为准。

当前入口 <https://test.kookvv.com:8443>，图表 origin <https://chart-test.kookvv.com:8443>。管理命令：`python3 /home/quant/repos/.mwa-equity-qfq-20261025/operate.py status|start|stop|audit`（将末尾替换为单一子命令）。不运行旧计划的整栈启动命令去覆盖长期私有配置。原任务独立 PG Compose 已原样纳入仓库，当前不另启旧 project。长期实例和验收样本留存，备份/恢复、精确镜像与回退说明见当前报告。


### 最终验证结果补记（2026-10-26）

API r12 / Chart r10 / Web r1 已运行。平台四源 r11 原生图表通过；r12 唯一产品变化为自建 metadata SQL 复用，最终自建新浪 A/H/Yahoo 三图与日线详情在 r12 通过。腾讯共享采集忙改为等待及采用来源预算，真实 PG 回归通过。后端全量首轮3120通过、20失败、3跳过；修正后失败节点及新增回归为16通过、8失败，8项均在改动前基线复现。严格保留审计仍未通过（1工作区、3偏好变化，归因未知），不宣称整体收口。完整来源/镜像身份、测试、失败与保护证据见 [最终状态](../equity-qfq-mwa-20261025/acceptance-status.json) 和 [报告](../equity-qfq-mwa-20261025/README.md)。
