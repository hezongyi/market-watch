# Volume 修复 spec 独立评审

评审时间：2026-10-02 03:02 UTC。对象：`docs/volume-repair-plan.md`，共 115 行。问题基线：`v1.3.0` / `b9d69dd`。实施目标按当前代码确认：`8774f329f35aa2c56b2c14db280ab60718405138`；评审期间 HEAD 前进至 `db0c4e1340cd3a9dbdce46d561b85c41bbc263b0`，后者仅增加发布与验证文档，本文引用的产品源码没有变化。祖先 `1e8a17a` 已提交历史修订发布机制及 `o16_managed_revisions`。

结论：方案的断点定位、两来源口径、平台缓存隔离和原生图表供数方向正确。没有发现 P0。可以据此开始平台解析与前端映射等局部工作；**尚不宜把它作为完整实施和交付的定稿**。实施自建写入、补量和聚合前，应补齐下面三个 P1 契约。它们影响现有预警、历史任务控制或已补齐的数据，不属于可选增强。

未找到适用的 `AGENTS.md` / `CONTEXT.md`：已检查从根目录到项目的祖先路径，并搜索项目及 `/home/quant`。本次没有修改产品代码、spec、用户数据库或运行服务，没有部署、发送通知或创建其他 agent。验证仅使用独立内存 SQLite 和公开文档。

## P1-1：明确仅量修订如何绕过 OHLC 失效路径，否则会暂停预警并冻结错误的演练快照

**Spec 位置：第 34、55、58、70–72、99 行。** 第 34 行规定量不完整不能破坏 OHLC complete；第 58 行要求仅量更新触发聚合；两项之间缺少实际执行边界。

当前代码证据：

- `backend/alerts/market.py:211–245` 将响应中的所有已收盘 M1 都加入 touched；异步聚合分支无条件把重叠高周期 `complete=False`、`revision += 1`，不区分价格修订、仅量修订或完全重复输入。这条路径在 v1.3.0 的同文件第 207–240 行已经存在。
- `backend/alerts/chart_history_worker.py:54–57` 的真实历史执行器使用 `defer_aggregation=True`；`backend/alerts/market.py:723–728` 在导入之后调用现有预警求值。
- `backend/alerts/service.py:189–191` 遇到不完整行情暂停预警；`service.py:131–135` 在新建预警热身时重置状态。
- `backend/alerts/api.py:979–1029` 从 staging 的 `Bar` 创建演练不可变快照；`service.py:312–315` 会把快照里的不完整事件视为回放缺口并暂停。演练随后不会自动随数据库中的 complete 恢复。
- 当前 o16 发布器已经比较完整 payload 并递增已发布行修订：`backend/alerts/managed_dataset.py:173–177`、`298–319`；稳定历史前缀检查使用已发布行修订：同文件 `514–527`。因此量应进入图表修订，不需要为了显示量而重算预警状态。

**具体失败场景：** 最近窗口已有完整 M5，升级后的量补采只是补入同一组 OHLC 对应的 volume。如果复用现有异步 ingest，M5 暂时变为不完整。此时预警被暂停；用户新建的演练把这个中间状态永久写入快照。重试同一页还会继续制造修订和后续图表重载，与第 72 行的幂等承诺冲突。

已在当前代码的独立内存库做最小验证：五根已存在、价格相同的 M1，响应额外带 `volume`（当前解析会丢弃），摄入前 M5 `complete=True, revision=1`；调用异步 ingest 后为 `False, 2`，预警提示“ K 线数据不完整，等待补齐”；再次相同输入修订变为 3。此验证证明现有路径不能直接复用，并非声称未实现的 Volume 修复已接受过测试。

**建议补充：** 在实际写入比较结果中区分价格/完整性变化、仅量变化及无变化。仅量变化保持价格 complete、coverage、预警 state/cutoff 和已有演练快照，安排量聚合及图表发布；无变化不产生新工作或修订。存在真实价格差异才走既有价格失效流程。明确量任务等待期间的读取状态，不能仅以“预警与演练回归”代替这个规则。无需预先要求新增独立 revision 列；可复用现有图表修订，只要执行路径区分清楚。

