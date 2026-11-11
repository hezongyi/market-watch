# 价格告警可靠性实施任务书

状态：实施中。任务在独立 `feat/price-alert-reliability-v203rc1` 工作树推进；当前证据与未完成项见 `docs/verification/price-alert-reliability-v203rc1/README.md`。本文的全部完成条件保持不变。

## 1. 接手入口与固定基线

- 项目：Market Watch；主仓库 `/home/quant/repos/market-watch`。
- 用户指定基线：`v2.0.3-rc.1`。
- 已核实 tag 指向：`ef57bed61f66715a4c5ec2797f9abd67cb23d2fb`。
- 方案工作树：`/home/quant/repos/market-watch-alert-plan-v203rc1`。
- 方案分支：`docs/price-alert-reliability-v203rc1`。
- 建议实施工作树：`/home/quant/repos/market-watch-price-alerts-v203rc1`。
- 建议实施分支：`feat/price-alert-reliability-v203rc1`。
- 本文是实施的需求和验收依据，不依赖原聊天或解释网页。

2026-11-10 已 fetch 核实。该 tag 包含供应商图表加载候选变更，不能以当时 `origin/main` 的 `746839d3` 或本地主线 `f111d3a6` 替代。本文涉及的告警核心代码与前次分析一致。

旧工作树 `/home/quant/repos/market-watch-price-alerts` 基于旧提交，其中旧方案不是本次执行依据。保留它以及其他 agent 的所有工作树，不清理、不 reset、不迁移其未提交文件。

从以下命令开始；同名路径或分支已存在时先检查归属，确认是本任务再续做，不能覆盖：

```bash
cd /home/quant/repos/market-watch
git fetch origin --tags
test "$(git rev-parse 'v2.0.3-rc.1^{commit}')" = ef57bed61f66715a4c5ec2797f9abd67cb23d2fb
git worktree list
git worktree add -b feat/price-alert-reliability-v203rc1 \
  /home/quant/repos/market-watch-price-alerts-v203rc1 \
  ef57bed61f66715a4c5ec2797f9abd67cb23d2fb
cd /home/quant/repos/market-watch-price-alerts-v203rc1
cp /home/quant/repos/market-watch-alert-plan-v203rc1/docs/price-alert-reliability-v203rc1-implementation-plan.md docs/
cat AGENTS.md
```

tag 校验失败必须停止并报告差异，不跟随移动后的 tag。所有业务改动以这个提交为祖先；若后续为 PR 集成新主线，单独记录集成提交与冲突处理，保留指定基线的可追溯性。

## 2. 目标、范围与成本约束

用户为个人使用、个人开发和维护。优先实现价格告警的可靠、简洁、低维护运行：规则启用后，系统持续判断；不能完成时，主动说明原因和影响；恢复后继续有依据的监控。

本次必须完成的闭环：

1. 简单价格条件只要求其实际需要的输入。
2. 本机成功接收并提交的有效价格观察不会被最新快照覆盖而漏判。
3. 确认收盘柱按进度顺序判定，可重启续做。
4. 临时断线保留用户启用意图；不能判定的区间留痕并通知。
5. 规则执行状态、触发结果、通知结果分别明确。
6. 真实 PostgreSQL 事务、迁移和 Ubuntu 隔离实例通过验收。

### 2.1 本期支持的规则

继续只允许从现有组合行情创建。新增一个明确的价格规则分类函数：

- `condition.left.kind == price`；
- 没有 ATR offset；
- 比较目标为 `constant` 或无限水平线 `horizontal_line`；或者现有固定价格区间条件；
- 支持现有 `cross/cross_up/cross_down/above/below/enter/exit/break_upper/break_lower`；
- 支持 `intrabar` 与 `close`；
- 沿用项目现有九周期 M1、M5、M15、M30、H1、H4、D1、W1、MN，不增加周期。

水平射线有起点语义，不自动归入无限水平线。指标、斜线、射线、ATR 继续使用原评估路径。可共用执行异常的通知入口，但不改变它们的判定、首次观察和恢复语义。本期不得以复杂规则仍有旧限制为由宣称它们已达到价格规则的新保证。

### 2.2 不在本期实施

- 新供应商告警入口、自动换源、自动切换组合修订。
- 全模块重写、通用策略平台、独立消息中间件、逐规则线程或进程。
- 全市场 tick 永久归档、用 OHLC 高低点推演盘中路径。
- 扩展历史修复和 30 天实时窗口、自动更新历史基线。
- 改变指标算法及正常图表聚合结果。
- 外部存活检测服务、生产发布、正式 tag、合并 PR。

可靠性保证只覆盖取得且可验证的输入。REST 形成中 K 线 close 仍是抽样，供应商未提供的瞬时路径无法补造。整机断电期间只能恢复后报告中断；实时离线提醒需要外部机器，属于后续范围。

## 3. 必须先读的实现与已知问题

所有路径相对实施工作树；行号以指定基线为参考。

