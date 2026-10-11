# Android APK 壳：受控 HTTPS WebView 与 Capacitor 本地打包的官方事实

日期：2026-10-11。仓库源码核对基线：`afe7bcf`；归档入口见 [讨论总览](android-apk-discussion-record-20261011.md)。本次只研究产品和集成边界，不实现、构建、部署 APK，不讨论后台通知、保活或推送。未读取凭据、签名密钥或许可库。

## 判断

对当前 Market Watch，优先评估**小型原生 Android WebView 加载受控 HTTPS 手机路由**更符合已有架构：主页面继续通过同源 `/api` 使用 HttpOnly 会话和 CSRF，图表继续位于独立 HTTPS 主机名，由可信父页面代理认证请求。手机路由仍须设计与实现；“可以沿用架构”不等于已有 APK 或已经通过真机验证。

**Capacitor 标准 `webDir` 本地打包也是可行候选，但会引入新的 API 地址、传输和认证契约。** 不应把 `server.url` 配到生产网站当成与标准本地打包等价的官方生产路径。框架选择本身也不会补齐手机自选表、指标、数据中心和告警管理入口。

下面把官方确证、项目推断和待实测项分开。当前最有价值的区别是页面来源与原生桥权限，并未认定 Capacitor 会发生已经证实的登录故障。

## 官方确证

### 1. Capacitor 标准工作流打包已编译的 Web 资源，Android 默认来源为 `https://localhost`

官方配置定义 `webDir` 为 Web 构建产物目录，包含最终 `index.html`；官方工作流要求先构建 Web 应用，再由 `npx cap sync` 把 bundle 复制进 Android/iOS 工程。它适用于 Vite，并不是默认加载已有生产网站。[C1][C2]

短原文，2026-10-11 抓取：

> “The directory of your compiled web assets.”
>
> “Running npx cap sync will copy over your already built web bundle to both your Android and iOS projects …”

`server.hostname` 默认为 `localhost`，官方建议保留；`server.androidScheme` 默认为 `https`。当前官方 Android 源码也用 `scheme + "://" + authority` 生成本地 URL，未配置远程 `server.url` 时以此作为 `appUrl`。[C1][S1][S3]

短原文/代码，2026-10-11 抓取：

> “It is recommended to keep this as `localhost` …”
>
> `@default https`
>
> `localUrl = scheme + "://" + authority;`

因此 `https://localhost` 是本地资源使用的浏览器来源，不代表远程 Market Watch 服务器变成同源。这里的“本地来源”也不意味着把服务器、行情数据库或图表数据搬到手机。

### 2. `server.url` 与 `allowNavigation` 均被官方标为非生产用途

`server.url` 可让 WebView 加载外部 URL，但官方明确称其用途为 live-reload servers，且明确不用于生产。`server.allowNavigation` 可增加允许 WebView 内导航的 URL；默认外部 URL 打开外部浏览器，同样有非生产用途的说明。[C1]

短原文，2026-10-11 抓取：

> `server.url`: “Load an external URL in the Web View.”
>
> “This is intended for use with live-reload servers.”
>
> “This is not intended for use in production.”

> `server.allowNavigation`: “Set additional URLs the Web View can navigate to.”
>
> “By default, all external URLs are opened in the external browser (not the Web View).”
>
> “This is not intended for use in production.”

这不是说底层 WebView 无法显示 HTTPS 网站，也不是说所有第三方插件都不允许远程内容；准确结论是：**把上述两个配置作为正式远程网站套壳的默认依据，与当前官方配置说明不一致。** 本项目若选择远程 HTTPS 路线，小型原生 WebView 可以直接表达自己的受控导航和桥接规则；若选择 Capacitor，应围绕其标准本地打包方式评估集成成本。

### 3. 原生 HTTP 和 Cookies 补丁是显式选择，不是默认替网页解决跨来源登录

Capacitor 官方 `CapacitorHttp` 文档说明，可以用原生库提供 HTTP 请求，并可补丁替换 `fetch` / `XMLHttpRequest`；补丁默认关闭。`CapacitorCookies` 可补丁替换 `document.cookie`，默认同样关闭。[C3][C4]

短原文，2026-10-11 抓取：

> “By default, the patching of window.fetch and XMLHttpRequest to use native libraries is disabled.”
>
> “By default, the patching of document.cookie to use native libraries is disabled.”

