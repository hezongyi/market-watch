# Advanced Charts 移动端与 360 浏览器兼容性调查

> **归档说明（2026-10-11）：** 兼容性调查归档：保留同机 Chrome 正常、360 黑屏的用户反馈及官方证据。360 根因仍未确诊，本页不证明新 APK WebView 已验收。当前范围与选型见 [讨论总览](android-apk-discussion-record-20261011.md)。

调查日期：2026-10-11（Asia/Singapore）。范围为用户报告的 Android 手机 360 极速浏览器访问 Market Watch 专业图表黑底；本调查只读取公开资料和仓库源码，不修改应用或生产配置。

## 结论

用户随后在同一台手机使用 Chrome 打开生产专业图表，确认正常显示；360 极速浏览器仍为全黑。这项真机对照将故障范围缩小到 360 的浏览器行为、配置或站点状态差异。具体是 `blob:` iframe 处理、请求拦截、缓存还是其他初始化异常，尚未取得浏览器控制台证据，不能认定某一项为根因。当前可用的访问方式是 Chrome；本次未修改生产配置。

TradingView 官方明确支持手机浏览器；“Advanced Charts 不支持手机，所以黑屏”不成立。官方列举 Chrome、Firefox、Safari、Opera、Edge 及其移动版，但没有单独列举 360，不能把主流浏览器支持声明解释成对所有 360 版本和设置的保证。[1]

官方确实记录了两类与空白屏有关的兼容问题：Android WebView 太旧、不支持 ES6；浏览器或 WebView 对 `blob:` iframe 处理不标准，或 CSP 禁止 `blob:`，后者提供 `iframe_loading_compatibility_mode` 作为兼容开关。资料并未把这两类问题明确归因于 360，也不能据此直接认定当前生产故障根因。[1][2][3]

## 已核实的官方原文

### 手机支持与移动端限制

来源：[Mobile app development][1]；2026-10-11 抓取的 `latest` 文档版本菜单包含 v31，正文可读。猜测的 `/v31/mobile_specifics/` 返回 Page Not Found，因此引用工作正常的 `latest` 页面。

> Advanced Charts and Trading Platform are compatible with mobile devices.

> The library supports mouse and touch-based inputs and recognizes single and multi-touch gestures.

> It is available on all major browsers such as Google Chrome, Firefox, Safari, Opera, and Microsoft Edge, including their mobile versions.

小屏会调整或隐藏右侧 Watchlist / Details / News / Data window、时间轴 Marks、底部 Account Manager 等部件，这是布局限制，并非整张 K 线图只显示黑底的正常行为。文档还说明移动端只显示一个价格刻度。[1]

### Android 空白屏的已知排查项

同页 FAQ 标题：

> The library Android Integration Example demonstrates a white screen. How to fix it?

答复：

> Make sure that the WebView version installed on your device supports ES6. We recommend you update to the latest WebView version to avoid potential issues.

文档还声明 Android 最低版本为 Android 5.0，并指向 Chrome DevTools 的 Android / WebView 远程调试说明。这是 Android 集成示例的白屏问题，不是确认所有手机浏览器都存在缺陷；用户手机是否使用系统 WebView、360 自带内核，以及实际版本，仍需设备侧证据。[1]

### `blob:` iframe 的官方兼容路径

来源：[Featuresets → iframe_loading_compatibility_mode][3]，默认 Off：

> Loads the library iframe from about:blank and builds its content with document.write, instead of the default blob: URL.

> Use it in environments that cannot load a blob: iframe source, such as wallet browsers and other in-app webviews with non-standard iframe handling, or under a Content Security Policy that forbids blob:.

> Using document.write is slower than the default blob: path, so enable this featureset only in environments that need it.

同表还列出 `iframe_loading_same_origin`，从 `library_path + 'sameorigin.html'` 加载真实同源 URL，同样使用 `document.write`，要求正确部署 `sameorigin.html`。[3]

官方 [Troubleshooting → Content Security Policy errors][2] 同样建议检查 CSP / `blob` 错误，并在无法修改 CSP 时使用 `iframe_loading_compatibility_mode`。这些说明支持把 iframe 加载与脚本启动列为排查方向；是否适用于用户的 360，必须通过同一手机 Chrome 对照、实际报错或资源请求证据确认。