| 文件 | 作用与关注点 |
|---|---|
| `backend/alerts/chart_alert_application.py`、`chart_alert_api.py` | 创建准入、能力接口、规则展示及判定记录接口，现仅 composite 可执行 |
| `backend/alerts/chart_alert_service.py` | create/edit/lifecycle/consume，幂等和单事务保存；到期前置判断 |
| `backend/alerts/chart_alert_domain.py:186` | 纯条件判定；first observation 建基准；above 与 cross_up 同义 |
| `backend/alerts/composite_alerts.py:139,494` | 绑定与评估；通用依赖、自动暂停、重建基准 |
| `backend/alerts/chart_alert_worker.py:212,437` | 只扫描 active；逐条事务，异常处理 |
| `backend/alerts/alert_monitor.py` | 250ms 默认轮询、发布唤醒、运行心跳 |
| `backend/alerts/live_pricing.py:405,465` | 流式最新 quote 覆盖；REST 当前 close 接收事务 |
| `backend/alerts/composite_quotes.py:94` | 流式 Bid 与 REST close 样本的不同口径 |
| `backend/alerts/market_usage.py` | 规则持有准确绑定数据集需求；旧 stale_input 暂停特例 |
| `backend/alerts/composite_inputs.py`、`composite_aggregates.py` | 固定输入版本、聚合水位、按序读取 |
| `backend/alerts/composite_series.py` | source_confirmed 只证明已有成员，不能单独证明窗口全部拉取完成 |
| `backend/alerts/live_confirmation.py`、`confirmed_minutes.py` | 确认水位、拉取错误与来源证据 |
| `backend/alerts/composite_price_confirmation.py` | 已有 D1 原生 OHLC 核验特例，不扩大为多级兜底 |
| `backend/alerts/notification_sources.py`、`notification_center.py` | 同事务 notice_source、持久事件、去重投影 |
| `backend/alerts/notification_runtime.py`、`notify.py` | 角色故障通知、发送重试、401/403 blocked |
| `backend/alerts/chart_alert_health.py` | 当前只统计 active，漏列 coverage_pending |
| `backend/alerts/storage.py`、`migrations/versions/` | 表结构与增量迁移 |
| `web/src/advanced/ChartAlertsPanel.tsx`、`chartAlerts.ts`、`useAlertData.ts` | 状态、条件文案、列表刷新 |
| `web/src/advanced/ChartAlertDialog.tsx`、`nativeAlertUI.tsx`、`advanced-host/chart-alerts.js` | React/原生告警入口与显示一致性 |
| `web/src/notifications/` | 异常与恢复展示、深链接、发送状态 |

基线中明确存在：价格也经过历史覆盖检查；开市超过输入有效期可改为 paused；收盘只取最新柱；恢复/漏柱/迟到会重建基准；异常主要是 health 字段；已有事务 Outbox 值得保留。

旧测试 `test_composite_alerts.py::test_missed_and_expired_events_establish_baseline_without_notifications` 验证旧语义。应针对本期价格规则调整断言并新增恢复测试，不能删除整个文件，也不能把复杂规则的保护一并放宽。`test_composite_alerts_postgres.py` 直接引用多个测试函数，重命名时同步维护。

## 4. 已确定的业务行为

### 4.1 创建、条件和边界

- 创建成功表示已保存；只有后台已接管且取得有效基准/判断进度，才显示“监控中”。
- 继续拒绝错误身份、账号不匹配、无效价格口径、已冻结绑定等创建请求。
- 价格规则准入按触价/收盘分开；不再要求无关的历史图表产物全部准备完成。
- 首次基准不触发；`above/below` 保持既有越界语义，不偷偷改为“当前满足即触发”。新建价格表单可去掉与上穿/下穿重复的选项，旧规则和 API 仍兼容；详情明确“首次建立基准，之后越界触发”。
- 上穿是 `previous <= threshold && current > threshold`，下穿相反。到达等值本身不算越过；触价表示盘中观察时机。
- 区间入/出继续按真实相邻有效观察端点判断，不用分钟高低点重建路径。
- 新建/编辑/手动恢复在事务中确定监控起点。触价在与采集一致的锁保护下抓取有效当前样本、日志位置和固定阈值作为基准，随后处理位置之后的观察。基准、需求登记与规则保存必须原子提交，避免注册与采集之间漏一段。
- 若无可用触价基准，明确拒绝本次启用；不得返回“监控中”后无限等待。收盘使用生效时刻前最近一个可验证、同源同周期的确认柱作基准；没有则标记准备中，由第一根合格柱建基准，不追发创建前的事件。
- 编辑/主动恢复重新界定监控区间；用户主动暂停期间不追补为告警。restart 的 run/count 行为沿用现有实现。
- 日期、周期与交易日界仍按固定绑定计算，不能靠当前图表 head 或当前账户默认值重解释旧规则。

### 4.2 输入依赖

