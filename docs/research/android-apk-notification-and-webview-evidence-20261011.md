# Android APK：图表与通知的可复用资源和官方约束

> **归档说明（2026-10-11）：** 官方证据归档：WebView、来源隔离和旧 mobile/ 范围可供继续分析；厂商推送及后台通知段属于早期研究。用户已排除 OPPO 通道，当前界面分析也排除后台通知，不以通知准入作为前置条件。当前范围与选型见 [讨论总览](android-apk-discussion-record-20261011.md)。

> 较早路线更新：用户当时已明确不接 OPPO 厂商推送，要求分析原生后台直连，比较见 [开源项目研究](android-direct-push-open-source-20261011.md) 和 [Market Watch 直连方案](android-direct-push-market-watch-plan-20261011.md)。本页厂商规则作为候选调查保留，不再作为选择路线的前提。

日期：2026-10-11。范围：评估 Market Watch 增加 Android APK，首期为自选表、单图、指标、告警通知、数据中心。用户后续确认手机为 **OPPO Find X8 / ColorOS 16**，重点要求是保障收到告警；现在 ntfy 在被停止后无法接收。本次只读仓库与公开官方资料，不实现 APK、不发送通知、不修改生产。不将旧文档中的“停止 APK 开发”当成本次讨论的限制，也不把本次讨论当成开始实施或生产发布的授权。

## 判断

采用手机专用页面与 Android WebView 的混合方案可行：复用现有 Advanced Charts、指标适配、数据中心及服务端告警；原生部分处理通知、通知跳转与 Android 生命周期。TradingView 官方明确支持 Android WebView，但没有提供现成的原生 Android 图表包装器，需要自行实现调用桥。[1]

APK 不会自动补齐手机按钮。官方图表在小屏仍会隐藏右侧自选/详情/数据窗口；Market Watch 现有代码又把触屏专业图表设为只读，并关闭指标与数据中心入口。手机页面需要重新组织入口，不能直接把现有 `/advanced-charts` 套壳就认为首期功能完成。[1][R1]

最需要独立估算的部分是**告警送达与本人确认**。复用服务端现有告警判定、outbox 和确认接口很省工作；取代 ntfy Android 客户端的送达职责是新增工作。新 APK 的图表显示可以暂停，告警判定应继续在服务器运行，避免依赖图表或 WebView 在后台存活。[2][3][R2]

将 ntfy 长连接或旧 5 秒轮询移进新 APK，无法满足用户补充的关键要求。可研究的主通道是 OPPO 系统通知推送，配合服务端消息状态、超时重试、本人确认与用户选择的备用通道；**厂商平台已受理、消息已到手机、通知栏已展示、用户已看到是不同状态**。即使采用厂商推送，也不能承诺断网、通知关闭、手机关机等情况下 100% 即时收到。[13][14][15]

### OPPO 正式推送是首个准入门槛

本次成功读取新开放平台实际使用的公开文档接口 `POST /oneoppoapi/doc/detail`，不是仅引用旧 `/wiki/doc/detail`。新文档 [申请推送服务][16] 仍明确要求：

> 一、注册成为OPPO企业开发者
>
> 二、应用上架软件商店
>
> 通知栏推送：应用需在OPPO软件商店上架。

每天 1000 条的测试推送权限只供测试；新版 [推送服务受限说明][15] 还规定测试权限仅支持内容与营销、单设备 2 条/日，不支持通讯与服务。自 2024-07-29 起，**非 OPPO 软件商店官方渠道下载的应用不再提供公信消息服务**。[15][16]

因此，不能把“个人自用、直接安装一个 APK”默认等同于“可以接入正式 OPPO 推送”，也不能以少量自用告警为由将测试权限当生产通道。当前没有 OPPO 已审核账号或项目正式申请的证据，需先核实主体资质、商店上架和通知类别批准是否可行。未找到公开的新平台规则放开个人未上架正式推送；这是当前有证据的准入限制，不是臆测 SDK 技术做不了。[15][16]

