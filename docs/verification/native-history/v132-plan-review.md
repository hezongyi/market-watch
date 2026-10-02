# v1.3.2 原生历史缓冲实施方案独立审核

日期：2026-10-02。审核对象：[初稿](../../provider-native-history-buffer-plan.md)。范围是实施方案及其与真实源码的对应关系，不是代码差异审核、部署验收或性能达标声明。

结论：方案可沿现有取数链实施，datafeed 薄桥接、原生单周期交付、真实需求优先、冷可选量不增 HTTP、热额外量只读 PG、有限后台预热均有合理落点。**初稿须修订以下 2 项 P1、3 项 P2 后再复核；目前不标记审核通过。**

基线已核实：主仓库 HEAD 与 `v1.3.2^{commit}` 都是 `9596b25eda507ef708a327feb5271f238cdfdc0b`。标签本身是 annotated tag，不能用裸 `git rev-parse v1.3.2` 的 tag object 当 commit。源码发布清单的运行构建来源是 `2aef8acfab6871b9e9c0770067219581c48ad16e`，且 `deployed=false`、`images={}`；初稿对此描述准确。本审核没有使用旧 research worktree 的 HEAD 作为新基线。

## P1-1：最终 bar 与 revision/as_of/coverage 必须是一个一致数据库快照

**触发与影响。** 第 4 节第 7 步允许真实读取完成后再读缓存额外历史，但没有规定第二次读取与原 metadata 的合并规则。若先获得 bar 快照 A，再追加快照 B 的历史，却沿用 A 的 `cache_revision/as_of`，可能重复识别已交付修订并触发 reset；反过来给 A 的旧 bar 配 B 的新 revision/as_of，会把尚未交付的历史修订标记为已见，漏掉应有的 reload。只写“同一事务”也不足以保证 PostgreSQL 的多次 SELECT 一致。

**源码证据。** [provider_cache.snapshot](../../../backend/alerts/provider_cache.py:101) 先读取 dataset，随后读取 bars，返回 dataset 的 `coverage/latest_at/revision/updated_at`；[storage.make_engine](../../../backend/alerts/storage.py:251) 未指定隔离级别，默认 PostgreSQL READ COMMITTED 并不保证多条 SELECT 使用同一快照。[bridge providerHistoryState](../../../advanced-host/bridge.js:374) 将 `page.cache_revision/page.as_of/rows.at(-1).time` 传给订阅；[events](../../../backend/alerts/provider_service.py:213) 在 revision 相同直接跳过，随后通过 `changed_at > observed_at` 判断历史 reload。因此响应的一致性直接决定实时正确性。

**修订建议。** 明确最终响应必须从同一一致快照取得全部 D/E bars、覆盖证明、边界、`cache_revision/as_of/latest_at`，不能拼接两个读时点的 bars/metadata。选择一个明确可实施机制，例如单条 SQL 一致读取，或短一致快照事务；不要把普通 `transaction()` 等同于一致快照。额外读取无法即时取得一致结果时，返回已完成的真实需求快照，不能为 E 等待上游或长期锁。纯读取 E 不增加 dataset revision；首次写入更早的 bar 按既有 `revision=1` 语义不得触发历史 reset，已存在 bar 的真实修订仍须 reload。

**通过条件。** 在真实 PG 上以屏障强制“必需读取—历史修订提交—可选读取—订阅注册”交错，证明响应自洽、纯 backfill 无 reset、未交付修订不会漏 reset、已交付修订不会造成重复 reload。测试覆盖历史分页响应晚于最新响应的情况；追加更早 bar 不得把实时 cursor 倒退到最早 bar，也不得因 E 根数增加触发 `>2000` 的 SSE reset 条件。

## P1-2：同锚点 target growth 缺少在途 worker 回写防护

**触发与影响。** 第 5 节要求目标单调扩大并保留进度，但只改 `activate` 不能保证该性质。warm_step 可能已经复制旧 count=1000 的 target，随后 activate 将目标增为 8000；旧 worker 完成后仍能写回 count=1000/done=true，丢掉新需求，后台永久误判完成。已完成 target 若只是因为“未满足目标才扩大”而被跳过，同样可能漏掉增长。

