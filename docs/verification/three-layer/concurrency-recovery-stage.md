# 十品种、多图、历史维护并发与实际断线恢复

日期：2026-10-07。本阶段完成有限窗口并发和恢复验证；完整 A–E 与长期质量仍待收口。

## 实现与回归

真实十品种串行 REST 确认曾出现 p95 约 11.6–18.7 秒，后排品种超过候选 15 秒目标。
确认改为最多两个并行网络等待，每批只提交两个请求；线程显式进入既有 realtime 额度，
保留跨进程每秒两个请求/两个槽。所有确认提交仍在调用线程串行执行，校验账户拥有者、
token、epoch 与期限；取消后不发布已完成的同批结果，鉴权失败不提交后续批。
没有把 stream 与 REST 共用网络连接，也没有增加供应商总额度。

历史循环原来忽略周期产物处理的返回值，成功生成一个分块后仍可能等待五秒。
现在产物取得进展也使用既有一秒忙碌等待，不改变发布、引用保护或历史身份。

- 历史本地 **25 passed /9.37s**，实际 PostgreSQL **16 passed /27.30s**。
- 确认生命周期、stream、来源与额度本地 **37 passed /4.11s**；实际 PG 拥有者和组合策略
  **20 passed /46.95s**；完整后端 **1067 passed /227 skipped /253.80s**，33 个既有迁移警告。
- 最后补充实际 PG 的 401/429 及确认生命周期 **10 passed /9.88s**。使用实际 OandaPractice
  adapter、HTTP MockTransport 和独立测试 schema；故障 HTTP 为受控注入，未改供应商价格。
  验证 401 拒绝后续发布且持久配置故障阻止重连；429 不写确认价格，遵守 Retry-After，
  realtime/chart/history 共用冷却，期限前不重试。不能称作真实供应商故障。
- 新两路并发合同初轮因 helper 未实现失败，之后修复通过；Ruff、JS 语法和 diff 检查通过。
  完整回归先于最后新增的两项 PG 合同；后者单独复验，不把新增数目并入全量通过数。

## 实际供应商与浏览器

Ubuntu 独立实例同时维持十条持久固定 M1 策略：既有 Dukascopy→OANDA EURUSD/XAUUSD，
以及 OANDA→OANDA AUDUSD、GBPUSD、USDJPY、USDCHF、USDCAD、EURJPY、EURGBP、GBPJPY。
后八组准确相同账户/品种/Bid 的映射已有显式依据；历史维护频率 once。
没有外部通知投递，没有注入测试行情或下单。

两个实际许可四图工作区共八个图格，七个可见品种，EURUSD 跨窗口复用；
每个选择以实际历史读取记录验证。数据库运行快照确认 **8 条图表租约、10 条持久策略、
1 个活跃 stream 拥有者、10 个订阅品种**。同时提交十个有界历史复查任务，全部发布，
旧策略固定的历史版本/修订保持不变。

首次十条策略全部 ready 等待 **126.832 秒**，包含默认 1500 分钟恢复；
初始八份 M1 快于请求的周期产物，后者曾等待约两分钟，随后发现并修复历史忙碌等待。
恢复脚本继续使用真实默认恢复参数，没有为了验收缩小恢复范围。

五分钟测量 **100 次轮询、50 个新增确认分钟**。实际 PG 对相同开市窗口按十品种各五分钟
核对，共 **50 个预期分钟全部确认**，unknown=0、missing=0、失败尝试=0，未排除已结束分钟。

| 实测口径 | p95 | p99 | 限制 |
| --- | --- | --- | --- |
| 来源 M1 确认 | 11112 ms | 11405 ms | 时间戳在 ingestion flush 后、事务提交前；未验证源时钟偏差 |
| HTTP 组合确认可读 | 13090 ms | 13131 ms | 3 秒轮询，上界估计，包含读取/聚合 |
| 缓存组合读取 | 52.647 ms | — | 实际短历史，不能代表多年冷历史 |
| 策略有效判断记录 | 30664 ms | 32191 ms | 43 条 evaluated；与来源确认延迟分别统计 |

