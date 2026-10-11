# Android 自有 APK：服务端直推与开源项目比较

> **归档说明（2026-10-11）：** 历史开源比较：记录当时后台直连方案的固定版本、许可与连接恢复证据。下文“最新方向”指该阶段，当前后台通知工作已排除；本页不代表选定或开始实现新接收端。当前范围与选型见 [讨论总览](android-apk-discussion-record-20261011.md)。

日期：2026-10-11。目标设备：OPPO Find X8 / ColorOS 16。按用户最新方向评估：**不用 OPPO 推送，自有 APK 在后台接收服务器消息**。本文取代前两份 APK 评估中以厂商推送为前提的通知建议；五项手机功能仍可复用现有网页与后台。本次仅调查公开第一方文档、固定版本源码和仓库资源，未实现、构建、安装或部署新客户端，未发送通知。

## 结论

这条路线可做，有维护中的开源实现可参考。建议采用 **自有 APK 的原生前台服务 + 现有 FastAPI 的设备专用 SSE + OkHttp**，继续复用已有设备配对、未确认快照、到达回执和用户确认接口；参考 ntfy / Gotify 的连接恢复与状态显示。原生服务独立于 WebView 页面运行，页面负责自选、图表、指标和数据中心。这里是基于本项目资源的工程判断，不代表已经在 Find X8 上验证可靠性。[M1][M2][M3][K1][N6][G6]

**成熟开源项目不等于免受系统回收。** 它们证明直接长连接是可用架构，也给出了重连、前台服务、开机和补漏的具体做法。用户目前遇到的 ntfy 被停止后不收消息问题，不能仅靠把同一连接代码搬进新 APK 宣称解决。自有客户端的价值是统一提醒设置、连接状态、恢复、补收和确认，再以本机结果判断效果。[N6][G1][A1][A2]

若优先复用当前 ntfy 传输，ntfy Android 是最接近现有系统的参考，不必为了评估另起一个 Gotify 服务。若确定直接连接 Market Watch 服务器，OkHttp 是合适的可嵌入传输库，ntfy / Gotify 是行为参考，整包修改它们不是首期必要条件。[M2][N1][K1]

## 三项重点资源

版本与 SDK 为本次读取的上游状态，不是 Market Watch 新 APK 的已选配置。

| 资源 | 维护与许可证据 | 可以复用什么 | 集成判断 |
|---|---|---|---|
| [ntfy-android][N1] | 最新稳定发布 v1.25.2，2026-07-21；Apache-2.0。当前源码 minSdk 26、target/compile SDK 36。[N2][N3][N4] | `specialUse` 前台服务、JSON 流/WSS、网络切换、持久化消息游标、通知去重、后台恢复和连接状态。[N5][N6][N7][N8][N9] | **整套 App，非即插即用推送 SDK。** 与现有 ntfy 发布最接近；移植服务代码仍要适配数据库、身份和通知。适合优先参考，也可用于继续使用现有 ntfy 的方案。 |
| [Gotify Android][G1] | 最新稳定发布 v2.10.1，2026-07-06；MIT。当前源码 minSdk 26、target/compile SDK 36。[G2][G3][G4] | `specialUse` 前台服务、OkHttp WSS、网络监听、退避、连接通知、开机恢复和缺失消息补拉。[G5][G6][G7][G8][G9] | **整套 App；`client` 模块只是 Gotify API 客户端。** 原样使用需要 Gotify 服务端/API，不能直接接现有设备接口。无需为借鉴连接代码迁移本项目服务器。 |
| [OkHttp / okhttp-sse][K1] | Apache-2.0；读取的 main 提交日期 2026-10-07。项目支持 Android API 21+。[K1][K2][K3] | 可嵌入 HTTP、SSE、WSS；认证请求、连接与事件回调。ntfy / Gotify 本身也使用 OkHttp。[N7][G7] | **真正的传输库，最适合自有 FastAPI 设备流。** 不包含前台服务、持久游标、补漏、通知、完整重连或手机后台设置；这些需要客户端实现。[K3] |

