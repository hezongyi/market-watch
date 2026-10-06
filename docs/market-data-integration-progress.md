# 行情接入接续开发记录

日期：2026-10-06。工作区 `/home/quant/repos/market-watch-data-integration`，分支
`feat/market-data-integration`；`git fetch origin` 后基于 `origin/main` 的 `3c18f60` 创建。
主工作区与其他任务的未提交文件保持原样。正式方案由原文档 worktree 复制保留，原件仍在。

## 已恢复决策与当前边界

主历史采用 dukascopy-python；实时为 OANDA practice；首批 EURUSD/XAUUSD；外汇/黄金回测
只读单一 Dukascopy 数据集。MT4 在其活跃终端验收后才可参与互备。保留 Binance、yfinance 的既有能力。
最初完成 P0 首批代码及离线验证；下文最新 P2 章节记录当前实现与运行状态。

本会话范围更新：用户要求完全实现并真实验收；随后明确 **MT4 实时接入留到后续**。
当前目标为 P0–P2 全部实现与验收，P3 不列入本次完成门槛。下面初始 P0 记录保留作历史，
本节更新为最新状态。

## P1 与 P2 接续实现（2026-10-06）

- 新增 `dukascopy_history.DukascopyHistory`，锁定 SDK 4.0.1；复用其请求构造、JSONP 解码和
  行迭代，以独立 SDK 模块实例绑定传输。每次调用最多 5000 行、一个实际请求、明确 start/end；
  不调用无终点 fetch、不积累无界 DataFrame、不修改全局 requests/SDK。
- SDK 原始 `_stream` 的第二页空数组索引及隐式重试问题由有界传输停止处理；HTTP 失败直接返回
  结构化结果，不由 SDK 重试或转成空成功。Decimal 精确解码，UTC 半开裁剪，页检查点递增。
- `history_versions` 建立月窗口固定截止任务、持久检查点、带 token/到期验证的任务租约、退避及
  共享冷却。每个已提交页面与 managed M1 同事务写入 gzip 不可变分块；失败不推进 cursor。
  成功空页允许记录查询进度，但未知分钟写入分块，不认证观测覆盖或休市。
- 发布时验证分块连续查询分区与 SHA-256 内容清单；ORM 禁止删除/修改分块及已发布版本。
  新导入修订产生新版本，旧版本内容不变。`t21_history_snapshots` 迁移已有数据时拒绝破坏性降级。
- `/api/market-data/datasets|inventory|versions` 增加经过现有认证的查询/任务入口。
  `/api/replays` 支持来源限定品种，显式数据集必须指定已发布 `dataset_version`；历史聚合、
  warmup、前日数据均从所选版本读取，seek 保留版本及 manifest；`u22_replay_dataset_version`
  增加来源信息，已有 pinned replay 时拒绝丢弃 manifest 的降级。仍需前端提供版本选择界面。
- `OandaPractice` 使用独立 REST/stream 客户端。账户范围 BID/smooth=false/complete M1，
  五秒收盘保护，严格数据窗口与账户指纹校验；NDJSON 增量 UTF-8 解码支持跨 chunk、多行、
  单侧无流动性、心跳及大小上限，不使用 stream 消息数当 volume。
- 修复 `market_resources.acquire` 对非 Yahoo 来源没有执行已写入 cooldown 的问题；
  所有来源/通道现均在冷却期拒绝新请求，历史任务与实时请求仍共享既有预算。
- 最近全量后端回归 573 passed、39 skipped；随后新增 SDK 预算超时和 replay 迁移保护，
  对应定向回归 20 passed。两个新增迁移均为单头；Ruff、diff 空白检查及 Compose 静态解析通过。

## 本轮真实只读探测证据

这些是 Ubuntu 本机有限只读 SDK/API 探测，没有启动开发服务、Docker 实例、通知或交易。
脚本复用后端配置，仅输出公共行情与品种规格，不复制/提交 `.env`、账号标识、token 或代理地址。

- [Dukascopy 两品种采样](verification/data-integration/dukascopy-samples.json)：EURUSD/XAUUSD
  分别查询近月、2016 年、跨年、DST 周四个 15 分钟窗口。六个窗口各 15 根；两个跨年窗口
  成功空页，保持 unknown。实际非零价格位数为 EURUSD 5、XAUUSD 3；原始 JSON 有六位尾零。
  这证明选定 SDK 与这几段真实数据可用，不证明十年完整性、来源全部日历或全量吞吐。
