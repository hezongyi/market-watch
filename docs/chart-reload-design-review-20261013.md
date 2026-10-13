# M1 与 Supertrend 连续刷新：补充设计审查

日期：2026-10-13。工作树 `market-watch-chart-reloads-20261013`，分支 `diagnose/chart-indicator-reloads-20261013`，代码基线 `be636948a4bb67db1012104ae89fae2ad0500a97`（v1.25.2）。

本轮读取交接、根因记录、修复方案、CONTEXT、三个 ADR、生产采样摘要，并复核后端与原生指标适配代码。执行本机诊断与数值可行性验证；没有实现业务修复、登录新的生产观察窗口或发布。原有 UI 静默改动及诊断红用例保持不变。

这是对 [原修复方案](chart-reload-fix-plan-20261013.md) 的补充审查，不替换 [原始根因与生产证据](chart-reload-root-cause-20261013.md)。新增模拟场景与已捕获生产事件分别标注。

## 结论

已观察分钟的留存与实时报价新鲜度被混在同一套读取条件中，是已确认的撤柱根因。撤柱触发整图重载，随后 REST 补回较早分钟再次触发历史重载；原生指标适配器真的撤销结果，所以 Supertrend 消失并非只有提示文字。

推荐保持 Python 为唯一指标数值来源，先完成共享观测留存、一致的展示输入、递归展示后缀与按原因刷新。公共历史刷新保留为真实修订的正确回退。主价格私有原子替换是后续独立验证项，当前不能承诺所有修订场景零闪烁。

仅添加分钟队列、延长 15 秒阈值、取消 reset 或只隐藏 preparing，都不足以达到目标。新增队列必须同时修正分页与实时缓存，并处理检查点已越过未确认分钟的情形。

## 1. 证据的确定程度

| 判断 | 证据及限制 |
| --- | --- |
| 跨分钟、报价年龄 16 秒让已显示 M1 消失 | 本轮重跑真实 `publish_event → chart_data` 用例，2 failed，pytest 用时 0.96 秒。原诊断在交接前也已稳定失败。 |
| 撤柱/补回导致 Supertrend 实际清空 | 既有生产 150 秒 trace 两组 `tail_retracted → history_changed`，两次非初始 study rows=0。不是新生产采样。 |
| 多分钟队列不能直接沿用当前指标代码 | 本轮真实 `chart_results` seam 输入三根未确认展示柱，仅输出第一根；独立 provisional step 与顺序递归从第二根开始数值不一致。 |
| 后柱先确认会漏掉前方待确认展示输入 | 本轮使用真实确认记录、聚合、fixed run，再向展示页加入前方待确认观察；`chart_results` 输出的临时分钟集合为空。此为方案边界模拟，当前生产没有多柱留存。 |
| 同样价格的较早分钟首次确认仍触发 reset | 本轮真实 `CompositeMinuteInput → delivery` 重放；确认前后送入 native 的 time/OHLC/volume 投影相等，仍返回 `history_changed`。模拟确认交接，不声称原生产两个事件的 OHLC 完全相同。 |
| 固定输入版本无法标识临时价格版本 | 本轮加载真实 coordinator 的 Node seam 重放：主价格仍对应观测 7，HTTP 已读到观测 8；同一个 input_revision=1 的新值仍被应用。适配器和 HTTP 为受控替身，没有证明生产某次闪烁由此触发。 |
| 原 10 分钟中的一次 M1 回调回退 | 缺少那条逐事件载荷，仍未完成精确归因；不把两次后续 reset 链等同于那一次回退。 |

原窗口 23 个 reset 不应全部归为同一个 bug；图格与自选表瞬时差值需按来源、quote/source 时间与接受版本对齐。未复现的 load failed 保持原任务边界。

## 2. 当前实际生命周期

### 报价与临时柱

[live_pricing.py](../backend/alerts/live_pricing.py) 的 `publish_event` 对账户 owner、epoch、序号和来源时间进行 fencing，事务中更新 `LiveState.quote/forming`。forming 已持久化，但只有一个当前分钟槽位；新分钟直接替换旧分钟。`begin_connection` 在新 epoch 开始时清空 forming。

已有 `LiveMinute` 只保存来源观测与确认统计，如 quote_count、确认时间和延迟；它不保存 OHLC。不能因为表名含 minute 就把它当待确认价格存储。

