# Market Watch 系统消息四项问题：排查结论与解决方案

2026-10-22；仅分析与只读诊断，未实施修复。本文所有时间均为 UTC。

## 范围、版本与证据边界

目标 worktree `/home/quant/repos/market-watch-integration-20261022`，branch `integration/mwa-20261022`，HEAD `d0e439dd205b04a32d2ee03e25f4e36038f4d4a0`，Git 干净。当前权限可直接执行本轮读操作，无需提权或再次确认。

长期验收实例在 Ubuntu `quant-server`，Compose project `mw-issue75-v2-20261018`，入口 https://192.168.7.232:18280 。实例是多个既有镜像组合，不能将本地 HEAD 当作整栈构建版本。API / market-stream-worker 镜像源码标签为 `7418c08`，Web 为 `0883a5a`，Chart 为 `cc321a0`；pricing-worker 仍使用原镜像 `f44eba56add6`。已核对运行镜像中相关确认窗口和 OANDA page 请求实现，并在该镜像中执行离线诊断。

基准是 11:24:24 的 278 个未读事故快照。本方案覆盖其中组合行情读取失败 198、设置/工作区保存失败 38、组合注册失败 14，并补充这些组合消息的名称可读性问题。第四项是已有消息的展示与搜索问题，不新增事故计数。上述数字是历史事故条数，不是当前同时存在的故障数。未刷新成另一个统计口径，也未标记已读或处理。

数据库查询显式 `SET TRANSACTION READ ONLY` 并回滚。上游探针只有有界行情 GET，沿用原凭据、代理和适配器；未写配置/草稿/业务数据、未重启、未部署、未改主机时间。临时诊断与本文放在 `/tmp`，产品文件未改。

## 结论表

| 问题 | 已证实 | 解决方向 | 优先级 |
|---|---|---|---|
| 组合行情 198 | 存在供应商拒绝未来 `to` 的 400；本机未同步时钟；确认与实时采样共用错误字段产生抖动；另有真实 504/超时 | 恢复可靠时钟同步、确认窗口容错、分离采样/确认健康、补安全证据 | 最高 |
| 设置/工作区 38 | 同字段保护会拒绝覆盖；旧验收脚本会制造相同冲突；通用 409 误用告警文案；偏好失败值只在内存 | 验收读写模拟保持一致并隔离通知、错误分域、偏好草稿可恢复、保留工作区现有草稿机制 | 高 |
| 组合注册 14 | 均先于对应组合建立；422 被当永久失败；全部记录已是 `observation_status=ended` | 首次建立完成后订阅、特定未就绪代码与定向重试、保留观察结束语义 | 高 |
| 组合消息名称可读性（不另计事故） | 通知遗漏已有品种名；64位组合ID原样显示；历史名称搜索缺失 | 新消息名称快照、旧消息批量只读解析、统一列表/详情/气泡与搜索 | 中 |

## 一、组合行情读取失败：原因已经收敛

### 证据

198 条涉及 EURUSD 103、XAUUSD 77、USDCAD 18；全部有恢复时间，恢复跨度 0.522～48.073 秒。它们确实复发，不能因“已恢复”而忽略。

保留的一段 pricing-worker 日志摘要包含 96 次失败（10:23:05～11:37:06 的观测片段）：

| 请求 | 原因 | 次数 |
|---|---|---:|
| candles（确认窗口） | HTTP 400 / JSON | 59 |
| candles（确认窗口） | HTTP 504 / HTML | 13 |
| candles_latest（实时采样） | HTTP 504 / HTML | 20 |
| candles_latest | ReadTimeout | 3 |
| candles_latest | ConnectTimeout / TLS 阶段 | 1 |

这是请求失败计数，不能与 198 个组合通知一一对应；一次共享源失败可能影响多个组合，采样也可能在通知发布前恢复。400 集中在每分钟第 5～6 秒。比如 11:13:05.602 的确认 400，对应 XAUUSD 11:13:06.071 的事故，6.512 秒后恢复。

通过运行镜像的 `OandaRestBatch.page` 做了同一时刻的对照，只改变窗口 `to`：