- [OANDA practice 探测](verification/data-integration/oanda-stream-probe.json)：实际账户目录有
  EUR_USD/XAU_USD，displayPrecision 分别 5/3；账户范围 candles 各返回 5 根完整 M1。
  一条共享 stream 75.045 秒返回 EURUSD 32、XAUUSD 169 个价格、14 次心跳，两品种 tradeable。
  来源到接收价龄 p50/p95/p99 为 EURUSD 269/538/581ms、XAUUSD 231/393/436ms。
  尚未校准独立时钟误差，不将该短样本称为 SLA、两交易日或 M1 收盘延迟验收。

## P2 实现与 Ubuntu 容器验收（最新状态）

- `live_pricing` 与 `oanda_worker` 已实现账户级共享 stream、跨进程拥有者租约、连接世代 fencing、
  常驻与监控/浏览器需求并集、独立 REST 确认与租约续期线程、恢复预热与过期信号抑制。
  断线只降级与暂停，MT4 未参与。本次新增 `v23_live_pricing`；显式数据集不会走旧采集入口。
- 账户目录未采集品种不显示故障；订阅需求过期的非驻留品种退出采集；单侧缺失或倒挂报价不报告 tick 就绪。
- 每个已观测分钟持久记录确认请求、失败、缺失/未知分母；报价价龄使用 10ms 分桶直方图，
  同时保留更新次数与最大到达间隔。历史预热与实时确认延迟分开，时钟偏差尚未校准。
- 新页面 `/market-data` 展示来源、practice 环境、Bid/Ask、临时与确认柱、恢复及监控就绪状态，
  支持同源预警和历史版本任务；浏览器通过 SSE 消费快照，不创建上游 stream。
  演练可选择已发布不可变版本；图表工作区目录与保存允许来源限定身份，不改写旧系列。
- Docker 组权限现已可用，通过新的组会话 `sg docker` 访问 Ubuntu 本机 Docker。
  项目 `market-watch-data-integration` 的 PostgreSQL、API、web、OANDA/history/aggregation worker
  已实际启动。PostgreSQL 17 镜像拉取超时后改用本机已有 **14.24 / postgres:14-bookworm**。
  独立网络/volume/数据库，网页仅绑定 `127.0.0.1:16589`；没有改动其他实例或 unraid。
- 已在 r19 前置结构完成 `pg_dump -Fc` 与独立 `integration_restore` 数据库恢复，再升级至 head。
  [备份恢复记录](verification/data-integration/backup-restore-baseline.txt)仅证明本隔离库的结构恢复，
  不证明生产存量或生产备份已清点。
- PostgreSQL 容器定向测试 **116 passed**，包含真实竞争拥有者/旧世代 fencing、身份迁移及快照回放。
  [测试记录](verification/data-integration/postgres-tests-p2.txt)。本地全量回归为 **592 passed、40 skipped**，
  [全量记录](verification/data-integration/backend-tests-p2.txt)。前端生产构建通过。
- 两个小时样本版本分别发布 60 根 M1、0 未观测分钟；两个固定十年区间
  `2016-10-06T00:00Z` 至 `2026-10-06T00:00Z` 已启动后台导入，尚未完成。
  [任务身份](verification/data-integration/history-import-seed.json)。任务有持久检查点、重试和公平轮转。
- 实际 OANDA 双品种采集及 REST 确认已运行；30 秒暂停后两品种降级，13.2 秒恢复，
  2 分钟暂停后约 14.3 秒恢复，进程重启约 36.6 秒恢复。见 [30秒](verification/data-integration/fault-pause-30s.json)、
  [2分钟](verification/data-integration/fault-pause-120s.json)、
  [进程重启](verification/data-integration/fault-restart.json)。暂停的是本任务 worker，未操纵生产网络。
- 浏览器实测包含桌面/390px 手机、三个浏览器并发、不可变历史版本选择和真实回放入口。
  首次截图发现浏览器需求 client 超出 40 字符，已缩短并增加错误断言；复测通过。
  [浏览器结果](verification/data-integration/browser-acceptance.json)还验证断网重连、三品种共享采集、
  实际创建/取消同源监控并随真实 M1 推进，固定版本演练推进一根，
  现有图表工作区使用来源限定身份读取真实 M1，续期共享订阅。
  [桌面截图](verification/data-integration/market-data-desktop.png)、[手机截图](verification/data-integration/market-data-mobile.png)。

## 当前尚未完成的验收门槛