[composite_series.read_window](../backend/alerts/composite_series.py) 每次清理 worker bucket 中的 provisional 输入，再仅接纳当前 forming。接纳依赖 15 秒 quote/receive 新鲜度、有效拥有者、交易状态、报价有效性及 epoch。因此年龄变化、换分钟、重连或失去 owner 都可能删除此前显示的数据。

### REST 与组合确认

`commit_confirmation` 在一个 fenced 事务中调用 `apply_minutes(record(batch))`：canonical source minute、组合输入事件与输入版本一并写入。正常路径没有一个已提交的“source 已确认、该组合输入尚未提交”的独立窗口。其他调用者仍需遵守同样的源锁/组合准备锁顺序。

异步阶段是后续 `CompositeAggregateTask.applied_input_revision` 追平、fixed indicator run 生成与 native 展示接收。HTTP 价格读在聚合落后时可以有界回读固定 M1；fixed indicator build 则会等待周期聚合水位。`confirmed_end` 是最高已观察分钟的结束，不是区间内每分钟均存在的连续证明。

因此要分别处理“权威价格已经可读”和“匹配指标已经可展示”。让所有 indicator checkpoint 都推进后才能释放来源临时记录，会把数据保留绑到每个消费者的运行情况，容易造成无界等待。

### 图表交付与原生结果

[market_stream.py](../backend/alerts/market_stream.py) 的共享快照检测到窗口内柱被删除时发送 `tail_retracted`。消费者历史检查将 loaded_before 之前新增的确认分钟视为 `history_changed`，目前不区分其是否与已接受的临时价格相同。

[bridge.js](../advanced-host/bridge.js) 对 reset 增加 correctionVersion、清空尾部游标/历史接受状态，并走受控重载。coordinator 对 correction 调用全范围 `invalidate`；native adapter 的空 replaceRange 确实清除 study 行，随后重新读取。

此前另一次 Supertrend 修复解决过多 plot 携带完整指标前缀导致 `delivery_budget` 重载。当前方案必须保留按交付窗口裁剪值的行为；增加分钟留存和结果批次不能重新放大全前缀载荷。

## 3. 对现有方案的必要修订

### 3.1 一个共享的展示输入模块

建议新增专门的已观察分钟存储，例如 `ObservedMinute`，以完整 dataset identity、epoch、UTC minute start 为身份，保存 OHLC、来源/接收时间、序号和观测内容版本。最终类名由实施时沿用仓库风格确定。不要复用 `Bar`、`SourceMinuteRevision` 或 `CompositeMinuteInput`，这些是确认输入。

优先采用“当前分钟沿用 LiveState.forming，封存分钟写入独立表”：

1. 换分钟时，在同一 owner-fenced 事务内先封存旧 forming，再切换新 forming。
2. `begin_connection` 清空前先封存此前可留存的 observation；失去连接时冻结既有观测。进程异常退出时最后 forming 已在 DB，下次接管可封存。
3. 历史观测读取不再依赖当前 owner 的有效租约或 15 秒阈值；这些条件继续决定新实时输入及 quote_ready。
4. 留存只代表实际来源观察，不提高 complete、source_confirmed、coverage_complete 或 volume 可用性。

必须先定义“可进入展示观测”的条件。当前 forming 更新条件比读侧展示门槛宽，不能盲目把每个带 bid 的 forming 都作为可显示历史。非交易报价、无效价差、缺 ask、旧世代与迟到时间应有明确策略；新鲜度是观测当时的接纳证据，不是后来删除已接纳 OHLC 的理由。

同 dataset、同一分钟重连产生多个 epoch 片段时，保留片段来源，并定义确定的展示选择与显式 epoch 交接。新 epoch 的 live forming 不继承旧 epoch 的运行状态，不默默合并成完整当前柱。来源/账户变更按身份变更处理，不能把旧观察挂在新来源。

写入者的 epoch fencing 与来源分钟的确认身份需要分开：新 epoch 中合法提交的 REST 确认，可以接手同一完整来源身份、同一分钟的旧 epoch 历史观察。不能要求确认永久与观察同 epoch，否则重连前的待确认片段无法回收。接手时仍需核对来源身份、分钟范围与确认输入可读性；旧 epoch 的迟到写入继续拒绝，历史观察也不因此恢复 quote_ready。当前 `commit_confirmation` 对当前 writer/state 校验 epoch，而确认统计按 dataset/minute 查询，已体现这两个身份域的区别；新观测存储应保留该区别。