**源码证据。** [activate](../../../backend/alerts/provider_service.py:44) 的 fast return 对所有 latest 读取成立，对历史读取则匹配约 1 秒内锚点；[warm_step](../../../backend/alerts/provider_service.py:400) 复制 target 后离开事务取数，最后 [回写](../../../backend/alerts/provider_service.py:448) 只验证 cursor 和 index，随后用旧 target 替换当前 target，没有验证当前目标的 count/version。前台 busy 只在选候选前检查，无法消除已在途 worker 的竞争。

**修订建议。** 将“单调扩大”明确到并发回写协议：利用现有 JSON target 的版本或事务内 CAS/合并，不必 schema migration。旧 worker 不得降低 count，且不得用旧目标的 satisfied=true 设置增大后目标的 done=true；应对当前目标重判覆盖。聚焦周期已经 done 的相关 basic/depth target 也要在需求增长后重新判定，跨周期无变化目标保持进度。明确传入的真实计数是 D+H，不包含 E；latest 仍按 `max(goal,D+H)`，历史左侧按 `goal+D+H`，右侧有限目标不随返回量增长。

**通过条件。** 用屏障固定 worker 读取旧目标、activate 增长、worker 回写的顺序，断言目标不回退、增大后 coverage 不足时 done=false、完成后不重复取数；另覆盖两个 activate 同时增长、原目标 done=true、latest 固定旧 anchor 的 fast return。不能靠重新启动所有 18/20 个目标通过。

## P2-1：Python E=0 与 D>N 的“基线输出一致”存在两个不同含义

**触发与影响。** 第 3 节既要求完整 `[from,to)` 范围（D 可能大于 N），又要求 Python E=0、“维持基线计算窗口”；测试矩阵写“与基线输出一致”。基线按 N+H 计算，扩大真实 D 会改为 D+H，递归指标初始化位置随之变化。E=0 只能隔离可选缓冲的影响，不能保证 D 修正后所有重叠 bar 与旧 N+H 窗口逐值相等。

**源码证据与本地验证。** [provider_cache.data](../../../backend/alerts/provider_cache.py:359) 基线读取 N+H，然后对整个读取窗口 calculate；[history_requirement](../../../backend/alerts/chart_indicators.py:105) 的 EMA/RSI/ATR 是有限 10×period 前缀；[calculate](../../../backend/alerts/chart_indicators.py:135) 对每段从头初始化 TA-Lib。独立只读 Python 探针使用 `close=100+sin(i/9)`、EMA20、H=200：同一个 time=800 bar，N200+H200 输出 `100.0943401781792`，D400+H200 输出 `100.09434018077808`，差 `2.5988811103161424e-9`。该差证明不能承诺逐值完全相等，不表示差值本身构成不可接受交易误差。

**修订建议。** 保留真实 D 范围需求和 Python E=0；把“基线一致”改为：缓冲开关不改变同一真实 D/H 输入窗口，按相同 D/H、相同缺口/NULL/边界的按需计算作对照。D>N 属于真实需求覆盖修正，若需与旧 N/H 比较，明确数值容差和可能的初始化差异，不能声称字节级等值。不要为了追求旧窗口等值而截断真实范围、计算无前缀的新输出或补造数据。

**通过条件。** Python D=N 和 D>N 都返回完整真实范围；同 D/H 的开关开启/关闭值一致；递归指标、有限窗口指标、年轻品种缺前缀和 gap/NULL 都有有意义的对照。原生 MA200 的通过不能替代此验证。

## P2-2：opt-in 字段与旧后端兼容协议应选一个最小确定方案

**现状。** 初稿第 8 节要求“现有配置握手增加单一能力标志”，但实际启动拿的是裸指标 map，不是可扩展 envelope。[advanced_api.catalog](../../../backend/alerts/advanced_api.py:169) 以指标名为全部 key，[pythonStudies](../../../advanced-host/indicators.js:3) 遍历全部 key；直接加入 capabilities 会被当指标处理。[AdvancedWorkspace loaded](../../../web/src/advanced/AdvancedWorkspace.tsx:188) 读取该 catalog 并透传 init。