**触价**：仅要求绑定仍有效、来源身份/价格口径正确、样本在采集时有效，并遵守采集模式。普通价格条件不要求历史聚合水位、之前 M1 齐全、历史 seam 在 30 天内或 `LiveState.ready` 所代表的全量历史恢复完成。必须拆清“价格输入可用”与“历史确认准备完成”，不能简单删除 owner/epoch/来源校验。

**收盘**：要求时间结束、已有成员全部来源确认、确认拉取已覆盖判定窗口，并且该窗口没有尚未处理的已知拉取故障。读取固定 input_revision 对应的聚合柱。当前 quote 是否新鲜不阻止消费已确认的历史柱。

外汇正常缺少部分 M1 时，若窗口已成功查询确认且无未解决采集缺口，按实际有效 K 线判断 close；保留 coverage 信息，不能修改其真值。仅有 `source_confirmed=True` 不足以确认窗口查询完整。优先复用确认水位及现有拉取证据；确实缺少证据时，仅补一个确认窗口事实，不另造覆盖框架。

保持与图表相同的周期、日界、源和 close。不能未经用户决定切换到另一种日线报价。已有 D1 核验可保留，但不能成为所有周期的必经门槛。

跨不同来源接缝不比较价格跳变。窗口超出现有可读历史/实时范围、冻结绑定或需要换修订时，明确“需处理”，记录受影响区间和建议动作。不得把窗口限制静默改为最新输入建基准。简单触价不受无关历史窗口到期影响。

### 4.3 中断、恢复与休市

| 情况 | 必须采取的行为 |
|---|---|
| 判定 worker 暂停，采集日志连续 | 按游标消费积压，不因为时间变老或 worker 重启重建基准 |
| 来源实际断开、采样不可用、输入保留范围丢失 | 记录中断区间并通知；不跨未知区间推演穿越 |
| 触价恢复且存在无法还原区间 | 第一条恢复有效观察建新基准，保存中断结果；继续未来观察 |
| 收盘已补齐可信确认柱 | 按序补判；保存真实发生时间和发现时间 |
| 收盘柱缺少必要确认 | 等待现有确认流程；进度停滞后明确需处理，不跳到最新柱 |
| 已确认正常休市 | 展示休市；先处理已到达的最后收盘柱，不丢弃闭市前积压 |
| 正常休市后同源重新开市 | 正常日历边界不构成故障；保留比较基准，按下一有效观察判断开盘跳变 |
| 账户失效、绑定身份变化、显式关闭实时开关 | active 意图保留，运行 blocked/需处理，主动通知；尊重显式关流，不偷偷重新打开 |
| 用户 pause/archive | 停止未来判断及本规则新增需求；不自动恢复，不撤销已提交事件 |

采集模式发生 stream/REST 切换时，不跨不同观察契约比较；记录模式变化和可能未观测的区间后建立新基准，正常恢复通知中注明口径。

不能仅因 epoch 变化就清空基准。必须用持久记录区分“输入连续但进程换代”“正常休市”“实际未观测区间”。无法证实连续时，记录缺口并建立恢复基准；不能伪称连续。

恢复通知不能抹去缺口记录。例如：“当前已恢复监控；10:01—10:04 未能判定是否触发”。缺口上下界不精确时明确它是可能受影响区间，禁止伪造精确断线时间。

### 4.4 到期与通知

- 定义有效区间：输入发生时间在本次启用起点之后、到期时刻之前；到期时刻恰好发生的观察不触发。
- 到期停止新采集需求；有效期内已取得且可验证的积压输入允许结算。不能让现有 `detected_at >= expires_at` 提前 return 吞掉这些结果。
- 到期后的结算按有限批次继续，页面显示“已到期，结果结算中”；它不是仍在监控。处理完可读输入后终结；缺失部分留出明确结果，不无限等待未来补齐。
- 结算只能处理固定版本/run/启用区间，不能以此让 paused/archived 规则继续触发；次数上限仍有效。
- worker 显式选择 price-v2 且带未完成结算标记的 expired 规则；consume 对这个受限入口验证事件时间和截止位置。不要把 detected_at 伪装成过去时间来绕过旧到期检查，也不要全局放宽其他规则的生命周期校验。
- 迟到阈值及 `late_delivery` 保持现有约定。迟到信号始终保存；`log_only` 不发价格手机消息，`notify` 发并标记发生/发现时间。不能再在上游将迟到输入吞为 baseline。
- 规则因次数用完显示“触发次数已用完”；投递继续独立处理，不能显示为“手机已送达”。
- 新建/启用时选择手机通知却缺 topic 或全局关闭发送，返回明确字段级错误。网络/权限验证失败在运行阶段形成发送受阻，不在创建事务内请求外网。
- 沿用网页/手机偏好与静默时段。规则运行故障始终持久记录，网页显示；选了手机提醒的规则通过既有 system 通知路径发送故障/恢复提醒。手机配置随后失效时不得把故障消息成功写入 Outbox 当成已经通知到人。
- `server_accepted` 只表示服务端接受；设备收到继续依赖真实回执。发送失败不能递归生成无限“发送失败通知”。

