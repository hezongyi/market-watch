# Pricing 线程优化思路与执行边界

此文最初作为分析交付；用户随后认可执行。实施按以下步骤 1–3 推进，步骤 4 仅在测量支持时考虑；执行与验收结果另记 pricing 优化证据文档。

## 基线和证据

- 工作树 `/home/quant/repos/market-watch-idle-v2-20261112`；分析基线 `56f95db4`，开发运行代码 `2814c38b`，PR #134。
- 最近 900.320 秒、4,085 条接受报价、0 浏览器/订阅/活跃告警：pricing 线程 **3.178% 单核**，全服务 **12.534% 单核**。
- 已运行的固定 600 报价 PG 回放：6,626 SQL、600 commits，稳态 **7 SELECT + 4 UPDATE**。初始化/分钟切换/续租等额外语句不能用稳态数字概括。
- cProfile 显示 ORM 查询、flush、驱动和提交是主要累计耗时路径；累计时间包含网络/数据库等待且相互嵌套，不能相加或称为 CPU 占比。现有回放只覆盖两身份、无规则、单分钟；下一轮需要补齐真实三身份、分钟切换、活跃规则与确认并发。
- 原始回放和线程证据在私有目录 `~/.local/share/market-watch-dev/updates/idle-v4-execution-20261112/`。不提交其中私有配置。

## 当前每条报价为何有开销

| 读操作 | 作用 |
|---|---|
| PricingOwner FOR UPDATE | 检查 token、epoch、租期及维护/认证状态 |
| MarketDataset KEY SHARE | 保护父数据和首次规则注册边界，当前锁订阅集合 |
| LiveState | 去重/乱序、epoch、连接、最新报价、forming |
| Instrument | 当前日历与状态 |
| LiveMinute | 报价统计、期待证据、时延直方图 |
| ObservedMinute | 经过展示准入检查的分钟 OHLC |
| 活跃规则配置查询 | 当前事务判断是否需要保存价格告警输入 |

无活跃规则时依然更新 LiveState、Instrument、LiveMinute、ObservedMinute 四处。无浏览器并不等于接续行情停止更新；交易判断算术很少，关系型读写、JSON、ORM 对象维护更值得优化。已有报价日历结果复用、半租期续租、handover 正完成缓存和避免双次 LiveState UPDATE，本轮不重复把这些列为待实现收益。

## 推荐步骤

### 1. 合并同一事务内状态读取，优先实施

保持 owner 锁、dataset 锁及其顺序。取得 dataset 锁之后，用一次有精确 dataset/minute/epoch 条件的查询读取当前 LiveState、Instrument，并 LEFT JOIN 当分钟的 LiveMinute、ObservedMinute。返回对象在本事务保持引用，后续 helper 复用；不存在的分钟仍走原创建/容量校验。

**可验证目标：稳态 7 次 SELECT 降为 4 次，约 11 条 SQL 降为 8 条（减少约 27%），仍每条报价一次提交。** 这是 SQL 结构目标，尚未证明 CPU 下降比例。不在这一步合并 owner/dataset 锁 SQL，不跨事务缓存 live/规则/日历状态。

首次 handover 会刷新状态或创建展示行，必须走原路径或在 handover 后重新取得当前观测。外连接不能把缺失分钟过滤掉，也不能把所有连接表一起加 FOR UPDATE 改变锁顺序。异常/重复报价路径以功能正确为准，不为了稳态数字多做无用加载。

涉及：`live_pricing.publish_event/_minute_observation`、`display_observations.accept`。不要将“未预读”和“已读取但不存在”混淆，否则首次分钟会重复读取或创建。

### 2. 组织一次计算和集中 flush，随后测量

当前回放约 1,802 次实际 flush / 600 报价（约三次/条），虽然 LiveState 已只 UPDATE 一次，仍重复运行 UnitOfWork 和全局 before_flush hooks。

先把当前状态读取与必要判断放在状态修改之前，完成本条字段计算后再统一落库；仅在已经证明安全的纯读取区间禁止 autoflush。稳态无规则路径争取约一次 flush/quote，首分钟、handover、活跃规则注册/容量检查保留必要 flush。

**成功条件是 CPU 时间下降并保持四份状态和消费者查询的可见性，不能只追求 flush 次数。** 不笼统包住整个 publish_event 禁止 flush，不绕过引用/不可变身份保护，不把活动规则输入的 sequence/retention 流程当作纯读取。