**实证。** 本地按真实 v1.3.2 [DataQuery](../../../backend/alerts/chart_api.py:54) 构造包含 `native_history` 的对象：`model_extra=None`，无 `native_history` 属性，原 N=200 不变，配置为 Pydantic 默认 `extra=ignore`。已验证的最低兼容后端可以安全忽略可选上下文；不需要以未验证假设替代此事实。

**修订建议。** 首版选择直接发送可选上下文，明确最低支持的回退后端为已验证的 v1.3.2，保留旧 API 按需语义并冻结 unknown optional field 的 ignore 合同；增加新前端/旧后端集成验证。字段定稿为 `native_history:{chart_count:1..8,focused:null|bool,historical_navigation:bool}`，first 只用现有 `firstDataRequest`，不发送 E/R/cache_hit。父页面必须在 [DataQuery 白名单重建](../../../web/src/advanced/AdvancedWorkspace.tsx:519) 中做校验与透传，不能只改 bridge 后把字段丢掉。无可靠匹配图/聚焦时用保守预算。此推荐不需要修改 catalog、额外请求或通用 header 握手框架。

如交付需要兼容尚未核实、会拒绝 unknown fields 的后端，应明确将其排除或另选已有响应 header 协商；不能同时留下“必须协商”和“字段直接发送”两套未定实现。普通 API 缺上下文、新后端总开关关闭的响应语义应分别明确，尤其 D/from 覆盖修正是否随缓冲开关关闭，避免 A/B 同时切换两项功能。

**通过条件。** 新旧两侧组合不出现 422/假指标/永久加载；缺上下文 E=0；非法图数/字段有确定校验；父页面透传后的字段与 bridge 请求一致。最低兼容版本、开关关闭的 D/H 规则写入方案。

## P2-3：范围发现、20000 容量错误与性能样本归类需确定可执行口径

**具体缺口。** 第 4 节先验证 D+H+E 上限再查实际 D，但冷缓存的真实范围 bar 数尚未知；现有 [snapshot](../../../backend/alerts/provider_cache.py:120) 仅取 count+1，没有范围需求检查，[_read](../../../backend/alerts/provider_cache.py:320) 仅按数量 residual 分页，`body.from_time` 在 provider 路径未使用。实现不能先用自然时间估出 D，再把此估计作为容量或覆盖证明。性能部分同时有“多数 <3s”“8/10 候选门槛”与基线不达标时的对照评估，应说明后者不自动满足启用门槛。

**修订建议。** 给范围读取补一个确定停止协议：count 满足且覆盖已到 from，或证实真实边界，才完成；冷路径逐页用真实 bar/coverage 发现 D，达到 20000-H 后用受限计数/边界证明区分“正好支持”与“真实超限”，明确错误 code/HTTP 状态和前端保留正常 err 回调。容量只约束一次前台取数，不应误写为后台两轮目标或 native 累积历史的统一上限。冷热分类在请求开始对必需 D/H 的覆盖与 freshness 决定；尾部过期刷新保持 cold/miss，不因刷新后的缓存变完整而跳到 hot E3000；可选缓存不足不降为 cold。

HTTP 验证应固定无重试正常样本的基线，数真实 candles HTTP attempt 而非 adapter page；429/503/连接重试独立记录，连接维护 HEAD、后台预热与前台 candles 分开统计。[native_page](../../../backend/alerts/provider_chart.py:187) 有高周期 +3/filter 内循环，[请求重试](../../../backend/alerts/provider_chart.py:145) 另有多次 HTTP attempt；初稿正确指出前者，验收仍需同时区分后者。必需 amount 接近 Binance1000/OANDA4000 时 optional 不能抢掉必需量；无法证明无额外调用时 E=0 可通过。

冷 SLO 的 t0 明确为 UI 打开/导航动作，t1 为 dataReady 后实际绘制可见；PG 指标 t0 必须在原生 getBars 入口，不能只从父页面 `/charts/data` HTTP request 开始，因为那会漏掉 bridge 排队/postMessage。[已有首屏浏览器脚本](../../../web/tests/advanced-provider-first-screen.browser.cjs:136) 的 warm 指标目前用 HTTP 起点，实施时需要补原生时间戳。失败和超时进入总样本分母；每平台/关键场景独立报告，不以两平台汇总遮盖一侧失败；同场基线不达标保留对照证据，但默认启用仍须明确门槛或显式列为未通过。