### 正确的行情告警类别与提醒方式

新 [OPPO PUSH 消息分类][17] 将消息分为“通讯与服务”（原私信）与“内容与营销”（原公信），支持 OS 13+，与用户 ColorOS 16 的版本范围匹配；是否为实际可用系统推送实例仍需设备注册实测。

- `SUBSCRIPTION`（个人订阅）明确包括“主动关注的行情动态提醒”；类别的适配依据成立，但 **审核通过尚未发生**。[17]
- 通讯与服务默认可用“通知栏、锁屏、铃声、振动”；横幅强提醒 `notify_level=16` 只对特定聊天、办公、商家服务、汽车远控类开放，不能承诺普通行情 App 会获得横幅强提醒。[17]
- 内容与营销只能下拉通知栏展示。其他 App 单设备 2 条/日，通常还有 7:00–23:30 下发时间限制（官方新闻/投资理财分类有时段例外），无法当连续行情告警的默认替代通道。[15][17]
- 个人订阅申请需显示订阅/取消入口、独立且默认关闭的“订阅”和“是否接收推送”开关，告知收到何种消息，标题/正文体现“您订阅的……”等身份，并提交设置全过程截图/录屏。不能把桌面告警“启用”开关自动当厂商推送订阅许可。[17]
- 新接入应用还需正式推送权限、API 接入和审核过的私信模板；2025-08-01 起新申请通讯与服务应用发送时需 `private_msg_template_id`。模板包含必要固定内容和变量，不能自由发送任意标题正文。[18]

新受限页还保留全类型单用户接收总上限 2000 条/日；这**不覆盖**内容与营销的单 App/单设备 2 条/日限制。通讯与服务虽在分类表标为不限量，也必须遵守适用服务规则、模板与整体接收限制，不能用“不限量”推出无条件即时投递。[15][17][18]

### 送达回执的真实含义

新 [消息回执][14] 原文：

> 调用请求接口成功仅表示消息成功开始下发，不代表消息最终的推送状态。
>
> push_arrive …… 表示消息到达OPPO PUSH客户端，不包含通知栏的展示，点击等后续动作含义。

回执支持 `push_arrive`、`regid_invalid`、`user_daily_limit`、`MESSAGE_NIGHT_CONTROL`。因此服务器应记录发送受理、设备到达与本人确认，并保留消息 ID/设备 ID 对应关系；平台到达也不能替代本人的“已看到”确认。[14][R2]

新版统计页也分别定义下发成功、客户端到达、展示、点击和调起。该页主要描述后台统计，**没有因此证明每条单点消息都能实时获得展示/点击 webhook**；回执页明确可取得的是到达等事件。实现前需确认当前账号的可用能力与回执鉴权；不能把统计报表当实时可靠性闭环。[14][19]

已存在 outbox 可复用服务端持久化、重试和确认取消，但需要增加通道与设备映射、厂商失败原因及超时升级。以“用户确认”作为终止升级的依据；未确认时按用户允许的时限与次数继续提醒或切换备用通道。短信/电话等备用方式当前只是待用户选择的方案，不启用、不发测试、不假定授权。消息过时应明确提示发生时间，避免断网恢复后把旧信号当当前信号。[R2][R10]

OPPO 新受限页明确请求 QPS 不等于到达 QPS，高峰可能在平台排队；旧受限页在“网络良好且不拥堵”条件下声称通道时延 1 秒内，此条件值也不是服务端判定到用户看到的端到端 SLA。因此本项目应通过 Find X8 真机记录端到端延迟及失败恢复，不能承诺固定秒数。[15][20]

## Advanced Charts 在 APK 中的路径

官方移动开发文档的原文：[1]

> Native wrappers for iOS or Android are not provided.
>
> You can embed Advanced Charts and Trading Platform inside a mobile application using a WebView.

