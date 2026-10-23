# 自选切换延迟诊断

当前结果见 [RESULTS.md](RESULTS.md)：连切修复、回归、分段测量及局部结果轮询已部署，最终 13/13 业务复验通过。前后对照、反例与建议见 [CLOSEOUT-20261023.md](CLOSEOUT-20261023.md)。下文及原始测量保留修复前历史事实，不能作为当前版本成绩。`deep/probe-cleanup.cjs` 断言旧缺陷，修复后预期失败；修复回归使用真实 bridge／TS loader 测试。

后续深入分析见 [DEEP-ANALYSIS.md](DEEP-ANALYSIS.md)：补齐真实队列阻塞者、默认预热／快照锁分段，以及成功读取后等待 cancel 的证据。本文保留首轮诊断与原始测量，不将后续观察回写为首轮结论。

2026-10-22，Ubuntu `quant-server`，现有 `mw-acceptance`，入口 https://192.168.7.232:18280 。只做诊断，未修改产品代码、更新容器或保存测试布局。使用独立 Playwright context 登录，保护原浏览器 profile。

## 结论

已复现。五图联动把一次自选点击变成多个周期读取；新请求在前端四个共享在途槽位中排队，平台行情随后还要等待历史任务与轮询。自建、组合行情的后端固定读取也有可测延迟。当前证据支持多段延迟叠加，尚不能把数据库内部某一条 SQL 或指标预热指定为唯一根因。

## 最终测量

计时从真实自选行点击开始。活动图为 H1；五图周期为 H1/M5/W1/D1/H4。数据就绪指原生 `dataReady()`，不代表全部 Python 指标计算完成。

| 场景 | 活动图就绪 | 全部图格就绪 |
| --- | ---: | ---: |
| 五图：平台 EURUSD | 12.417 s | 12.989 s |
| 五图：自建 USDCAD | 2.678 s | 4.000 s |
| 五图：组合 EURUSD | 3.548 s | 5.335 s |
| 五图：再次切回平台 EURUSD | 10.557 s | 15.169 s |
| 单图：平台 EURUSD，首次读取 | 8.550 s | 8.591 s |
| 单图：自建 USDCAD | 0.653 s | 0.677 s |
| 单图：组合 EURUSD | 3.673 s | 3.698 s |
| 单图：原生缓存回切平台 EURUSD | 0.250 s | 0.273 s |

单图通过仅拦截工作区 GET 响应构造，未保存服务端布局。单图视口要求约 198 根，五图 H1 约 77 根，指标也不同；这组对照不能用来声称严格的性能提升倍数。这里只测到一个自建 USDCAD 样本，不能推广成所有自建品种的统计分布。

## 已确认的延迟位置

1. **前端排队。** 最终五图第四次点击中，H1 `getBars` 在 +193 ms 发起，平台历史 POST 在 +4503 ms 才出现，相差约 4.31 s。自建 H1 也有 +120 ms 到 +1884 ms 的等待。实际 bridge 的 `drain()` 将普通在途请求限制为 4；数据、报价、解析、指标需求共享此调度，当前活动图没有专门的首屏优先级。旧行情读取仍可能为原生缓存完成，不能直接把这些有效读取全部取消。
2. **平台历史任务。** 最终两次平台切换的五个首屏 POST 均返回 `load.state=waiting`，之后经过状态轮询和 result 读取。第一次平台 H1 到 +11874 ms 才请求结果；第二次到 +9864 ms。后者最终缓存读取内部 `read_total` 约 82 ms，HTTP result 约 569 ms，但此前的任务等待已经耗掉数秒。最终 `cache_hit=true` 不能证明初次提交时就满足缓存与新鲜度条件。
3. **自建／组合后端读取。** 最终组合 H1 HTTP 约 2.394 s，其中 `fixed_read_freeze` 约 2.112 s；H4 HTTP 约 2.820 s，其中固定读取约 2.246 s。这是后端数据与事务阶段的时间，不能全归给浏览器绘图。自建 W1 也测到固定读取约 1.272 s。
4. **五图与后台需求放大。** 每次点击立即触发五个周期 `getBars`。最终平台两轮记录 91 和 148 个 API 请求，包含历史轮询、订阅更新、报价及通知查询，并非全部为重复或无效请求。主机仅 4 核，观察期 load average 曾从约 7 回落至约 2；有多个其他开发实例运行。环境竞争会影响数值，本次未隔离负载做因果实验。