**通过条件。** from 范围大于 N、跨休市/DST/周月、D+H=20000、D+H=20001、边界少于需求有明确用例；无 E 时的真实需求与有 E 时完全一致。冷高周期可选不足不补第二次 HTTP；真实不足则继续补。性能原始样本包含 native/UI 起点、画面终点、mandatory cache 命中分类、状态/失败/真实 HTTP 次数；满缓存多数 <1s 的门槛不能用 native 已持有缓存动作代替。

## 已核实可保留的设计

- 原生 provider getBars 透传 N/from/to，后端 cache 层取数；宿主只收集图数/聚焦提示，适合保持薄桥接。额外 bar 均 `<to`，历史目标较新侧以后端有限 coverage 准备，不插入未来或重复走廊。
- 同 workspace 的暂时周期切换保留 provider 请求，与 [query 生命周期](../../../advanced-host/bridge.js:217) 和 [现有回切测试](../../../web/tests/advanced-provider-request-lifetime.cjs:18) 一致；workspace epoch 替换才取消。不可把当前周期筛选用于取消 provider 历史。
- 多图 R/E 只限可选量，D>R 仍交付真实 D；共享序列上下文优先聚焦、未知情况保守，均可由公开 chart API 收集。它不限制 native 累积堆，不应作内存/60fps 保证。
- 高周期 +3 与过滤会改变实际 HTTP 次数，冷附带需要 adapter mandatory/optional 停止条件；不能仅改 count 或仅在缓存层减少外循环。初稿这项约束正确。
- v1.3.2 transport 维护是两条 HTTP/1.1 HEAD 保活，不是 candles 预取；后台 busy 仅进程内，跨进程使用既有资源 lane 和 dataset lease，初稿无跨进程即时抢占承诺。

## 验证范围与限制

已读真实 provider_cache/chart/service、DataQuery 生命周期、storage/资源 lane/transport、bridge、React 透传、启动 catalog，以及对应现有测试。执行了基线/tag/发布清单核对、真实 DataQuery unknown-field 探针和递归指标窗口只读探针。未运行产品全套测试、未构建新镜像、未调用上游、未部署；上述竞态是源码明确支持的交错路径，仍需实施时用 PG 屏障测试验证修复。仅新增本审核报告，不修改方案正文、产品或部署。

复核关注点：P1 的一致快照协议与 target 回写协议是否明确，Python 对照是否改为同 D/H，兼容协议是否只保留一个确定方案，以及范围/容量/SLO 是否具备可执行停止和统计规则。采用理由应逐条记录，不能以“已读审核”替代处理结果。

## R1复核结论

2026-10-02 复核修订稿 R1。**五项首轮意见已实质处理；两个最小补充完成前，结论为方案级条件通过，不能写无条件审核通过。** 本次只读方案与相关源码后追加记录，没有验证实施代码或性能。

| 首轮意见 | R1处理结果 |
| --- | --- |
| P1-1 一致快照 | 第4.7明确单SQL statement snapshot、空bar保留dataset、完整响应替换、不可即时读取E则退回必需自洽结果，关闭了混拼风险。晚到响应的订阅协议仍需补成确定规则，见下。 |
| P1-2 目标并发回写 | 第5节JSON generation CAS与行锁、旧worker保留PG页但丢弃过期状态、done目标增长重判、两个activate串行max，足以指导实现。实施时应验证任务替换/删除重建不会复用旧任务身份版本。 |
| P2-1 Python窗口 | 明确真实D+H，E=0，同D/H开关对照，承认D>N初始化差异，已处理。 |
| P2-2 上下文兼容 | 唯一optional协议、v1.3.2 ignore合同、严格字段校验、父页面透传、保守图数、E关闭与源码回退分开，已处理。 |
| P2-3 范围/容量/SLO | 实际coverage/bar逐页发现D、20001超限证明、结构化容量错误、请求开始分类、UI/native起点、失败分母与分平台默认启用门槛，已处理。未来空白范围再补一句规则即可。 |

