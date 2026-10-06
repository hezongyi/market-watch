# Ubuntu 行情接入验收实例

实际环境：Ubuntu 22.04.5，本机 Docker Compose project `market-watch-data-integration`。
网页地址：http://127.0.0.1:16589/market-data 。API 与 PostgreSQL 不向宿主发布端口。
数据库为 PostgreSQL 14.24，独立网络、`integration-postgres` volume 和 `integration` 数据库。
`integration_restore` 也是本任务的备份恢复校验数据库。未在 unraid 创建验收实例。

当前分别交付[实现验收](implementation-acceptance.md)（通过）和
[质量验收](quality-acceptance.md)（未通过，后台观察中）。实现先提交PR，后续问题另提交修复PR。
2026-10-06 06:41/06:42UTC两个旧宿主观察进程失败退出，规则日志明确ENOSPC；
六个实例容器仍运行。经授权清理已完成实例与缓存后，已恢复新的独立窗口，
预计10月8日18:47（新加坡时间）结束观察。原JSONL、未完成尾记录及窗口元数据已归档，
不将旧时长拼接为新窗口。连续48小时是工程观察方式，不是SDK官方要求或提交PR的前提。

## 启动与停止

命令从 `/home/quant/repos/market-watch-data-integration` 执行。
当前进程尚未继承新 Docker 组时使用 `sg docker -c`；新登录已继承组后可以直接使用 Docker。
`runtime.env` 用 raw 格式注入容器，不用于 Compose 插值，避免密码 hash 中的 `$` 被解释。

```bash
# 仅首次准备。只选择 OANDA/行情代理凭据，生成新的数据库和页面密码；不复制生产 DB 配置。
PYTHONPATH=backend .venv/bin/python scripts/prepare_data_integration.py --source-env /home/quant/repos/market-watch/.env

sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml up -d --build api oanda-worker history-worker aggregation-worker web'

# 实际 PostgreSQL 定向验收；测试使用独立临时 schema。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml run --rm verify'

# 只停止本实例，保留十年导入检查点、观测与不可变版本。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml stop'
```

管理员验收密码只保存在被忽略、权限 0600 的 `artifacts/data-integration/login.json`。
通知网络发送关闭，不运行通知投递 worker。MT4 实时行情按用户要求留到后续。
禁止广泛删除 Docker 资源；不要使用全局 prune。本实例 `stop` 不删除 volume。

## 可复现检查

```bash
# 创建幂等样本/固定十年任务，或输出无凭据当前报告。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml exec -T api python - report' < scripts/data_integration_acceptance.py

# Chromium 缺系统依赖时，可使用本机已有的隔离 Playwright 依赖目录。
cd web
LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu node tests/data-integration.browser.cjs
```

浏览器检查桌面/手机、三个浏览器、浏览器断连恢复、三品种共享采集、固定版本演练推进。
`scripts/fault_oanda_acceptance.py` 只暂停/重启本 project 的 OANDA worker，实际故障结果保存为 JSON。
验收期间的暂停/重启已记录，不从正常价龄统计中偷偷移除。

```bash
# 本地响应/过滤接缝；其他请求仍用真实 OANDA。结束恢复本 project 的常规 worker。
.venv/bin/python scripts/fault_oanda_responses.py unauthorized
.venv/bin/python scripts/fault_oanda_responses.py rate_limited
.venv/bin/python scripts/fault_oanda_responses.py single_symbol

# 十品种需求约 7 分钟，结束后本次需求自然过期；常驻两品种保留。
.venv/bin/python scripts/load_oanda_acceptance.py

# 真实报价生成本地信号/通知，外部投递仍关闭。
.venv/bin/python scripts/verify_live_signal_acceptance.py

# 原始已发布版本内容/精度/unknown 分区审计；十年版本发布后可加 --minimum-years 9。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml exec -T api python -' < scripts/verify_history_snapshot.py

# 已发布十年版本的真实 API 回放、步进/定位和同源再导入固定输入校验。
.venv/bin/python scripts/verify_ten_year_replays.py
# 恢复上述真实已保存十年回放并核对图表和未来隐藏。
cd web
LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu node tests/data-integration.ten-year.cjs
cd ..

# 两品种持续 M1 规则；结束窗口后只取消本工具拥有的规则。
.venv/bin/python scripts/sustained_m1_watches.py status
.venv/bin/python scripts/sustained_m1_watches.py cancel
```

API 镜像更新会短暂中断 HTTP；在开始正常负载/长观测窗口前完成部署并等待 readyz 与采集恢复。
中断窗口单独记录，不把重新运行的成功结果覆盖成第一次就通过。

## 持续浏览器观测