同页明确支持触摸、多点手势、主流手机浏览器；图例、价格刻度及右侧栏存在小屏差异。它还要求 Android WebView 支持 ES6，并建议更新 WebView，提供 Android 集成示例和 Chrome DevTools 调试路径。用户在同一手机 Chrome 上已确认正常，支持继续复用图表，但不能据此宣称 APK 的 WebView 已经通过实机验证。[1][R3]

普通 Android WebView 使用设备上的 WebView 提供程序。Android 的 `getCurrentWebViewPackage()` 可以读取实际包版本；官方说明该提供程序会因为更新、卸载、禁用或开发者设置而变化，发生变化时使用它的进程也会被终止。因此 App 能选择 WebView 设置、记录版本和提供清楚的错误提示；仅仅编译 APK 不会把一份可由我们完全固定的 Chromium 内核带到手机上。[4]

### 保留现有图表来源隔离

现有 `advanced-host/bridge.js` 明确要求可信父页面处理所有认证请求；`message` 接收同时检查 `e.source`、`e.origin` 和消息通道。Android 集成应保留这条边界，不向图表静态来源直接提供登录凭据或高权限原生接口。[R4]

Android 官方说明旧 `addJavascriptInterface` 默认暴露给 WebView 内的每一个 frame，包括 iframe，而且缺少按 origin 授权的能力。新的 `WebViewCompat.addWebMessageListener` 支持 `allowedOriginRules`，回调提供 `sourceOrigin` 和 `isMainFrame`；应在功能检测支持后，仅对可信应用页面提供范围有限的桥，再由原有网页桥与图表通信。[5][6]

这里的选择是对现有隔离方案的延续。无须为了做手机 App 将整个专业图表改为原生绘制，也无须把 API token 注入许可图表 iframe。实际集成仍需检查 HTTPS、登录保持、两个来源的加载、旋转/返回、WebView 进程恢复。[4][5][6][R4]

仓库 `.gitignore` 将 `advanced-host/charting_library` 标为许可二进制、不发布。若沿用现有受控 HTTPS 宿主，复用现有交付方式；若打算把库资源直接装进 APK，发布前核对项目实际取得的许可是否覆盖该分发形态。此次未读取实际授权协议，不能推断新增许可限制，也不能承诺 APK 分发已经获准。[R5]

## Android 通知为何是主要难点

| 官方约束 | 对首期 APK 的含义 |
|---|---|
| Android 13 / API 33 起，普通通知需要运行时 `POST_NOTIFICATIONS` 权限。[2] | 首次启用告警需请求权限；拒绝权限时显示真实状态。前台服务能启动不等于用户会看到告警通知。 |
| Doze 会暂停联网、忽略一般 wake lock、延后 jobs/sync/普通 alarm；适当的 FCM 高优先级用户可见消息是官方推荐路径之一。[3] | 不能用后台 WebView、每隔几秒的普通定时器或常规 WorkManager 保证即时告警。 |
| target API 31+ 在后台启动 FGS 有限制，只有列举的例外可用。[7] | 不能把任意 ntfy 广播当成可以随时拉起服务的保证；用户可见启动和停止状态需要设计。 |
| target Android 15 / API 35+ 的 `dataSync` 与 `mediaProcessing` FGS 在后台每 24 小时分别累计最多 6 小时；前台用户交互可重置计时。[8] | 不能把全天通知监听简单标成 `dataSync`。这条不是所有 FGS 的统一 6 小时上限。 |
| `specialUse` 用于其他类型未覆盖的有效场景；声明 subtype，发布 Google Play 时用例会被审查。[9] | 需要实际用途匹配；不能把它解释成任何后台服务都可无限运行或已获应用商店批准。 |

上述是 Android 平台规则；没有因此推断用户当前 ColorOS 版本一定杀进程，也没有保证开启 FGS 就能抵抗用户强行停止、所有省电策略或网络中断。新客户端的可靠性只能用该客户端自身的实机证据说明。[2][3][7]

### 国内 OPPO / 无 Google 服务场景及原候选方案