| 本机发送时间 | from | to | 结果 |
|---|---|---|---|
| 11:51:01.068 | 11:49:00 | 11:51:00 | 400：`Invalid value specified for 'to'. Time is in the future` |
| 11:51:01.069 | 11:49:00 | 11:50:00 | 200 |

两条响应 Date 均为 11:50:56，本机收到时为 11:51:02.5～02.6；其他边界探针也观察到接收时间减 Date 约 6～7 秒，包含 RTT、HTTP Date 秒精度及服务端生成时点误差，不能直接当精确 NTP offset。

主机只读检查：`System clock synchronized: no`、`NTP service: active`、`Packet count: 0`，当前配置的 NTP 名称解析到了 `198.18.0.31`。这证明尚未成功同步；该地址为何产生、UDP/NTP 是否被路由或 DNS 策略影响，仍需运维修复阶段核查。

`live_pricing.confirmation_window` 使用 `cutoff=(stamp-5000)//60000*60000`。本机比供应商时间靠前数秒时，5 秒成熟余量不足，与日志边界模式吻合。普通历史窗口及一些第 5 秒探针可正常返回 200，所以这是边界竞态，不能说 URL 或固定参数始终错误。历史 59 次 400 没有保留正文，不能逐条保证都属于同一种供应商错误；已直接复现的未来窗口拒绝是高可信主因。

### 第二个缺陷：两类健康共用一个字段

`commit_confirmation` 失败写入 `LiveState.error`（`backend/alerts/live_pricing.py:748`），即使当时实时采样新鲜且 ready=true。`live_snapshot` 将其作为 connection_error，`composite_quotes.snapshot` 写入 fetch_status（`backend/alerts/composite_quotes.py:247`）。`market_notices.result_state` 据此报告读取失败。

下一次健康 latest 样本又清空同一 error（`live_pricing.py:533`），于是记录恢复。实际运行镜像函数的离线探针已复现这条失败/恢复链。反方向同样有风险：健康采样并不能证明确认缺口已补齐，当前共用字段却会抹去确认错误。

504 / HTML 和连接、读取超时确实影响 latest 与确认请求，不能全部归到时钟，也不能仅调整通知显示。现有 `route=upstream` 标签不能进一步证明 504 是供应商本体还是中间网关产生。

### 建议方案

1. **先恢复可靠时间同步。** 排查 NTP 名称解析、出口及服务响应，确认系统实际获得时间源并稳定同步。实施时评估时间调整对租约、会话和任务时间戳的影响，按适用方式平滑校正；本轮没有改时钟。不要单靠重启 pricing-worker。
2. **确认请求增加边界容错。** 保留 UTC M1 半开区间；使用有观测依据的安全余量，并对供应商明确的 future-to 拒绝做有界延后重试。最初可验证 10～15 秒余量，但必须用边界延迟与业务确认时延数据确定，不能把某个常数当永久答案。可信服务端时间可用于请求成熟度判断，不能单凭 HTTP Date 证明数据完整。重试仍覆盖原待确认分钟，不推进虚假 coverage、不丢弃缺口、不把任意 400 当可重试。
3. **分离状态。** 将 sampling health、confirmation/recovery health 与账户级认证/维护状态分开。正常采样只恢复采样故障；确认成功只恢复对应确认故障。报价仍按真实样本时间判断新鲜度；确认失败显示“实时样本可用，分钟确认延迟”等准确状态。账户错误、恢复未完成、依赖缺失仍按原门槛阻止相关告警判断，不因拆字段而放行。
4. **分类并保留安全证据。** 在适配器结果中添加兼容的可选字段：operation、HTTP status、phase、受控 reason_code、请求窗口、观测时间/重试时间和关联 ID。明确区分 TIME_BOUNDARY、上游超时、网关故障、认证与未知错误。供应商错误正文只用白名单识别短原因，不能进入原始 URL、账户、token、代理配置或任意正文。
5. **处理网络问题与通知抖动。** 复用现有限流、deadline、退避和共享请求，诊断 504 所在链路；不盲目增大超时或重复请求。通知按源/操作/有效代次聚合，保留发生次数和时间线；只有对应操作真实成功才恢复，不能用存储旧价或另一通道成功结案。

### 验收标准