## 尚待验证

固定价格读取在无指标请求时仍调用 `warm_defaults()`；SMA/EMA 预热的需求更新会经过 `pg_advisory_xact_lock(8675313)`。这是值得优先剖析的候选，但本次没有 SQL 分段计时或锁等待采样，不能断言它贡献了上述全部 1–2 秒。

身份解析不是这次关键样本中的主导项：多次慢切换直接进入 `getBars`，未为目标品种发送新的 resolve POST。不同品种冷解析仍需另测。

## 建议顺序

1. 给当前可见图的首屏价格请求独立优先级；把可复用旧缓存填充、储备预取、非首屏指标放到后面。继续保留原生缓存与正确的取消生命周期。
2. 拆开平台任务的缓存检查、任务排队、供源等待和结果应用计时。优化已经满足覆盖与新鲜度要求的快路径；保留真正缺口的完整性检查。
3. 给固定读取增加 SQL／锁／快照／指标预热分段计时，依据结果缩短事务与锁占用；再决定是否将默认预热移出价格响应路径。
4. 复测相同工作区、视口与周期的冷切、缓存回切和连续切换。分开报告活动图、所有图格和指标完成时间。

## 版本与证据

给定项目 HEAD 为 `42a1b711b23171a7ad19d9fc3c7c5e1b59ae1399`，与实例运行候选不同。最终测量期间 API／Chart／Web 镜像保持不变，身份见 [runtime.json](runtime.json)。实际下载的 bridge 与 `market-watch-notice-reliability-20261022/advanced-host/bridge.js` 哈希完全一致；API 内 `chart_api.py`、`series_access.py`、`native_history_loads.py`、`indicator_demands.py` 与该目录也分别哈希一致。

主要代码位置：

- `advanced-host/bridge.js:751`：调度与四槽位上限。
- `advanced-host/bridge.js:989`：读取生命周期与缓存策略。
- `web/src/advanced/nativeHistoryLoads.ts:38`：任务提交、轮询、结果读取。
- `backend/alerts/native_history_loads.py:93`：缓存检查与任务创建。
- `backend/alerts/series_access.py:102`：固定行情读取与预热。
- `backend/alerts/indicator_demands.py:30`、`:212`：预热需求与锁。

[五图原始测量](measurements-five.json)、[单图原始测量](measurements-single.json)、[复现脚本](reproduce.cjs)。原始工作区内容未导出，仅保留 revision 与哈希；最终测量前后完整工作区相同，revision 75。两个 context 均无 pageerror。

脚本使用环境变量 `MW_ACCEPTANCE_PASSWORD`，不得把密码写入仓库。从项目根目录运行：

```bash
MW_PERF_ALLWAIT=1 MW_PERF_SHORT=1 MW_PERF_OUT=/tmp/mwa-switch-repeat node docs/verification/watchlist-switch-latency-20261022/reproduce.cjs
```

密码通过既有私有配置注入。脚本以 3 秒为诊断报警阈值；这是复现判定，不是已批准的产品 SLA。检测到慢会退出 1，并保留 JSON；实际已运行的等价命令为 `MW_PERF_ALLWAIT=1 MW_PERF_SHORT=1 MW_PERF_OUT=/tmp/mwa-switch-final node /tmp/mwa-switch-perf.cjs`，结果 `SLOW_REPRODUCED`，四轮。

允许所有图表读取、后台预取及需求生命周期请求；阻止偏好／布局保存与通知事件写入。图表正常读取仍会产生缓存、需求租约和任务，这是正常加载行为，不宣称数据库零写入。早期拦截过严的 45 秒超时结果已经作废，未纳入本报告；早期关闭 reserve 的测量也未作为最终数据。

15 服务运行，API／PG healthy。未重启服务，未修改认证、数据源、数据库结构或持久卷，未清库／seed／迁移。现有启停仍为 `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。本次未提交或推送代码，未部署。