## P1-2：旧历史补量尚未落成可执行任务契约，价格覆盖与任务完成不能证明量已补齐

**Spec 位置：第 59、65–75 行。** 这里仍使用“推荐后台任务”，没有决定任务归属、现有取消控制、独立完成条件及上游价格差异的默认处理。

当前代码证据：

- `backend/alerts/chart_history_plan.py:107–121` 只调度 pending 的价格历史计划，用 `stored_coverage` 的缺口推进；已有完整价格覆盖会直接完成，无法驱动旧行补量。
- `backend/alerts/market.py:658–708` 允许“已完整查询 OANDA”的响应推进游标；其他来源检查的也是已有完整 M1 是否存在。旧 OHLC 已在库时，这些条件不会发现本次 volume 缺失。
- `backend/alerts/chart_history_plan.py:279–303` 的取消/恢复只修改现有 `ChartHistoryPlan` 及 `ImportJob.chart_plan=True` 的任务。新增独立补量任务不会自动纳入这些控制。
- `backend/alerts/market.py:147–150` 校验 source/basis；`upsert` 和 `write_bars` 的既有 candle_revision 流程会直接替换不一致的 OHLC：同文件 `68–85`、`backend/alerts/bar_batch.py:38–72`。当前不存在一个独立的“只记录价格冲突、保留发布价格”的审核流程。
- 历史执行器已有全局和逐品种聚合队列上限、近期修复优先及来源退避：`backend/alerts/market.py:574–627`。新增任务绕开此执行器会失去这些现成约束，单用 HTTP history lane 不能约束聚合积压或持有 Instrument 锁的时间。

**具体失败场景：** 已完成维护的品种没有价格缺口，升级后只新增 nullable 列并复用原计划，旧图表长期仍无量；或者补采返回没有 volume 的同时间价格，旧 import 判定成功并越过游标。另一个场景是用户取消历史任务后，上游响应仍在飞行，新增量任务继续提交，因为取消没有撤销它的租约。补量命令若直接交给既有 upsert，遇到上游 OHLC 差异还会同时修改价格。

**建议在开工前固定最小任务契约：**

1. 决定复用扩展 `ImportJob` 还是独立任务；明确执行器和可检查/取消/重试入口。保留已批准起点，明确补到的固定上界，以及 complete、cancelled、realtime_enabled=false 和无计划旧历史的处理。取消与提交使用同一租约/状态检查，不能借补量调用 join/resume 来改变维护授权。
2. 对缺量 M1 独立推进游标；区分已补齐、查询后仍缺量/不可达及待重试。OANDA 合法无观测区间不生成虚构行，已有 M1 但本次缺量不能靠价格覆盖宣告成功。
3. 明确价格差异默认保留价格并记录冲突，还是执行现有价格修订；若执行修订，量和价格必须来自同一有效观测并接受 P1-1 的价格失效语义，不能只说“进入既有流程”却承诺这项任务只补量。
4. 沿用现有短页执行、近期修复优先、来源退避和聚合队列背压。无需增加进程或连接池预算，也不要求额外的通用调度平台。

上述是任务正确性需要的决策；不要求在实施前保证所有上游历史都能取得，也不要求先下载全历史。

## P1-3：可空 volume 与旧调用兼容之间缺少合并规则，已知量可能被后来的无量输入擦除

**Spec 位置：第 32、53–55、70–72 行。** `null→有量` 的空值安全比较要求正确，但只规定它还不足以定义 `有量→null` 应如何处理。

当前代码证据：

- `backend/alerts/domain.py:33–41` 的旧 Candle 调用没有 volume。第 53 行选择在末尾新增默认可空参数后，这些旧调用自然携带 `None`。
- 单条 upsert 把所有 values 直接写回：`backend/alerts/market.py:68–84`；批量 upsert 对全部 keys 使用 excluded 值覆盖：`backend/alerts/bar_batch.py:17`、`55`、`64–72`。只将 volume 加入 keys 并改用 `IS DISTINCT FROM`，也会让已知值被 None 覆盖。
- `backend/alerts/storage.py:329–336` 的 `candle_from` 恢复旧 JSON 时必然面临缺字段；聚合还有重建 Candle 的包装点：`market.py:310`、`chart_data.py:159–168`。这些点须带量，但“兼容旧调用”本身不保证旧写入不擦量。