许可均允许修改和分发，但复制或打包源码时必须保留适用版权/许可声明；Apache-2.0 还规定修改文件的说明及适用 NOTICE 的保留。许可声明应随实际集成内容处理。[N3][G3][K2]

OkHttp 原 `square/okhttp` 仓库链接本次跳转到 `lysine-dev/okhttp`，现官网为 `lysine.dev/okhttp`。本文使用当前第一方入口及固定提交，未把旧官网 404 误判为项目停止维护。[K1][K4]

### ntfy：恢复机制更完整，但不能原样当可靠性结论

官方说明：无 Firebase 的 F-Droid 构建依赖前台服务维持即时订阅；自托管订阅也直接连接服务器。协议支持 JSON 流、SSE 和 WebSocket，`since` 可从服务器缓存补取历史；补收仍受缓存保留范围限制。[N10][N11]

本次确认的实际源码行为：

- `SubscriberService` 为 `specialUse` 前台服务，`onStartCommand` 返回 `START_STICKY`；通知展示连接状态。开机广播和销毁后的恢复广播通过 `SubscriberServiceManager` 发起恢复任务。后台启动被 Android 拒绝时也存在停止并等待用户打开的处理。[N5][N6][N12]
- `MainActivity` 实际安排了每 **3 小时**的服务恢复 Worker；它是兜底检查，不能当秒级到达通道。[N13]
- `Application` 监听默认网络变化，Wi-Fi/移动网络切换时更新强制重连版本；离线时服务关闭连接但保留服务，等待网络恢复。[N6][N9]
- JSON/WSS 建连读取存储的最后消息 ID，收到消息后写入仓库并去重；唤醒锁用于消息处理阶段，不应仅从 manifest 有 `WAKE_LOCK` 推出全天持续持锁。[N6][N7][N8]
- WSS 失败退避依次为 5、10、15、20、30、45、60、120 秒，随后维持 120 秒。该实现 Android 13+ 会检查精确闹钟能力；没有授权时只记录日志，**此重连路径没有另设延时回退**。需要适配，不能无条件照搬。[N7]
- 从最近任务移除后的重启使用普通 `AlarmManager.set`，不是允许闲置时准时执行的保证。[N6]

最值得借鉴的是完整连接状态、网络切换、持久去重和恢复管理；最不应照搬的是“已使用这些机制，因此后台绝不会断”的判断。

### Gotify：连接实现清晰，补漏要补上本项目语义

官方 README 直接提醒：应关闭电池优化，否则系统可能杀死 Gotify 并停止通知。它使用持续前台通知显示连接状态。[G1]

当前 WSS 使用无限读取超时、1 分钟 ping、10 秒建连超时。失败重试默认基准 1 分钟，指数退避范围 5 秒至 20 分钟；网络可用/属性变化触发连接恢复，开机有服务恢复入口。源码中的精确闹钟回调不应理解为绕过 Doze 或所有手机后台限制。[G6][G7][G8][A1]

Gotify 有断线期间补拉，但这份代码的 `lastReceivedMessage` 是服务内 `AtomicLong`；服务新建时 `MissedMessageUtil` 从服务器最新一条消息 ID 初始化基线，随后重连才按该 ID 补取。**这不等于持久化保存“手机最后成功处理的位置”，不能据此保证进程退出期间全部通知补发。** 本项目应继续用自己的持久事件身份、未确认快照和回执补齐这一点。[G6][G9][M1]

### OkHttp：适合直接接自有服务器，需要自己管理连接生命周期

`okhttp-sse` 解析事件并回调事件 ID；失败和正常结束交给 listener。固定源码的 `onRetryChange` 明确注释 `We do not auto-retry`。因此不能把“用了 SSE 库”推定为已有自动恢复、持久游标或离线补漏。[K3]

建议自有服务维护单一连接状态机：认证有效性、心跳/断线判断、带抖动退避、网络切换、可取消连接和重连；持久化事件身份/已显示状态，避免同一告警反复新增通知。SSE 主要传递事件与状态变更，重连后以服务器完整快照校准；收到消息、显示通知、本人确认分别记录。以上是本项目集成建议，不是 OkHttp 自动提供的功能。[M1][M2][K3]

## UnifiedPush 的定位