FCM 官方客户端要求设备为 Android 7.0+ 且安装 Google Play Store，或使用带 Google APIs 的模拟器。直接侧载 APK 不影响采用 FCM，但**没有相应 Google 服务或没有可用 Google 网络的手机，不应只依赖 FCM**。当前资料未确认用户手机是否具有这些条件，不能把“OPPO”自动等同于“必定无 Google 服务”。[10]

ntfy 官方提供两条已实现的 Android 路径：[11]

- Google Play 版本只对主站 `ntfy.sh` 使用 Firebase；它不会对自建 ntfy 服务使用 Firebase。
- F-Droid 版本不包含 Firebase，所有订阅默认使用 instant delivery。instant delivery 依靠前台服务，显示常驻通知；官方还明确关闭即时投递可能导致较长延迟。

这证明无 Firebase 的常驻连接方案可行，不证明我们新写的 App 已拥有 ntfy 的成熟连接恢复、通知管理或用户设备验收。若新 APK 直接接 ntfy，可以采用其公开 JSON/SSE/WebSocket 订阅 API、缓存回放和 `since` 参数；同时需要实现连接重建、去重、补拉、前台通知、鉴权配置及 Android 权限处理。[11][12]

| 首期送达方案 | 复用程度与边界 |
|---|---|
| 保留现有 ntfy Android App 送达，新 APK 承担浏览和告警列表/确认 | 原先复用最多的候选，已有用户真机闭环；用户现已报告停止后不接收，单独用它不能满足新增的送达要求，可作为次通道。[R2][R6] |
| 新 APK 自己订阅 ntfy，采用前台连接 | 原候选可保留服务端发布，但并未解决进程停止后的接收问题；需连接恢复和权限处理，FGS 不构成送达保证，不作为新增关键要求的主方案。[3][7][9][11][12] |
| 新 APK 的 FCM | 需自己的注册/SDK 与服务器 token 投递；不能迁移官方 ntfy App 的 Firebase 接收资格。无合适 Google 服务/网络时不押此单通道。[10][R2] |
| OPPO 系统通知推送 | 与应用进程无关的方向更符合需求；正式接入需企业开发者、商店上架及通讯服务模板审核，个人侧载可行性不能默认成立。[13]–[18] |

普通 APK、FGS、持久 SSE/WebSocket 都无法独自保证收到告警。**先核实可用的正式送达主通道和用户允许的兜底方式，再决定 App 是否能实现用户目标**；不能为了更快发布 App 把已有失败路径搬进新壳。即使使用聚合推送 SDK，也不能假定其会绕过 OPPO 的主体、上架和通道审核；本次未取得这种例外的官方证据。

### 应用退出与系统停止的边界

Android 可因资源不足回收进程，这与设置页“强行停止”产生的 package stopped state 不同。Android 15 官方说明强停后应保持停止状态，直到直接/间接用户操作重新启用；FCM 官方同样明确设置页强停后需重新打开 App 才恢复消息。[21][22]

从最近任务划掉、系统内存回收、系统活动应用页点停止、设置页强停不能笼统当成同一行为。Android 的活动应用页停止会移除整个 App 进程，但既有 jobs/alarms 仍可按计划执行；设置页强停另有 stopped-state 规则。[21][23]

OPPO 旧通知规范明确其系统长连接支持“无论应用进程是否运行”接收；新 SDK 隐私文档说明 App 中的 SDK 只做身份认证/RegID 通信，App 关闭时 SDK 也关闭，消息推送服务另由系统 APK 构成。这支持选系统通知路径，而不支持承诺用户设置页强停、关闭通知、设备离线时也一定收到。公开已读文档未给出 ColorOS 16 对所有强停/省电模式的特例保证，需结合准入后的 Find X8 真机测试。[13][24]

## 旧 `mobile/` 真正可以复用什么