- 十年导入仍在运行；最终 manifest、缺口/休市归因、跨年/DST/精度全量报告尚待形成。
- 两交易日持续实测尚未达到，不能把短样本价龄当成 SLA。接收机 NTP 状态已采样：offset +1.699ms、root distance 22.2ms、jitter 10.491ms；
  [时钟记录](verification/data-integration/receiver-clock-sync.txt)不证明供应商时钟偏差。
  十品种短负载、401/429、单品种停更和本地 signal/notification/outbox 已通过（见下节），
  仍需两交易日持续分段记录与预警计算观测；不将关闭的外部投递称为实际送达。
- OANDA/Dukascopy 的候选 NY17 日历尚未获得账户产品与历史区间的完整核实，UI 保持“待核实”。
  生产存量只读清点与已有生产备份在 Ubuntu 隔离恢复已完成，见下节；没有迁移或部署生产。
- MT4 按用户指令留待后续；本次完成门槛为 P0–P2，目标仍 active，尚不能宣称全体验收通过。

## 继续验收与修正（2026-10-06 02:30 UTC 起）

- 增加在真实 Ubuntu Compose/PostgreSQL 上运行的本地响应故障接缝；不会向供应商发送错误凭据或
  故意触发限流。401 保持配置故障 20.324 秒，无自动重连，认证 `/retry` 后恢复；429 实际 REST
  请求间隔 20.062 秒，遵守注入的 Retry-After。故障与真实上游请求分别记录。
  [401](verification/data-integration/fault-unauthorized.json)、
  [429](verification/data-integration/fault-rate_limited.json)。最初 429 工具把注入前的恢复重连也纳入
  “不应重连”断言，记录在 [初次工具结果](verification/data-integration/fault-rate_limited-initial-harness-result.json)；
  修正断言范围后重新运行，没有删除原始失败。
- 过滤真实 EURUSD 报价 40 秒，XAUUSD 与心跳继续。EURUSD 为 stale、quote_ready=false，XAUUSD
  仍 healthy，真实 REST M1 继续确认。恢复首个真实报价前人为设置跨阈值旧判断前态，采集器正确
  清空并重新建立前态，没有假信号；共享 stream 世代未改变。
  [单品种故障](verification/data-integration/fault-single_symbol.json)。
- 日历一手资料核对发现：OANDA SG 外汇通常 17:05–16:59、黄金 18:05–16:59 纽约时间；Dukascopy
  当前 JForex 表支持 NY17 与黄金一小时暂停。当前 practice 账户 division 和十年 Python feed
  历史例外仍未证明，不把候选身份改写为已验证。保留合法边界柱，不从公告时刻粗暴裁剪。
  [研究与适用边界](verification/data-integration/source-calendar-research.md)。已向用户询问账户法律实体/地区，
  不索取账号或凭据；该信息缺失不阻碍其他验收工作。
- 回归复现并修复单次 nontradeable 报价被泛化成整分钟闭市的问题；空 REST 不再借此让恢复提前就绪。
  倒挂 Bid/Ask 同样中断 tick 判断连续性，下一条有效报价先建立新前态。
- M1 `confirmed_at` 改为 ingestion flush 完成时刻；新增独立写入/预警计算完成与处理耗时审计。
  该时刻不包含最终数据库 commit 或外部通知投递。小样本 p95/p99 改用 nearest-rank，避免漏报
  最慢一次确认。新增真实 Chromium SSE 分桶记录接收到浏览器、源到浏览器延迟及全部异常状态。
- 真实 XAUUSD 报价触发规则，signal、local notification 已生成，继续采集 10 秒只有一个信号；
  来源到 signal 创建为 561ms，通知保持 pending，外部投递关闭。
  [本地通知链路](verification/data-integration/live-signal-runtime.json)。该单样本不代表 SLA 或手机送达。
- unraid 只读清点确认实际存量 EURUSD/XAUUSD 来源均为 OANDA，BTCUSDT 为 Binance，revision r19。
  不自动映射账户范围或将旧系列改成 Dukascopy。
  [生产清点](verification/data-integration/production-legacy-inventory.json)。已有生产备份通过 SHA256 后
  复制到 Ubuntu 独立 PG14 临时库恢复，36 张表/820768 根柱及全部表计数匹配，临时库已清理。
  [恢复证据](verification/data-integration/production-backup-ubuntu-restore.json)。生产服务及数据库没有修改。
- 在相同数据集上重新调用真实 Dukascopy 导入产生新小时版本，原版本及 4 个已有 replay 的柱、
  warmup、day context、manifest 组合 SHA256 保持相同。
  [版本固定证据](verification/data-integration/replay-real-reimport.json)。已发布样本逐块校验通过：
  [内容完整性](verification/data-integration/history-sample-integrity.json)。