共享模块的外部 Interface 只需表达：获取选定展示输入快照、按固定范围读取分钟/桶、比较两个快照的受影响区间。合并、来源验证、确认优先级和版本校验集中在 Implementation。HTTP、分页、SSE worker 与指标计算跨同一个 Seam；`CurrentBuckets` 只是该读取规则的缓存 Adapter。

实施初期不引入另一套内存实现来绕过 DB：重启、刷新与多 API 进程应从同一持久状态重建。

### 3.2 队列留存必须同时改分页和缓存

只改 `read_window` 会漏柱：

- `composite_chart.chart_page` 只把当前 forming 加入 seek 候选；已有持久聚合时也只覆盖其一个周期桶。
- `CurrentBuckets.page` 缓存的是确认 base，再覆盖当前 forming/最后未时间闭合的确认桶。前方待确认分钟不在 base 中。
- 旧页 `before` 查询、首次加载与 worker 接管必须能找到“截至该 cutoff 的最新实际待确认观察”，不能只从确认输入和当前 forming 推断。

所有受影响桶从相同分钟集合重建，不能用累积 max/min 应对 REST 缩小高低点。当前 `Bucket.replace/remove` 已具备替换与惰性极值失效能力，可以沿用；缓存必须包含 observation 内容版本，并能在输入版本回退/身份变化时重建。

### 3.3 确认优先的读取与安全回收

对于一个确定快照，逐分钟选择：该组合固定 input_revision 中的确认值优先；缺少确认时使用该快照纳入的实际观察；没有观察就保留 gap。

确认写入不立即按 SourceMinute、LiveMinute.confirmed_at 或最高 confirmed_end 删除观察。先保证该组合输入已提交且确认读路径能接手，随后隐藏其临时重叠副本。物理 GC 独立于图表重算，遵守尚有效的展示快照引用/有效期和资源预算。固定 input_revision 查询继续完全排除 mutable observation。

若要让旧展示快照被指标 HTTP 重读，必须留有对应内容，而不是只有版本号。建议最小快照描述由不可变确认 input_revision + 已封存观察引用 + 接受时的当前 forming 副本组成；可用短租约的服务端持久快照。它按实际展示批次共享，不为每个图格复制多年历史；频率和保留预算要在 PG 压测后确定。

禁止把新字段叫 input_revision 后塞入旧固定输入语义。确认版本与展示版本是两个域。

### 3.4 多柱指标使用独立、顺序的展示状态

当前 `chart_results` 在临时支路第一根后 break；`IndicatorState.step(provisional=True)` 每次独立复制确认状态。删除 break 后逐根调用该方法仍不连续。

建议逻辑：

```text
affected = 最早未确认展示桶 / 本次修订影响桶
checkpoint = 在 affected 之前、且对当前确认输入仍有效的检查点
shadow = 从 checkpoint 复制出的展示工作状态
读取 checkpoint 之后至展示尾部的完整桶序列
按时间依次推进 shadow，保留真实 gap 的 reset/break
输出 affected 之后的全部展示结果与依赖证据
不写回确认 run.state、block、cursor 或输出
```

还要重算其中已来源确认的后续桶：其价格可已确认，但指标可能依赖此前未确认观察，指标仍属 provisional dependency。不能只给价格未确认的那几根结果打标签。

展示计算可以把已观察但未确认的 OHLC 作为算法输入，在副本中推进递归；原始柱的确认标志不能随之改写。真正缺分钟照旧中断状态，不 forward-fill。当前一页可能只含最新几根，读取必须涵盖 checkpoint 之后的完整依赖，不能只遍历 visible page。

检查点块当前每次最多 2000 根，回退可能落到较远块尾，甚至需要从 origin 初始化。第一版用有界任务继续构建，不能把无检查点的长历史重算塞入 HTTP。根据实测再增加必要的近期检查点密度。

Swing 有 preview/confirmed 统计和事件标志，不能用一个通用 complete=True 快捷方式让 preview pivot 变成 confirmed 事件。该指标需独立验证顺序影子状态与 presentation；本轮数值可行性只验证 EMA 和 Supertrend。

### 3.5 价格和指标必须锁定相同展示输入

现有 input_revision 只标识确认 M1。当前 tick、封存/留存分钟、连接世代与当前 quote 都可能在其不变时改变。bridge 的 tailVersion 是本地接受版本，没有随 HTTP 请求传入，也没有校验响应 OHLC 是否与 parent 一致。