**最小补充 A：晚到历史响应要选定动作，不能只写“应复核”。** 第4.8目前既禁止状态倒退又禁止盲max，但没给冲突时动作。可复现情形是：较新响应/SSE已交付revision12，随后旧历史响应revision11才交付；其中某个旧bar在revision12真实修订过。保留12会让既有SSE revision相等直接跳过，旧bar可能不被纠正；无条件退回11及旧cursor则可能把纯backfill误作大批SSE变更并reset。

推荐采用一个有限的取数层复核协议，保持桥接不做bar缓存：同序列较旧快照晚到时，宿主仍保存合法回调，但不立即更新订阅已见状态；通过既有data请求透传原N/from/to与旧快照revision/as_of，以取数层检查该待交付窗口是否有快照之后的**既存bar修订**（revision>1），不因新增revision=1的更早bar作失效判断。无真实修订则交付原自洽快照，订阅cursor保留已交付最新bar，既有订阅检测水位不被纯分页推进；有真实修订则由后端按原真实D/H返回新的自洽必需快照，复核不抓E、不缩N、不将更晚metadata配旧bar。现有公开reload只用于确认真实修订后需要更新此前已交付原生历史的情况； inactive序列保留有限待办，回切处理，不能取消其仍合法回调。复核次数/总deadline有界，错误走正常err，不能无限重试。新上下文字段应纳入同一兼容验证；原始读取不触发此协议时不增加网络。

以上是可执行的推荐方向，正文应选定它或另一条能证明同等不变量的确定协议；不是要求照此增加通用同步框架。**通过条件**仍是屏障固定“新响应/SSE→旧响应晚到”两种测试：纯backfill无reset/无cursor倒退，真实历史修订不漏reload/不重复reload；不能仅测试revision单调max。单SQL解决服务器响应内部一致性，不能替代此交付顺序测试。

**最小补充 B：未来空白的有效范围是空集合。** 原始`from<to`合法，但`from>=clamped_to`时，剔除未来后范围条件真空满足，只按N/H数量需求读取历史；不得因为空范围返回422、503、noData或要求coverage跨越未来。第4.1/4.2补此规则及一个用例，现有原始区间校验和`<to`规则可以保留。

除上述两项，无需新增供应商实验、扩展全套测试或改变分层。修订后方案级通过仍以单SQL一致性、JSON目标竞争测试、同D/H指标对照、兼容组合与定义的正式浏览器门槛作为实施交付条件；不称代码验证通过。

## R2终审结论

2026-10-02，复核正文第4.2及“晚到历史响应的有界复核协议”补丁。**方案级审核通过：首轮2项P1、3项P2及R1两项补充均已处理，无剩余方案级阻塞意见。** 本结论取代R1的条件通过状态；不表示已实施、已完成代码/PG验证或性能达标。

未来空白范围已经明确为空集合，仅满足N/H，不要求覆盖未来。晚到协议已选定既有`/charts/data`最多一次复核，原需求保持、旧快照边界与观察版本透传、取数层一致读取实际`revision>1`修订、纯revision=1补历史不reload、真实修订返回新D/H且E=0、公开reload合并待办、非活跃回切处理、失败/再次乱序不盲max或无限复核，足以指导实施。此选择优于继续留下data/subscribe两个候选，不需要再引入订阅握手或新endpoint。

实施应落实正文已规定的通过条件，并在接口/测试中固定三个边界：`history_observation.first/last`描述原响应实际交付bar的chart_time窗口（last为实际最后bar，检查应包含该bar；空响应不伪造窗口）；复核结果缺失不能被当作`changed=false`证明（v1.3.2降级仍只是旧合同）；存在待更正状态时，正常SSE或另一较新历史响应不能提前清除待办或提升为“所有旧bar已见”，只有正文规定的无旧回调待交付且更正完成条件才消费。失败回调和更正待办的有限生命周期用屏障测试确认，不因错误伪造noData，也不把未验证状态称为成功修正。这些是所选协议的实现不变量，无需新一轮方案扩展。

后续交付仍必须提供单SQL快照/空bar测试、JSON任务CAS竞争测试、同D/H指标对照、新旧前后端组合、纯backfill与真实修订的晚到交错、20000/20001及未来空白边界测试，并按方案完成正式链路性能门槛。当前仅完成文档审核，源码、许可库、部署与上游配置未因审核改变。