- 模拟本机领先供应商 0、5、7、15 秒及网络延迟，跨分钟请求不再持续产生 future-to，拒绝后有限退避且原区间最终完整确认。
- 当前样本健康、确认失败：报价状态准确、确认事件保持开放；latest 成功不能恢复确认事件。latest 失败也不能被确认成功掩盖。
- 401/403、429、504、TLS/读取超时、晚到分钟、代次取消、重启恢复各保持正确门槛和证据；不制造 coverage，不漏补分钟。
- 时钟同步后至少连续观察 30 个分钟边界；自然网络故障单列计数，不能把“没有所有错误”作为不可控的验收要求。

## 二、设置/工作区保存失败：区分保护、验收污染与草稿能力

### 证据与边界

37 个设置事故：widgetbar.layout-settings 26，chartproperties.mainSeriesProperties 8，chartproperties 2，mapping.category 1。33 条明确为同字段冲突、3 条套用告警文案、1 条设置改变/删除；5 条有恢复，32 条没有。

`advanced-host/preferences.js` 已有基线/本地/远端三方合并、写入序列化和最多两次 revision 竞争重试。不同字段合并、同字段拒绝、重复回调不覆盖远端、删除不复活、模板保持不透明等既有测试全部通过。应保留这些保护。

进一步发现旧验收脚本对 preferences/save 返回虚拟成功、递增 revision，但 GET 仍读取真实旧值，例如 `docs/verification/mwa-integration-review-20261022/mwa-title.cjs:16` 和 `/tmp/mw-v2-mwa-debug.cjs`。这些脚本未拦截通知 intake。

使用真实 preferences.js 离线复现：初始 width=300；虚拟保存 width=400 返回成功、真实读取仍是300；同一窗口再保存 width=500，适配器就报告“同一字段已在其他窗口修改”。将 mock 改成读写一致的存储，完全相同的回调序列成功。这证明验收脚本可以制造与历史消息相同的症状。08:48:53～08:49:19 的验收报告有 14 次偏好写入拦截，08:49:05～14 正好有同类历史记录，时间高度重叠；但缺少 intake 与具体脚本 run ID 的严格关联，不能精确归因或扣除条数。

另一些旧脚本直接用英文 detail 返回 HTTP409。真实 `responseError` 将未识别的409统一显示为“告警已在其他窗口改变”，这一误归类已离线复现。真正后端工作区 revision 冲突返回的是中文“工作区已在其他窗口修改，未覆盖；请另存副本”，它可被正确保留。因此单凭“告警”文案不能证明真实后端发生过工作区 revision 冲突。

1 条工作区事故发生在09:56:54，native-charts/save、revision43；后续revision51只证明其他保存曾成功，不能证明这一次草稿保存了。工作区本来已有保存前写本地 `mw-tv-draft:<id>`、失败暂停保存和“复制恢复为独立工作区”机制（AdvancedWorkspace.tsx:1121、1231、1758）。本轮未打开受保护浏览器存储核查具体草稿，所以不宣称实际丢失或已恢复。

偏好适配器的 pending 则是闭包内 Map，没有跨刷新持久化或用户可见的解决出口；文案建议“重新加载”可能丢失仍在内存的偏好修改。这是可确认的恢复能力缺口，不能据此证明38次数据已丢失。

### 建议方案

1. **先修验收隔离。** 查看型验收禁止把模拟故障送入真实通知中心；同时隔离 intake 与观察写入。若必须模拟保存成功，配套 context 内的 shadow store，保证 read/save/delete/revision 一致；或在浏览器副本明确关闭这些保存能力。不要通过假成功、真实读值的组合验证冲突逻辑。真实故障验收在独立实例进行，携带 acceptance_run，不能污染长期真实消息。
2. **错误按业务域结构化。** 后端返回 WORKSPACE_REVISION_CONFLICT、PREFERENCE_REVISION_CONFLICT 等代码及安全中文；前端通用409默认用中性文案，只有告警域使用告警名称。保留旧中文字符串兼容，旧英文/非预期体安全兜底。记录尝试 revision、操作和错误代码，避免用户猜测失败原因。
3. **偏好草稿持久化与明确冲突处理。** 保存前记录原基线 revision、本地修改及作用域；按用户/设置键/窗口会话区分，刷新后可恢复。冲突时可查看差异、保留本地草稿、采用远端或经用户明确选择重新提交；提交仍使用新基线和 CAS。成功只删除对应草稿版本，不能清掉较新的本地修改。不要用最后写入覆盖或仅刷新revision绕过保护。
4. **减少无意义竞争。** 相同值不写、短时间回调按设置键合并；跨标签广播成功revision，只有未触及的键可自动接纳远端。不能把布局数据拆字段或改变共享范围当作无需产品确认的默认修复。
5. **复用并加强工作区现有恢复链。** 保留失败暂停和复制恢复。核查同源多标签共用 `mw-tv-draft:<id>` 的覆盖边界，必要时保存会话/基线版本的独立草稿。未知结果先核对原操作，不盲重试；另存副本成功不等同原工作区原操作恢复，通知应准确标记处理结果。
6. **通知关联到未解决修改。** 同一草稿的重复自动回调不刷出独立错误；实际提交成功或用户明确处理才收口。设置事故仅有 operation，没有足够 revision/错误分类，是本轮无法精确归因的重要原因，需补足安全证据。