## 5. 实现结构与持久性要求

建议新增三个小模块，名称可按仓库习惯微调，职责不得散落复制：

1. `price_alert_inputs.py`：价格观察登记、顺序读取、游标范围和清理。
2. `price_alert_evaluator.py`：规则分类、触价/收盘输入准备、连续性及批次推进；复用 domain 和 consume。
3. `chart_alert_execution.py`：执行结果/故障状态转移、持久异常事件和通知入口。

不要引入新的通用策略基类或插件注册框架。`chart_alert_worker` 先分类，本期规则走新价格路径，其他规则保留原路径。原公共身份校验提取复用；不能通过整体关闭 composite 校验来减依赖。

### 5.1 价格观察日志

用现有 PostgreSQL，加增量迁移。推荐两张紧凑表：

- `PriceAlertStream`：每 dataset 一行，保存最后分配序号、已裁剪序号/时间范围、登记开始时间等必要事实。
- `PriceAlertInput`：`(dataset_id, sequence)` 主键，保存 kind、价格、发生/接收时间、采集模式、epoch、来源事件标识及最小验证证据。kind 区分有效价格与影响连续性的中断标记。使用精确 Decimal/字符串口径，不转换为 float。

约束：

- 仅有本期启用触价规则需求的 dataset 写观察日志；恢复中的规则仍贡献需求。无需求不持续写 tick。数据库查询/锁保证首条规则启用登记与采集衔接，不能仅依赖数秒缓存。
- 采集接收、最新状态更新与日志 append 同事务提交。流式和 REST 接收入口都覆盖；重复接收不重复 append，重放可幂等。
- 按 dataset 串行分配单调序号，且序号与数据同事务提交。源时间戳不是唯一标识；同毫秒不同有效价格都要保留。
- 统一锁顺序，遵循既有 dataset→LiveState 顺序；采集事务不反向锁 ChartAlert。consumer 不得持有新 Stream 锁再等待旧 dataset 锁。提供真实 PG 并发测试证明创建、采集、清理和判定没有反向等待。
- 样本是否有效按其接收时事实判断。判定积压时不能拿“当前报价年龄”否决已合法记录的历史观察；其迟到属性独立处理。
- 保留连接/模式变更及已知拒收对连续性的影响。采样/日志写入失败不能保持“连续无缺口”的假象；恢复时必须能识别中断，至少记录保守区间。
- consumer 每条规则保存最后已处理 sequence，同一次事务提交游标、条件状态、次数、信号、通知及 Outbox；回滚后从原游标重试。
- sequence 与 `Observation.occurred_at` 分离；不得把数据库序号当时间。事件身份包含 dataset/sequence，另保留 rule version/run 去重。重启和重复输入最多产生一个逻辑事件；HTTP 发送重试仍可能重复抵达，不承诺外部 exactly-once。

默认保留上限可直接采用：最多 24 小时、每 dataset 100,000 条、全局 1,000,000 条，先达到者生效。记录这些默认值及对应日志大小实测；仅在验收数据证明必要时调整，并同步任务书和测试。它们是资源边界，不是可无条件补判 24 小时的承诺。先清理所有有效 consumer 已处理的旧数据；硬上限仍必须有效。

裁剪未消费输入时，在删除同一事务中推进裁剪边界并持久记录受影响区间；worker 恢复后即使原日志已不存在，也能识别游标落后。不能靠主键不连续推断丢失。清理使用有限批次，在现有循环定期执行，不加新部署角色。

### 5.2 收盘消费

- 复用 `CompositeAggregateBar`/固定输入版本和现有聚合，不另建全部周期行情副本。
- 使用“已处理周期终点 + 有限分页”读取后续柱，避免每条规则每轮 `chart_page(count=2000)`。
- 同一批固定 input_revision；只有所需范围已聚合才判断。全局更新水位正在前进不应让已确认旧范围永远无法消费。
- 第一根未决柱阻挡其后跨越比较；若该范围被证实无供应商观察，保存 no_observation 结果并按既定日历和连续性处理。没有柱不等于已经证实休市或无交易。
- 同一历史柱后续修订不重复触发、不改写既有信号证据；保存修订影响，必要时重新建立未来基准。未判柱使用此次固定版本的有效数据。
- 现有 30 天边界导致输入不可读时明确结论，不扩展历史机制。若当前纯 target 周期可从已有有效物化柱确认，不应仅因旧 seam 年龄就拒绝；必须验证该柱构建时没有截断所需分钟，尤其 MN。

### 5.3 状态、执行证据与巡检

沿用 status/health/runtime，增加必要 runtime 字段及兼容 API 投影：

