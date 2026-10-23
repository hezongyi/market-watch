# fix(chart): keep watchlist switches ready and reduce history result round trips

Base: `integration/mwa-20261022` at `983b402`。产品 API／Web 为 `914525a`、Chart 为 `b7ef7be`。这是本地草案，未推送或创建远端 PR。

五图切换时，指标释放／续租、报价和预取争用普通四槽；快速连切还会使重复报价／释放占满 64 项队列，当前首屏被拒后长时间不再就绪。本次统一有界用途和公平准入，优先活动首屏，成功价格不等待句柄清理，可选预热锁忙跳过；清理失效队列、共享同集合在途报价、合并未派发释放，保留独立取消／reset／最高世代及 SSE 观察围栏。

新增任务认领／填充／提交和浏览器轮询／回调计时。实测 ready 后存在额外取结果 HTTP，因此使用既有 result 入口轮询，完成时同次交付结果及最终页数；能力缺失保留旧流程。并发、缓存重验、新鲜度和数据口径保持，无 schema／持久格式变更。风险 F1，涉及原生历史与指标取消后台链路，采用隔离真实 PG 和双轴复核。

验证分阶段记录，彼此有重叠：首轮 106 项 Python／PG、50 条前端 runtime、6 条 Chromium；连切续轮 42 项 Python、7 项 PG、53 条前端 runtime 最终通过；轮询增量 18 项 Python、2 项 PG、20 条 bridge CI 命令、构建／Ruff／diff 通过。连切与新协议回归先红后绿，Standards／Spec 无剩余阻断。容量时序首次失败后复跑通过，两个非 CI 旧 VM bootstrap 失败未进入断言，均如实列入边界。

Ubuntu mwa 已更新并完整复验 13/13，含原五图／指标、两类翻页及三轮 15 次连切；配置、真实数据与保护浏览器保持。前版两轮 10/10、6/6 任务需额外结果往返，当前 0/10。平台和指标仍有数秒等待，存在变慢样本；不是受控 A/B，不声称稳定 p95 或零退化。GitHub CI 未运行。见 [RESULTS.md](RESULTS.md)、[CLOSEOUT-20261023.md](CLOSEOUT-20261023.md)。不包含合并或生产发布授权。
