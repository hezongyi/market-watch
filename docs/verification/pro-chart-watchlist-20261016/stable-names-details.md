# 已知名称直接显示与 OANDA 详情文字闪烁

本轮补修本身是兼容的 UI/报价呈现修复，不改变数据库 schema、行情标识或价格计算。整个 Issue #73 按 F1 / R2 收口：此前还包含组合 NY17 previous close 与 REST/stream 报价链路变更。复用 Ubuntu `quant-server` 的独立 project `mw-issue73-real-20261016`，R1 为单轮实例规模记录。

## 原因及修正

此前 `d14ec34` 只保证内部 ticker 不可见，仍把已预热的组合、固定历史、Dukascopy 名称显示为“加载中…”。第一、第二行的 EURUSD/XAUUSD 本身就是可读代码，所以先被释放；并不是它们的真实报价更快。`e2db36c` 将已有元数据接入同一个行适配器，在原生名称尚为内部标识时直接显示对应的真实名称，保留原生文本/点击/路由身份；行被复用时清除旧名称。只有确实尚未取得名称的新条目才显示加载状态。

真实浏览器另复现了 OANDA 详情闪烁：点击后相同 XAUUSD 详情在约 25 ms 内由“平台原生行情”切到“平台行情”，并重复多次。名称元数据回调使用前一种文案，后端真实报价使用后一种；原生组件切换品种会重新订阅，前端又无条件发送只有名称的行，覆盖当前详情。

修正统一平台文案为“平台行情”，保留 Dukascopy 的价格口径与 Yahoo 的真实延迟说明。重新订阅的异步回调在交付时读取当前报价快照，已有价格、时段和绑定信息就直接复用；报价先到时优先采用它，revision reset 清除的旧报价不再重放。旧 managed 名称回调也不再误标为组合行情。

首次真实复验还暴露了详情的初始读取问题：`e2db36c` 的订阅回调虽已复用报价，原生详情先调用的 `getQuotes` 仍会重新排队；快速切换期间记录到 33 个待处理报价请求，导致详情短暂空白甚至超过 60 秒。本轮未将这些失败运行判为通过。`abadf45` 进一步让初始读取异步复用当前仍被订阅的真实快照，订阅后台刷新和 polling 模式仍实际请求供应商；异步交付前仍核对 workspace、reset 与最新观测，避免恢复旧版本价格。

## 回归

修复前新增回归分别失败于：已知 EURUSD/GBPUSD 名称仍为“加载中…”；平台文案为“平台原生行情”；重新订阅时已有价格 `1.12345` 变为 `undefined`；详情初始读取在已有报价时仍被慢批次阻塞。修复后通过名称首帧、元数据、原生布局、startup metadata、market stream 与 watchlist restore 六项针对性检查。额外覆盖新元数据到达、行身份复用、回调前到达的报价、reset 与取消订阅，以及 Dukascopy 口径和 Yahoo 15 分钟延迟。

## 真实浏览器结果

19:00–19:03 UTC，实际表单登录，Chromium/Playwright，未拦截或注入行情。OANDA、Dukascopy、Binance、Yahoo 四源平台代表样本都有真实报价，另验真实 OANDA 固定历史、组合及旧 managed 名称，共九条身份。旧 managed 在此实例未维护价格，不伪造；本实例也没有其他来源的真实发布历史/组合，不宣称全部来源×类型组合都已实测。

六次实际行点击在 EURUSD/XAUUSD 之间交替：13 个详情文本状态里，“平台原生行情”出现 **0** 次；25 次已有报价的 native 初始回调在本次记录中最多约 **131 ms** 返回。修复前则为 34 个详情状态中 12 次出现旧文案。后者是逐帧实际文本证据，不能只凭一张稳定截图判定无闪烁。

首次打开、刷新、混合列表切换、Dukascopy 删除重添、混合列表刷新共 37 个去重后的行状态，内部 ticker 可见帧为 **0**，`pageErrors=[]`。首次打开、刷新、混合列表刷新三个预热场景的第一帧全部直接显示真实名称，没有“加载中…”。混合列表初次新增的未预热身份仍允许短暂加载；新取名与新取价各自等待真实响应。

[修复前时间线](stable-names-details/before-evidence.json)；[修复后脱敏证据、实际报价、回调时序与截图哈希](stable-names-details/evidence.json)。八张截图均逐张打开检查：[EURUSD 详情](stable-names-details/detail-EURUSD.png)、[XAUUSD 详情](stable-names-details/detail-XAUUSD.png)、[首次打开](stable-names-details/01-startup.png)、[刷新](stable-names-details/02-reload.png)、[混合列表](stable-names-details/03-switch-all.png)、[重新添加](stable-names-details/04-add.png)、[混合刷新](stable-names-details/05-mixed-reload.png)、[新身份加载阶段](stable-names-details/loading.png)。图中旧 managed 无价与新增行等待报价阶段不作为报价通过证据；四源报价通过依据为真实 snapshot 与稳定列表。

功能运行完成后另做持久状态核对，发现原生列表恢复事件虽已调用，关闭浏览器时保存仍未完成。已将永久验收脚本改为分开切换/删除任务，并轮询保存后的 preference，保存未确认即报告失败，避免只凭内存状态宣称恢复成功。随后独立浏览器实际核对 API 持久值，并以只读 DB 查询确认仅保留原列表和五条品种，Dukascopy、USDCAD 均保留；最后又确认原五行和详情的真实价格已显示，[恢复后的稳定页面](stable-names-details/06-restored.png)也已打开检查。

## 运行实例

页面：<https://192.168.7.232:18483/advanced-charts>，原密码保留。图表候选镜像 `market-watch-chart-origin:issue73-real-details-final`（`abadf45`）；后端/web 仍为原隔离实例。没有生产发布。

```bash
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json up -d --no-build
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json stop
```

用户于 2026-10-16 明确确认人工验收通过。实例暂保留；合并、生产发布与永久资源删除仍分别执行仓库检查点。