建议给价格快照返回独立 `display_snapshot_id`（示意名称），绑定组合修订、固定输入、观察集合与当前分钟副本、聚合规则/日历和来源世代。指标读取请求携带该 ID；响应返回相同 ID、算法实际版本、参数 fingerprint、计算起点与可展示范围。

前端在入队与真正 native 提交之前都检查：当前 parent 接受快照、symbol/period/study generation、算法参数、结果序号与 snapshot identity。不能仅比较单调 input_revision，更不能把摘要 hash 当 numericRevision 比大小。adapter 保留固定版本字段，另加相等匹配的展示凭据。

普通 tick 可先更新价格，指标晚到时只允许与该价格一致的结果接手；迟到或过新的结果等待/丢弃。若严格要求父序列与 study 同一绘制帧更新，需另行证明跨两种 native 更新队列的原子契约。单独 study 的 applyBatch 原子性不足以证明跨父序列原子性。

频繁 tick 可能使“每次不匹配就丢弃”长期饥饿。故应支持精确快照读取，合并尚未提交的展示批次，并提供有界取消/超时/恢复；性能验收要包含最坏报价频率与 worker 延迟。

### 3.6 把首次准备、后台修复和展示就绪分开

目前 coordinator 对 pending fixed run 直接返回 pending，且 correction 先撤销全范围。即便价格已经连续留存，常规确认产生新 fixed run 后仍可能等待并消失。

建议区分：固定任务进度、该展示快照的结果可读范围、首次加载是否已有有效曲线。确认 worker 继续异步维护固定 run；展示计算可使用已验证的确认前缀和影子后缀提供同快照结果，不能只因 fixed run.status=pending 就全量清空。

普通确认的未受影响前缀保留。修订影响区间从最早依赖变化处起到有效展示尾部，利用指标 replaceRange 提交整个后缀。准备新结果后一次替换，避免先提交空结果再读；如果当前价格已采用新版本而结果尚未就绪，只能明确使该影响范围无效，不能把旧指标当新价格的有效值。

原有隐藏 preparing 的 JSX 改动保留；error/retry 继续展示。需要减少实际清空，而不是只减少通知次数。

## 4. 刷新事件契约

| 事件 | 价格处理 | 指标处理 |
| --- | --- | --- |
| 同一分钟有效 tick | 更新最新柱 | 从该分钟之前状态重试算，原子接手对应快照，不全量 reset |
| 下一实际观察分钟到来 | 旧分钟留存未确认、新分钟追加 | 顺序推进完整展示后缀，不推进确认检查点 |
| 15 秒无新报价/仅 heartbeat | 保留已观察 OHLC，更新实时状态 | 无新价格输入则不重算曲线；告警独立降级 |
| REST 确认与已接受 native 价格投影、指标输入相同 | 更新确认凭据/有效性；无需价格历史 reset | 相同数值交接与更新依赖证据；不空批清屏 |
| REST 改动最新柱 | 可通过最新柱回调更新 | 从依赖变化点重算后缀 |
| REST 改动已显示较早柱/填入真缺口 | 首版使用公共受控历史刷新 | 保留确定未受影响前缀，后缀重算并匹配新价格 |
| 来源/账户/组合身份、规则或参数变化 | 新 generation 与正确历史加载 | 相应身份完整失效，拒绝旧响应 |
| 结果日志超出恢复范围/预算 | 验证后受控恢复 | 按实际原因恢复，不一律伪装成历史修订 |

“同价确认”必须由消费者已接受的展示快照和实际 native 投影证明。不能仅看 `previous_source_revision_id is None`；这也可能是真正补缺。应比较 OHLC、实际 volume 渲染、桶时间集合及该指标依赖，而不是忽略所有输入版本变化。信息不足时走正确的受控刷新。

当前历史 fingerprint 的原始版本变化仍用于固定输入审计；展示事件另按 accepted snapshot 差异分类。否则即使跳过 delivery 中的首个 history_changed 检查，后面的 fingerprint 检查仍会 reset。

订阅 state 要保留/引用初次 HTTP 接受快照与本次接受凭据；改 delivery、shared commit 和 bridge 必须一起落地。服务器可以在已观察快照差异上统一计算受影响桶，消费者再按窗口裁剪，避免每用户重扫 M1。

## 5. 队列容量、长期确认延迟和告警