`web/tests/data-integration.observe.cjs` 是 Ubuntu Chromium 验收工具，从现有本地登录文件认证，
只把时间分桶、状态和错误计数写到忽略的 `artifacts/data-integration/browser-sustained.jsonl`。
两个交易日窗口默认观察 48 小时，覆盖开市、维护与跨日；仅开始进程不能证明验收已达标。
页面正常订阅与工具 SSE 都不创建上游 stream。源时钟误差仍单独说明。

从 worktree 根目录可安装/启动本任务专用用户 service：

```bash
mkdir -p ~/.config/systemd/user
cp docs/verification/data-integration/browser-observation.service ~/.config/systemd/user/market-watch-data-integration-browser.service
systemctl --user daemon-reload
systemctl --user start market-watch-data-integration-browser.service
systemctl --user status market-watch-data-integration-browser.service

# 停止只结束本任务浏览器观察，不停止其他任务或行情实例。
systemctl --user stop market-watch-data-integration-browser.service

# 输出当前真实窗口摘要，保留所有 SSE 错误及不健康状态。
.venv/bin/python scripts/summarize_browser_observation.py artifacts/data-integration/browser-sustained.jsonl
```

原 03:06 UTC 窗口因 API 部署触发观察工具 EventSource CLOSED 而中断，保留
[原窗口](sustained-observation-window-interrupted.json)及原 JSONL。工具补齐 15s 心跳超时重连，
真实 Chromium 本地 502→恢复验证见 [重连证据](observer-reconnect.json)。
03:50 窗口为工具续期修正而停止，[该窗口](sustained-observation-window-pre-renewal.json)保留。
04:04窗口后来因宿主磁盘写入失败退出；[旧窗口](sustained-observation-window-disk-interrupted.json)
及[原始归档](observation-restart-archives.json)保留，不拼接旧时长。
当前新窗口于 **2026-10-06 10:47:53.719UTC** 启动，计划至 **2026-10-08 10:47:53.719UTC**。
浏览器PID2233613；起点/代码版本见[窗口记录](sustained-observation-window.json)。
工具每 12 小时重新登录并重载真实页面，保留续期事件；
默认账户会话为 24 小时。[实际续期验证](observer-auth-renewal.json)在续期后继续收到 55 个心跳，
无 SSE 错误。此 service 不设置自动重启或开机启用。实例停止前也应停止观察。
小时版本再导入固定 replay 的证据、生产备份 Ubuntu 恢复与源日历适用性研究都在本目录，私密
原始备份只存忽略目录，生产机器只读检查，不在那里创建验收实例。

当前窗口摘要使用 `summarize_browser_observation.py ... --since 1791283673719`，
后端 M1 完整分钟起点为 `1791283680000`。不将原窗口空白或部署迟到混成新窗口正常样本。
持续 M1 验收规则于 04:08 UTC 建立；其 armed_at 与首次 last_event 独立记录，
预警计算验收从规则真实存在并完成首次判断后统计，不能回填到浏览器窗口起点。
规则使用远离市场的价位保持 M1 计算活跃，不人为制造信号；先前真实触发样本另有证据。

按 UTC 小时与欧美观察时段输出有界持续验收报告，无需构建镜像或重启服务：

```bash
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml exec -T api python - --since 1791283680000 --evaluation-since 1791283680000' < scripts/sustained_live_report.py
```

该工具使用 PostgreSQL 只读 repeatable-read 快照，最多查询72小时，保留每个完整分钟的分母，
分别报告未知、有记录但未确认、没有观测记录、失败、迟到和补数。源到接收时差的直方图精度为10ms；
成功确认的 p50/p95/p99 使用 nearest rank，与缺失/失败分母同时输出。

`attempts`/`failed_attempts`按请求覆盖的每个分钟记录累计；一次三分钟重叠请求可增加三条记录，
不能当作独立REST请求数。失败过的分钟后来确认成功仍保留失败计数；其last_result会被成功覆盖，
不能用最终值重建失败类型或发生时刻。实际已恢复失败分钟见
[06:03UTC快照](sustained-live-recovered-failures-checkpoint.json)与[明细](m1-recovered-failed-minutes.json)。

`--evaluation-since` 表示首根合格柱的**收盘时刻**，还会按验收规则真实 armed_at 限制；
没有本工具规则时不输出计算样本。
现有审计仅证明入库与规则计算阶段完成，不包含逐规则执行记录，也不能独立证明规则一直活跃。
当前规则状态/last_event、[规则起点](sustained-m1-watches-start.json)和观察记录需共同评估。

