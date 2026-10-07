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

## 当前交付状态（2026-10-06更新）

用户要求实现与质量分别验收。**[实现验收通过](verification/data-integration/implementation-acceptance.md)**，
P0–P2功能有独立证据，可以先交付；**[质量验收未通过](verification/data-integration/quality-acceptance.md)**，
整体目标仍active。两份报告分别列出门槛，不以功能通过代替长期验收或来源会话认证。

06:41:44UTC浏览器观察与06:42:06UTC规则观察失败退出，后者明确ENOSPC。
原JSONL及116字节未完成尾记录完整保留；六个验收容器仍运行，API/PG健康。
原定10月8日12:42新加坡时间的质量收口时间失效，恢复后须明确新窗口及实际覆盖。
后续章节为开发历史，包含已完成十年导入之前的旧状态，以此处及两份验收报告为准。

10:27UTC复核上述状态未恢复：观察MainPID0/failed，六个实例容器running、API/PG健康，
宿主余量约429MB。本任务主要日志约6MB、ignored验收文件58MB，未删除原数据或其他任务资源。
已请求Ubuntu容量恢复/另一个本地数据目录；质量收口时间须在恢复后重排。

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

## P2 实现与 Ubuntu 容器验收（阶段记录）

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

## 02:30UTC之前尚未完成的验收门槛（历史记录）

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

### 2026-10-06 05:28 UTC：首个超过30秒的已知M1确认

- [真实82分钟快照](verification/data-integration/sustained-live-pressure-checkpoint.json)：两品种各82个
  预期分钟全部确认，missing/fail0；EUR over30s1、p95 11.624s、p99 **32.005s**，短窗口当前p99超标。
  XAU over30s0、p95 9.300s、p99 25.987s；未知/无观测0，分母未裁剪。
- [逐项迟到明细](verification/data-integration/m1-first-late-detail.json)：EUR05:23UTC收盘，
  REST接收+29.009s、入库flush再+2.996s、计算阶段再+0.467s，保持epoch49、真实tradeable期望。
  后续重叠请求共3次、请求失败0，不把这根改划为历史补数来减少实时迟到分母。
- 请求开始时间未保存，不能区分供应商可用性、网络、调度及宿主压力根因；同一宿主压力证据只是伴随。
  不宣称已经修复或完整达标，保留真实窗口继续观察，结束后计算全窗口分布与故障计数。

### 2026-10-06 06:05 UTC：接续核对与已恢复失败分钟

- 已重读原交接、方案及AGENTS，确认继续现有隔离worktree/branch；HEAD477d7d1，
  未重建工作树或重启观察。浏览器PID2266365与规则PID2669988仍active/running。
- [06:03UTC只读快照](verification/data-integration/sustained-live-recovered-failures-checkpoint.json)：
  两品种各118个预期分钟全部确认，missing/unknown/unobserved0；XAU失败分钟计数3、EUR0。
  [明细](verification/data-integration/m1-recovered-failed-minutes.json)保留XAU05:28/05:29/05:30收盘柱，
  均已成功确认。失败按请求覆盖的分钟累计，不等于独立失败请求数；成功覆盖last_result，
  不凭这些记录推断失败类型或发生时刻。无需为已恢复的计数重启采集或修改来源身份。
- XAU确认p95/p99为10.485s/23.438s，EUR为11.671s/18.165s，EUR超过30秒仍1；
  样本增长后的分布变化不构成迟到修复证明。浏览器230块仍保留3个SSE错误、1个无心跳块，
  逐规则313次采样保留2次部署502失败，两规则各观察79次推进、无暂停或回退。
- 验收实例六个服务仍running，API/PG健康；Ubuntu宿主可用磁盘约2GB，
  本任务ignored artifacts约58MB。不重新构建、不删除其他任务资源；继续真实窗口及来源适用性核实。

### 2026-10-06 10:48 UTC：容量恢复、独立后台观察与实现PR

- 用户授权分析并直接清理已完成实例与已统计缓存。按精确Compose标签清理8个已完成/被新候选
  替代的项目，数据库先pg_dump并以pg_restore --list校验备份目录；未另建实例恢复验证。
  备份位于ignored artifacts目录，源码/验收记录保留；活动项目、生产环境未删除，无全局prune。
- 下载/编译缓存已清理，系统journal因权限不足未清理，未删除镜像或build cache。
  [清理结果](verification/data-integration/ubuntu-cleanup-result.json)记录精确名称、备份hash与文件系统余量，
  可用空间恢复至约16GiB；净变化含其他任务并发，不能等同单独镜像层释放量。
- 原中断JSONL按[清单](verification/data-integration/observation-restart-archives.json)保留字节/hash，
  新raw另建；浏览器PID2233613、规则PID2233614 active/running，记录继续追加。
  新窗口10月6日10:47UTC起，计划10月8日18:47新加坡时间结束；不拼接旧时长，不自动判通过。
- 用户决定实现先推PR，质量验收后台继续，有问题再提交修复PR。48小时方式来自工程实现，
  两活跃交易日来自方案第10节，并非SDK官方要求；质量窗口不作为提交PR前提。
  [实现报告](verification/data-integration/implementation-acceptance.md)保持通过，
  [质量报告](verification/data-integration/quality-acceptance.md)仍未通过，保留来源证据、迟到与失败限制。