- 接管时间、最后有效判定时间、处理位置、最近输入时间、执行状态起始时间；
- 当前 reason_code、下一次合理期待输入时间、待结算标记；
- 未解决故障标识与最近无法判定区间摘要。

last_checked 表示 worker 看过规则，last_evaluated 表示实际处理过有效观察；不能互相替代。相同输入等待时无须每轮写完整审计，更新时间可合并。不要为每个 tick 再存一份庞大的 CompositeJudgment JSON；保留有界输入、最新无触发进度，长期保留信号、基准切换、缺口及生命周期事件。

对本期价格规则，运行故障不修改用户的 active；health/runtime 表示 preparing/monitoring/closed/recovering/blocked 等执行情况。API 可复用旧 health 枚举并给出明确执行投影，避免破坏旧客户端。

复用 Audit→notice_source→通知中心；扩展上下文允许 alert_id/version/run 与查看规则的链接。故障转移与源事件同事务写入，投影失败可重试。故障去重键包含规则/run/故障实例；恢复关闭对应实例，随后再发生允许新实例。单条规则去重为本期必需，多规则根因合并为可选，不阻塞交付。

将任务巡检放入现有 notification runtime 的健康循环，与 evaluator 分开，覆盖后台未接管/处理停滞。沿用角色级心跳，不新增监督进程。默认时间策略：

- 触价样本有效性沿用现有来源约定，流式/REST 分别解释；失效即记录 recovering，不 pause。
- 临时故障持续 60 秒再发手机故障提醒；永久错误及已确认不可补判缺口立即通知。短暂中断仍留站内记录。
- 启用 60 秒未被接管，或已经存在待处理输入 60 秒没有推进，记执行停滞。无新输入且正常休市/未到收盘时间不误报。
- 收盘期待时点按该规则下一周期结束与交易日历计算；给确认/发布留 `max(120 秒, 3×实际确认轮询周期)` 宽限。已有确认故障立即记录原因。
- 不设置额外重复催促体系；每次故障开启一次、实际恢复一次。沿用现有角色级持续故障提醒。

上述时间是首版默认值，可集中成常量或现有配置，不增加用户必须填写的表单。验收用可注入时钟，不靠真实睡眠数分钟。异常当前状态要即时可见，通知延后不等于状态延后。

## 6. 旧数据兼容与迁移

风险分类：F1，涉及持久输入、规则进度、后台链路和数据库结构。要求增量迁移、实际 PG、Ubuntu 故障恢复验收及独立 Standards/Spec review。

- 迁移前记录 Alembic head；新增 revision 只接指定基线实际 head，不复制过时 down_revision。
- 保留 ChartAlertVersion、SignalRow、CompositeJudgment 的不可变历史。新字段有兼容默认值，不批量修改老信号、次数及用户配置。
- 新价格路径保存 `execution_contract=price-v2` 等明确执行契约；旧 timestamp sequence 不能当作新日志 sequence。
- 对旧 active 价格规则逐条幂等接管：收盘可从可信原游标继续；触价无法重建升级前未保留的路径，记录一次接管边界/未保证连续区间，再建当前基准。不得悄悄宣称升级前未遗漏。
- 老 paused 规则保持暂停，不能根据模糊中文原因字符串批量自动启用。对于 runtime 中有明确 stale_input 证据的旧自动暂停规则，生成一次需处理提示，用户可明确恢复。
- expired/completed/archived 不自动重开。暂停但已到期的规则要展示真实到期事实；旧数据兼容更新不能使其重新贡献采集需求。
- 新版价格故障状态转换不会制造旧 paused 记录。手工关闭实时开关不被自动打开。
- 升级和重启幂等，通知投影积压不丢。增加存量 active/paused/expired/completed、已有信号及 pending Outbox 的迁移用例。
- 代码回退不能让旧 evaluator 把新日志游标当时间戳继续运行。验收需证明：回退前停本任务写入者，并将 price-v2 规则保持暂停/不可执行；旧信号和 Outbox 可读取。仅新增列兼容不足以声称行为可回滚。
- 不通过 downgrade 删除事件或日志。测试库可按本任务初始化；真实实例的数据回退/删除需要另行授权。

## 7. 按依赖顺序实施

### 步骤 1：基线与行为测试

核对第 1 节 SHA，读 AGENTS 与第 3 节入口。建立本地 Issue 草案，记录 F1。先添加能复现“快照覆盖、收盘跳柱、自动暂停后不恢复”的行为测试。用例穿过真实模块接口，不仅测试新辅助函数。

### 步骤 2：输入日志及迁移

新增日志和 stream 表、迁移、采集同事务写入、保留边界；先完成 stream/REST 两种模式、同毫秒样本、重放及裁剪用例。此时可暂不切换消费者，但必须验证登记首条规则的竞争条件。

### 步骤 3：价格规则分流与触价

实现分类函数、按模式准入、创建基准、顺序消费、有效事件时间、事务游标。改造 worker 的选择逻辑与 market_usage，保留复杂规则旧路径。串行 worker 保留，每条规则每批最多 256 个观察或 128 根收盘柱，积压轮次继续，避免一条规则独占循环。