### 验收标准

- 两窗口不同字段均保留；同字段冲突不覆盖；删除不复活；重复回调不重复刷错；持续竞争达到上限后草稿仍可恢复。
- 偏好与工作区在刷新、浏览器关闭重开、存储失败、多标签、另存副本场景中不误清较新草稿；用户可以明确完成冲突处理。
- 模拟写入与读取保持一致；查看型验收前后真实偏好、工作区、通知数不因 mock 发生变化。
- 中文/英文/非预期409都不能误称为告警冲突；只有原对应操作成功才能报告恢复。

## 三、组合订阅注册失败：建立顺序错误，历史已结束观察

### 证据

14 条全部为 HTTP422 / VALIDATION_ERROR：“组合尚未建立；订阅不能隐式创建组合”。

| 组合 | 次数 | 失败时间范围 | 实际建立时间 |
|---|---:|---|---|
| USDCAD | 8 | 07:28:07.517～07:28:29.787 | 07:28:35.841 |
| XAUUSD | 6 | 07:28:10.361～07:28:36.234 | 07:28:42.490 |

`advanced-host/bridge.js:1150` 在 subscribeQuotes 时立即为列表全部 symbol 创建 listener/generation 并发出 market-subscribe；这条路径没有等待首次使用建立。真正建立发生在图表实际使用入口（series_access.py:152 的 first_use），也有显式 POST /market-data/composites/use 可用。后端 market_stream_api.py:99 禁止订阅隐式创建组合，这个边界正确。

providerSubscriptions.ts:89 将除408/429外所有4xx视为 permanent invalid。离线执行真实模块可确认：422 后不安排重试；将模拟组合改为已建立也不会自动登记；新的显式订阅代次才可成功。

重要更正：14 条全部已经 `observation_status=ended`。取消/替换旧 generation 会发观察结束；后端 notification_center.py:308 特意保留 closed_at=null，只写 ended。当前UI也显示“观察已结束，未确认恢复”。这是防止假恢复的正确语义，不能把这14条解释为当前仍活动的订阅故障，不能批量补 closed_at。

### 建议方案

1. **在明确首次使用处建立完成屏障。** 用户明确打开候选/使用组合时，等待现有 first_use 命令提交成功，采用后端返回的正式组合ID及revision，再登记 bars/quotes。合并同一候选并发建立请求，切换工作区/取消选择后丢弃旧结果。
2. **列表观察保持纯订阅边界。** 仅出现在自选/候选列表的未建立组合不触发 use、不隐式创建；显示尚未使用或 pending，延后登记。接到明确建立完成事实时，只唤醒仍然有效的观察者。不能为列表所有候选调用 composites/use。
3. **错误代码与定向重试。** 为“组合尚未建立”增加兼容的专用代码（例如 COMPOSITE_NOT_ESTABLISHED）；在已存在的显式建立操作完成后重新登记当前有效代次。建立期间可有限等待/退避，超时或建立失败明确报告；其他422仍为终止错误。不要把所有422改为无限重试。
4. **减少代次抖动。** 在真正的选择/作用域变化时才替换订阅，避免同一次首次建立因报价回调反复创建listener。继续保留取消顺序、generation fencing、过期事件过滤和共享SSE。
5. **保留历史语义。** 原代次结束依然是 ended；只有该次有效观察确实登记成功才恢复。若未来需要“后续已替代/已处理”，应单独关联后续订阅，而非伪造原请求成功。原14条不改消息状态或数据。