### 用户最新调整：暂缓PR，先修改实现

- 用户要求先不提交PR，存在待修改项；尚未推送或创建PR，不合并或生产发布。
- 当前下载Dukascopy BID M1；高周期沿用项目原Node接入链路使用的后端NY17聚合，
  并非直接使用dukascopy-node内部高周期结果。日界/DST、周月边界、闰年已有回归；
  来源会话认证及与供应商原生高周期逐根一致仍未证明。
- 为准备PR已开始整合origin/main（826d316，v1.11）；本地完成冲突解决与兼容回归后保留，
  不推送、不重新部署观察实例。原实例与后台两个service继续运行其已记录版本。

### 用户明确聚合标准：NY17 H4/D1

- 用户不要求高周期与Dukascopy数据一致，明确要求按NY17切H4/D1；现有实现沿用该口径。
  纽约当地17:00换日，H4日界锚点每四小时分桶，DST由America/New_York转换；
  供应商高周期一致性不属于目标，来源会话证明仅用于缺失分钟归因/complete判断。
- 已同步方案、实现与质量报告；暂缓推送和创建PR的决定仍有效。

### 本地主线兼容整理完成（未推送、未部署）

- 整合origin/main 826d316（v1.11），保留共享browser/MCP业务接口、显式来源watch ID与live状态、
  原生图表observed_at/provisional语义、来源日历与需求续期；依赖保留MCP与Dukascopy Python。
- 新增w24_merge_market_data将v23行情与u22图表预警两head合一；覆盖两条已部署head升级及历史版本保留。
- 首次全量748 passed/57 skipped，3个测试fixture/旧预期失败已修正；最终相关19项全部通过，
  NY17日界/DST/周月/历史计划及预警迁移45项通过，前端构建与8项web单测通过。
  [证据与限制](verification/data-integration/main-compatibility.json)保留初次失败与最终结果；
  全仓Ruff29项均在与origin/main字节相同的文件中，改动文件Ruff通过。
- 未重建/更新后台观察容器，未推送、未创建PR、未合并到主线、未生产发布。

### 可调聚合日界：类别默认、单数据集覆盖与版本保留

- 用户要求Dukascopy Python外汇/金属默认NY17，加密默认UTC，指数未定。
  已加入注册API/页面资产类别与日界配置；指数无默认必须选择，既有系列保留当前日界。
- 改日界建立新身份，可选择已发布原M1版本分块派生；worker处理派生，不重新下载、
  不覆盖原版本或固定回放。记录类别的x25迁移不猜测旧类别或变更历史切分。
- [交付/证据](verification/data-integration/configurable-aggregation.md)：86项本地回归、
  实际Ubuntu PostgreSQL2项、前端构建和Chromium交互通过；浏览器使用fixture API，
  实际后端API/PG证据另列。未更新长期观察实例，未推送或提PR。
- 用户询问Dukascopy历史+OANDA近期的组合源；当前保持独立两源，组合视图尚未实现，
  本轮先分析价值/边界，不把咨询推断为新增开发授权。

### 2026-10-06：三层综合分析获认可，形成正式方案

- 用户认可三层综合建议，并询问是否仍需澄清、是否可形成方案；剩余三项采用已推荐选项：
  明确保存且版本化的实时映射；首次实际使用第三层时幂等创建并共享；行情、策略判断和预警供人工交易使用。
- 新增[行情三层方案](market-data-three-layer-plan.md)，覆盖身份、能力、发布、固定接缝、组合修订、
  volume、接缝指标影响、就绪门槛、共享需求、恢复防重、引用保护、迁移与分阶段验收。
- 第二层日更不移动已启用组合的拼接点或替换其历史版本；变更基线须新修订、预热和明确启用。
  第三层尾部按已保存规则更新并审计，不扩展为组合回测或订单执行产品。
- 更新术语表及旧接入/按需/实施顺序文档的优先级与冲突条款。方案无阻塞性业务待答项，
  调度参数、来源实际能力、旧身份清点和容量作为实施技术验证事项。
- 代码核对基线abb2030；本轮仅文档修改，无功能实现、推送、PR、部署或后台观察重启。
  旧实现/质量证据保留，不能作为三层新增能力验收。

### 2026-10-06：补充数据中心组织与UI方案

- 用户询问数据中心组织与UI是否已设计、是否一并加入方案；此前仅有功能与状态要求。
  新增[数据中心组织与UI设计](market-data-center-ui-plan.md)，由三层主方案第9.1节引用。
- 明确自建行情、平台品种、组合行情、任务与记录四个分区；补齐列表/详情/创建线框、
  映射与首次使用、搜索联动、任务、删除引用、异常状态、移动端及可访问性验收。
- 核对现有MarketDataPage默认续订实时需求、旧维护弹窗混合历史与实时等差异；方案要求
  浏览管理页面无采集副作用，维护计划与实时需求分开呈现。尚未修改现有页面行为。
- 数据中心随B/C/D阶段分别交付，不把全部UI留到E；本轮仅文档修改，无部署和浏览器验收。

### 2026-10-06：桌面范围调整与开发交接