官方说明这些能力存在，**没有据此证明本项目的 HttpOnly Cookie、CSRF、流式请求、Cookie 持久化与注销行为已被无缝保留**。选择原生 HTTP 或自定义代理后，应把它作为新增传输路径说明、核验；单独启用 Cookies 补丁，也不能据此声称 Strict 会话跨来源问题已经解决。

### 4. Capacitor 的导航来源会参与原生桥来源规则；现代桥与回退桥要分别审查

官方配置中的 `android.useLegacyBridge` 默认为 false，描述其替代方案为更安全的 `addWebMessageListener`。官方源码中，`Bridge.setAllowedOriginRules()` 把本地来源、`server.url`、`allowNavigation` 的条目加入桥来源集合；`MessageHandler` 首选此集合约束的 `addWebMessageListener`，并通过 `isMainFrame` 限制插件调用到主 frame。[C1][S1][S2]

短原文/代码，2026-10-11 抓取：

> “Use legacy … addJavascriptInterface … instead of the new and more secure … addWebMessageListener …”
>
> `allowedOriginRules.add(this.getServerUrl());`
>
> `allowedOriginRules.add("https://" + allowNavigation);`
>
> `if (isMainFrame) { postMessage(message.getData()); … }`

同份 `MessageHandler` 源码显示，当功能不支持、选择 legacy bridge，或添加监听失败时，会回退 `webView.addJavascriptInterface(this, "androidBridge")`。[S2] Android 官方说明，`addJavascriptInterface` 注入每个 frame，包括 iframe，且没有按来源的访问控制；新的消息监听接口支持 `allowedOriginRules` 和 `sourceOrigin`。[A2][A3]

Android 短原文，2026-10-11 的原研究抓取留存，本次重新读取原始官方 HTML：

> “The addJavascriptInterface method injects a supplied Java object into every frame of the WebView, including iframes …”
>
> “It lacks origin-based access control.”
>
> “… requires a Set<String> of allowedOriginRules during initialization.”

这些事实说明**需要审查导航来源与原生能力的关联**，不是认定本项目已经存在可利用漏洞。图表 iframe 的正常加载与“允许图表来源调用原生插件”是不同权限。不能为了让图表可用，就默认把图表主机名加入广泛导航/桥允许列表，或向图表注入登录 Cookie、token 和通用原生 HTTP 能力。最终还须核验所选发布版本和设备 WebView 实际走哪条桥路径。

### 5. Android WebView 不继承系统浏览器登录状态，外部来源应打开默认浏览器

Android 官方 WebView 导航说明明确，系统浏览器不与应用共享应用数据。官方桥安全说明要求验证 URL 的 scheme 和 host；不在允许名单的域应由默认浏览器打开。[A1][A2]

短原文，2026-10-11 的原研究抓取留存，本次重新读取原始官方 HTML：

> “For security reasons, the system's browser app doesn't share its application data with your app.”
>
> “If any external links are loaded in a WebView, validate both scheme and host (allowlist domains). Any domains not in the allowlist should be opened by the default browser instead.”

因此手机 Chrome 已登录、已确认图表能显示，是浏览器兼容性的有用证据；不能当作新 APK 的登录状态或 WebView 兼容性验收。APK 应有自己的登录流程。受控 HTTPS 主页面、独立 HTTPS 图表来源和普通外部链接，应各自保留明确的角色。

## 针对当前项目的推断

仓库只读证据于 2026-10-11 核对：