### 步骤 4：收盘进度和恢复

实现确认窗口语义、稀疏 M1、固定版本分页、迟到、日历边界、修订及到期结算。先消费已确认输入，再决定当前是否休市/断流。所有 cannot-evaluate 路径都有稳定 reason_code 和区间证据。

### 步骤 5：执行状态与通知

集中处理故障转移，接入通知中心及 system Outbox；补充独立巡检。区分可恢复输入问题、需人工动作、未观测区间和通知发送失败。修正 health 汇总，覆盖 blocked、recovering、coverage_pending 及旧自动暂停记录，不能以 active 数量为唯一健康依据。

### 步骤 6：界面与兼容接管

列表和详情显示真实执行状态、最后判断、未判定区间及通知状态。更新 React 与原生图表告警入口的同义文案；新建与快捷新建一致。实现旧规则幂等接管，完善暂停、编辑、次数上限、到期及通知点击链路。

### 步骤 7：隔离 PG 与故障验收

按照第 8、9 节运行；记录实际结果。功能检查通过后，仅围绕本任务测一次资源和延迟，除非有失败或新改动，不重复全量折腾。

### 步骤 8：交付

完成自审和适用的独立 Standards/Spec review、CI；整理文档及候选说明。执行 agent 得到“继续开发”授权后可按 AGENTS 创建 Draft PR。PR 清楚标注基于 rc.1，其中预取基线尚未并入目标分支时，不能把它冒充本任务改动；与 main 的集成另行记录。

不合并、不打正式 tag、不切换常驻开发实例、不发布生产。交付可验收的隔离地址和运行命令，由用户决定后续动作。

## 8. 验收矩阵：必须有真实可复现结果

| 编号 | 场景 | 必须得到的结果 |
|---|---|---|
| A01 | 创建、重复请求、多个创建入口 | 单一规则；准确起点/基准；未接管不显示监控中 |
| A02 | 关闭全部浏览器 | 后台采集与判断继续 |
| A03 | 阈值 100，连续收到 99→101→99，worker 之后才运行 | 一次上穿；信号证据含中间 101 |
| A04 | 两条不同价格具有同毫秒源时间 | 两条均可消费；源重发不重复 |
| A05 | 50 条规则共享品种，多品种混合 | 日志按品种共享；每规则独立游标和次数 |
| A06 | 在游标/事件提交前故障，在提交后重启 | 前者回滚可重试，后者不重复信号/计数/Outbox |
| A07 | stream 与 REST close 采样 | 各遵守真实口径，不把 REST 称逐笔触价 |
| A08 | 判定暂停但采集不断，积压超过 120 秒 | 保留条件连续性；按 late_delivery 保存/投递 |
| A09 | 实际断线后恢复且价格越过阈值 | 缺口主动可见，恢复基准不伪造穿越；之后新穿越正常触发 |
| A10 | 超过日志保留上限后恢复 | 检出裁剪区间，绝不显示无中断；日志大小有界 |
| A11 | 连续多根收盘柱积压，含中间穿越再回落 | 按序补判；次数上限决定停点；不只读取最后柱 |
| A12 | 当前报价过期，但此前收盘柱已确认 | 该柱正常判定；当前供源问题单独呈现 |
| A13 | 正常稀疏 M1 与真实断线缺口 | 前者不阻塞简单价格 close；后者需确认/报告，不能伪装完整 |
| A14 | 周末/休市、DST、W1、MN、最后闭市柱 | 正常休市不报错；最后柱不丢；周期日界正确 |
| A15 | seam 老化、窗口越界、冻结修订、账户改变 | touch 不依赖无关历史；实际无法执行有原因和动作，无自动改源 |
| A16 | pause/resume/edit/restart 与判断并发 | 原版本/run 的事件不能落到新版本；主动暂停区间不追判 |
| A17 | 到期时有未处理但有效期内输入 | 结算后有确定结果；到期及之后输入不触发；无永久结算中 |
| A18 | 指标/斜线/ATR/水平射线规则 | 不被错误分流；原有关键测试通过 |
| A19 | 故障、重复检查、恢复、再次故障 | 每实例去重；恢复对应；保留不能补判的区间 |
| A20 | worker 存活但不推进、worker 被杀 | 现有独立 notifications runtime 检出，网页有持久结果 |
| A21 | 无 topic/发送关闭、HTTP 500、401/403、超时、静默时段 | 配置错误明确；可重试错误重试；blocked 可见；server_accepted 不冒充设备到达 |
| A22 | 旧库升级/重复启动/故障回退流程 | 不丢旧事件与计数、不自动启用旧 paused、不误读新游标 |
| A23 | 全链路浏览器查看 | 登录后可创建、看状态、查看故障/恢复及历史信号；新进页面无需重新激活规则 |
| A24 | 裁剪/创建/消费/采集的 PG 并发 | 无锁顺序反转、无先提交游标后丢输入、无跨 dataset 乱序 |