- 用户明确“当前不要求再兼容适配移动端”，并调用handoff供下一agent接续开发。
  已更新主方案与UI配套方案，移除移动布局、线框及手机验收要求；当前交付以桌面浏览器为准，
  保留键盘、200%缩放和权限要求，不将历史验收中的移动证据改写为当前目标。
- 下一会话按既定阶段接续开发；本会话仅更新方案与生成临时交接文档，未实现新功能。
  未提交的文档需完整保留；暂缓推送/PR、MT4延期及无订单执行范围继续有效。

### 2026-10-06：接续开发，来源身份与多源固定 M1 基础

- 建立来源采集身份与旧派生身份的明确关联，y26 不重写旧 ID/原始价格/manifest，未知旧通道不猜测映射。
- 历史 worker 支持 Dukascopy 与 OANDA Practice，按来源限制分页；OANDA 的固定版本与改日界派生保持同一来源和量口径。
- z27 增加来源隔离的内容寻址 M1 与共享请求租约；新版本引用共享分块，旧内嵌版本兼容，过期采集拥有者不能发布。
- [基础验证与环境](verification/three-layer/source-foundation.md)：本地全量 784 passed/67 skipped；
  新 Ubuntu 独立 project `market-watch-three-layer` 的 PG 定向 19 passed，全链升级到 z27。
- 本批未交付日更、分周期产物、数据中心或组合/策略功能，不宣称三层整体验收通过。
  未推送/PR、未生产部署、未改变旧观察窗口；继续完整 A–E 目标。

### 2026-10-06：多源维护、固定周期产物与桌面数据中心阶段验证

- 新增独立维护计划、固定任务区间与检查点；增量复用未变化 M1 分块和周期产物。
- M1、H4、D1 等周期独立发布；新版 M1 不下架旧周期，全部所选周期完成后才记录维护成功。
  派生期间暂停/取消保留已发布内容，并覆盖并发构建和完成记录中断恢复。
- 数据中心默认自建行情，已有列表/详情/创建/覆盖/任务/维护设置，管理浏览不建立实时需求。
- Ubuntu 新项目实际 API、PG、worker、web 已运行，页面端口16629，迁移至ab29。
  真实 Dukascopy 黄金、OANDA 欧元/黄金 M1 与 H4/D1 查询通过；真实 Chromium EURUSD创建、
  发布、固定图表、暂停/恢复以及桌面宽度/内容缩放通过。
- [阶段报告及启停方式](verification/three-layer/managed-center-stage.md)区分实现、真实流程和未完成范围；
  当前32项本地定向与15项实际PG通过，新代码本地全量805 passed/82 skipped，215.60s。
- B阶段仍有引用保护、业务入口、目录与覆盖分类；C/D组合与策略、E整体验收尚未完成。
  没有把短样本通过判为三层整体或长期质量通过；继续暂缓推送/PR和生产操作。

### 2026-10-06：固定历史图表分页、回测入口与引用保护回收

- 图表默认最新观测，按固定版本周期分块索引向前分页；URL固定版本，周期选择读取对应版本产物。
  真实浏览器验证分页、切换周期保留版本及回测页面选择固定版本，不自动执行演练。
- 新增引用页及暂停/归档后回收：被回测、策略、工作区、派生和活动任务引用则拒绝。
  保留数据集身份/发布清单/回收记录，共享分块按可达引用保留，回收旧版本不能被重新引用或派生。
- ac30实际PG迁移通过，回收与新增引用的两种竞争顺序经实际PG验证；工作区乐观SQL更新也使用引用锁。
- 真实Ubuntu浏览器完成来源下载、保存引用阻止回收、页面审阅回收、清单保留及新版本重新维护，
  其他NY17数据集继续可用。[阶段证据与剩余范围](verification/three-layer/history-retention-stage.md)。
- 全量首次813通过/89跳过，两个前序迁移失败已修复且定向通过；后续全量815通过/89跳过，
  293.43s，最终增量回收/数据中心本地14项、实际PG回收8项通过。
  没有将B阶段局部通过宣称为完整三层通过，继续开发目录/覆盖/组合/策略和整体交付。

### 2026-10-06：来源目录、固定覆盖分类、持久请求事实与只读MCP

- 自建选品接SDK目录及当前OANDA账户显式刷新；未知精度要求填写，准确代码/类别继承。
  与旧平台目录隔离，修复旧创建提交重试及目录变化后的固定请求返回。
- 固定版本覆盖区分观测/unknown/有限证据闭市/冲突，不用NY17或空响应证明休市。
- ad31持久保存读取失败及重试、缓存和父版复用事实；完成不可变，价格回收后保留。
  进程中断不虚构来源结果，公开审计ID与工作租约token分离，旧版本不补造证据。
- 实际PG30项；全量831通过/97跳过/244.87s，最后审计ID变更另有本地10项及PG6项定向通过。
  真实OANDA20分钟复查、8个只读MCP与网页输出一致、真实Chromium目录/覆盖/请求记录通过。
- MCP启用暴露旧基础镜像缺依赖，独立新镜像按lock补齐，port16629 API恢复健康；旧观察未改变。
  [阶段证据及限制](verification/three-layer/history-catalog-quality-stage.md)。
- 第二层搜索/统一回测输入/维护写MCP及完整C/D/E仍未完成；继续完整目标，未推送/PR/生产操作。