完整判断分母为 **54 条：43 evaluated、11 recovery_baseline**。恢复基准不会发送历史事件，
也没有从策略延迟统计中掩盖其存在；不是 50 个分钟均产生一次策略事件。
正常分钟可能短暂 warming 等待聚合水位，不把每次采样描述为全部 ready。

43 条判断可以准确连接同输入事件与持久 M1 聚合记录；阶段 p95 分别为
收盘到输入事件 **10818ms**、输入到 M1 聚合 **20450ms**、聚合到判断 **1376ms**。
这些分位数不能相加，created_at 也不是事务提交时刻。证据显示主要额外等待在聚合调度，
没有依据归因于供应商库。HTTP 图表可在持久水位落后时有界读取固定 M1，而策略等待所需
周期完整持久水位，因此两者时延不同。此性能限制保留，尚未通过更长窗口确定稳定分布。
后续只读调度快照为 20 个修订/180 个周期任务、7 个待追平任务、无任务错误；
旧显式修订也维护各自固定输入。该瞬时快照不用于证明完整延迟分布或单独归因。
本轮与全量本地 pytest 同时运行，存在额外主机 CPU 负载；候选来源确认目标达成，
不把该结论延伸成策略延迟目标或 48 小时质量结论。

## 实际停机与恢复

只停止精确容器 `market-watch-three-layer-pricing-worker-1` **120 秒**，没有停止数据库/API。
停机 30 秒后十条策略全部拒绝判断；历史图表仍可读，固定绑定不变。
finally 恢复同一容器，约 **84.831 秒**后十条策略全部恢复，epoch 增加，确认水位推进。
实际 PostgreSQL 上受控发送旧 epoch heartbeat，**30→31** 期间拒绝旧世代发布；
未提供合成价格，拥有者 token 不输出。

浏览器关闭后持久策略继续支持上述停机测试。阶段结束只取消记录的十条验收策略，
只删除两个脚本自己创建的工作区；保留有用的历史数据、映射和版本供后续质量验收。
最终释放与闲置状态另存私有证据；旧观察实例及其他项目不变。
实际等待 **50.180 秒**后复核：本次 cancelled Watch=10、活跃图表租约=0、
所需来源=0、活跃 stream 拥有者=0、全部来源状态 inactive；容器继续运行并等待后续需求。

## 证据、环境与边界

可提交脚本为 `scripts/verify_composite_concurrency.py`（setup/measure/release）、
`scripts/verify_composite_recovery.py`（有 finally 恢复）、
`scripts/verify_concurrency_evidence.py`（只读实际 PG）和
`scripts/verify_obsolete_pricing_epoch.py`（明确受控旧世代 heartbeat）及
`scripts/verify_concurrency_idle.py`（确认释放后实际闲置）。
浏览器入口为 `web/tests/composite-concurrency-real.browser.cjs`。
私有真实记录和完整失败保存在忽略的 `artifacts/data-integration/concurrency10-*`。

失败分母：初次 setup 误提交 Watch 不接受的 dataset/mapping 字段，正确返回 422；
恢复已有发布任务后改为合格搜索候选，未重复创建历史。初次浏览器以 `platform=MWC:`
进入平台创建接口遭拒绝，改从原生入口创建工作区再显式选固定组合；没有扩大接口权限。
最初独立证据脚本曾误读判断字段，改用 event_time/created_at；最终报告覆盖完整分母。
首次浏览器通过后新增末尾固定绑定断言；最终完整浏览器复验三项通过、pageerror=0，
330 秒持有结束后十条策略仍固定原输入，结果单独保存。

Ubuntu 本机 Compose **market-watch-three-layer**，PostgreSQL 14，migration ak38。
UI/API <http://127.0.0.1:16629>，许可图表 origin <http://127.0.0.1:16630>。
启停：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime start api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
```

约 **56GB**可用，不存在用户权限/凭据/空间或业务决策阻塞。本轮没有 Docker 资源清理。
剩余自建历史 DST 样本、完整逐条与桌面/旧身份审计，以及稳定版本单独 **48 小时工程观察**。
新观察尚未启动，到期不自动判通过。完整目标未完成，未推送/PR/生产操作；MT4 后续。