[UnifiedPush Android connector][U1] 是连接业务 App 与 distributor App 的协议库，处理注册、取消和接收；**connector 自己不负责维持服务器长连接**。官方明确需要安装分发器。它适合多 App 共享推送连接的体系，不会单独解决“一个自有 APK 直接连接现有服务器”的后台存活问题。[U1][U2]

官方 Sunup 分发器采用 Apache-2.0 和 WebSockets，对接 Mozilla autopush-rs，安装指南仍要求通知权限和电池优化例外。引入它意味着新增分发器/协议或相关服务，而当前首期已有服务端与单 App 目标，故本次不推荐先增加这套体系。本次未逐项审计 Sunup 实现或在手机上运行它。[U3]

## Android 边界与新客户端验收

原生前台服务能让提醒接收独立于图表页面，并提高系统保持其运行的优先级；`START_STICKY` 表示被回收后请求系统重建，不是进程永远存活的保证。Doze 对网络等有约束，用户给予电池优化例外可放宽部分限制，后台启动和手机自身管理仍需核实。ntfy / Gotify 当前都用 `specialUse`，不能套用 Android 15 对 `dataSync` 的六小时限额来断言这些连接服务必须六小时后停止。[A1][A2][A3][A4][A7][N5][G5]

需要分别测量锁屏、从最近任务划掉、系统资源回收、活动应用页“停止”、设置页“强行停止”。最后一种会进入 package stopped state，Android 要求保留停止状态直到用户重新启用，不能设计成无条件自行拉起。活动应用页停止进程的规则又不同，已有 jobs/alarms 仍可能运行。[A5][A6]

如果进入开发，首先验证**新客户端自身链路**，而不是把已有 APK 的编译记录或 ntfy 的历史验收当新 App 的结果。最小验证范围：

1. Find X8 / ColorOS 16 正常后台和锁屏待机，记录服务器事件到手机通知的时间、持续时间及实际权限/省电配置；包括数小时待机和整夜观察。
2. Wi-Fi/移动网络切换、短时断网、服务端重启后重连；恢复后补收、去重，并保留事件原始时间。
3. 进程被回收与重新打开后的未确认快照一致；连接状态真实，失去接收能力时可以诊断，强停后重新打开恢复。
4. 手机确认立即停提醒；离线确认持久化并补传；网页确认后新客户端在恢复/同步后停止，不因重放复活已确认事件。
5. 设备令牌撤销、通知权限关闭和重启时行为清楚；点击通知打开正确告警/品种，而不是依赖 WebView 已在前台。

这是待执行的验收建议，未运行上述实验。验证服务端实例只允许 Ubuntu 隔离环境，按现有 `mw-docker` 入口构建；不在 unraid 创建测试或临时实例。本文不提出新的生产部署动作。

## 来源与固定版本

- ntfy：`51730a0f06cebfad59f1b7bc0cb6d5c47082b032`。
- Gotify：`211682fddee06bc1b53e9980c8ec9ad72409685b`。
- OkHttp：`42e5888d45623662c138ed27e80ea28bbe0aa5cc`。
- 发布信息与在线文档于 2026-10-11 查询；维护日期只说明当前有更新，不替代本机验收。

