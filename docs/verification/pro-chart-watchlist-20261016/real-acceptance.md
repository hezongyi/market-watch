# 真实行情浏览器复验

2026-10-16 17:58–17:59 UTC，使用 Playwright/Chromium 通过真实登录表单验收，所有 7 张截图均逐张打开人工检查。结论：本次真实数据浏览器检查通过。早期 fixture 的 `w6-browser-dom.json` 结论已撤销。

Ubuntu 本机 `quant-server`，独立 Compose project `mw-issue73-real-20261016`，独立网络、PG 14.24 volume、数据库、凭据和端口。页面为 <https://192.168.7.232:18483/advanced-charts>，图表来源为 <https://192.168.7.232:17483>。两端使用同一自签名证书，首次访问需要在浏览器接受证书。登录密码不进入仓库。

真实行情来自 OANDA Practice API。EURUSD/XAUUSD 平台历史直接读取原生数据；EURUSD 组合以近三天真实 BID M1 发布版本接续当前 REST Batch 数据。REST Batch 当前价格的类型为 `sampled_candle_close`，即当前未闭合 M1 的收盘采样，不宣称为逐笔 Bid tick。未设置响应 mock，未运行合成行情 seed，未触碰其他 project 或生产服务。

| 检查 | 结果 |
| --- | --- |
| 真实表单登录 | HTTP 200 |
| 首次打开与刷新 | `ready=true`、`loading=false`、`dataReady=true`，画布有真实 K 线 |
| 混合自选列表 | EURUSD、XAUUSD、EURUSD 组合均有最新价、涨跌和涨跌幅 |
| 组合报价一致性 | `1.12263 - 1.12208 = 0.00055`；涨跌幅 `0.0490161129331242%` |
| 实际订阅更新 | 10 秒内组合 callback sequence 28 → 33，真实 REST Batch 收盘采样 |
| 三点菜单 | 位于 `+` 左侧，实际点击展开原生列选项，780px 窄屏仍可展开 |
| 品种切换 | 黄金平台与 EURUSD 组合均完成真实 K 线加载 |
| 上标与详情 | 三行末位上标保留完整文本/aria；详情无自定义扩展节点 |
| 浏览器错误 | `pageErrors=[]`；登录后的 API 请求无 4xx/5xx；登录前 session 401 属正常登录探测 |

修复前，真实数值会使上标适配器递归改写自己的 MutationObserver 记录，嵌套的原生涨跌 span 又使上标标记无法被识别，渲染线程持续高 CPU。现在对未变化的值保持 DOM 不变，并识别嵌套上标；原生重绘后保留新报价。三点按钮保留原 React root 的事件委托，仅移动视觉位置，并解除该列表 body 对工具栏控件的绘制裁剪。永久浏览器回归在旧实现上观察到失败，再在修复后通过。

代码和测试验证：`advanced-watchlist-layout.browser.cjs`、`advanced-startup-metadata.cjs`、`advanced-market-stream.cjs`、`advanced-watchlists.cjs`、JS 语法及 `git diff --check` 通过。图表实际镜像为 `market-watch-chart-origin:issue73-real-d90e90d`；API/web 业务内容未在本轮修改，沿用本任务构建的 `issue73-real-2ba0ce6` 镜像。

截图：[首次打开](real-screenshots/01-desktop.png)、[原生菜单](real-screenshots/02-menu.png)、[黄金](real-screenshots/03-gold.png)、[组合历史](real-screenshots/04-composite.png)、[组合当前采样](real-screenshots/05-composite-live.png)、[780px 菜单](real-screenshots/06-narrow-menu.png)、[刷新恢复](real-screenshots/07-refreshed.png)。结构化证据和截图 SHA256 见 [real-acceptance.json](real-acceptance.json)。

实例保留供用户人工验收。管理命令只作用于此 project：

```bash
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json up -d --no-build
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json stop
```

复验命令为 `node /tmp/mw-issue73-real-browser.cjs`，读取本任务私有凭据并输出到 `/tmp/mw-issue73-real/screenshots/`。永久 DOM 回归为 `cd web && PLAYWRIGHT_CHROMIUM_EXECUTABLE=<本机 Chromium> node tests/advanced-watchlist-layout.browser.cjs`。本机缺少的系统库使用任务目录中的补充库路径运行。

边界：组合仅导入三天真实历史，H4 可见根数有限；780px 检查为桌面指针的窄屏，不包括物理触屏手机、生产规模或长期稳定性。没有执行生产发布。