有限存储无法无条件承诺“供应商无限期不确认也永远保留所有新分钟”。实现必须写出容量例外，而不是设置 TTL 静默删柱。

建议同时限制每数据集热观察数、全局字节数、展示快照数/有效期和单次重算工作量。达到预警线时优先补采最早待确认窗口；达到硬上限时显式冻结/降级图表追加，保留已经承诺的展示范围，不让队列丢头造成尾部回退。当前报价采集与自选表独立更新。恢复以可验证新快照进行。预算值需用实际 payload/PG 读写测量确定，不随意把 15 秒改成另一个隐含删柱期限。

实时确认 `confirmation_window` 在 ready 后通常从 confirmed_end−2 分钟回看。若后方分钟已确认而前方长期未确认，那个观察会逐渐落到回看窗口之外；原逻辑不足以保证队列最终排空。新留存模块需要共享、有界、持久的补采需求，不能依赖刷新浏览器或每用户独立发请求。成功空响应不结束确认需求、不删观察、不证明闭市；补采遵守原 REST 预算、退避和 source fencing。

观测 GC 的证据必须是对应确认值/有效快照可重建，而不是最高 confirmed_end、定时器、一个成功查询或者任意 checkpoint 游标。

告警不是完全独立的调用者：`composite_alerts` 盘中模式会调用相同 chart_page/chart_results，而收盘模式与 ATR offset 使用固定确认输入。新增展示影子链必须与判定证据隔离，不能仅凭 provisional=True 把展示输出引入判断。保留 owned/quote_ready、此前分钟 confirmed_window、真实 gap reset、恢复不补发及稀疏 D1 原生价格证据要求。

需要特别断言：后柱价格已确认但指标仍依赖未确认前柱时，图表可以预览，确认告警不能消费这个指标；heartbeat 不能让过期报价恢复 ready；source/epoch 变化后的旧展示观察不建立新的实时判断前态。

## 6. 是否需要改成图表库本地原生计算

当前路径是原生 custom study 注册与渲染 + Python 数值 + 固定 v31 私有结果适配。库的公开 CustomIndicator.main 是同步计算契约，公开接口没有任意 Python 结果替换方法。已有 replaceRange 是我们对 study 的适配能力，不是主价格的公共替换方法。

Supertrend 若改成 JS/PineJS 同步计算，可以让指标直接跟随父序列；但父序列撤柱仍需先修复，Python 告警/回测与前端计算又会产生两套算法维护及一致性验证。用户已接受 Python 唯一数值来源，当前推荐先修输入生命周期与结果交接，不把算法迁移作为此次必要条件。

“100% 原生效果”还应拆分为呈现、算法与刷新：原生 study 的线/填色/参数生命周期已有实现；同 OHLC 的原 Pine 引擎导出尚缺，既有夹具不能证明所有算法行为等价；本次生产结果也表明实时连续性未达标。修复数据生命周期不会自动补齐这些证明。

Supertrend 的盘中 Buy/Sell 撤回是允许的预览行为；整份历史结果归零才是本问题。不能以禁止重绘为名固定不再随新价格改变的信号。

## 7. 可执行的实施顺序与验收

### 第一阶段：正确、可复现的展示输入

完成存储迁移、旧 forming 封存、统一读快照、HTTP 分页/CurrentBuckets 一致、确认优先合并与补采需求。把既有 2 个生命周期红用例变绿，并验证正常告警新鲜度仍按原规则下降。

### 第二阶段：准确的展示递归链

增加完整影子后缀、检查点选择、固定任务/展示就绪拆分和严格 snapshot matching。使本轮边界探针覆盖真实存储后的调用，而不是继续手工注入 page。确认顺序乱序、多页、checkpoint 落后/越过 pending、REST 极值缩小、真实缺口、Swing preview 统计一并验证。

### 第三阶段：减少重载与清空

实现 accepted snapshot 的同价确认分类、范围 correction、study 后缀替换、迟到版本 fencing。公共 reset 仅处理需要刷新已加载较早价格的数据变化及身份/恢复场景。记录每次 reset 的真实原因和受影响范围。

### 第四阶段：原生库验证与可选主价格适配

先在 Ubuntu 独立 PG/真实 Chromium 验收第一至三阶段。若正常确认的真实 OHLC 修订仍造成明显闪烁，再独立验证固定 v31 主价格替换；覆盖主价格 thread/cache、time-scale 索引、多个 pane 共源、study 结果、缩短尾部、prepend、drawing/视区、重连/世代及并发用户交互。未通过前继续正确的公共 reset，不假定 study adapter 可以直接复用。