### 2026-10-06：组合定义、明确映射与首次使用固定基础

- 新增版本化产品匹配与目标账户目录校验，不靠删斜杠/下划线自动认定产品等价。
- 首次使用在数据集锁内固定可用M1版本和最近日界T，创建共享定义/固定修订/持久准备任务；
  日更不移动原基线/T，缺M1或T前无历史拒绝；映射和修订成为回收保护引用。
- 实际PG定义/并发/迁移及回收13项通过，8并发首次使用只建一个定义/修订/准备任务。
  全链旧迁移7项通过，Ubuntu库已升ae32；[基础证据](verification/three-layer/composite-definition-stage.md)。
- 这批只有内部基础接口，尚未接公开使用入口或执行尾部准备；组合采集/统一聚合/图表/MCP/
  策略/UI及E仍需接续，不能把本批通过称为可使用的混合源或完整C阶段通过。

### 2026-10-07：确认接续、共享需求与组合数据中心公开入口

- c153531 固定截止的接续准备、来源确认 M1 及不可变输入修订已落库，af33 实际迁移；
  真实 OANDA EURUSD 单次读取 1159 根确认 M1。空成功只完成查询，不证明有价格或覆盖。
- c572af6 组合需求映射实际来源并共享采集，零需求不占拥有者，宽限后健康释放；
  实际验证双图共享 EURUSD stream/REST 恢复及释放。固定输入先接 M1 再按 NY17/UTC0 聚合，
  跨来源量为空、保留分段原量，确认/时间/覆盖分别表达。见对应 inputs/usage/series 阶段报告。
- 当前公开批次接六个只读 MCP、HTTP 读和明确首次使用命令，数据中心映射、候选、组合列表和
  四页详情，管理浏览无需求。候选校验 T 前历史，重复打开只为原固定基线补派生。
- 图表用索引跳过稀疏尾部并复用接缝前固定周期产物；修复只有历史观测的接缝桶遗漏。
  当前仍是有界分页，持久长尾聚合、主图表/统一搜索、组合策略预警和显式修订尚未交付。
- 最终本地定向 13 项、实际 PG 13 项、真实六工具 HTTP/MCP 对照通过；全量后端
  876 passed / 126 skipped / 213.42s。真实浏览器管理/映射/组合 M1-H4、桌面三宽度、
  四详情页和映射页 200% 内容缩放及键盘操作通过，修复画布撑宽和周期控件名称。
- [本批行为、实际启停及剩余范围](verification/three-layer/composite-center-stage.md)。
  Ubuntu 16629 管理实例健康，pricing-worker 保持停止，旧观察不变；未推送/PR/生产操作。
  本批真实浏览器使用 OANDA→OANDA，不宣称 Dukascopy→OANDA 或完整 C/D/E、质量观察通过。

### 2026-10-07：三层统一搜索、固定输入主图表与 CSV

- 新 qualified 身份 MWH/MWC 保留固定历史版本和组合定义，旧 bare/MD/MC/MWP 含义不变。
  原生库大写 UUID/hash 在解析及引用保护规范化；保存偏好/观察列表也保护版本回收。
- 普通/原生主图表及只读 MCP series_search 接统一选品，搜索/解析不创建组合；
  首次实际组合图表请求幂等使用，单次多页固定输入，固定历史不触发旧维护。
- 修复观察列表单条解析失败阻挡整个有效主图表的弹窗；错误由请求控件显示，
  保存的不可用来源身份不改写。原生标题显示 EURUSD，完整身份仍保存。
- 固定历史/组合 CSV 共用读取器，保留版本、输入修订和分段来源，不创建采集需求。
  指标完整预热未完成时明确拒绝页面截断计算，不将当前可画图当作策略就绪。
- 最终全量 883 passed / 131 skipped / 228.89s，实际 PostgreSQL 32 passed / 130.76s，
  JS 五脚本、前端构建、Ruff/diff、真实七工具 HTTP/MCP 和加强浏览器八项通过。
  [实际环境、启停、问题证据及剩余范围](verification/three-layer/series-access-stage.md)。
- Ubuntu 16629 API 健康，16630 独立许可库 origin 已运行；pricing-worker 停止，旧观察不变。
  持久尾部聚合、修订缓存修复、完整指标/组合策略、显式修订、原生 Dukascopy、
  回测周期输入及真实跨源/并发/长期质量仍待交付；没有推送/PR/生产操作。

### 2026-10-07：固定输入旧柱修订复核与原生重绘

- 已提交上一搜索/主图表批次 `d7d9528`。本批增加固定历史/组合的 history_check，
  指纹限定已加载旧桶；新追加、最新桶和范围外改动不重置历史，旧柱修订/补洞触发公开重绘回调。
  原生复核保存实际 UTC 起点，不用 NY17 日期显示标签查询分钟修订；旧输入版本复现旧指纹。
- 本地定向 54 passed / 18.77s，实际 PG 10 passed / 34.77s，四个相关 JS 脚本通过；
  真实 Ubuntu 浏览器九项通过，API 已重启且健康。新代码 Ruff/diff 通过。
  [修订复核证据与范围](verification/three-layer/fixed-series-revisions-stage.md)。