| 当前契约 | 原生 WebView 加载受控 HTTPS 手机路由 | Capacitor 标准本地 `webDir` |
|---|---|---|
| `web/src/api.ts` 使用相对 `/api`、`credentials: "same-origin"`，写请求附 `X-CSRF-Token`。[R1] | 只要手机路由仍在主应用 HTTPS 来源，原有 API 地址和浏览器认证路径可复用。 | 相对 `/api` 会指向本地页面来源，不能直接当作远程 API。必须显式决定远程地址及请求路径。 |
| `backend/alerts/api.py` 登录写入 `session` Cookie，`httponly=True`、`secure=settings.cookie_secure`、`samesite="strict"`；非只读请求检查 CSRF。[R2] | 继续沿用网页会话契约是成本较低的候选，但登录保持、重启、注销需要实测。 | 用本地页面向远程 API 做浏览器请求，会涉及新增来源、凭据发送和 CORS/预检契约；Strict 会话如何适用也需验证或重新设计。不能只改 API base URL 就宣称完成。 |
| 当前 `api.py` 未配置应用级 `CORSMiddleware`。[R2] | 同源页面通常不要求新增浏览器 CORS 允许来源。 | 若选普通浏览器跨来源 HTTP，不能假定服务器当前已经接受本地来源、凭据和 `X-CSRF-Token` 预检。代理层配置与最终方案仍需核对。 |
| `AdvancedWorkspace.tsx` 硬检查图表与主页面来源不同；发送指定 target origin，接收核验 `source`、`origin` 和 channel。[R3] | 主应用与图表继续使用两个独立 HTTPS 主机名，可沿用现有 `postMessage` 边界。 | 本地来源成为新的可信父页面来源；图表 CSP/父来源、嵌套页面和桥范围也要适配。框架不会自动处理项目自己的隔离契约。 |
| `advanced-host/bridge.js` 明确所有认证工作由可信父页面承担。[R4] | 不给图表来源认证凭据，父页面继续代理已允许的操作。 | 也应保持相同边界；不能把可访问会话/原生 HTTP 的通用桥下放给图表来源。 |

两个 HTTPS 主机名是项目既定隔离要求；这里只讨论如何保持这条要求，不把“两个端口”当成等价部署设计。也没有建议通过放宽 Cookie、关闭 CSRF、忽略证书错误或取消图表隔离来降低集成成本。

Capacitor 可通过进一步设计服务端来源、原生 HTTP、受控代理或专门的移动认证路径实现集成，但那是需要明确维护的新增模块。当前没有 APK 运行证据，不能把可能的跨来源 Cookie 行为写成已发生且已定位的故障。选型上，小型原生 HTTPS WebView 让首期复杂度更多集中到手机产品页面与有限的 Android 生命周期集成；Capacitor 本地打包则更适合有明确“Web 资产随 APK 发布”和插件使用需求、并愿意承担新传输契约的路线。

## 待实测与待决定

- 在 OPPO Find X8 / ColorOS 16 上记录实际 WebView 提供程序与版本，验证 HTTPS 手机路由、图表 iframe、登录、写请求 CSRF、退出登录、进程重建后的会话。Chrome 正常不能替代这些验证。
- 若仍评估 Capacitor 本地方案，分别验证普通浏览器 HTTP 与所选原生 HTTP 路径的 API 地址、来源/CORS、Cookie 接收与重发、CSRF、注销和项目现有流式数据行为；不以“可以编译”作为认证通过。
- 验证 `postMessage` 的准确父来源、图表来源与消息来源检查，且图表来源拿不到会话凭据或通用原生桥权限。现代桥与回退桥都应纳入实际版本核验。
- 手机浏览体验仍需验证输入法、安全区域、手势、横竖屏、返回键、失败恢复与外部链接去向；TLS 失败应保持失败并给出可理解提示。以上是后续验收建议，本次没有运行结果。

## 来源与抓取说明

Capacitor 在线官方文档于 **2026-10-11** 抓取，页面标记 **v8**。源码通过 Ionic 官方 GitHub 仓库公开 API 读取，固定到 `eb0660667b0deb9ca7a3807ceda1c71d7b034d99`（提交日期 2026-10-09），用于解释当前行为，不替未来 SDK 版本作保证。各关键官方事实的短原文见对应段落。

Android 官方站点本次直接联网复抓超时，改为复用同日原研究保留的 WebView、原生桥安全及 JSBridge 原始官方 HTML。本次重新读取并核对了上列引文；没有把复抓超时写成服务端或设备故障。原研究见 [Android APK 图表与 WebView 证据](android-apk-notification-and-webview-evidence-20261011.md) 的 WebView 段；本报告只复用相关网页集成证据。临时原始抓取不随本次 PR 发布，公开来源与核对引文保留在本文。