验收最小矩阵：

| 场景 | 必须满足 |
| --- | --- |
| 跨分钟；REST 延迟 5/20/90 秒 | 已接受观察不消失；多个 pending 的递归值正确；普通追加不 reset |
| 16 秒无报价且 heartbeat 正常 | OHLC 不删除，quote_ready=false，告警不判断 |
| 后柱先确认；较早柱后来修订 | 从正确检查点重算完整后缀，后柱指标依赖仍如实 provisional |
| REST 同价交接与 high/low 缩小 | 同价无多余整图清空；真实修订高低点/方向/后续结果与完整重算一致 |
| API/worker 重启、owner 更换、同分钟重连 | 页面重读与 worker 接管集合一致；旧 owner 写入拒绝；无跨世代冒充 ready |
| 真实缺分钟/成功空响应/确认长期不来 | 不填柱、不伪确认；补采不漏旧 pending；容量降级显式且可恢复 |
| 多图/多用户、固定版本分页、频繁 tick/13+指标批量 | 快照一致、共享任务、无过期覆盖与请求饥饿；保持预算裁剪 |
| D1 稀疏确认/close 与 intrabar 告警 | 原价格认证和确认依赖不放宽；恢复不补发 |
| 至少 10 分钟真实浏览器跨多个整分钟 | 普通实时事件无 reset、M1 实时回调单调、有效 study 不反复归零；合法历史刷新另记 |

浏览器应观测真实 `study.data().size()`、原生价格/study 接受快照与有效值，而不只看 DOM 提示。每 10 秒采样不足以证明零短暂闪烁；用 native 更新事件及 requestAnimationFrame 在刷新窗口记录清空次数/时长。对合法 reset 后的历史重放和普通 subscribeBars 单调性分别判定。

## 8. 本轮验证与复现命令

既有生产症状反馈环（本轮已执行）：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch-production-pending-fixes-20261013/.venv/bin/python -m pytest backend/tests/test_chart_reload_diagnosis.py -q
```

结果：`2 failed in 0.96s`，两种触发均使观察分钟缺失。它们应继续为红，直到实施根因修复。

本轮独立审查探针位于受限本地目录 `/tmp/mw-chart-reload-review-20261013`，不自动加入常规测试集：

```bash
PYTHONPATH=backend:backend/tests /home/quant/repos/market-watch-production-pending-fixes-20261013/.venv/bin/python -m pytest /tmp/mw-chart-reload-review-20261013/test_review_probes.py -q -s
node /tmp/mw-chart-reload-review-20261013/mutable_tail_probe.cjs
```

最终重放：`4 failed in 2.51s`（预期红）。三根临时柱只输出 `[166200000]`；pending 在较后确认 checkpoint 之前时输出 `[]`；同 native 价格投影确认返回 history_changed；EMA 第二/第三根分别得到 `17.0/20.3333333333`，正确顺序值为 `17.8888888889/22.6296296296`。Node 预期红，已应用 1 个来自较新 mutable tail 的结果批次。

顺序状态方案的数值可行性：

```bash
PYTHONPATH=backend:backend/tests /home/quant/repos/market-watch-production-pending-fixes-20261013/.venv/bin/python -m pytest /tmp/mw-chart-reload-review-20261013/test_shadow_reference.py -q
```

`6 passed in 3.64s`：EMA/Supertrend × 连续观察尾部/后柱先确认/实际缺分钟。比较完整合并输入的 calculate 结果，确认 fixed run.state 与原始 bar 标志没有变化。这不是产品实现或端到端验收，也不是独立 Pine 引擎对照。

额外 Supertrend step 样例：连续下跌三根的正确展示 Sell 仅第一根出现；独立 provisional step 三根都出现 Sell，趋势下沿也不同。说明顺序状态错误影响交易信号，并非只有行数少。

现有基线回归：fixed_indicators、composite_aggregates、indicator_state 共 `59 passed in 10.06s`；JS `indicator-range-events.cjs` 和 `indicator-shared-read.cjs` 通过。它们只证明已有覆盖仍成立，不能推翻新增红探针。未创建 PG/浏览器验收实例，未重新构建 UI 或运行生产操作。

本轮交付是分析与建议。实际业务实现、独立 PostgreSQL 并发验证、真实浏览器连续性验收和生产发布仍未完成。