- 受控修订测试不冒称供应商真实修订；当前索引范围指纹也不等于已完成持久桶物化。
  完整指标/策略、显式修订及其余 A–E 交付继续；无推送/PR/生产操作。

### 2026-10-07：九周期接续持久聚合与实际 worker 验证

- ag34 新增周期任务/不可变桶产物，按固定输入事件有界处理、进度/租约恢复、
  完整处理某次事件后才推进水位；修订只重建受影响桶，旧输入仍可重现。
  图表优先复用已处理输入周期，不扫描 M1；未追上时沿用明确固定输入的有界读取。
- 数据中心显示九周期已处理/当前输入、失败与重试时间，不当作覆盖或策略就绪。
  完整九行及滚动区键盘焦点、桌面 1024/1440/1920 和 200% 内容缩放实际通过。
- Ubuntu 库备份/list 检查后升级 ag34，worker 自动为两条已有真实组合生成九周期，
  18 组产物与固定 M1 参考完全一致，图表原 M1 读取禁用后仍通过；没有制造真实供应商修订。
- 全量 895 passed / 145 skipped / 294.85s；最终实际 PG 聚合/定义/图表 22 passed / 108.14s，
  迁移旧 head 断言已修复。七工具 HTTP/MCP、原生九项和新增管理三项实际通过；
  前端构建、JS 回归、Ruff/diff 通过。[环境/证据/限制](verification/three-layer/composite-aggregates-stage.md)。
- 当前完整指标/策略、显式修订、原生 Dukascopy、统一固定周期回测、跨源并发和质量观察仍待交付。
  pricing-worker 停止、旧观察与生产未改；不推送/PR，MT4 后续。

### 2026-10-07：固定输入指标完整初始化、检查点与修订恢复

- 从 `b238cc8` 接续八种内置价格指标完整初始化，不以图表页或任意近期根数代替递归输入。
  ah35 新增固定输入任务、压缩结果和有界状态；每次处理 2000 根周期产物，后台租约/检查点可恢复。
- 输入追加继承有效前段；旧柱修订从最早受影响桶之前检查点重算后段，旧输入保持可复现。
  标明实际依赖范围与接缝影响，有限窗口移出接缝后解除标记；临时柱只在状态副本计算。
- 图表显示准备进度，原生在完整初始化/修订进度改变后重绘。带指标 CSV 等待时提交任务，
  就绪后导出全部页指标；无业务引用的已归档历史可连同指标缓存回收。
- 全量 943 passed / 156 skipped / 254.86s；最终指标本地50 passed，实际 PG 指标/主图/周期
  30 passed。最后新增边界由本地50项与实际PG指标13项覆盖；真实两条 OANDA→OANDA、16组指标完整前段
  与 TA-Lib 一致；实际原生历史 EMA/组合 RSI通过。
- 并发首请求实际揭示共享锁升级死锁，修复并复测；工具加强全段范围与任务终态检查，保留原失败。
  [环境、证据、启停与边界](verification/three-layer/fixed-indicators-stage.md)。迁移 ah35，Ubuntu16629健康。
- 组合策略/预警、显式修订、原生 Dukascopy、统一周期回测及剩余 A–E 验收继续，目标未完成。
  pricing-worker 停止，旧观察/生产不改，不推送/PR，MT4后续；实现与长期质量分别验收。

### 2026-10-07：固定组合策略与持久图表预警

- 组合告警保存准确历史基线/校验和、修订、映射、T、日界与指标算法，持久规则维持准确目标采集。
  周期/指标/确认/来源拥有者/覆盖分别设门槛；默认拒绝接缝依赖，显式接受也不在接缝制造穿越。
  正常异步计算等待保留前态，真实断线/修订/漏判恢复建立基准，不追发过期事件。
- ai36 不可变判断记录与状态、信号、通知/队列同事务；数据中心展示逐规则依赖与固定修订。
  临时 Bid 仅抽样，检查报价与此前桶内 M1，不改变确认指标状态。
- 全量959 passed /174 skipped；实际 PG 组合+指标28 passed，组合+旧告警/迁移23 passed。
  最后本地17项、原生桥接7项及固定大小写回归、前端构建、Ruff/diff 通过。
- Ubuntu 原生实际创建、准确绑定及三宽度/键盘/缩放通过；等待图表两分钟租约实际归零后，
  后台确认 M1 和无事件证据继续推进；EMA19两种政策当前有效段就绪，测试规则全部暂停。
  实际库转大写造成告警入口身份查找失败已修复；PG测试启动副作用隔离及失败迁移受控修复有完整记录。
  [环境、证据、启停与边界](verification/three-layer/composite-alerts-stage.md)。
- 16629/16630运行，独立pricing-worker本批启用，外部delivery禁用。真实样本仍为OANDA→OANDA，
  跨源、旧策略入口、显式修订、原生Dukascopy、周期回测及其余A–E继续；整体目标未完成。
  无推送/PR/生产操作，MT4后续，实现与质量分开。

### 2026-10-07：显式组合修订与准备后原子启用

- `04dd578` 后实现幂等固定新基线/映射/日界修订，独立M1准备、九周期发布与已有指标初始化，
  明确启用同事务切换指针并保存旧/新修订及事件边界证据；旧运行规则不静默迁移。
  同组合ID采用新修订的日历/目标，旧输入与原候选保持可读和共享身份。