**具体失败场景：** 已补齐 M1 的量为 `12.3`，随后同样 OHLC 的旧格式观测或缺 volume 的响应被解析为 `None`。按第 55 行直接扩展现有差异检测，记录一次 revision 后把量写成 null，重新把派生桶和图表变成未知。反过来，无条件 `COALESCE` 保留旧值也不安全：如果价格确实更正，新价格可能配上旧观测的量。

**建议补充：** 定义字段未提供、来源明确报告未知、有效值（含零）和显式撤销的输入语义。默认补量合并中，同 OHLC 的无量输入保留已确认量；量从同一来源新观测更正时覆盖；发生价格更正但新观测无量时不能静默保留一个未经确认仍匹配的旧量。单条和批量路径使用一致策略，并在此策略之后做 NULL 安全差异比较。实现测试至少覆盖“有量后旧格式重放”“零不被当成缺失”“价格更正且缺量”；不是额外要求一般性事件版本框架。

## P2-1：迁移和发布版本描述已过期，Volume 不能再次使用 v1.3.1

**Spec 位置：第 3、61、106–108 行。** `o16_managed_revisions` 已提交，当前 `pyproject.toml:7` 和 `web/package.json:3` 均为 `1.3.1`。`docs/versioning.md:48–50` 及 `docs/chart-v1.3.1-delivery.md:13–18` 已把此版本和 o16 归给历史修订修复。评审期间增加的 `db0c4e1` 也仅记录该发布。

问题基线保留 v1.3.0 合理，但实施基线应固定到实际当前提交；新迁移接在 o16 后，Volume 使用下一未占用版本（若仍为兼容修复，通常是 v1.3.2），同时确认本地/远端标签状态。不能移动既有标签，也不能借历史修订版本的验证记录宣布 Volume 已通过。这项可在代码实现前准备阶段修正文档，不阻塞解析代码，但阻塞打包交付。

## P2-2：Numeric(38,18) 不能独自兑现跨数据库的 Decimal 精确保留

**Spec 位置：第 32、42、53、93–95 行。** 当前存储显式支持 SQLite 和 PostgreSQL：`backend/alerts/storage.py:251–266`；批量写入也选择两种 dialect：`backend/alerts/bar_batch.py:15–16`。在独立内存 SQLite 直接用 SQLAlchemy `Numeric(38,18)` 写入 `Decimal('0.12345678')`，读取为 `0.123456780000000002`，不再相等。声明 Numeric 并没有改变 SQLite 的实际数值存储行为。

建议明确此次真实精度验收以 PostgreSQL 为准，SQLite 的精度限制记录为限制；若也承诺 SQLite 精确持久化，则需为它采用精确编码，不能继续仅凭 Numeric 声明承诺。另需明确允许的数值范围和小数位：PostgreSQL 该类型最多 20 位整数、18 位小数。此处没有证据表明当前 Binance/OANDA 样本越界，不把它升级为生产阻塞；原生 Bar 数值转成 JavaScript Number 的显示精度也不能被宣传为无损 Decimal。

## 已核实无需改方向的部分