### 验收标准

- 首次建立故意延迟时，无提前订阅422风暴；已有组合快速登记；列表未使用候选不创建组合。
- 建立成功只登记当前作用域；失败、取消、切换工作区、双窗口同时建立都不留下幽灵订阅。
- 特定未就绪代码可定向唤醒，其他422不重试；408/429/5xx继续使用现有合理策略。
- 原代次取消显示ended，真实成功显示recovered；不存在用新代次成功关闭无关旧事故的行为。

## 四、组合行情消息名称：内部身份与可读展示分离

### 结论与目标

问题已确认。用户看到的是内部系列身份，其中本轮组合消息使用64位SHA-256组合ID，并非标准带连字符UUID。建议列表主标识显示 `EURUSD · 组合行情`，标题保留 `共享行情读取失败`；详情显示品种、系列类别和适用周期，完整内部ID放在“排查详情”并允许复制。报价消息的 timeframe=quotes 应显示“报价”，不能错误显示为M1。

**内部身份继续用于关联、去重、恢复、定位及权限；名称只负责展示。** EURUSD 并非组合唯一身份：不同固定历史、映射或规则可以对应同一品种。遇到同名组合，应提供历史来源或短ID辅助区分，必要时在详情查看完整映射与修订信息。

### 已取得证据

- 基准快照 `/tmp/mwa-unread-analysis-20261022-list/report.json` 的198条组合共享行情事故，instrument均为64位ID，且没有独立symbol/name/display字段。
- 只读数据库得到：`8c490df0…` → EURUSD，`4087caee…` → XAUUSD，`54ef74f0…` → USDCAD。EURUSD现存共享任务identity.metadata已含symbol/display_symbol/name和series_kind=composite。
- `web/src/notifications/types.ts:131` 的 noticeInstrument 只把带连字符UUID替换为类别；64位ID不匹配，去掉MWC前缀后仍是原始ID。它不查询品种名，也不读取display_symbol。
- `web/src/notifications/Panel.tsx:347、640` 的详情与列表都调用该函数，原生消息面板复用同一NoticePanel；所以原生容器不是根因。
- `backend/alerts/series_access.py:92` 已提供symbol、display_symbol、name和series_kind，`market_stream_api.py:95`已放入任务metadata。
- `backend/alerts/market_notices.py:165` 生成通知时仅把task.query.instrument传入context，丢失了可读名称。`notification_center.py:130`只是序列化原字段。
- 服务端全文搜索在`notification_center.py:457`搜索原始ID和消息正文。旧事故无EURUSD文本，因此仅在序列化时补名称还不能解决历史搜索。
- 本地搜索在`web/src/notifications/systemMessages.ts:22`搜索title/message/context/evidence，也不使用独立展示字段。

临时复现命令：`node /tmp/mwa-notice-name-repro-20261022.cjs`。输出确认64位ID泄露到主显示、UUID只变类别、EURUSD无法匹配真实旧记录；普通MWP:EURUSD为正常对照。数据库探针 `/tmp/mwa-notice-name-db-20261022.py` 显式只读并回滚，结果在同名json。

### 推荐实现：事件名称快照 + 旧记录只读解析

#### 1. 增加独立的可选展示对象

在通知body/API响应增加`instrument_display`，不替换instrument，不拼接进身份context。建议字段：

| 字段 | 用途 |
|---|---|
| series_kind | composite/provider/history/managed，来自可信系列元数据 |
| symbol | 业务品种代码，如EURUSD |
| label | 可选品种名称，来自已有market_names规则 |
| provenance | event_snapshot / resolved_current，说明名称来源 |

对象始终随所在事件instrument使用，不单凭symbol做缓存键。字段长度有界，按纯文本渲染；缺少字段的旧客户端/旧记录继续兼容。

#### 2. 新消息在源事实中捕获当时名称