- 数据中心加入新修订表单、准备状态、受影响规则和分页记录；超时先按编号核对结果，
  非日界分钟拼接明确声明；超过20条待准备修订轮换检查。
- 全量964 passed /181 skipped /261.89s；实际PG修订/需求/主图21 passed，
  最终修订完整8 passed /32.54s；最后本地修订/预警19 passed，前端构建、Ruff/diff通过。
- Ubuntu备份/list检查后升级aj37，真实表单完成OANDA M1与固定EMA19准备后明确启用，
  七条已有规则身份保持不变，旧同输入价格复现，测试规则暂停。三桌面宽度/键盘/200%通过。
  [环境、启停、实际准备耗时及边界](verification/three-layer/composite-revisions-stage.md)。
- 维护写MCP、原生Dukascopy、固定周期回测、剩余业务入口、真实跨源/并发及整体质量仍继续。
  16629/16630健康，旧观察/生产未改，无推送/PR，MT4后续；目标未完成。

### 2026-10-07：自建历史维护写MCP与浏览器共用事务

- 八个写工具覆盖创建/配置/计划控制/任务控制/改日界/周期准备/回收，需要明确market:write。
  注册失败完整回滚；续期凭据重试幂等，不同意图拒绝，无供应商IO或实时需求副作用。
- 全量968 passed /186 skipped；最后本地45 passed，实际PG22 passed，Ruff/diff通过。
  四凭据八次并发只注册一个任务；失败不留下来源/数据集；引用竞争沿用回收锁保护。
- Ubuntu真实AUDUSD OANDA M1共108根，UTC派生价格一致，M1/H4发布后可读；
  原版本与保存工作区引用均阻止回收，仅本次无引用UTC派生回收，原始价格保持可读。
  最后API重启后复查提交/原key重试/未发布周期拒绝/取消通过，history-worker恢复。
  [环境、启停、脚本失败及范围](verification/three-layer/history-writes-stage.md)。
- 固定周期回测、原生Dukascopy、剩余入口、真实跨源/并发及完整质量继续。
  16629健康，磁盘4.7GB，旧观察/生产未改，无推送/PR，MT4后续，完整目标未完成。

### 2026-10-07：固定回测与图表统一读取周期产物

- 删除固定回测另一套即时M1聚合，流式读取相同已发布周期，保留确认/覆盖/量语义和完整预热。
  输入清单固定父M1及所选周期/D1校验和，保存恢复/seek不变化；待发布拒绝同步重算。
- 桌面回测增加OANDA和准确日界选择、九周期回放、显式周期准备/等待及维护入口。
  原有模拟预警六周期能力保持，不将新增回放周期当预警已支持。
- 全量980 passed /195 skipped；本地57 passed，实际PG回测/回收/周期23 passed，
  指标/维护17 passed。真实OANDA M1、Dukascopy及OANDA各10根H4与图表价格及质量一致，
  三宽度/键盘/200%浏览器通过，最后build/Ruff/diff通过。
  [实际环境、启停、失败证据与范围](verification/three-layer/fixed-replay-stage.md)。
- 原生Dukascopy、统一搜索其余入口、旧Watch策略兼容、真实跨源/并发、容量及长期质量继续；
  16629健康，旧观察/生产未改，无推送/PR，MT4后续，完整目标未完成。

### 2026-10-07：Dukascopy 平台原生九周期与目录

- 原生JSON3九周期直读，不从M1重算；UTC标签、Bid价格、来源量精确保留。
  确认位null、时间结束独立披露，未验证日历不通过原生告警门槛。
- 数据中心完整SDK目录分页、准确平台图表入口、显示精度与自建精度分开；
  搜索避免来源遮蔽且保留Yahoo远程模糊查询。原生历史worker已实际启动。
- 最后全量1003 passed /197 skipped；最后限流/超额页/工作区本地30 passed，实际PG5 passed。
  实际九周期供应商/HTTP价格时间量一致，MCP读取和真实许可图表H4/D1/MN通过，
  桌面三宽度/键盘/200%通过。最后完整回归结果记录于阶段报告。
- [环境、失败证据、启停与剩余范围](verification/three-layer/dukascopy-native-stage.md)。
  完整A–E仍未收口，统一业务入口/跨源/并发/容量/长期质量继续，无推送PR，MT4后续。
### 2026-10-07：组合自选报价与独立就绪证据

- 保存组合的HTTP、自选列表和只读MCP共用准确报价快照；有效owner/epoch/账户与15秒新鲜度
  校验后展示抽样Bid，否则展示同固定输入的保存确认M1收盘及时间，不生成涨跌或创建需求。
- 实际PG15项、本地最终接口38项通过；全量1018 passed/204 skipped/320.16s。
  首轮两处旧MCP工具数量断言失败已修正，全量复验通过，失败日志保留。
- 实际Ubuntu闲置/显式图表使用/原生桥接/关闭并释放租约后回退、HTTP/MCP与固定图表证据通过。
  新报告 [组合报价](verification/three-layer/composite-quotes-stage.md)。实例16629/16630运行正常，
  旧观察/生产未改，不推送/PR，MT4后续。完整目标未完成，48小时新观察未启动。

### 2026-10-07：真实Dukascopy→OANDA两品种及聚合吞吐