[C1]: https://capacitorjs.com/docs/config "Capacitor v8 官方配置：webDir、hostname、androidScheme、server.url、allowNavigation、useLegacyBridge"
[C2]: https://capacitorjs.com/docs/basics/workflow "Capacitor v8 官方工作流：构建 Web 资产与 cap sync"
[C3]: https://capacitorjs.com/docs/apis/http "Capacitor v8 官方 HTTP API：原生传输及默认关闭的补丁"
[C4]: https://capacitorjs.com/docs/apis/cookies "Capacitor v8 官方 Cookies API：默认关闭的 document.cookie 补丁"
[S1]: https://github.com/ionic-team/capacitor/blob/eb0660667b0deb9ca7a3807ceda1c71d7b034d99/android/capacitor/src/main/java/com/getcapacitor/Bridge.java#L236 "Ionic 官方源码：原生桥来源、导航与 appUrl"
[S2]: https://github.com/ionic-team/capacitor/blob/eb0660667b0deb9ca7a3807ceda1c71d7b034d99/android/capacitor/src/main/java/com/getcapacitor/MessageHandler.java#L26 "Ionic 官方源码：现代桥 main-frame 检查与 legacy 回退"
[S3]: https://github.com/ionic-team/capacitor/blob/eb0660667b0deb9ca7a3807ceda1c71d7b034d99/android/capacitor/src/main/java/com/getcapacitor/CapConfig.java#L37 "Ionic 官方源码：默认 localhost 与 HTTPS scheme"
[A1]: https://developer.android.com/develop/ui/views/layout/webapps/webview "Android 官方：WebView 导航及系统浏览器不共享应用数据"
[A2]: https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges "Android 官方：原生桥、可信 HTTPS 内容与外部导航"
[A3]: https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge "Android 官方：现代 JSBridge 来源规则与 legacy 桥范围"
[R1]: ../../web/src/api.ts "Market Watch：同源相对 API 与 CSRF"
[R2]: ../../backend/alerts/api.py "Market Watch：HttpOnly Strict 会话与 CSRF 验证"
[R3]: ../../web/src/advanced/AdvancedWorkspace.tsx "Market Watch：独立图表来源与 postMessage"
[R4]: ../../advanced-host/bridge.js "Market Watch：可信父页面承担认证请求"

- Capacitor：[配置][C1]、[工作流][C2]、[HTTP][C3]、[Cookies][C4]。
- Ionic 官方固定源码：[Bridge][S1]、[MessageHandler][S2]、[CapConfig][S3]。
- Android：[WebView][A1]、[原生桥安全][A2]、[JSBridge 来源规则][A3]。

## 个人使用、优先维护简单：补查 PWA 与 TWA

补查日期：2026-10-11。用户补充 App 只供个人使用，网页后续还会改动，因此需要区分“手机桌面入口”与“自行构建、签名和分发 APK”。本段不改变上文 Capacitor 事实；只补充低维护选项。

### 官方确证

**PWA 可以直接从浏览器安装，不要求开发者生成自有 APK。** Google 的 PWA 安装文档说明，浏览器安装不需要开发者创建任何 package 或 executable。Android 的安装结果随设备和浏览器而异，可能是 WebAPK，也可能只是网站快捷方式；使用 WebAPK 时构建和签名由浏览器、设备与 minting server 透明完成。[P1][P1S]

短原文，2026-10-11 读取官方文档公开源码：

> “… you don't need to create any kind of package or executable for your PWA to be installed from a browser.”
>
> “Depending on the device and browser, your PWA will either be installed as a WebAPK, a shortcut, or a QuickApp.”
>
> “You, as a PWA developer, don't need to build or sign any package when a WebAPK is used.”

因此“添加到桌面”不能一概当作已经得到独立安装的 WebAPK。安装入口、独立窗口和系统中的应用条目要看设备实际结果；不在这里假定用户手机具备 GMS 或可用的 WebAPK minting 服务。[P1S]

**TWA 仍有 Android 宿主，但网页由用户的浏览器承载。** Chrome 官方概览说明 TWA 基于 Custom Tabs；内容来自 Web，由用户浏览器渲染并以全屏展示，App 与网站的关联通过 Digital Asset Links 验证。TWA 宿主不能直接访问网页或 Cookie、`localStorage` 等 Web 状态；浏览器支持情况会影响是否出现 Custom Tab 工具栏。[T1][T1S]

短原文，2026-10-11 读取官方文档公开源码：

> “… rendered by the user's browser, in exactly the same way as a user would see it in their browser except they are run fullscreen.”
>
> “… verified using Digital Asset Links.”
>
> “The host app doesn't have direct access to web content … like cookies and `localStorage`.”

它与 WebView 的关键区别是：TWA 依赖支持该协议的浏览器提供网页运行环境和 Web 状态，宿主不能直接管理网页 Cookie；WebView 则在应用自己的 WebView 数据范围中运行，并可由应用明确控制导航与桥。[T1S][A1] **不能把 TWA 当成带有同等 JavaScript 原生桥权限的 WebView。** 登录能否沿用用户已有浏览器会话，还应核验实际选择的浏览器与 profile，不把“用户手机装了 Chrome”直接当成已验收。

