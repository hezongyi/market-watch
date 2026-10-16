# 自选表加载时内部 ticker 闪现：四源复验

2026-10-16 18:14–18:26 UTC。F0：兼容的 UI 名称显示修复，不改变 ticker、价格、持久偏好格式或数据库 schema。沿用 Ubuntu 本机 `quant-server` 的独立 R1 project `mw-issue73-real-20261016`、数据库、volume、网络及端口。

复现确认：旧实现连续三次刷新均在可绘制帧中显示组合哈希与 `DUKA:…`，切到只有一个真实固定历史版本的列表也显示版本 UUID。[修复前截图](ticker-flash/before.png)。此前稳定状态截图不能证明没有启动闪现。

原因：原生行在 `subscribeQuotes` 之前就以 ticker 初始化名称，即使 resolve 元数据已返回也不使用它；恢复、切换列表会再次重建这些行。Dukascopy 又未进入原来仅限 Yahoo/固定历史/组合的提前名称回调。

修复 `d14ec34`：四源及四条身份入口统一使用名称回调和预热元数据，兼容 native 大写身份；共用首帧样式在名称就绪前显示“加载中…”。现有版本适配器只释放可读名称，在列表重建和文本/身份变化时重新校验，不改写 React 名称节点。价格、原生点击和系列存储身份保留。

## 真实数据 R1

实际表单登录，真实 Chromium/Playwright，未拦截供应商响应、未注入价格或 K 线。每个绘制帧通过 host rAF 读取同源 native iframe；该方法可覆盖 native 的 `document.write` 初始化。五次场景共观察 102 个行状态变化，内部标识可见帧为 **0**，`pageErrors=[]`，最终所有九条身份均显示正确名称。

| 来源/类型 | 真实样本 | 结果 |
| --- | --- | --- |
| OANDA 平台 | EURUSD，兼容入口与 `OANDA:EUR_USD` 原生入口 | 名称正确，实际报价 |
| Dukascopy 平台 | GBPUSD，`DUKA:<hash>` | 名称正确，实际报价 |
| Binance 平台 | BTCUSDT | 名称正确，实际报价 |
| Yahoo 平台 | AAPL，`YAHOO:<hash>` | 名称正确，实际报价，供应商标注延迟 15 分钟 |
| 自建发布历史 | OANDA EURUSD 真实 BID 发布版本 | 名称正确，固定历史收盘价 1.12248 |
| 组合行情 | 该真实 OANDA 历史接续 REST Batch | 名称正确，实际采样报价及涨跌 |
| 旧版 managed 入口 | EURUSD、BTCUSDT | 名称正确；此实例未维护其旧版历史，无价格不伪造 |

覆盖首次打开、刷新、混合列表切换、删除后重新添加 Dukascopy、混合列表作为活动列表刷新恢复。临时列表结束后已删除并恢复原活动列表；用户新增的 Dukascopy 条目保留。

本实例原先关闭 Yahoo，本次在任务私有 env 中开启并重建同一 project 的后端服务，供四源真实检查。未触碰其他 project 或生产。图表运行镜像为 `market-watch-chart-origin:issue73-real-d14ec34`，web/API 代码镜像沿用原验收版本。

## 回归与证据

修复前新增浏览器首帧回归失败于 `constructor rows must not paint opaque tickers before the adapter attaches`，名称元数据回归失败于 `0 !== 7`；修复后通过。浏览器回归覆盖解析完成、重新写入内部名称、原生行复用，以及 `^GSPC`、`GC=F`、`BTC-USD` 等合法展示代码。

通过的永久测试：

- `web/tests/advanced-watchlist-names.browser.cjs`
- `web/tests/advanced-watchlist-metadata.cjs`
- `web/tests/advanced-watchlist-layout.browser.cjs`
- `web/tests/advanced-startup-metadata.cjs`
- `web/tests/advanced-market-stream.cjs`
- `web/tests/advanced-watchlists.cjs`
- `web/tests/advanced-watchlist-names-real.browser.cjs`，读取私有环境配置，对真实实例执行。

[脱敏时间线、实际报价、截图 SHA256](ticker-flash/evidence.json)。以下七张图均已逐张打开检查：[修复前](ticker-flash/before.png)、[加载帧](ticker-flash/loading.png)、[首次打开](ticker-flash/01-startup.png)、[刷新](ticker-flash/02-reload.png)、[切到混合列表](ticker-flash/03-switch-all.png)、[重新添加](ticker-flash/04-add.png)、[混合列表刷新](ticker-flash/05-mixed-reload.png)。

18:27–18:28 UTC 追加原真实行情完整 smoke：K 线、原生菜单、黄金/组合切换、组合采样报价涨跌校验、10 秒订阅更新、780px 菜单、刷新恢复全部通过；7 张追加截图也逐张打开检查。[结果](ticker-flash/post-fix-smoke.json)，[菜单](ticker-flash/smoke/02-menu.png)、[组合实时](ticker-flash/smoke/05-composite-live.png)、[窄屏菜单](ticker-flash/smoke/06-narrow-menu.png)。最后只读核对 DB：原活动列表恢复、仍只有原列表及四条品种，Dukascopy 条目保留。

边界：这是四个来源及平台/自建历史/组合/旧 managed 入口的真实代表样本检查，不是所有可搜索品种逐一验收，也不是所有来源与类型的笛卡尔积。本实例仅有 OANDA 的真实发布历史与组合；Dukascopy/Binance 尚无发布历史样本，Yahoo 本身不支持自建历史/组合。相同名称保护覆盖全部行，并以离线回归补充 NATIVE/MD 等身份格式。未宣称生产、触屏设备、长期稳定性通过。

## 用户验收及实例管理

页面：<https://192.168.7.232:18483/advanced-charts>。Ubuntu 主机 `quant-server`，原密码不变；登录信息不进入仓库。实例保留运行，供人工验收。

```bash
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json up -d --no-build
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json stop
```

真实回归入口：在 `web/` 运行 `node tests/advanced-watchlist-names-real.browser.cjs`，设置 `MW_BASE`、`MW_CHART`、`MW_CREDENTIALS`、`MW_OUTPUT` 和本机 Chromium 可执行路径；可复用本任务私有字体/补充库环境。凭据与完整浏览器状态不提交。