- 实际EURUSD/XAUUSD通过HTTP映射/首次使用、worker确认接续与九周期价格独立核对。
  历史checksum与NY17 T保持固定；周/月保留两来源分段量，统一量为空。
- 首轮180秒未追上，探针显示独立计算快速但共用历史循环每批等待。
  新独立聚合worker沿用原持久claim/lease；实际部署后积压追上，后续已有组合等待9.32s。
  此时长不是冷建新组合或多年历史性能。默认旧历史worker行为保留。
- 本地50项、实际PG18项通过；真实桌面两品种图表/接续/产物/三宽度/键盘/缩放通过。
  [跨源阶段报告](verification/three-layer/cross-source-stage.md)，初轮失败保留。
- 目标仍有旧Watch接线、多品种并发、来源参数配置及日历/映射修订/恢复和48小时观察。
  Ubuntu16629/16630，旧观察/生产未改，不推送/PR；MT4后续。

### 2026-10-07：回测默认统一自建搜索与显式版本

- 回测默认自建搜索，来源/Bid/日界分开；选择后显式固定版本和范围，搜索不续订需求。
  按数据集读取版本，直接保留深链接指定旧版本，避免全局100条截断。
  未就绪结果给维护入口，失败/无结果保留选择，旧历史兼容入口及已保存回放绑定保留。
- 最终TypeScript/Vite构建及真实浏览器七项通过，包括两来源H4与固定图表产物相同、
  深链接/旧入口/恢复、三桌面宽度、键盘和200%内容缩放；无pageerror或实时需求。
- [回测搜索阶段](verification/three-layer/replay-search-stage.md)。仍需旧Watch组合输入与策略搜索、
  多品种并发/恢复/口径配置和48小时质量；完整目标继续，未推送/PR，MT4后续。

### 2026-10-07：四类Watch固定组合输入与默认策略搜索

- 新增独立固定输入绑定/判断审计，四类既有策略共用组合周期产物；历史分批预热与恢复、
  接缝政策、确认/覆盖/拥有者门槛、过期事件抑制、事务outbox与逻辑防重完整接入。
  旧规则状态结构与旧绑定保留；新实时策略默认组合搜索，回放入口不改变。
- 真实Dukascopy→OANDA EURUSD：价格/回落/SMA/抽样报价就绪并在无图表时持续推进，
  前日突破因真实D1覆盖缺口保持warming并保留固定输入证据。第二轮39.062秒准备，
  HTTP/MCP身份、幂等写和固定图表OHLC一致；浏览器桌面/键盘/缩放/刷新/取消通过。
- 迁移ak38先私有备份并实际恢复核对；仅本次验收Watch取消，最后主动需求归零、来源inactive、
  stream拥有者释放。推送禁用；首轮真实五条全部ready失败保留，不掩盖日线质量门槛。
- [策略阶段报告](verification/three-layer/composite-watches-stage.md)。完整A–E继续：来源完整参数、
  大目录搜索、真实日界/映射修订、多品种并发和整体质量观察未收口，48小时观察尚未启动。

### 2026-10-07：OANDA 原生完整参数与独立配置图表

- 数据中心支持 Bid/Ask/Mid、smooth、日对齐小时/IANA时区与周对齐；保存不可变配置，
  实际请求、缓存、周期身份、报价与图表使用同一口径，默认ticker/cache保留。
  图表直读供应商柱；第二层/组合日界不受影响，自定义日历的原生告警仍有验证门槛。
- 真实OANDA四套配置21组周期页面与原始OHLC/量/确认一致，缓存隔离和分页通过；
  三种时区九组周/月窗口核对DST、闰年与换月结束，相邻供应商开始时间一致。
  实际许可图表H4/D1/MN与刷新通过；三桌面宽度、键盘、200%缩放通过。
- 最终全量1056 passed/223 skipped/245.41s；相关105项、实际PG20项、最后报价/日历24项通过。
  Build/Ruff/JS/diff通过；首轮夹具/脚本与标签问题、失败日志及实际限制保留。
  [原生参数阶段](verification/three-layer/native-parameters-stage.md)。
- Ubuntu16629/16630健康，migration ak38；本轮无资源清理，磁盘外部变化后约59GB可用。
  完整A–E继续：规模搜索、实际日界/映射修订、多品种并发/恢复、完整审计及48小时观察；
  新观察未启动，无推送/PR，MT4后续。

### 2026-10-07：三层大目录纯搜索与分页选择

- 三层明确分页，平台完整目录、自建最新可用版本、组合当前账户映射与启用修订身份；
  SQL按来源公平排序，限定候选检查数量，HTTP/MCP共用游标，保留旧列表接口。
  策略/回测筛选、准备状态和图表弹窗分页；请求中禁用旧行，取消/无结果保留绑定。
- 全量1063 passed/226 skipped/337.28s；随后当前映射修复相关19 passed，实际PG4 passed。
  真实1380个Dukascopy目录项可达；HTTP/MCP共66页无重复和采集副作用。
  实际许可图表、桌面宽度/键盘/200%缩放、深浅主题、取消焦点及503重试通过。
  sandbox阻止表单关闭已改显式关闭，失败证据保留；Build/Ruff/JS/兼容/diff通过。
