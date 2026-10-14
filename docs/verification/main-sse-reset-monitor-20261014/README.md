# 主 SSE 10 分钟 reset 监测分析

2026-10-14，新加坡时间 **12:59:31–13:09:31**，连续 **600.108 秒**。Ubuntu 浏览器连接现有 Unraid 正式 v1.25.3；没有部署、改配置或修改应用实现。临时切换平台 OANDA EURUSD 五图工作区（M1、M5、H4、D1、W1），阻止自动偏好／布局保存；无指标、无拖动。浏览器监测后已关闭。

## 结论

**13 次 reset 全部为 `history_changed`，并对应 13 次原生 `resetData`。M1 每个分钟交接都出现一次。** 主 SSE 已先交付旧柱确认更新和新柱，之后历史检查仍使用 HTTP 历史加载时的 `observed_at`，把已交付的确认更新再次判为历史更正。

| 周期 | 主 SSE reset | 原生 resetData |
| --- | ---: | ---: |
| M1 | 10 | 10 |
| M5 | 2 | 2 |
| H4 | 1 | 1 |
| D1 | 0 | 0 |
| W1 | 0 | 0 |

主 SSE 原始业务消息：`quotes` 1687、`bars` 205、`reset` 13；另有命名 heartbeat 1115。数量按监听者消息计，不代表独立上游写入。SSE transport error、页面异常、监测窗口 HTTP 错误均为 0；没有观察到旧 provider SSE 消息。其他 reset reason 均未出现，本结论限定这一个工作区和窗口。

## 证据链与当前源码

1. `market_stream.delivery` 的 provider 检查以 `revision > 1`、`changed_at > observed_at` 及已加载范围为条件，任何 payload 修订都可命中。`provider_cache.store` 对 complete、volume_complete 等元数据变化同样增加 revision／changed_at。
2. 交付 bars 后，`delivery` 更新 `loaded_before` 为新柱起点；provider 分支没有同时建立逐柱消费接受凭据，原 HTTP `observed_at` 仍保留。上一根因此从“当前柱”进入历史检查范围。
3. 下一次共享结果送达，旧柱已确认更新再次命中检查，返回 `reset/history_changed`；bridge 清缓存并进入历史恢复／原生 resetData。
4. 13/13 次 reset 之前，SSE 都已交付已确认旧柱和新柱（12 次同一消息，1 次旧柱先确认、随后追加新柱）。reset 出现在最后一条 bars 消息之后约 **13.591–28.523 秒**。
5. 监测结束后，以 `SET TRANSACTION READ ONLY` 对 13 个旧柱逐一核对：13/13 的 `changed_at` 早于对应确认 bars 的发出时间；13/13 的数据库原生 OHLC／volume／时间投影与已发出的旧柱一致；13/13 仍满足原 HTTP 观察时间的修订条件。未发现这些柱在确认交付后又发生新的持久修订。

生产 `market_stream.py`、`market_stream_worker.py` SHA256 与本 worktree 一致，源码定位适用于被监测版本：`backend/alerts/market_stream.py:500`（检查）、`:574`（推进边界）；`backend/alerts/provider_cache.py:359`（payload revision）；`advanced-host/bridge.js:100`（实时接受）、`:2592`（恢复）。

## 确认交接时实际改变了哪些内容

| 确认前后的原生数据差异 | 次数 |
| --- | ---: |
| OHLC 与 volume 同时变化 | 11 |
| 仅 volume 变化，另伴随确认状态 | 1 |
| 原生 OHLC／volume／时间完全不变，仅确认状态变化 | 1 |

这张表比较 SSE 中最后已交付的未确认旧柱与确认旧柱，不是全站源提交分类。全部已通过 bars 发出，不能因包含真价格／成交量补确认就认为随后整段重载必需；也不能将全部样本称为“纯元数据误判”。

纯元数据例：**13:05:11.327** 交付确认旧 M1 柱和新柱，旧柱仅 `complete`、`volume_complete` 变化；**13:05:26.351** 对同订阅返回 `history_changed`，随后原生 resetData。后台只读变化采样也观察到该旧柱原生投影未变。

## 逐次 reset

| 新加坡时间 | 周期 | reason | 确认交接差异 | 距上一 bars 秒数 |
| --- | --- | --- | --- | ---: |
| 13:00:18.469 | H4 | history_changed | OHLC + volume | 13.591 |
| 13:00:35.031 | M1 | history_changed | OHLC + volume | 28.523 |
| 13:00:40.929 | M5 | history_changed | OHLC + volume | 15.170 |
| 13:01:25.098 | M1 | history_changed | volume | 15.189 |
| 13:02:28.911 | M1 | history_changed | OHLC + volume | 14.808 |
| 13:03:33.102 | M1 | history_changed | OHLC + volume | 15.487 |
| 13:04:21.733 | M1 | history_changed | OHLC + volume | 15.250 |
| 13:05:20.470 | M5 | history_changed | OHLC + volume | 14.016 |
| 13:05:26.351 | M1 | history_changed | 仅确认元数据 | 15.024 |
| 13:06:30.271 | M1 | history_changed | OHLC + volume | 16.041 |
| 13:07:18.894 | M1 | history_changed | OHLC + volume | 16.042 |
| 13:08:24.668 | M1 | history_changed | OHLC + volume | 16.120 |
| 13:09:29.889 | M1 | history_changed | OHLC + volume | 15.514 |

## 后续调整建议（未实施）

优先收敛主 SSE 的“已交付尾柱确认再次触发历史更正”判断，并按原生 OHLC／volume／时间投影区分确认元数据变化；保留真正未被接受的旧柱价格、成交量修订及删除等恢复。不能简单全局推进 observed_at 到当前时间，否则可能漏掉其他已加载历史的真更正。应以成功接受的柱／范围建立明确证据。收束旧 provider SSE 出口属于独立维护事项，本次定位的问题在主 SSE 的消费历史检查中。

## 范围与复查

浏览器捕获原始 EventSource message、heartbeat、订阅请求，并以临时运行时包装记录 resetData；未改变服务器或应用源码。辅助数据库探针在主观察开始约 51 秒后开始，每 2 秒采样五个周期最新 16 根柱，可能合并采样间隙内的多次提交。结论还使用结束后的 13 根旧柱只读核对；没有把采样数当作全部源提交数。

未测试其他账号／品种、组合 K 线、指标或拖动，也未录屏；本记录证明事件与重置链，不能作为无闪绘制验收。完整事件和会话仅保留在受限私有目录，不提交密码、cookie、账户、数据集身份或行情价格。

[脱敏完整统计与逐次事件链](summary.json)。