性能验收固定负载：10 个 fixture 品种、50 条价格规则、总计 40 条有效观察/秒，持续 10 分钟。记录主机竞争负载、CPU/RSS、DB/日志大小、采集提交 p95、从已提交输入到信号提交 p95。

正常无故障目标：信号提交 p95 ≤2 秒，无持续增长积压，无输入/事件丢失；采集提交 p95 相对同基线同负载增加不超过 20% 或 20ms（取较宽界限）。故障注入期间另报，不能混入正常延迟。若主机竞争使测量无效，报告具体证据及未验收项，不伪称通过，也不为压测扩大到多实例或更高负载。

## 9. 验证环境和命令

### 9.1 本地静态/单元检查

Python 3.11+、锁定依赖；Node 按 CI 采用 22。从本任务 worktree 执行，不改其他工作树的虚拟环境。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install -e . --no-deps
.venv/bin/python -m pytest -q \
  backend/tests/test_chart_alert_domain.py \
  backend/tests/test_chart_alert_service.py \
  backend/tests/test_chart_alert_worker.py \
  backend/tests/test_composite_alerts.py \
  backend/tests/test_chart_alert_api.py \
  backend/tests/test_chart_alert_health.py \
  backend/tests/test_market_usage.py \
  backend/tests/test_live_pricing.py \
  backend/tests/test_notification_center.py \
  backend/tests/test_notification_runtime.py \
  backend/tests/test_notify.py
npm --prefix web ci
npm --prefix web run build:ui
git diff --check
```

追加本任务新增测试。对实际修改的 Python 文件运行 ruff，遵循 CI 配置。按 CI 运行适用前端脚本；不要盲跑有硬编码旧地址的历史 browser 脚本。

### 9.2 必须先创建的验收资产

以下文件在基线中不存在，执行 agent 须在步骤 7 创建，并纳入 PR：

- `docs/verification/price-alert-reliability-v203rc1/compose.yaml`：独立 PostgreSQL 14.24、migrate、api、market-runtime、data-worker、notification-worker、web/网关及本地通知接收 fixture。应用镜像用下方任务标签；需要完整源码与测试的 runner 使用只读源码挂载和私有输出目录。
- `scripts/price_alert_acceptance.py`：受控 fixture、并发/故障恢复、性能记录；参数 `--config FILE --output FILE`。配置含仅本任务数据库/端口/project，先检查归属，拒绝常驻开发/生产连接。直接调用真实采集、评估、投递模块；不能用脚本直接插入最终 SignalRow 代替链路。
- `web/tests/price-alert-reliability.browser.cjs`：读取 `MW_ALERT_ACCEPTANCE_CONFIG` 指定的私有配置，走真实登录、接口和界面，不用 route mock 代替后端。
- 新 PG 测试 `backend/tests/test_price_alert_reliability_postgres.py`：沿用现有 task-owned schema fixture，缺 PG 时 skip，但验收时不得 skip。
- `README.md`：逐项记录矩阵结果、实际命令、主机/端口、提交、镜像、迁移前后 revision、资源、启动/停止命令及限制。

已有 R1 preview 默认禁用真实行情/通知且不带完整链路，不能单凭 R1 /readyz 宣称本任务验收通过。这里做 Ubuntu 本机隔离的定向 R2，不复制生产库。

准备私有目录，例如 `/home/quant/.local/share/market-watch-private/price-alerts-v203rc1`，目录 0700、配置 0600。生成本任务独立账号、密码、topic 和数据库凭据。合成行情必须明确为 fixture，不注入其他实例。通知接收使用本地 fixture；没有用户额外授权时不向真实手机 topic 发送测试消息。

启动前只读检查：

```bash
docker compose ls
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}'
ss -ltn
free -h
df -h /home/quant/repos /var/lib/docker
```

执行 agent 按检查结果选择空闲端口，写入私有 config/compose.env。不得占用或停止其他任务。所需服务及资源不足时报告事实，保留现场；不要转到 Unraid。

### 9.3 构建与启动模板

以下命令在上节资产、许可图表库和私有配置准备完成后才可运行。Compose 内镜像字段、env_file、runner 和端口由执行 agent落实，不能把未创建模板写成已验收命令。

```bash
export MW_ALERT_PRIVATE=/home/quant/.local/share/market-watch-private/price-alerts-v203rc1
export MW_ALERT_PROJECT=mw-price-alerts-v203rc1
export MW_ALERT_COMPOSE=docs/verification/price-alert-reliability-v203rc1/compose.yaml

mw-docker build --repo . --component api --tag market-watch-api:price-alerts-v203rc1 \
  --task mw-price-alerts-v203rc1 --project mw-price-alerts-v203rc1 --purpose acceptance