伦敦、纽约工作日08–17点只是观察分组；黄金纽约17–18点标 candidate，不构成已认证会话或闭市。
`--until` 可限制时段，但分钟级期望、尝试及报价累计仍是采样时数据库中的最终状态，
不能把该参数当完整的历史事件重建。首次实际报告见
[有界持续快照](sustained-live-report-checkpoint.json)，短窗口仍不代表两交易日验收。
后端 `accepted_quote_update_rate` 按已接受、去重的stream更新计数除以完整源分钟的经过秒数，
分母包含闭市、unknown和无观测分钟；总体与每小时/观察时段均输出，不从成功报价筛选分母。
浏览器 `visible_quote_update_rate` 单独记录：仅有一个明确started窗口时才输出速率，
从started到最后完整block的经过秒数包含启动、失败/无心跳块和记录间隙；多个窗口不会拼接速率。
一秒快照可能合并多个源更新，每次重新加载的首条报价可能被重新计数，浏览器可见更新率
因此不能替代上游更新率，更不能当全tick频率。实际统计与分母回归见
[更新率测试](update-rate-tests.txt)。
当前浏览器计划结束为10月8日10:47:53UTC；持续规则计算自新窗口10:48UTC起独立统计，
不能将创建前的几分钟回填成实际规则执行。

## 持续逐规则只读观察

`scripts/observe_sustained_rules.py` 每15秒读取本实例的规则与live状态，只保留起点文件中的
两个验收watch ID及已核实品种身份。记录last_event、暂停原因、tradeable、行情质量、连接世代、
缺失规则/来源及HTTP失败；不创建/修改规则，也不重启采集。原始文件为忽略且0600权限的
`artifacts/data-integration/rules-sustained.jsonl`，不含价格、账户目录或cookie/token。
工具每12小时重新认证，每小时取得接收机NTP的offset/root distance/jitter测量；
各轮采样还记录UTC与monotonic时间差，保留时钟跳变和长请求间隔。

```bash
cp docs/verification/data-integration/rule-observation.service ~/.config/systemd/user/market-watch-data-integration-rules.service
systemctl --user daemon-reload
systemctl --user start market-watch-data-integration-rules.service
systemctl --user show market-watch-data-integration-rules.service -p MainPID -p ActiveState -p SubState
.venv/bin/python scripts/summarize_sustained_rules.py artifacts/data-integration/rules-sustained.jsonl
# 只停止本任务的规则观察；若停止整个验收实例，也先停止此service。
systemctl --user stop market-watch-data-integration-rules.service
```

首次采样的last_event是基线，不计为本工具观察到的执行；跨分钟跳变只证明末尾状态已推进，
不能推断跳过分钟逐次执行。`rule_close_to_poll_upper_bound`包含请求和15秒轮询，属于
逐规则收盘到被观察的**上界**，不与后端阶段耗时混成同一分布。暂停/失败/缺失和未推进区间
全部保留，规则列表与live列表为先后请求，不能冒充同一数据库快照。

两分钟真实工具验证含一次认证续期、实际规则推进和NTP采样，见
[规则观察工具验证](rule-observer-validation.json)。正式窗口起点/计划结束及PID见
[规则窗口](rules-observation-window.json)，[当前摘要](rules-sustained-checkpoint.json)保留短窗口进展。
当前规则PID2233614，窗口10月6日10:47:48UTC至10月8日10:47:48UTC；旧窗口已归档。
该窗口不回填到04:08规则创建时刻，不拼接磁盘中断前的时长。
此service无自动重启或开机启用，每次start/finish都追加记录；不把多个片段拼成无中断窗口。

## 05:01 UTC 健康状态接口更新

实时快照新增 `cooldown_until`：共享来源REST预算的活动冷却截止UTC毫秒，没有活动冷却时为null。
它不表示stream报价失效，也不取代报价/完成柱独立就绪状态。小数毫秒向上取整，其他来源的
冷却不混入OANDA快照；SSE签名包含该字段，冷却开始/到期即使没有新报价也能发布。

[修正验证](cooldown-health-tests.txt)28项通过；Ubuntu Docker中
[12项验证](cooldown-health-container-tests.txt)包括独立PostgreSQL临时schema的读取和过期测试。
[运行记录](cooldown-health-runtime.json)保存仅API重新创建和认证GET核对；
从部署准备到API验证共28.998秒，**不是纯HTTP不可用时长**。
两个观察PID、OANDA/历史/聚合worker及数据库/web容器ID均保持不变，上游仍为epoch49。
[代码核对](cooldown-health-code.json)确认API已更新，保留worker的采集、租约、确认函数逐一相同，
只有未被worker调用的快照函数版本不同。后续启动新worker会使用已构建的新镜像。

浏览器与规则JSONL均追加deployment_started/finished，两个窗口元数据保留部署分段与代码指纹。
不能再称这些窗口全程采用同一API代码或HTTP无中断。
[浏览器恢复](cooldown-health-browser-recovery.json)保留3次SSE错误；
[规则恢复](cooldown-health-rules-recovery.json)保留2次502采样失败，恢复后两watch继续推进新的M1。
逐规则摘要保留部署事件，额外[8项回归](rule-deployment-summary-tests.txt)通过。
原始错误不删除、不重启窗口来掩盖；计划结束时间保持原值，最终按实际分段和全量失败分母评估。