- 最终代码全量回归 **596 passed、40 skipped**，最新定向 **20 passed**，PostgreSQL 容器回归
  **120 passed**；API/OANDA worker 实际加载模块 SHA256 与 worktree 相同。
  [最终全量](verification/data-integration/backend-tests-timing-final.txt)、
  [最新定向](verification/data-integration/live-tests-timing-final.txt)、
  [PostgreSQL](verification/data-integration/postgres-tests-timing.txt)、
  [容器代码核对](verification/data-integration/container-timing-code.json)。
- 十品种共享连接负载已重新验收通过。十品种每个 5 个已知应有的完成分钟，共 50 个全部确认，
  missing/failed/late-over-30s 均为 0；nearest-rank p95/p99 最慢为 EURUSD 13.399 秒。
  全窗口共享 epoch40，历史导入并行运行；部分低频报价出现 stale，完整状态保留，没有隐藏。
  [完整容量窗口](verification/data-integration/load-ten-symbols.json)。首次被本轮 API 镜像更新期间的短暂 502 中断，原始结果保留在
  [中断窗口](verification/data-integration/load-ten-symbols-api-deployment-interrupted.json)。
  容量结果只采用完整无部署干扰的重新测量窗口；它不替代两个交易日观测。
- Chromium 短工具验证包含故障、扩品种与本轮 API 部署，
  [汇总](verification/data-integration/browser-timing-tool-validation.json)完整保留错误与不健康状态。
  工具首次遇到目录新增品种的空 quote 时产生 NaN 分桶，修复为明确统计未报价快照；旧 NaN
  在汇总中列为 invalid_samples，不用于延迟百分位。正式持续观察使用修正后的工具。

十年导入在 02:56 UTC 左右达到 EURUSD 60.55%、XAUUSD 58.44%；尚未完成。新的长观察窗口需在
本轮部署与故障结束后明确保存起点、代码版本与浏览器进程状态，不能回填为过去已发生的持续验收。

### 已启动的持续观察

最后修复已提交为 `1af4b5d`，实际 API 与常规采集 worker 已部署该模块。负载临时需求自然到期后
两品种恢复 healthy、epoch43。真实 Chromium 用户 service 已于 **2026-10-06 03:06:00.756 UTC**
启动，计划观察至 **2026-10-08 03:06:00.756 UTC**；没有开机启用或自动重启。
[窗口起点与代码摘要](verification/data-integration/sustained-observation-window.json) 保存 backend/observer
SHA256，M1 统计从下一完整分钟 `03:07 UTC` 开始；接收到浏览器记录从实际启动起计。
首个观测块已真实写出，没有 SSE 错误，不能据此声称两日验收已通过。

Ubuntu 接收机重新读取 systemd NTP：offset −12.298ms、root distance 22.155ms、jitter 8.720ms，
[窗口时钟状态](verification/data-integration/receiver-clock-sync-window.txt)；供应商时钟误差仍未独立证明。
浏览器/API 共用主机时钟，记录范围区别于源到接收的时钟误差。
十年任务在 03:06 UTC 左右推进到 EURUSD 70.27%、XAUUSD 68.84%，仍保留检查点继续运行。
目标保持 active；日历账户归属待用户说明，未知与故障分母继续保留。

## 来源会话与十年精度修正（2026-10-06 03:25 UTC 起）

- 来源会话单独绑定 provider/channel/environment/account/product、IANA 时区和有限复核日期。
  候选 NY17 只保留聚合相位，不能认证周末或黄金暂停为闭市。真实 M1 冲突仍保留、记录 audit，
  冲突会话不能减少该桶缺失分母。profile/precision 不在既有身份原位修改；见 ADR0002 和 runbook。
- 真实十年 EURUSD 页面有 57 条非零六位价格，原五位推断只覆盖采样范围。
  [精度证据](verification/data-integration/dukascopy-eurusd-six-decimal-page.json)。父任务隔离，
  新 `ny17-observed-v2` 六位身份复用原始 685 chunks / 2,986,089 M1，从原 cursor 继续。
  [实际派生](verification/data-integration/history-precision-derivation.json)保留 parent/checksum，
  无取整、无 staging 复制、无重复下载前缀；观测 coverage 已幂等补齐，见 [覆盖修复](verification/data-integration/history-derivation-coverage.json)。