| 资源 | 已有证据 | 不能直接算作已交付的新 APK 能力 |
|---|---|---|
| `mobile/build.py` 与提醒 APK | 使用官方 API 35 SDK 编译、v2/v3 签名；`artifacts/android/market-watch-reminder.apk` 在工作区存在。[R7] | 这是本地开发签名的提醒伴侣，没有图表、指标、自选或数据中心。正式更新需保管同一签名密钥，密钥不进仓库。 |
| `ReminderService.java` | `specialUse` FGS、每 5 秒认证同步；ntfy 广播作为触发同步的提示；不从广播读取任意 URL；读取 `/api/device/sync`，回传 received / ack。[R8] | 仍依赖 ntfy 外部客户端送达提示，自己没有 ntfy/FCM 接收链路；轮询不是新的系统推送。 |
| `RingEngine` 和状态保存 | JVM 测试覆盖响停节奏、次数、静音、确认等；本地待上传确认可重试。[R7][R8] | 原 README 明确未在 OPPO 真机安装运行；编译、签名和 JVM 测试不证明锁屏/后台可靠。 |
| 后端设备 API | 可配对、撤销、取未确认完整快照、记录到达、幂等确认；已有 API 测试。[R2] | 目前设备 token 对应的是提醒 API，不能直接当所有图表/数据中心接口的通用登录身份。 |

旧 manifest 为 `minSdkVersion=26`、`targetSdkVersion=35`，已声明通知、FGS、specialUse 与 wake lock 权限。其 FGS 类型是 **specialUse**，不能把 Android 15 的 `dataSync` 6 小时规则错误套到这份已有代码；同时也不能据此声称旧服务已经是可靠的全天监听器。[8][9][R9]

旧伴侣本来围绕特定响停节奏设计。若首期“告警通知”只要求普通系统通知、点击查看、确认及历史列表，可以先限定在这些功能；精确反复响铃、远程即时停止等需要另外估算。原 ntfy 已有验收记录不会被重新标成失败，但新 APK 如果接管送达，需验证它自己的锁屏接收、断网重连、确认一致性与返回正确品种/周期，不能借用旧客户端的结果。[R6][R7]

## 来源

公开资料于 2026-10-11 读取；`latest` 文档可能以后更新。