05:21UTC的首个无心跳块及后续SSE重新打开/恢复见
[观察空白块上下文](observer-silent-block.json)。当前摘要保留zero_heartbeat_blocks和最大块间隔，
不能用SSE errors没有增加推断全程没有观察空白。同期宿主压力作为上下文记录，未证明为根因；
两个观察进程和规则计算仍在运行，未重启或清理其他任务资源。

05:27UTC[完整分钟快照](sustained-live-pressure-checkpoint.json)记录EUR首个超过30秒的M1确认，
当前82个确认样本的p99为32.005s，超过候选30s目标；两品种missing/fail均0。
[迟到明细](m1-first-late-detail.json)保留源收盘、REST接收、入库及计算阶段flush时间。
这些时间不足以区分供应商可用性、请求调度和网络耗时，不能借同期宿主压力推断原因。
最终验收必须保留该迟到样本及整个已知应存在分母；当前短样本不代表最终长期结果。

## 当前结果与限制

后端与 PostgreSQL 测试记录、截图、容器快照与故障 JSON 位于本目录。
两品种十年版本已发布且全量原始内容校验通过。EURUSD 新版 `ny17-observed-v2` 为六位精度，
XAUUSD 为三位精度；来源会话均保持未核实。
持续采集尚未达到两个交易日，价龄没有独立时钟偏差校准。
短样本与故障恢复结果不代表完整 P0–P2 验收已通过；最终状态见
[接续开发记录](../../market-data-integration-progress.md)。

## 来源会话与不可变元数据

`ny17`/`utc0` 只定义聚合相位。显式数据集没有经过核实的来源会话时，未观测分钟保持 unknown，
周末或黄金暂停不能仅凭相位判成闭市。真实来源 M1 与会话冲突时保留原值、记录审计，并阻止
用冲突会话证明该聚合桶完整。旧非显式品种保持既有规则。

OANDA 配置 `ALERTS_OANDA_CALENDAR_PROFILES` 是按 `EUR_USD`/`XAU_USD` 索引的 JSON 对象。
每个 profile 的 `revision` 必须与新的 `ALERTS_OANDA_CALENDAR_VERSION` 一致。profile 含
`source_session`，字段如下；凭据和账户完整 ID 均不属于 profile：

| 字段 | 要求 |
| --- | --- |
| source/channel/environment/provider_symbol | 精确匹配数据集，如 oanda/v20/practice/XAU_USD |
| account_scope | public 或既有数据集的 sha256 指纹，不能借另一账户的会话 |
| timezone | IANA 时区，例如 America/New_York；按当地周规则跟随 DST |
| reviewed_start/reviewed_end | 有限、含时区的整分钟日期范围；范围外继续 unknown |
| evidence_url/applicability | HTTPS 一手来源和该账户产品、地区、期间的适用性说明 |
| weekly_closures | 有序且不重叠的 `{start,end}`，当地周一 00:00 起算分钟，范围 0–10080 |

`weekly_closures` 应只包含已经核实的完整闭市分钟内部，公告边界与已有真实柱冲突时保留边界。
跨周区间拆为两个区间。额外 `closures` 也必须有来源适用证据且位于 reviewed 日期范围内。
当前账户地区/法律实体及十年历史例外仍未核实，实际运行未启用经过认证的 source_session。

身份、精度、volume 和 profile 一经绑定不能原位改写。得到新证据后注册新 calendar_version；
历史修正可用 `history_derivation.derive_version/derive_page` 从已校验的不可变原分块派生，禁止
从可修订 staging Bar 复制。未完成父任务必须停止写入、等待租约结束并带明确原因隔离。
分块、M1、观测覆盖与检查点逐页提交，崩溃后从提交位置恢复；发布保留 parent/checksum provenance。
精度溢出明确为 `price_precision_overflow` 配置故障，不取整、跳页或无限网络重试。

本实例 EURUSD 六位精度修正脚本是幂等工具，运行后保留原五位任务与已发布小时版本：

```bash
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml run --rm --no-deps -T api python -' < scripts/derive_precision_acceptance.py

# 撤销既有候选聚合中缺乏观测证据的 complete；保留 M1、价格、历史分块和固定回放。
sg docker -c 'docker compose --env-file artifacts/data-integration/compose.env -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml run --rm --no-deps -T api python -' < scripts/revalidate_candidate_acceptance.py
```

长观察期间部署必须在 `sustained-observation-window.json` 添加分段和实际恢复时间；浏览器
原进程继续采集 SSE 断连与状态，不能把部署前后拼成同一代码版本的无中断验收。