共享行情源`market_notices.record_result`直接复用已验证的task.identity.metadata。将可选展示快照写入可靠Audit facts，在notification_center投影时带入NoticeEvent.body。不要等到展示时才从当前活跃图表猜名字，也不要额外调用图表数据或创建接口。

这样源任务删除、组合改名或通知重建后，事件仍能说明当时对应品种。展示字段不进入dedupe_key、recovery_of、context精确比较或intake签名，避免名称变化拆分事故或阻止恢复。

对浏览器注册失败与历史读取消息，服务端根据明确series_kind、原始身份及受权限约束的注册信息补展示快照。当前BrowserEvent严格禁止额外顶层字段；不要直接在上传体加字段，否则会422。若要让本机待同步记录立即显示名称，可在localNotice展示对象中使用已有本地元数据；上传原始事件保持不变。本地提示不能充当服务端身份事实。缺少可信数据时使用明确回退。

#### 3. 历史消息在读取时批量补充

按页收集不同系列身份，使用纯读取resolver查询当前权限内MarketComposite→Instrument/MarketDataset。优先采用事件快照；缺失快照时才使用当前注册资料，并标记resolved_current。当前资料不是历史名称证明，不能把它反写成“发生时名称”。

类型判断优先来自显式series_kind、可信provider或已登记的精确身份匹配；不能把所有64位字符串都当组合，也不能仅按EURUSD猜组合。

列表、详情、事故发生记录以及changes增量输出应使用同一解析规则。特别是changes保存了历史body副本，单改summary不会更新已经存下来的增量内容。对旧客户端本地缓存采用展示缓存失效/刷新，不能为了补标签重放为新故障或重新弹通知。

每页按去重ID批量查询，避免逐条HTTP请求和N+1查询。不需要重写历史通知、重建投影、变更未读数或批量更新恢复时间。resolver不得调用chart_data、first_use、renew_demand、provider ensure或任何会注册需求/写数据的函数。

#### 4. 展示规则与搜索同步实施

统一展示顺序：可信展示快照 → 当前资料只读解析 → 已确认的普通业务代码 → “组合行情（名称不可用）·短ID”。未知类型显示“行情（名称不可用）·短ID”。完整ID保留在诊断中；缺资料、已删除或无权限时不能编造名称，不能跨权限泄露资料。

主列表和详情显示相同名称。系统即时气泡当前只显示title/message，若包含品种则补同一展示组件，不能再让用户看到只有MARKET_READ_FAILED的泛化提示。日志正文通用错误码是否翻译可另行处理，不应与本次身份展示混在一起扩大范围。

本地搜索纳入display.symbol、label、series_kind的中文展示名及原始instrument。服务端搜索同时覆盖快照字段；对于缺快照的旧记录，在分页前用权限受限的身份查询/EXISTS关联注册资料。不能先取一页再按名称筛选，否则会漏页、空页。沿用market_names的代码规范化规则支持EURUSD、EUR/USD和大小写输入。

保留原始ID搜索与exact instrument筛选语义。同名symbol必须返回所有符合权限的不同组合，不合并事故。

### 方案取舍

| 做法 | 结果 | 建议 |
|---|---|---|
| 把所有长ID改成“行情” | 不再长，但仍无法辨认品种 | 只作最终兜底 |
| 前端每行查组合详情 | 产生请求风暴，受当前页面状态影响，历史搜索仍缺失 | 不采用 |
| 将instrument改写成EURUSD | 破坏组合唯一身份、去重与恢复关联 | 不采用 |
| 快照 + 批量只读解析 + 统一搜索 | 新旧记录均可读，保留准确身份与历史边界 | 推荐 |

### 最小实施单元

1. 增加共享的纯读取展示resolver和展示契约。
2. 共享行情源事实与投影捕获新消息快照；浏览器消息按明确身份补全。
3. 覆盖events/detail/changes和历史搜索，前端统一名称格式及本地搜索。
4. 检查本地历史缓存更新、原生面板、普通面板和系统气泡。

主要文件：backend/alerts/market_notices.py、notification_center.py、market_names.py（复用）；web/src/notifications/types.ts、systemMessages.ts、Panel.tsx、runtime.ts及对应测试。具体resolver宜独立模块，避免通知中心反向调用业务图表读取链路。