- [搜索分页阶段报告](verification/three-layer/search-pagination-stage.md)。Ubuntu16629/16630，
  本阶段无迁移/清理，约55GB可用，无需用户协助。完整A–E尚需实际日界/映射修订、
  多品种并发/来源故障恢复、完整审计及单独48小时观察；新观察未启动，无推送/PR，MT4后续。

### 2026-10-07：真实NY17/UTC0修订与PostgreSQL轮询溢出修复

- 实际修订暴露毫秒JSON时间戳转INTEGER溢出导致历史worker退出；改BIGINT。
  真实时间戳21任务轮转合同修复前PG1失败，修复后PG8通过、本地11通过；仅恢复本任务worker。
- 真实Dukascopy→OANDA EURUSD/XAUUSD派生UTC0、准确新映射、幂等准备/启用及明确恢复NY17通过。
  2496/2360根M1与共享分块一致，无派生供应商下载；各13个H4/3个D1独立OHLC核对通过。
  UTC准备20.181/18.159秒，恢复12.134/14.103秒，限已有短历史/缓存；旧钉住图表与Watch不迁移。
- [日界修订阶段报告](verification/three-layer/calendar-switch-stage.md)。脚本初轮422/过早读取
  未发布M1及PG溢出失败保留；最后两组合NY17、测试Watch取消、活跃图表需求零，Ubuntu健康。
  无用户决策/权限/容量卡点，56GB可用。多品种并发/来源故障恢复、自建DST历史样本、完整审计与
  单独48小时观察继续；新观察未启动，完整目标未完成，无推送/PR，MT4后续。

### 2026-10-07：十品种、多图、维护并发与实际两分钟断线恢复

- 确认 REST 最多两路网络等待，保留跨进程额度与串行拥有者/epoch提交；鉴权失败不继续批量，
  取消后不提交完成的同批响应。历史周期产物工作成功后使用既有忙碌等待，避免每块误等5秒。
- 全量1067 passed/227 skipped/253.80s；历史本地25/实际PG16，确认本地37/实际PG20通过。
  最后实际adapter受控HTTP401/429与生命周期实际PG10 passed/9.88s；与真实供应商故障分开。
- 十品种/八图格/十历史复查任务同时运行，单stream拥有者、所有复查发布、固定策略不迁移。
  五分钟100次轮询、50预期确认分钟完整，来源确认p95/p99=11.112/11.405秒；
  缓存读取p95=52.647ms，43有效策略判断p95/p99=30.664/32.191秒，另11恢复基准完整披露。
  精确同输入判断链显示主要额外等待在聚合：该环节p95=20.450秒，完成后判断p95=1.376秒，
  分位数不可相加；额外主机回归负载与短窗口限制保留，不能宣称48小时质量通过。
- 实际只停精确pricing-worker120秒，十策略暂停，历史可读，重启84.831秒恢复；
  实际PG拒绝受控旧epoch heartbeat，无合成价格。初次脚本字段422/图表入口错误保留。
- 最后完整八图浏览器三项复验通过，末尾固定绑定不变；仅本次十条Watch取消、两个工作区删除。
  实际50.180秒后图表租约/所需来源/活跃拥有者归零，所有来源inactive，容器等待后续需求。
- [并发恢复阶段报告](verification/three-layer/concurrency-recovery-stage.md)。Ubuntu16629/16630，
  migration ak38，56GB可用，无用户协助卡点。剩余自建DST样本、完整审计与独立48小时观察；
  新观察尚未启动，完整目标未完成，无推送/PR/生产变更，MT4后续。

### 2026-10-07：真实日历组合样本、维护并发与桌面缺项修复

- 两来源两品种的春/秋DST及换月12项实际下载发布通过，50,605根M1；
  NY17/UTC0共享原始内容、不变manifest、派生无下载。后续HTTP独立复核24份固定发布，
  实际执行21/22点日界、167/169小时周桶及双月桶断言，不将启动后新增断言算入旧结果。
- 使用存储真实OANDA价格，在独立PG schema明确有界历史重放12组Dukascopy→OANDA，
  实际preparation/input/持久聚合/chart链路通过，分段量与unknown保留；
  不等于默认实时首次使用或来源会话完整性验证。所有重放schema已清理。
- 维护设置加入锁内配置修订检查，双窗口409保留输入并显式载入最新；真实浏览器通过。
  指定区间复查、固定父版本差异和映射/组合详情入口补齐；成功响应丢失后的真实重试
  返回同任务，worker发布、原父manifest及暂停计划不变。HTTP/MCP共用只读清单对比。
- 最新桌面审计11页面、三宽度/200%内容缩放/键盘/恢复/表单焦点通过，997文字样本通过；
  首轮真实对比度4.388:1问题已修复。最后全量1069 passed/233 skipped/254.71s；
  实际PG18 passed/27.95s，最后筛选/MCP3 passed/11.19s，TypeScript/Vite/Ruff/diff通过。
- [日历与桌面阶段报告](verification/three-layer/calendar-desktop-audit-stage.md)，保留完整失败分母。
  Ubuntu16629/16630健康，ak38，DB约268MB、有效需求/stream拥有者0、51GB可用；
  完整逐项审计、删除影响细节、容量与新48小时观察继续，观察未启动；目标未完成，不推送/PR，MT4后续。