**多来源 TWA 的官方规则针对跨来源导航保持全屏。** Chrome 的 multi-origin 文档说明，导航离开已验证来源后显示 Custom Tab UI；若要在多个来源之间导航时保持全屏，应分别验证这些来源，各域提供自己的 `/.well-known/assetlinks.json`。[T2][T2S]

短原文，2026-10-11 读取官方文档公开源码：

> “When a user navigates off the validated origin, Custom Tab UI is shown.”
>
> “… the user will remain in full-screen when navigating across those origins.”
>
> “… each domain to be validated needs to have its own assetlinks.json file.”

本次未找到上述规则要求每个跨来源 iframe 也做 TWA 关联验证的明确原文。因此**不把 Market Watch 的图表 iframe 直接等同于顶层跨来源导航**。主应用保持顶层页面、图表作为第二 HTTPS 来源 iframe 时，应验证嵌入、`postMessage` 与现有凭据隔离；只有后续产品流程让图表来源成为顶层导航目标，才需具体评估额外来源验证与全屏行为。没有据此改变图表来源不能获得认证凭据的要求。

### 对个人维护需求的建议与边界

- 若核心目标是桌面入口和手机页面，先验证 **Chrome 中的 PWA/添加到桌面体验**是否足够。网页仍是主要交付物，无须维护自有 APK 的构建与签名；当前网站的可安装条件仍需核对，不能称为已完成 PWA。
- 若明确需要一个自行分发的 APK，**小型原生 WebView 在线加载同一 Web 工程中的手机页面**仍贴合已有同源登录与图表隔离。一般网页内容变化不需要随之重新分发壳 APK；Android 壳或其契约改变时仍需发布新版本。这是当前集成架构的推断，并非“APK 永远无需维护”。
- **TWA/Bubblewrap 是在线网页 APK 的备选**：网页功能继续从 Web 提供，所以一般网页改动不需要每次重打 APK；仍需维护浏览器依赖、App 签名及域关联、宿主配置。它更适合浏览器即可完整使用的页面，无法直接沿用 WebView 原生桥设计。[T1S]

PWA 或 TWA 的在线内容也不等于任何修改都会立即显示；如果引入 service worker 或其他资源缓存，应设计更新行为。后续只需验证用户真机上的安装形态、启动入口、登录/注销、网页更新、图表 iframe、返回与外部导航，就能判断个人需求是否已经满足；本次没有运行或安装结果。

### 补查来源说明

web.dev / developer.chrome.com 在线页面本次 10 秒限时访问不可达，改为 **2026-10-11 读取 GoogleChrome 官方 GitHub 文档源码**，没有采用第三方解释。源码安装页元数据更新于 2022-02-23，TWA 概览与 multi-origin 更新于 2020-07-31；这里只取浏览器安装、浏览器承载、宿主访问边界和域验证这些明确事实，不用旧文档的历史浏览器版本、安装条件、设备占比或流行度作为当前结论。

[P1]: https://web.dev/learn/pwa/installation "Google 官方：PWA 安装"
[P1S]: https://github.com/GoogleChrome/web.dev/blob/main/src/site/content/en/learn/pwa/installation/index.md "GoogleChrome 官方文档源码；读取日期 2026-10-11，blob e53df531ba01330dc4839788409c2329070336a4"
[T1]: https://developer.chrome.com/docs/android/trusted-web-activity/overview "Chrome 官方：TWA 概览"
[T1S]: https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/android/trusted-web-activity/index.md "GoogleChrome 官方文档源码；读取日期 2026-10-11，blob bf9bafa49700172af04c08c19c06fcd5bcda03c3"
[T2]: https://developer.chrome.com/docs/android/trusted-web-activity/multi-origin "Chrome 官方：多来源 TWA"
[T2S]: https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/android/trusted-web-activity/multi-origin/index.md "GoogleChrome 官方文档源码；读取日期 2026-10-11，blob 726147cb6f11b0517eeb3ba06cd960bfa6e90930"

- PWA：[安装文档][P1]、[官方文档源码][P1S]。
- TWA：[概览][T1]、[概览官方源码][T1S]、[多来源文档][T2]、[多来源官方源码][T2S]。