涉及：`live_pricing.py`、`display_observations.py`、`price_alert_inputs.py`；核对 `storage.immutable_dataset_identity` / `history_retention.guard_reference_writes`，不优先改全局 hook。

### 3. 每条报价复用身份与价格解析，作为小补丁

- `DatasetIdentity.key` 每次访问都会 model_dump + canonical JSON + SHA256。先在一次 publish 内计算并复用 dataset_id；锁订阅集合可在该连接 immutable subscription context 内预计算 ID，但数据库锁每事务照常取得，身份变化随连接重建。
- bid/ask 在 QuoteEvent 校验、forming、展示、告警中重复转 Decimal。复用当前条的精确解析和身份 dict，保留各调用者不同的业务准入条件。避免改为 float。
- LiveState.forming 与 ObservedMinute 都计算 OHLC，但前者接收原始报价、后者有 freshness/spread/tradeable/session 准入门槛，**不能因结构类似直接共用结果或删掉其中一个**。
- 活跃消费者查询保持每条 authoritative；查询无消费者时可提前结束后续告警专用证据构造，但不要多查一次，也不缓存“没有告警”。收益须单独量测，不能假设是主因。

涉及：`live_pricing.py`、`market_contracts.DatasetIdentity`、`display_observations.py`、`price_alert_inputs.py`。优先局部变量，避免给通用 Pydantic 模型增加改变序列化/hash/复制语义的全局缓存。

### 4. 前三步后仍昂贵，再评估局部 SQL 写入

对有明确性能证据的热点评估参数化 Core UPDATE / UPSERT，减少 ORM 对象跟踪。逐条四份状态、确认并发字段和提交语义全部保留；先做一个表的局部替换，比较总 CPU 和代码复杂度。

这一步成本较高，尤其 LiveMinute 与确认线程共享 expected/attempts/confirmed_at，不能覆盖非本条负责的字段。JSON 列为 JSON，不能直接套 JSONB 的增量函数；不把表结构迁移或数据库存储过程引入首轮。SQLAlchemy execute 次数减少也不等于 DB 实际执行语句减少，必须分别记录。

## 验证与完成条件

后续实施按 F1，无 schema：

1. 复用任务独立 PG（25475）和 volume，启动前只读检查资源与其他项目，不写开发库做合成测试。
2. 扩充私有 `quote_replay.py`：三身份、跨分钟、无规则/活跃规则两个场景；独立记录不带 profiler 的 process CPU、DB CPU、SQL、commit 数及 P95。相同输入、交替基线/候选多次；cProfile 另跑，避免将插桩开销算成收益。
3. 先写实际调用入口的回归，验证稳态 SELECT 和 state UPDATE 数量，并验证输出与旧实现逐字段一致。保留首次分钟、handover rollback、乱序/重复/失效 owner、无 bid/ask、非交易、陈旧/闭市、分钟跨越。
4. PG 并发验证首个告警注册、确认同时更新 LiveState/LiveMinute、断线重连、容量不足、事务失败回滚。新首条规则生效后的下一条报价不能漏存。
5. 每组修改单独测量，收益无实测或可维护性变差就不保留；适用的独立 Standards/Spec review 后才构建开发候选。
6. 若获实施授权，开发部署后验证网页、供源、组合和活跃告警；停止测试 PG/关闭浏览器，3×300 秒同窗统计 CPU、报价数和确认产物；更新 #134，不追踪 CI、不合并、不打 tag、不操作生产。

执行入口建议：`按 docs/plans/pricing-optimization-analysis-20261112.md 推进步骤 1–3；步骤 4 仅在测量支持时实施。保留逐条提交、展示、告警和并发围栏，完成本地/隔离 PG 验收、独立审阅、开发部署及同窗 CPU 比较后更新 #134，不跟踪 CI。`

## 预期的边界

pricing 当前只占全服务约四分之一。即使它的 CPU 减半，全服务按当前其他开销不变仍约 **10.95% 单核**，距离全服务单核 3% 很远。这里只是算术说明，不是减半收益承诺；PG 可能跟随受益但不能提前量化。

优先验收“更少查询、相同持久结果、实测更低 CPU”。暂不承诺 pricing 达到 1% 或全服务达 3%，也不采用跨报价批量提交、展示降频、弱化同步提交、内存替代持久记录或取消首个规则注册围栏来达成数字。