| 范围 | 证据与判断 |
| --- | --- |
| 来源语义 | Binance 官方 `/api/v3/klines` 响应顺序支持第 5 项为 Volume，第 7 项为 quote asset volume、第 8 项为交易笔数；OANDA 明确定义为该 candle 时间范围内产生的 prices 数量。Spec 第 23–28 行正确。 |
| 平台 JSON 缓存 | `storage.py:516–526` 使用 JSON payload；`provider_cache.py:42–60` 的 identity 当前只有价格/对齐等维度。独立 payload 版本隔离旧价格缓存是必要且可行的，不需 volume 列。版本应覆盖所有新数据集读取与写入入口，保留旧数据集用于回退。 |
| 平台修订/SSE | `provider_cache.py:198–211` 已比较完整 payload；`provider_service.py:227–249` 用旧桶 revision/changed_at 决定公开 reset，`289–298` 发送原 payload。添加量后可以复用，不需重做 SSE 协议。 |
| 自建九周期 | `domain.py:140–160` 负责 M1 聚合；`market.py:310` 再包装结果；`chart_data.py:126–169` 的 M30 和周/月另建 Candle。Spec 正确涵盖这些路径，应确认所有包装点保留量，且沿用 coverage/休市判定合法成员，不能枚举并填补合法稀疏观测。 |
| 发布快照 | 当前 o16 的 publication queue 和行修订已可传播内部 payload 更正；M15→M30、D1→W1/MN 见 `publication_jobs.py:15–35`。实施必须基于此代码，v1.3.0 的发布器不能兑现相同承诺。 |
| Python 内部协议 | `advanced-host/bridge.js:175–184` 写出 0/1；`advanced-host/indicators.js:81–83` 用它过滤无效值。Spec 第 81 行正确，市场量不能替换此协议。 |
| 原生公开接口 | 实际随项目安装的 `advanced-host/charting_library/datafeed-api.d.ts:33–49` 支持可选数值 Bar.volume；第 735–749 行声明 `visible_plots_set` 和 `volume_precision`。不需要修改原生库内部代码。Binance 小数精度与 OANDA 整数量应分别配置。 |
| 初始元数据与 resolve | 平台初始元数据来自 `advanced_api.py:267–274`，普通 resolve 来自 `market_data.py:659–675`；前端两者汇合在 `bridge.js:304–342`。Spec 第 33 行覆盖初始/后续两条路线，实际缺量状态宜按范围独立报告，不能把“支持 tick/base 来源”当作“全部历史已完整”。 |
| CSV | `chart_export.py:47` 和 `75` 已有量列和空值行为；Spec 的扩展方向可实施。与文件关联的口径/单位仍要实际落地。 |
| 迁移/备份/回退 | Nullable、无默认零、真实 PG NULL 比较、独立恢复库、旧缓存保留、同提交镜像、兼容验证后留列或恢复备份都合理。`backup.py:157–196` 支持随机新库实际恢复。应按实际 n15→o16→Volume 迁移链演练，并证明旧镜像在迁移后 schema 上可运行；这里只审阅了机制，没有执行 Docker 或备份恢复。 |
| 真实图表验收 | 第 98、102 行要求真实来源、数值及可见柱形，门槛正确。必须至少有已确认正量样本；真实零没有柱形高度是正确行为。缺字段在当前原生版本中显示为空而不伪装成零仍是浏览器待验证事项，不由类型声明证明。 |

公开来源（2026-10-02 已读取）：[Binance Spot REST API](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#klinecandlestick-data)、[OANDA Candlestick 定义](https://developer.oanda.com/rest-live-v20/instrument-df/#Candlestick)。未以不存在的第三方精度/行情保证替代这些来源。

## 开工与交付边界

实施前必须冻结 P1-1 的修订分流、P1-2 的任务生命周期/授权/完成条件、P1-3 的缺字段合并语义，并确认最终基线、迁移链和新版本。平台解析、普通 barsOf 映射和公开元数据扩展可以先开展，但不能绕过这些决策开展自建批量补量。

可延后：不可取得的旧历史全量补齐、初次全历史完成时间、24h 量面板、VWAP/成交量分布/成交量蜡烛的能力宣传、其他来源接入，以及非本次 PostgreSQL 目标的 SQLite 精确编码。它们不应阻塞已确认来源的原生 Volume 修复。

交付前仍须完成 spec 已有的真实 PostgreSQL NULL/upsert、九周期和原生浏览器验证、备份迁移回退，以及八图负载下有限补量的性能验收。本次没有这些新功能的运行证据；Docker/Chromium 环境限制应继续如实保留，不得以源码评审或原版本 accepted=true 代替实例修复验收。