[M1]: ../../backend/alerts/api.py "Market Watch 设备配对、sync、received、ack 与现有 events"
[M2]: ../../backend/alerts/notify.py "Market Watch 当前 ntfy outbox"
[M3]: ../../mobile/README.md "旧提醒伴侣：5 秒同步与 ntfy 广播，未在 OPPO 真机验收"
[N1]: https://github.com/binwiederhier/ntfy-android "ntfy Android 仓库与 README"
[N2]: https://github.com/binwiederhier/ntfy-android/releases/tag/v1.25.2 "ntfy Android v1.25.2"
[N3]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/LICENSE "Apache-2.0"
[N4]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/build.gradle "ntfy SDK 与构建配置"
[N5]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/AndroidManifest.xml "ntfy specialUse 与权限"
[N6]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/service/SubscriberService.kt "ntfy 服务、去重、消息处理与恢复"
[N7]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/service/WsConnection.kt "ntfy WSS 与重连"
[N8]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/service/JsonConnection.kt "ntfy JSON 流与 since"
[N9]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/app/Application.kt "ntfy 网络变化与强制重连"
[N10]: https://docs.ntfy.sh/subscribe/phone/ "ntfy 官方手机订阅说明"
[N11]: https://docs.ntfy.sh/subscribe/api/ "ntfy 官方协议和历史缓存订阅"
[N12]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/service/SubscriberServiceManager.kt "ntfy 服务恢复 Worker"
[N13]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/ui/MainActivity.kt "ntfy 实际定期恢复任务与三小时常量"
[G1]: https://github.com/gotify/android "Gotify Android README 与电池优化说明"
[G2]: https://github.com/gotify/android/releases/tag/v2.10.1 "Gotify Android v2.10.1"
[G3]: https://github.com/gotify/android/blob/211682fddee06bc1b53e9980c8ec9ad72409685b/LICENSE "MIT"
[G4]: https://github.com/gotify/android/blob/211682fddee06bc1b53e9980c8ec9ad72409685b/app/build.gradle.kts "Gotify SDK 与构建配置"
[G5]: https://github.com/gotify/android/blob/211682fddee06bc1b53e9980c8ec9ad72409685b/app/src/main/AndroidManifest.xml "Gotify specialUse 与权限"
[G6]: https://github.com/gotify/android/blob/211682fddee06bc1b53e9980c8ec9ad72409685b/app/src/main/kotlin/com/github/gotify/service/WebSocketService.kt "Gotify 前台服务、网络回调与补拉"
[G7]: https://github.com/gotify/android/blob/211682fddee06bc1b53e9980c8ec9ad72409685b/app/src/main/kotlin/com/github/gotify/service/WebSocketConnection.kt "Gotify WSS、ping 与重连退避"
[G8]: https://github.com/gotify/android/blob/211682fddee06bc1b53e9980c8ec9ad72409685b/app/src/main/kotlin/com/github/gotify/init/BootCompletedReceiver.kt "Gotify 开机恢复"
[G9]: https://github.com/gotify/android/blob/211682fddee06bc1b53e9980c8ec9ad72409685b/app/src/main/kotlin/com/github/gotify/MissedMessageUtil.kt "Gotify 最新 ID 基线与缺失消息获取"
[K1]: https://github.com/lysine-dev/okhttp/blob/42e5888d45623662c138ed27e80ea28bbe0aa5cc/README.md "OkHttp 当前第一方 README 与 Android 要求"
[K2]: https://github.com/lysine-dev/okhttp/blob/42e5888d45623662c138ed27e80ea28bbe0aa5cc/LICENSE.txt "OkHttp Apache-2.0"
[K3]: https://github.com/lysine-dev/okhttp/blob/42e5888d45623662c138ed27e80ea28bbe0aa5cc/okhttp-sse/src/main/kotlin/okhttp3/sse/internal/RealEventSource.kt "OkHttp SSE：不自动重试"
[K4]: https://lysine.dev/okhttp/ "OkHttp 当前官方文档"
[U1]: https://codeberg.org/UnifiedPush/android-connector "UnifiedPush 当前主仓库和 README"
[U2]: https://unifiedpush.org/developers/implementations/ "UnifiedPush 官方连接器与分发器要求"
[U3]: https://unifiedpush.org/users/distributors/sunup/ "Sunup 官方许可、WebSockets、autopush 与电池优化说明"
[A1]: https://developer.android.com/training/monitoring-device-state/doze-standby "Android Doze、联网及电池优化例外"
[A2]: https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start "Android 后台启动前台服务的限制"
[A3]: https://developer.android.com/develop/background-work/services/fgs/service-types#special-use "Android specialUse 类型"
[A4]: https://developer.android.com/develop/background-work/services/fgs/timeout "Android 前台服务类型的超时规则"
[A5]: https://developer.android.com/about/versions/15/behavior-changes-all#stopped-state "Android 强行停止后的 stopped state"
[A6]: https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping "Android 活动应用页停止前台服务 App"
[A7]: https://developer.android.com/reference/android/app/Service#START_STICKY "Android START_STICKY 的恢复语义"