- XAUUSD 十年已发布。逐块 checksum/UTC 顺序/重复/OHLC/三位精度/unknown 全 partition 审计通过，
  814 chunks、3,540,725 observed / 1,718,155 unknown。
  [全量审计](verification/data-integration/history-ten-year-integrity.json)。unknown 不是已核实闭市。
- history graceful/crash 证据已保存；新增精度异常明确 `price_precision_overflow`，暂停为配置故障，
  不继续普通网络重试。原五位任务及已发布小时快照保持原样。
- 全量后端 **612 passed / 48 skipped**，其中新 PostgreSQL 文件在本地跳过；实际 Compose suite
  **144 passed**，新增来源会话容器 **20 passed**，批量撤销的实际 PostgreSQL **8 passed**；
  最后来源/图表/历史定向 **27 passed**。最后一处黄金 W1/MN 改为使用显式来源会话，无旧黄金
  closure 的额外前提，由定向及容器检查覆盖。
- API/OANDA 新镜像已加载 worktree live module，
  [代码核对](verification/data-integration/container-calendar-code.json)。epoch49 双品种 healthy
  已实际观察。原 Chromium PID1670521 未重启；部署开始/恢复事件写入长窗口，全部 SSE 错误保留。
  [当前浏览器摘要](verification/data-integration/browser-sustained-checkpoint.json)不是两交易日最终结果。
- 旧候选聚合完整性正在有界逐页核对与撤销，保留 M1 原值及 immutable history/replay 输入；
  未完成前不声称所有存量已重算。真实账户 source_session 仍未启用，法律实体/地区与历史例外
  尚无充分适用证据。
- [逐项 completion audit](verification/data-integration/completion-audit.md)明确完成和剩余门槛。
  两日窗口未达到时长，EUR 十年最终版本和长期时效仍待审计；目标保持 active。

### 持续观察工具部署故障修复

原 03:06 窗口部署 API 后，上游行情恢复，但独立观察工具 EventSource 收到 HTTP 502 后
进入 CLOSED，没有自动重连，产生零心跳/零样本块。产品页面原已有 watchdog；本次补齐观察
工具的 15s 心跳超时重连。[真实 Chromium 502 接缝](verification/data-integration/observer-reconnect.json)
修复前 calls1/beats0/CLOSED，修复后重新连接并收到 heartbeat。
旧窗口及失败/空白记录全部保留，见
[中断窗口](verification/data-integration/sustained-observation-window-interrupted.json)。
用户 service 已停止旧进程并启动新的 **PID2127966**；新完整窗口
**2026-10-06 03:50:58.841 UTC → 2026-10-08 03:50:58.841 UTC**，
M1 since **1791258660000**。按明确 since 统计新窗口，原 JSONL 不删除。
当前尚不能宣称两交易日已通过，目标保持 active。

## 十年最终内容与长期验收工具（2026-10-06 04:00 UTC 起）

- 两品种十年固定区间已全部发布并真实逐块校验：EURUSD **3,724,278 observed /
  1,534,602 unknown /859 chunks**；XAUUSD **3,540,725 observed /1,718,155 unknown /814 chunks**。
  [最终审计](verification/data-integration/history-ten-year-integrity.json)额外检查 manifest chunk 索引、
  完成时间与 volume 非负；EUR 原 685 chunks/2,986,089 M1 和派生前缀逐块原值一致。
  整体 unknown 不借来源日历重分类成确定闭市。
- [旧候选聚合](verification/data-integration/calendar-revalidation.json)核对结束：520,262 个完整标记，
  撤销 116 个 XAUUSD 缺观测依据的标记；M1、immutable history/replay 不变。
- 真实认证 API 已验证 EUR 十年版本回放、seek 和实际同源十分钟再导入，前后 replay/manifest
  保持一致；XAU 对应验证亦通过（约284万根预热/439.491s），见
  [十年回放](verification/data-integration/ten-year-replays.json)。约 299 万根 EUR 历史预热创建耗时 **410.863s**，
  这是同步全历史预热的使用限制，不能用小时样本声称十年回放立即可用。
- 24h 默认登录期限短于 48h 长观察；工具新增每12h真实重新登录/页面重连，记录每次续期。
  [实际2min工具验证](verification/data-integration/observer-auth-renewal.json)续期后55个心跳、errors0。
  03:50窗口主动结束，旧记录全部保留；最终工具 **PID2266365** 的窗口为
  **2026-10-06 04:04:14.900 UTC → 2026-10-08 04:04:14.900 UTC**，M1 since **1791259500000**。
  systemd KillMode=mixed 使停止时先只通知父进程，避免提前关闭 Chromium 子进程。