mw-docker build --repo . --component web --tag market-watch-web:price-alerts-v203rc1 \
  --task mw-price-alerts-v203rc1 --project mw-price-alerts-v203rc1 --purpose acceptance

docker compose --env-file "$MW_ALERT_PRIVATE/compose.env" -p "$MW_ALERT_PROJECT" \
  -f "$MW_ALERT_COMPOSE" config --quiet
docker compose --env-file "$MW_ALERT_PRIVATE/compose.env" -p "$MW_ALERT_PROJECT" \
  -f "$MW_ALERT_COMPOSE" up -d --no-build
```

migrate 先于应用写入者执行；默认隔离数据库为空，使用 fixture 生成所需组合、确认柱和规则。迁移兼容另在本任务 PG 的独立测试 schema/库上建立 rc.1 旧结构后升级，不能仅测试 Base.metadata.create_all。

PG 连接字符串从私有配置加载到环境，不输出。PG 服务版本必须为 140024。既有测试读取 `TEST_POSTGRES_URL` 和 `CHART_ALERT_TEST_DATABASE_URL`，均须指向本任务数据库；只读检查 URL 归属后再跑。

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_chart_alert_postgres.py \
  backend/tests/test_composite_alerts_postgres.py \
  backend/tests/test_live_pricing_postgres.py \
  backend/tests/test_market_usage_postgres.py \
  backend/tests/test_notification_outbox_postgres.py \
  backend/tests/test_price_alert_reliability_postgres.py

.venv/bin/python scripts/price_alert_acceptance.py \
  --config "$MW_ALERT_PRIVATE/acceptance.json" \
  --output docs/verification/price-alert-reliability-v203rc1/acceptance.json
MW_ALERT_ACCEPTANCE_CONFIG="$MW_ALERT_PRIVATE/acceptance.json" \
  node web/tests/price-alert-reliability.browser.cjs

docker compose --env-file "$MW_ALERT_PRIVATE/compose.env" -p "$MW_ALERT_PROJECT" \
  -f "$MW_ALERT_COMPOSE" stop
```

上述 Python 命令若在宿主运行，由 Compose 仅向 127.0.0.1 暴露任务 PG 端口；也可在 task runner 内运行，并在 README 固化实际命令。每项检查必须记录通过/失败/跳过。最终按 CI 运行规定检查，不用 SQLite 成功替代 PG 事务验收。

stop 保留 volume。永久删除、归档和退役按 AGENTS 与 mw-docker 规则处理，不顺手 prune。浏览器认证状态、env、token、许可库和完整私有配置不进入 Git 或输出报告。

## 10. 完成条件、可自主决定事项和停止边界

完成必须同时满足：

- 第 2 节闭环完整落地，不以“异常状态已显示”替代输入连续消费。
- 第 8 节适用矩阵通过；不通过项明确记录，不能将其标成完成。
- PostgreSQL 迁移/并发/回滚故障测试实际运行，关键项无 skip。
- 独立 Ubuntu 实例及真实页面验收，有可访问地址、开始/停止命令和证据。
- 增量资源可接受，未引入新的消息平台或逐规则后台进程。
- 自审、适用独立 review 和 CI 证据齐全；最终 PR 描述与实际范围一致。
- 没有修改、停止或删除其他任务和常驻实例；未合并或发布生产。

执行 agent 可自行决定模块私有函数名、表字段的具体类型、测试组织、可用端口及已有帮助函数复用方式。保持本文行为与数据保证即可，不为这些选择反复询问。

遇到以下情况停止相关依赖动作并报告：指定基线 SHA 不符；价格来源/口径只能通过改变用户规则才能继续；现有确认事实无法区分可用 close 与真实未知区间且必须扩大供源机制；资源/许可库/凭据缺失使验收无法执行；发现必须做破坏性迁移；需要合并、正式 tag、切换常驻实例或生产操作。仍可继续独立的代码、单元测试和文档工作，不能冒称完成受阻验收。

最终交付包含：实现提交范围、相对 rc.1 的差异、状态/恢复行为变化、已验证与未验证项、实例及命令、Draft PR（已获开发授权时）、剩余风险。不把任务末尾变成新的大规模重构建议。

## 11. 给执行 agent 的启动指令

> 读取 `/home/quant/repos/market-watch-alert-plan-v203rc1/docs/price-alert-reliability-v203rc1-implementation-plan.md`，按其中固定基线 `v2.0.3-rc.1`（`ef57bed61f66715a4c5ec2797f9abd67cb23d2fb`）及仓库 AGENTS.md 实施价格告警可靠性改进。建立本文指定的独立实施分支和 worktree，按步骤完成开发、迁移、适用测试、Ubuntu 隔离验收、review、CI 和 Draft PR。关键业务规则以本文为准；日常实现选择自行决定，不逐步请求确认。不得使用旧 price-alerts 分支作为基线，不得改动其他工作树或切换常驻实例。完成后报告证据；不要合并、打正式 tag 或发布生产。
