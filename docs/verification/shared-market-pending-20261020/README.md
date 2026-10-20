# 共享行情读取失败：原因与解决方案

观察：2026-10-20 13:14 UTC。Ubuntu quant-server，project mw-issue75-v2-20261018。只读调查，没有部署、重启或修改真实数据。

## 实际消息

19 条同标题消息，全部为 shared_quotes：OANDA HistoryPending 17 条（XAUUSD、EURUSD、GBP_USD）；Binance ConnectTimeout 2 条（BTCUSDT）。该统计对应本次数据库查询的过去24小时范围，不代表所有历史故障。

最新 XAUUSD 消息于13:10:42.421 UTC发生，13:10:57.601 UTC恢复。19条中14条记录了恢复，另5条在取消观察时结束，不据此宣称当时行情恢复。观察时4个相关任务均为正常报价，notice_open=false。

## 已证实的调用链

provider_chart.cached_page 在 OANDA rest_batch 且有活跃需求时，只读共享缓存。缓存为空或 latest_at 距今达到15秒即抛 HistoryPending；此分支没有执行供应商HTTP请求。

quote_page 捕获所有异常；有上次成功报价时保留价格但设置 fetch_failed，无上次报价时由 quote_snapshot 输出 error。market_notices.result_state 将这些状态统一归为 failed，record_result 生成“共享行情读取失败”。

隔离回放使用运行API镜像中的真实函数，数据库/网络边界替换为固定输入：缓存14秒 => healthy，无通知；16秒 => HistoryPending/fetch_failed，生成同标题；再14秒 => healthy。命令：docker exec -i mw-issue75-v2-20261018-api-1 python < /tmp/mw-shared-market-repro-20261020.py。该进程不写数据库、不发供应商请求。

运行参数：OANDA批次间隔2秒，报价读取间隔15秒，缓存新鲜度15秒。短暂等待的异常分类与真实读取失败混合，且恢复通常要等下次报价读取。

pricing-worker近30分钟日志另有 candles_latest ReadTimeout（约7秒）、candles HTTP504及oanda_native_cache_busy。它们可能推迟缓存更新，但现有HistoryPending证据不记录缓存年龄、空缓存或上游批次结果，不能把每条消息都精确归因于这些日志，也不能确定504由供应商还是中间网关生成。

Binance两条为真实ConnectTimeout，已有代理配置且已恢复；当前证据不能进一步区分代理连接、代理到供应商连接或其他网络环节。

## 建议实现

1. 给共享读取显式定义 pending / stale / failed，携带 cache_age_ms、last_success_at、等待原因和最近批次结果；冷启动及等待更新不立即产生失败事故。
2. 有旧报价时保留价格和原采样时间，显式标注暂未更新；没有报价时显示等待。pending不标healthy、不关闭既有事故；缓存数据不能充当供应商成功恢复证据。
3. 在共享任务级为pending安排有限、带抖动的短间隔缓存重读（例如2秒），不额外打开单品种供应商HTTP请求。持续等待按单独阈值升级（建议30–60秒，需以采集预算与产品要求确定），真实鉴权/网络/HTTP错误保留相应告警。
4. 给真实超时做有总预算的退避重试、共享任务合并与恢复迟滞；按实际代理链路补充分段耗时证据。不能仅扩大15秒阈值或屏蔽所有HistoryPending。
5. 通知文案区分“等待首次报价”“OANDA 报价暂未更新”“Binance 行情连接超时”，保留恢复、观察结束和历史失败的区别。

## 验收标准

覆盖冷启动、短暂缓存过期、持续超期、缓存写入竞争、上游504、Binance连接超时和真实恢复；验证短暂等待不弹失败、持续异常必升级、旧价格不伪装新鲜、旧缓存不触发恢复、多窗口只归属同一个共享任务。恢复历史记录与真实故障证据均保留。

本次交付为分析与方案，未实施上述修改。