[1]: https://www.tradingview.com/charting-library-docs/latest/mobile_specifics/ "TradingView：Mobile app development"
[2]: https://developer.android.com/develop/ui/views/notifications/notification-permission "Android：Notification runtime permission"
[3]: https://developer.android.com/training/monitoring-device-state/doze-standby "Android：Optimize for Doze and App Standby"
[4]: https://developer.android.com/reference/android/webkit/WebView#getCurrentWebViewPackage() "Android API：WebView.getCurrentWebViewPackage"
[5]: https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge "Android：Access native APIs with JSBridge"
[6]: https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges "Android：WebView native bridges security"
[7]: https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start "Android：Restrictions on starting a foreground service from the background"
[8]: https://developer.android.com/develop/background-work/services/fgs/timeout "Android：Foreground service timeouts"
[9]: https://developer.android.com/develop/background-work/services/fgs/service-types#special-use "Android：Foreground service types / Special use"
[10]: https://firebase.google.com/docs/cloud-messaging/android/client "Firebase：Set up an FCM client app on Android"
[11]: https://docs.ntfy.sh/subscribe/phone/ "ntfy：Subscribe from your phone"
[12]: https://docs.ntfy.sh/subscribe/api/ "ntfy：Subscribe using the API"
[13]: https://open.oppomobile.com/wiki/doc#id=11213 "OPPO 旧通知运营规范：系统推送不依赖应用进程"
[14]: https://open.oppomobile.com/documentation/page/info?id=11239 "OPPO 新平台：消息回执"
[15]: https://open.oppomobile.com/documentation/page/info?id=13190 "OPPO 新平台：推送服务受限说明"
[16]: https://open.oppomobile.com/documentation/page/info?id=10195 "OPPO 新平台：申请推送服务"
[17]: https://open.oppomobile.com/documentation/page/info?id=13189 "OPPO 新平台：新消息分类"
[18]: https://open.oppomobile.com/documentation/page/info?id=12391 "OPPO 新平台：私信模板校验"
[19]: https://open.oppomobile.com/documentation/page/info?id=11249 "OPPO 新平台：推送数据统计"
[20]: https://open.oppomobile.com/wiki/doc#id=11210 "OPPO 旧受限说明：条件性通道时延"
[21]: https://developer.android.com/about/versions/15/behavior-changes-all#stopped-state "Android 15：package stopped state"
[22]: https://firebase.google.com/docs/cloud-messaging/flutter/receive "FCM：强停后重新打开应用条件"
[23]: https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping "Android：Handle user stopping an app that has a foreground service"
[24]: https://open.oppomobile.com/documentation/page/info?id=11228 "OPPO 新平台：PUSH SDK 隐私政策与工作方式"
[R1]: ../../advanced-host/bridge.js "Market Watch：触屏只读、指标及数据中心入口"
[R2]: ../../backend/alerts/api.py "Market Watch：设备与通知 API"
[R3]: advanced-charts-mobile-browser-compatibility-20261011.md "手机 Chrome 对照与 360 调查记录"
[R4]: ../../advanced-host/bridge.js "Market Watch：认证父页面与独立图表来源通信"
[R5]: ../../.gitignore "Market Watch：许可库排除发布"
[R6]: ../acceptance-matrix.md "Market Watch：已有 ntfy 真机验收记录"
[R7]: ../../mobile/README.md "Market Watch：提醒伴侣的编译证据与未实机验收声明"
[R8]: ../../mobile/src/app/marketwatch/reminder/ReminderService.java "Market Watch：旧提醒伴侣实现"
[R9]: ../../mobile/AndroidManifest.xml "Market Watch：旧提醒 APK 的 SDK 和 FGS 声明"
[R10]: ../../backend/alerts/notify.py "Market Watch：现有 ntfy outbox 发布、重试与确认机制"

- [TradingView 移动 App 文档][1]
- [Android 通知权限][2]、[Doze][3]、[WebView 提供程序][4]、[JSBridge][5]、[桥安全][6]
- [FGS 后台启动限制][7]、[FGS 超时][8]、[FGS 类型][9]
- [FCM Android 客户端条件][10]、[ntfy 手机接收][11]、[ntfy 订阅 API][12]
- [OPPO 系统通知定义][13]、[回执][14]、[限额/时段/分发限制][15]、[正式准入][16]
- [OPPO 新分类与提醒等级][17]、[私信模板][18]、[后台统计][19]、[旧时延条件][20]
- [Android 强停][21]、[FCM 强停条件][22]、[FGS 用户停止][23]、[OPPO SDK 与推送服务分工][24]

### OPPO 抓取与版本核对说明

`/new/developmentDoc/info` 及新 `/documentation/page/info` 为客户端渲染页面。仅抓初始 HTML 会得到空文档，因此本次读取新页面 JavaScript 实际调用的公开 `POST https://open.oppomobile.com/oneoppoapi/doc/detail`，请求只包含公开 `doc_id`，无用户登录状态；`10195`、`11227`、`11221`、`11239`、`11249`、`13189`、`13190`、`12391` 等返回正文。新快速接入指南 SDK 是 3.7.1，下载资源日期 2025-08；新隐私页标 2025-08-07；新版消息分类模板链接日期 2025-12；均与旧页 3.1.0 及旧限额明显不同。采用新平台正文作为当前规则证据，实际审批仍以正式申请结果为准。

旧 `/wiki/doc/detail` 返回的一部分历史文档仍可读取，适用于解释旧系统架构和条件时延，但**不能用旧每日总量 100000、旧单用户 2000 的表述覆盖新分类的单 App/单设备 2 条及分发限制**。公开文档本身存在更新差异，报告已逐项注明旧/新来源。临时原始抓取留于 `/tmp`，不把代理、开发凭据、SDK 或正式许可资源写入仓库。