- 两品种持续 M1 验收规则于04:08UTC通过真实API建立，首次 last_event 已推进至04:09，
  无signal。[规则起点](verification/data-integration/sustained-m1-watches-start.json)保留armed_at，
  不能把此前无规则的 ingestion时刻包装为已执行预警计算。规则仅属Ubuntu验收，外部投递关闭。
- 两活跃交易日、实际maintenance/recovery及实际来源会话适用性仍未完成；目标保持active。

两品种十年 API 验收最后均通过；[真实浏览器](verification/data-integration/ten-year-browser.json)
也确认版本选择、恢复已保存回放、501根可见柱和未来隐藏，无页面异常。工具最初对“品种”标签
使用 exact 匹配而失败；实际 DOM 品种和版本值正确，改为正常标签匹配后通过。
当前长期观察与 M1 规则仍运行，所有实际状态包括 stale/unknown 都保留。

## 基线审计与实现

- 原方案引用 v1.7.0；新基线增加了平台原生历史缓存、后台任务、指标契约，managed M1 的来源字段
  及入库结构仍适用。平台缓存已有独立 `ProviderDataset`，本次不重算其键或迁移其缓存。
- 旧 `Instrument.id` 同时关联 K 线、覆盖、维护任务、预警、回放和图表引用；不能把旧 EURUSD
  改成 Python/OANDA 的新含义。新增 `market_datasets` 一对一绑定新 Instrument，旧数据没有自动映射。
- 新身份包含 source/channel/environment/account_scope/provider_symbol/basis/calendar_version。
  账户范围仅允许 public 或 SHA-256 指纹；`MD:<身份摘要>:<逻辑品种>` 保留现有图表 ID 长度约束。
- 注册默认 disabled；同名不同来源分别存储。完整身份、精度和 volume 语义入库前校验；绑定后禁止
  ORM 修改或删除身份及关键品种元数据。此保护不替代数据库管理员对直接 SQL 的控制。
- `CandleBatch` 为 UTC 毫秒半开有界窗口，价格/量用十进制字符串，拒绝重复、逆序、范围外、
  非有限值、无效包络和精度溢出。空返回不生成覆盖；临时柱不生成已确认分钟覆盖。
- 请求结果区分 data/empty_success/rate_limited/unauthorized/timeout/unavailable/invalid_payload；
  陈旧价格仍可属于成功请求。错误分类保留 Retry-After，安全错误不输出 URL/响应正文。
  这些契约供下一阶段 Adapter 使用，尚未替换所有旧采集入口的错误行为。
- 增加 Quote/Health/SourceSelection 契约；当前没有流拥有者、健康调度或自动切源运行逻辑。
- 黄金日历判断使用逻辑显示品种，覆盖来源限定的 ID、聚合、图表及回放。沿用现有日历规则不等于
  已证明 Dukascopy/OANDA 官方会话；正式导入前仍须验证具体来源日历。
- 显式 managed 数据集不能通过 MWP 变成平台原生别名。P1/P2 接入前不将新数据集开放为自动维护目录。

## 迁移与回滚

`s20_market_datasets` 是单头的增量迁移，前置为 `r19_native_history_loads`；不修改旧 Instrument/Bar。
旧数据清点使用 `market_datasets.legacy_inventory(db)`，只输出来源元数据、数量与映射状态，
不读取价格、账户标识或凭据。当前仅清点测试数据库；实际部署存量尚未审计，不能推断其来源。

验收库须先验证迁移前备份可恢复，再应用迁移。空映射可以 `alembic downgrade r19_native_history_loads`；
已有显式映射时降级主动拒绝删除身份，必须停写并恢复本实例的迁移前备份。
不得以删除绑定、修改旧 source 或继续启动旧 Adapter 来绕过保护；新版本日历也应注册为新身份。

## 初始 P0 验证记录（历史）

- 实际主机：Ubuntu 22.04.5 LTS。本 worktree 新建 `.venv`，按 `requirements.lock` 安装依赖；
  测试使用 `PYTHONPATH=backend`，不从其他工作区导入业务代码。旧主工作区 venv 缺 yfinance 的初次
  回归失败已通过独立依赖环境解决。
- 最终全量后端回归：544 passed，39 skipped，1 个现有 Starlette 弃用提示；跳过项目包括 PostgreSQL/
  需额外环境的验证。契约及身份定向回归：67 passed，新增 PostgreSQL 验收用例 1 skipped。
  无凭据证据见 [全量回归](verification/data-integration/backend-tests.txt) 和
  [契约回归](verification/data-integration/contracts-tests.txt)。