最小版本可在现有JSON body内增加可选字段，无需新增表或覆盖instrument。因为涉及可靠源事实与持久消息格式，按仓库规则建议F1，验证旧facts重放、旧客户端和新字段兼容性；不需要迁移重写历史记录。

### 验收标准

- 实际三个组合显示EURUSD/XAUUSD/USDCAD，并标注组合行情；列表、详情、气泡一致。
- 既有198条组合事故能只读解析名称；UUID、MWC前缀与普通代码均有明确回退。
- 新消息有事件名称快照；源对象删除后新记录快照仍可用；旧消息无资料时可读降级。
- 两个同名组合不合并；完整ID、去重键、恢复关联、未读/已处理状态保持原语义。
- EURUSD、EUR/USD、大小写、短ID/完整ID查询在本地与服务端规则一致，翻页无遗漏。
- 禁止跨权限解析；恶意label按文本显示；离线与本机待同步记录能降级。
- 100条消息按不同ID批量解析，无逐行网络请求；打开消息列表不创建组合或登记行情需求。
- 增量历史、通知重建与升级缓存不制造新事故、新弹窗或恢复事实。

## 实施建议与已完成验证

建议拆为四个可独立审阅的改动：先处理行情时钟/边界与状态，再处理保存/验收隔离，再处理首次建立订阅，随后处理组合消息名称与搜索。第一项与第四项都涉及 market_notices.py、notification_center.py，应共用兼容的可选展示/证据契约，避免重复改动；名称仍不参与身份、去重或恢复关联。按仓库规则，行情重要后台链路按 F1；保存若引入本地持久格式也按 F1；兼容的订阅时序改动按 F0，涉及持久契约则升级 F1；名称方案涉及可靠源事实与持久消息格式，按 F1 验证。实现时需要兼容旧客户端/旧状态、适用的 Ubuntu 独立验收；本轮没有触发实现、构建或部署。

已运行：

- `node tests/advanced-preferences-conflict.cjs`：通过，涵盖真实适配器的多窗口合并与保护。
- `node tests/advanced-provider-subscriptions.cjs`：通过，涵盖既有传输取消顺序、共享SSE、旧事件与卸载。
- `node /tmp/mwa-three-issues-offline-repro-20261022.cjs`：复现409误归类、首次422不复活；确认取消只结束观察。
- `node /tmp/mwa-preference-inspection-repro-20261022.cjs`：复现只读脚本假成功造成单窗口假冲突，与一致存储成功对照。
- `docker exec -i mw-issue75-v2-20261018-pricing-worker-1 python < /tmp/mwa-pricing-offline-repro-20261022.py`：在真实运行函数、假DB、无外部IO下复现确认错误与latest采样交替清除。
- 有界上游 GET 对照：真实400未来时间拒绝、提前一分钟200；`timedatectl`只读确认未同步。
- `node /tmp/mwa-notice-name-repro-20261022.cjs`：复现组合长ID原样显示及EURUSD无法搜索旧记录；普通MWP:EURUSD显示正常。
- 名称数据库探针显式只读并回滚：确认三个组合身份分别对应EURUSD、XAUUSD、USDCAD，现存EURUSD任务元数据已有可读名称。

诊断输出的 RED 表示成功捕获当前缺陷，不是修复后通过；由于用户明确要求暂不实现，未执行修复及修复后回归。

## 附件

- 原未读基准：`/tmp/mwa-unread-analysis-20261022-list/report.json`。
- 原只读数据库证据：`/tmp/mwa-unread-analysis-20261022/db-evidence.json`。
- 本目录 `mwa-pricing-failures-20261022.json`：安全日志计数和时间示例。
- 本目录 `mwa-oanda-clock-differential-20261022.jsonl`：不含凭据的真实HTTP400/200对照。
- 本目录三个 offline/repro 脚本：只作诊断，未添加产品功能或修改仓库测试。

- 名称专项方案来源：`/tmp/mwa-notice-name-plan-20261022.md`，已完整并入第四项。
- 名称复现脚本：`/tmp/mwa-notice-name-repro-20261022.cjs`；只读数据库结果：`/tmp/mwa-notice-name-db-20261022.json`。
- 名称方案图解：`/home/quant/.answer-me-with-html/pages/组合行情消息为什么显示长ID-20261022-123846.html`。