## 360 官方页面能证明什么

- [360 极速浏览器桌面官网][4] 标题为“欢迎使用360极速浏览器”，宣传“全新Chrome内核浏览器，性能更强，速度更快”和“全新Chromium内核”；页面提供 32 位、64 位、Mac、XP 版本。页面的 Windows 隐私政策和下载形态说明这是桌面产品页，不能用它推出 Android 360 的实际内核版本或 Advanced Charts 兼容性。
- [360 手机浏览器官网][5] 的移动页标题为“360手机浏览器”，页面宣传“轻松浏览世界”。本次访问未找到 Advanced Charts 的兼容承诺、公开的 iframe / `blob:` 特殊限制说明，或能够证明当前黑屏是广告拦截导致的文档。
- 通过 Google / Bing 搜索 `TradingView Advanced Charts mobile black`、`360 手机浏览器 TradingView 黑屏`、`"360" "TradingView" "黑屏"`。Google 轻量抓取返回验证/跳转页面，Bing 多次返回泛化或不相关结果；因此搜索覆盖有限。本次未取得可信的 360 专属故障公告。该表述不意味着网络上不存在相关案例。

更新 360、临时对该站关闭广告拦截/页面优化，可以作为用户设备上的对照实验；不能把这些操作描述为已有证据证明的修复。UA 内的 `Chrome/124` 也不能单独证明浏览器 App 就是 Google Chrome，更不能证明 360 在 iframe、请求过滤或页面优化层没有额外行为。

## Market Watch 本身的黑底与初始化条件

这部分来自本地项目源码，不是 TradingView 的通用要求：

- [`advanced-host/index.html`](../../advanced-host/index.html) 把 `html`、`body`、`#chart` 的背景设为 `#0f0f0f`。
- [`advanced-host/bridge.js`](../../advanced-host/bridge.js) 开头要求 URL 中包含合法 `parent` origin；否则立即抛出 `Missing parent origin`。文件末尾发送 `loaded`，只有收到可信父页面发来的 `init` 消息才调用 `boot(...)` 创建图表。
- 因此，直接打开独立图表宿主根地址、缺少 `parent` 和父页面初始化时，黑底不等价于手机不兼容。主站 `/advanced-charts` 工作区已嵌入的图表仍全黑，则是另一种需要排查的初始化或加载故障。

## 建议的验证顺序

1. 在用户同一台 Android 手机、同一网络，用最新版 Google Chrome 打开同一主站工作区；记录 360 与 Chrome 是否一致。官方 demo `https://charting-library.tradingview-widget.com/` 可作为另一项对照，不能替代真实工作区验证。[1]
2. 若只有 360 失败，采集实际 App 版本、控制台错误，以及宿主脚本 / 图表 native chunk / `blob:` 子 iframe 是否完成加载。无行情请求而宿主始终黑底时，应先定位 `loaded → init → widget`，不是先修改行情服务。
3. 只有证据指向 `blob:` iframe 处理时，才在 Ubuntu 独立验证环境测试 `iframe_loading_compatibility_mode`，比较 360 真机结果和原有桌面行为；不能仅凭一般文档就修改生产。

## 来源

[1]: https://www.tradingview.com/charting-library-docs/latest/mobile_specifics/ "TradingView 官方：Mobile app development"
[2]: https://www.tradingview.com/charting-library-docs/latest/troubleshooting/#content-security-policy-errors "TradingView 官方：Troubleshooting / Content Security Policy errors"
[3]: https://www.tradingview.com/charting-library-docs/latest/customization/Featuresets#iframe_loading_compatibility_mode "TradingView 官方：iframe_loading_compatibility_mode"
[4]: https://browser.360.cn/ee/ "360 极速浏览器桌面官网"
[5]: https://mse.360.cn/m/index.html "360 手机浏览器官网移动页"

1. [TradingView 官方：Mobile app development][1]
2. [TradingView 官方：Troubleshooting / Content Security Policy errors][2]
3. [TradingView 官方：Featuresets / iframe_loading_compatibility_mode][3]
4. [360 极速浏览器桌面官网][4]
5. [360 手机浏览器官网移动页][5]