- 所有变更 Python 文件 Ruff 通过，`git diff --check` 通过，`alembic heads` 为 `s20_market_datasets`。
- SQLite 验证两次迁移升降、保留旧历史、已有映射拒绝降级；不等于 PostgreSQL 运行验收。
- Ubuntu Docker socket 实际返回 `permission denied`；当前策略不允许申请提权，已请求用户配置本机
  权限。没有启动容器、运行迁移到服务数据库或连接 OANDA 账户；没有服务访问地址。

## 初始 P0 验收准备（已由上文运行记录取代）

[Compose](verification/data-integration/compose.yaml) 使用项目 `market-watch-data-integration`，
独立默认网络、`integration-postgres` volume、PostgreSQL 数据库；不发布端口、不加载生产 env，
不启动采集/通知 worker。`verify` 包含实际 PostgreSQL 新数据集注册/入库/回滚保护测试。
权限可用后，在此 worktree 执行以下命令；密码仅在当前终端环境生成，不提交仓库。

```bash
export MW_DATA_TEST_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
docker compose -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml up --build --abort-on-container-exit --exit-code-from verify verify
docker compose -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml down
```

停止命令保留该项目 volume；重复启动须使用相同测试密码。仅在确认归属且已不再需要验收数据时，
可对这个明确的项目执行 `down --volumes`。不得全局 prune，不能转到 unraid 运行这些实例。

## 接续验收

保持本任务隔离实例运行，保留已完成校验的两个十年固定版本。最终按正式方案汇总观察覆盖、
unknown、失败、迟到、正常与故障阶段、时钟校准和源日历证据；生产存量清点及Ubuntu备份恢复已通过。
当前目标仍 active，MT4 不在本轮范围。服务启动/停止与凭据位置见
[实例说明](verification/data-integration/README.md)。

### 2026-10-06 04:36 UTC：有界持续验收报告

- 保持 `feat/market-data-integration` 隔离 worktree，浏览器service PID2266365仍active/running，
  未重新部署或重启长期窗口。
- 新增 `scripts/sustained_live_report.py`：PostgreSQL只读repeatable-read快照，最多72小时，
  按UTC小时及伦敦/纽约观察时段列出完整分钟、未知/无观测、缺失、失败、迟到和补数。
  黄金NY17–18仅为candidate分组；原始价格、日历身份与历史版本均未修改。
- 规则阶段从04:09首根合格柱收盘起统计，不能回填此前入库时段；还按owned规则armed_at约束。
  无owned规则时不统计计算样本。阶段审计只证明入库/计算阶段flush，不证明逐规则连续执行。
- [实际快照](verification/data-integration/sustained-live-report-checkpoint.json)：两品种各30根M1，
  缺失/失败/超过30秒迟到均0，合格阶段审计各27；小时分组与总体分母逐项一致。
  浏览器62块、errors0、无心跳块0，所有stale状态保留。
- [9个统计回归](verification/data-integration/sustained-report-tests.txt)覆盖未知分母、失败/迟到、
  补数、重复审计、规则起点、未来确认、负时差和DST分组；Ruff、diff检查通过。
- 两交易日仍未完成。浏览器计划到10月8日04:04:14UTC，规则完整48小时需到04:09UTC后独立检查。
  来源账户日历适用性及供应商时钟偏差仍未证明，目标保持active。

### 2026-10-06 04:44 UTC：逐规则长期观察

- 现有pricing_confirmed审计未保存逐规则推进状态；补充宿主只读观察工具，每15秒读取两个
  已拥有的验收watch，保留last_event、status/paused_reason、tradeable/quality、世代变化、
  无观测或HTTP失败，以及轮询与UTC/monotonic时间差。只请求登录和GET，不修改业务状态。
- [真实两分钟工具验证](verification/data-integration/rule-observer-validation.json)：24次采样、
  一次续期、两规则各推进2次、失败0；每小时NTP采样机制首样本offset −2.214ms，
  root distance 22.155ms、jitter8.845ms。未独立证明供应商clock offset。
- 新工具7个定向回归通过，覆盖身份保密/缺失、基线不算执行、跳变不补造执行、暂停/失败、
  状态回退/清空、分段重启及clock jump；Ruff、diff和文档本地链接检查通过。
- 专用 `market-watch-data-integration-rules.service` PID2669988 active/running，无自动重启/enable。
  [独立规则观察窗口](verification/data-integration/rules-observation-window.json)：
  **2026-10-06 04:42:50.867UTC → 2026-10-08 04:42:50.867UTC**；
  该窗口不回填到规则创建时间，不替换04:04浏览器窗口，后者PID2266365继续运行。
- `rule_close_to_poll_upper_bound`包含15秒轮询，不能当成后端执行耗时，也不证明跳变中间的每次计算。
  合并评估时仍保留后端分母、阶段审计及实际每规则状态。两交易日与来源会话适用性未完成。

### 2026-10-06 04:49 UTC：报价更新率与实际分母

- 补齐方案要求的报价更新率：后端按完整源分钟累计接受、去重的stream更新；总体与小时分组
  均输出updates/elapsed_seconds/updates_per_second。未知/闭市/无观测分钟均保留在经过秒数分母。
- 浏览器单独输出可见更新率，要求明确的一个started窗口，从启动到最后完整block计时，
  包含失败/无心跳块与间隙。多个窗口不拼接速率；SSE一秒合并与重载首报价重复计数不能当作全tick。
- [14个统计回归](verification/data-integration/update-rate-tests.txt)通过；Ruff、diff检查通过。
  原浏览器工具未修改/重启，只改事后摘要；两个systemd进程仍运行。
- [实际后端快照](verification/data-integration/sustained-live-report-checkpoint.json)：43完整分钟，
  XAU3697次/2580s=1.433/s，EUR988次/2580s=0.383/s；两品种各43根M1确认，missing/fail均0。
  [实际浏览器](verification/data-integration/browser-sustained-checkpoint.json)：87块errors0，
  XAU约0.727/s、EUR约0.273/s；不能把不同分母相除推算漏tick。
- 此次补齐计量产出，尚未达到长期窗口或来源会话适用性门槛，目标保持active。

### 2026-10-06 05:03 UTC：共享REST冷却健康字段

- 对照正式方案Health契约，发现额度模块已执行cooldown_until但实时快照未返回。新增活动冷却
  UTC毫秒/null字段，按来源读取共享预算，每次快照仅每来源一次读取；小数毫秒向外取整。
  不把活动REST冷却等同stream报价失效，也不更改来源身份、价格、预警判断或确认调度。
- SSE签名加入cooldown_until，冷却开始和过期时没有新报价/新世代也能发布。新增回归先验证
  缺字段/缺签名函数失败，然后实现修正；[28项回归](verification/data-integration/cooldown-health-tests.txt)
  通过，[Docker12项](verification/data-integration/cooldown-health-container-tests.txt)包含独立PG临时schema。
- 实现提交42ec051；05:01UTC只重新创建Ubuntu验收API，其他worker/db/web容器ID及两observer PID
  均保持，upstream epoch49不变。[运行核对](verification/data-integration/cooldown-health-runtime.json)
  验证新字段与现有独立就绪状态；28.998s是部署准备到API验证包络，不是纯HTTP不可用时长。
- [容器代码核对](verification/data-integration/cooldown-health-code.json)：API已加载新版本；保留worker
  只有snapshots函数不同，其采集、租约、确认所有函数逐一相同，不需要为这个API读字段重启流。
- 两原窗口记录部署分段，JSONL追加开始/完成事件。[浏览器](verification/data-integration/cooldown-health-browser-recovery.json)
  117块含3次SSE错误；[规则](verification/data-integration/cooldown-health-rules-recovery.json)80次采样含2次502失败，
  恢复后两watch继续推进新M1。不能改称全程HTTP无中断或全程同一API代码。
- 逐规则摘要补齐部署事件保留，[8项回归](verification/data-integration/rule-deployment-summary-tests.txt)通过；
  Ruff、diff和文档链接检查通过。时长计划保持，所有故障分母保留；来源会话适用性仍未证明。

### 2026-10-06 05:24 UTC：观察空白块保留

- 原PID2266365/2669988仍active/running；浏览器05:21:25UTC有首个heartbeats0/snapshots0块，
  前后间隔48.907s/47.207s，随后opened1且恢复29snapshot/30heartbeat，后续继续采样。
- [上下文证据](verification/data-integration/observer-silent-block.json)保留异常、相邻计数、服务状态，
  同时记录两规则active/paused_reason null、last_event05:24、epoch49。
- 同期宿主4核load与CPU/memory/IO pressure明显上升，但未证明空白块原因，不据此修改业务判断。
  没有重启观察、覆盖原JSONL、终止其他任务或清理资源；此窗口不再声称无心跳块0。
- 长期分母继续包含该块和观测间隙；完整两交易日及来源会话适用性仍待完成。
