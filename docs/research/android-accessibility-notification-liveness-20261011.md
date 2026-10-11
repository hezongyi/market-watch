# Android 无障碍服务与后台告警存活调查

> **归档说明（2026-10-11）：** 历史无障碍专题：保留 AOSP 固定版本及公开项目证据；不等于 ColorOS 16 真机验证，也未选定或实现无障碍方案。当前 APK 界面分析排除无障碍与后台保活工作。当前范围与选型见 [讨论总览](android-apk-discussion-record-20261011.md)。

日期：2026-10-11。目标设备：OPPO Find X8 / ColorOS 16。
用户场景：正常切到后台、不主动划掉 App、不接 OPPO 推送；想参考李跳跳的无障碍服务，让 ntfy 或未来自有告警 APK 持续接收消息。
本文调查第一方文档、AOSP 固定版本和公开项目资料；未实现、构建、安装或部署客户端，未在目标手机执行锁屏测试，未发送通知。

## 结论

**这个方向有真实的技术基础，可以提高后台存活及被系统恢复的机会。** 无障碍服务由系统绑定；AOSP 的绑定标志既影响进程优先级，也能传递运行态网络能力。不能简单断言“它仅仅保进程，对息屏联网完全没有影响”。[A1][S1][S2][S3][S4][S5]

**现有官方 ntfy APK 没有无障碍服务，不能通过手机里的一个设置直接补上。** 本次检查的 ntfy Manifest 声明了订阅前台服务及相关接收器，没有 AccessibilityService 的 action 和 BIND_ACCESSIBILITY_SERVICE 声明。若采用这条路线，需要修改客户端或开发自己的服务，属于研发工作。[N1][A1]

**给李跳跳或 GKD 开无障碍，不会自动保护另一个 ntfy App。** 被绑定的是该服务所在的进程，能力及网络规则沿绑定关系、进程和 UID 处理。AOSP 的此处绑定不为任意其他 APK 提供保护；另行设计跨 App 服务关系又是新的研发方案。[S1][S2][S4][S5][S6]

它适合成为未来自有 APK 的一个研究选项，不能仅凭李跳跳长期运行，就承诺 Find X8 在整夜锁屏下必然即时收告警。应用存活、连接恢复、网络放行、CPU 执行和通知展示需要分别确认。[A2][A3][G1][G2]

## 系统绑定为何有帮助

Android 官方说明，无障碍服务的生命周期由系统管理，用户必须在设置中显式启用；系统随后绑定服务并调用 onServiceConnected。服务仍运行在应用自己的上下文，开启权限不会把第三方 APK 变成系统进程。[A1]

Android 16.0.0_r1 的 AccessibilityServiceConnection.bindLocked 使用以下标志：[S1]

- BIND_AUTO_CREATE：系统保留自动创建服务的绑定需求。
- BIND_FOREGROUND_SERVICE_WHILE_AWAKE：设备完全唤醒时，提供相应的绑定前台服务状态。
- BIND_INCLUDE_CAPABILITIES：将绑定客户端的进程能力传给服务宿主。
- BIND_ALLOW_BACKGROUND_ACTIVITY_STARTS：此绑定还带有后台活动启动相关标志；这不代表告警必须启动页面。

OomAdjuster 对高优先级系统客户端的绑定进行计算，能够提高服务宿主进程的重要程度。设备完全唤醒时，该路径可给到 BOUND_FOREGROUND_SERVICE；未完全唤醒时转为 IMPORTANT_FOREGROUND。这里描述的是进程状态计算，不能据此推断整个进程的内存回收分数同步变成普通后台。[S2]

**它也有恢复基础。** 官方 ServiceConnection 文档指出，服务进程崩溃或被杀造成 onServiceDisconnected 时，绑定本身仍保持，服务下次运行会再次回调 onServiceConnected。AOSP 无障碍连接普通断开时调用 binderDied，未直接解除此绑定；onNullBinding 则明确解除绑定。[A4][S1]

ActiveServices 在允许重启、用户仍运行等条件下安排服务重启，并包含延迟/退避；反复崩溃超过绑定服务重试限制、禁止重启等情况会停止服务。因此是“提高存活与恢复机会”，不是无限自动复活或保证从未中断。[S4][A2]

## 息屏联网：AOSP 16 确认到什么程度

本次沿固定 AOSP 16 源码核实了完整的运行态能力链路，而不只查看无障碍绑定标志。

| 环节 | 固定源码中的行为 | 意义 |
|---|---|---|
| 系统客户端 | SystemServer 启动 AccessibilityManagerService；AMS.setSystemProcess 把系统 ApplicationThread 登记为 persistent、SYSTEM_ADJ 的进程。[S3][S7] | 无障碍管理器的普通系统 Context 绑定来自 system_server。 |
| 绑定身份 | ContextImpl.bindServiceAsUser 最终传入本进程 ApplicationThread；ActiveServices 取 callerApp，并写入 AppBindRecord 的 client。[S4][S8] | 后续计算使用的是系统绑定客户端的进程记录。 |
| 系统进程能力 | OomAdjuster 的固定高优先级进程分支设置 PROCESS_CAPABILITY_ALL；其中包含 POWER_RESTRICTED_NETWORK。[S2][S9] | 系统客户端具有受省电限制时联网的能力位。 |
| 能力继承 | 未指定 BIND_WAIVE_PRIORITY 时，BIND_INCLUDE_CAPABILITIES 使宿主合入 client.curCapability。[S1][S2] | 无障碍服务宿主可获得上述网络能力，独立于“是否完全唤醒”的进程状态分支。 |
| 最终保留 | OomAdjuster 在较低进程状态下明确剔除的是 BFSL；这条最终处理没有因 IMPORTANT_FOREGROUND 而清除 POWER_RESTRICTED_NETWORK。[S2] | 不能用“息屏后状态降级”直接推出此网络能力消失。 |
| 网络规则 | NetworkPolicyManager 的 idle / power-save 判断接受 POWER_RESTRICTED_NETWORK；NetworkPolicyManagerService 据此生成 FOREGROUND allowed reason，清除 DOZE、BATTERY_SAVER、APP_STANDBY 网络阻断原因。[S5][S6] | AOSP 16 在这种运行态绑定及能力存在时，有相应省电网络放行机制。 |

所以，**在上述 AOSP 16 绑定成立、进程运行和能力存在的条件下，确有针对 Doze / 省电网络限制的放行链路**。这比“也许系统会稍微优待它”更有直接源码依据。[S1][S2][S3][S5][S6]

同时，AOSP 的默认网络能力也包含 FOREGROUND_SERVICE 状态；正常运行的 ntfy 订阅前台服务本就有对应的 POWER 网络能力。因此，这条无障碍能力继承链路不证明它比运行中的 ntfy 前台服务拥有独有联网特权，也不能直接解释所有迟收。比较重点仍是系统绑定、进程优先级和恢复机制；实际增益需要目标手机对照结果。[S5][N1]

这里仍有三个明确边界：

1. **运行态能力不等于永久电池优化白名单。** DeviceIdleController 的永久名单来自系统配置与用户名单；本次查看的 AccessibilityManagerService 绑定路径没有把启用的服务加入这些名单。关闭/丢失绑定后的状态不能沿用运行时结论。[S1][S10][S11]
2. **不是全部省电条件都用同一个判断。** AOSP 的 Low Power Standby 有独立的 TOP 状态/allowlist 条件；FOREGROUND allowed reason 本身不会清除 LOW_POWER_STANDBY。网络能力链路也不能单独证明所有 Doze CPU / wakelock 约束都已解除。[S5][S6][A3]
3. **AOSP 不等于 OPPO 的完整实现。** 上述是 Android 16 固定源码证据，本次没有取得 Find X8 / ColorOS 16 在该配置下的进程状态、网络规则或整夜收信测量，不能宣称设备已验证。[S1][S2][S5][S6]

Android 官方也没有提供“只要开启无障碍就永不回收并保证锁屏消息实时送达”的 API 承诺。即使重要进程，内存极端紧张时仍可被系统回收；应用必须处理重建后的状态。[A1][A2]

## 李跳跳与 GKD：哪些事实可借鉴

李跳跳作者署名的公开《李跳跳进阶指南》说明其通过安卓无障碍权限自动点击广告跳过按钮。这确认了该 App 的主要服务机制，但该指南未公开一套可直接移植、保证告警接收的实现。[L1]

GKD #201 有用户报告：在其设备上，GKD 给齐权限仍难长期存活，而李跳跳仅给后台运行权限即可存活数周。这是值得承认的正面使用经验，作者身份为普通用户；不能把它等同本机 Find X8 / ColorOS 16 的对照实验或原作者代码说明。[G3]

同类项目也提供了失败边界：[G1][G2]

- GKD 官方 FAQ 建议先锁定最近任务卡片，必要时启用常驻通知、允许后台活动、关闭省电策略或设置无限制、允许自启动；说明无障碍并不能消除所有系统管理条件。
- GKD #1399 项目成员查看用户日志后指出设备杀了进程。日志同时有“访问无障碍=true、特殊用途前台服务=true、创建无障碍悬浮窗=true”，但“忽略电池优化=false”。这证明相关机制叠加后仍存在被系统杀进程的实例。

此外，GKD 当前固定源码除了无障碍服务，还实现了 1×1、不接收触摸、不获取焦点的保活 overlay。A11yService 在连接时附加 TYPE_ACCESSIBILITY_OVERLAY，并有 StatusService.autoStart 路径；项目成员在 #883 也称已有“无感保活”。因此不能把同类 App 所有长期运行效果都归因于一个无障碍开关。[G4][G5][G6]

这里仅列出可以核验的机制，没有建议本项目直接实现不可见窗口。李跳跳的完整原始实现本次未取得；公开 APK 存储仓库也不能作为原作者源码证据。[L1][L2]

## 对现有 ntfy 与自有 APK 的实际判断

| 方案 | 当前能做什么 | 对当前问题的判断 |
|---|---|---|
| 继续用官方 ntfy | 已有订阅前台服务、网络恢复、消息游标等；按已整理的手机后台设置排查。[N1][N2][M1] | 可以继续改善和观察；系统设置无法凭空给它增加无障碍服务。 |
| 修改 ntfy | 新增服务声明并实现自己的 AccessibilityService，再与订阅连接生命周期配合。[A1][N1] | 有工程研究价值；属于客户端开发，不能表述为“现在打开一个开关就解决”。 |
| 自有告警 APK | 原生接收服务与网页图表分离，复用现有设备配对、同步/确认链路；无障碍可作为研究选项。[M2][M3] | 可控制连接状态和补收，仍需在目标设备验收后台及锁屏行为。 |
| 只给李跳跳开无障碍 | 保持李跳跳自身的系统绑定。[S1][S4] | 没有建立 ntfy 的系统绑定或为其 UID 添加上述能力。 |

未来 APK 即便加入无障碍，进程恢复后仍必须完成：建立连接、持久化最后成功处理的位置、拉取未确认快照、通知去重、区分到达回执与本人确认。这些职责不由系统绑定或无障碍事件自动完成。[A4][N2][M2]

## 后续需要的最小证据

如果用户决定进入研发，先验证“正常后台、不划掉 App”的实际场景，避免把强行停止与日常后台混在一起。

- 记录实际系统版本、后台/电池设置、无障碍连接状态，分别观察启用前后的服务重建和进程存活。
- 对正常亮屏后台、数小时息屏、整夜待机分别记录服务端事件时间与本机通知时间，检查进程活着但连接停收的情况。
- 包含 Wi-Fi / 移动网络切换、断网恢复和进程重建后的补收、去重；以未确认记录校准是否漏告警。
- 若日志只能证明收到 UI 无障碍事件，不把它当成锁屏网络通知已经可靠的验收证据。

上述为待执行的验证建议。本次只有文档及源码核查；没有创建 Docker 或生产调试实例，也没有替现有 ntfy 开权限或开发 APK。

## 来源

AOSP 来源固定于 android-16.0.0_r1。ntfy 固定于 51730a0f06cebfad59f1b7bc0cb6d5c47082b032；GKD 代码固定于 3749dceb9d01000f187c4b3ffc2c0921caa81328。在线资料查询日期为 2026-10-11。

[A1]: https://developer.android.com/reference/android/accessibilityservice/AccessibilityService "Android 官方：无障碍服务生命周期和声明"
[A2]: https://developer.android.com/guide/components/activities/process-lifecycle "Android 官方：进程生命周期及回收"
[A3]: https://developer.android.com/training/monitoring-device-state/doze-standby "Android 官方：Doze / App Standby"
[A4]: https://developer.android.com/reference/android/content/ServiceConnection#onServiceDisconnected(android.content.ComponentName) "Android 官方：连接丢失后绑定仍然存在"
[S1]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java "bindLocked / onServiceDisconnected / binderDied"
[S2]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/core/java/com/android/server/am/OomAdjuster.java "固定进程能力、绑定能力继承、最终能力处理"
[S3]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/core/java/com/android/server/am/ActivityManagerService.java "setSystemProcess"
[S4]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/core/java/com/android/server/am/ActiveServices.java "bindServiceLocked / killServicesLocked / 服务恢复条件"
[S5]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/core/java/android/net/NetworkPolicyManager.java "isProcStateAllowedWhileIdleOrPowerSaveMode / Low Power Standby"
[S6]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/core/java/com/android/server/net/NetworkPolicyManagerService.java "UID 状态与能力、getEffectiveBlockedReasons"
[S7]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/java/com/android/server/SystemServer.java "系统进程初始化及 AccessibilityManagerService 启动"
[S8]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/core/java/android/app/ContextImpl.java "bindServiceAsUser / bindServiceCommon"
[S9]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/core/java/android/app/ActivityManager.java "PROCESS_CAPABILITY_ALL / POWER_RESTRICTED_NETWORK"
[S10]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/apex/jobscheduler/service/java/com/android/server/DeviceIdleController.java "永久省电名单的构成和查询"
[S11]: https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityManagerService.java "updateServicesLocked 系统绑定路径"
[N1]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/AndroidManifest.xml "ntfy 服务与权限声明，未声明无障碍服务"
[N2]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/service/SubscriberService.kt "ntfy 订阅服务和消息处理"
[L1]: https://juejin.cn/post/6938590373740544007 "李跳跳作者署名公开指南，2021-03-12"
[L2]: https://github.com/rongzhiy/LiTiaotiao "README 说明仓库仅用于存储李跳跳软件"
[G1]: https://gkd.li/guide/faq#persistent "GKD 官方 FAQ：后台运行"
[G2]: https://github.com/gkd-kit/gkd/issues/1399#issuecomment-4707636155 "GKD 成员日志分析，2026-06-15"
[G3]: https://github.com/gkd-kit/gkd/issues/201#issuecomment-1784411707 "普通用户对比反馈，2023-10-30"
[G4]: https://github.com/gkd-kit/gkd/blob/3749dceb9d01000f187c4b3ffc2c0921caa81328/gkd-app/src/androidMain/kotlin/li/gkd/app/platform/overlay/KeepAliveOverlayCoordinator.kt "GKD 当前 overlay 实现"
[G5]: https://github.com/gkd-kit/gkd/blob/3749dceb9d01000f187c4b3ffc2c0921caa81328/gkd-app/src/androidMain/kotlin/li/gkd/app/service/A11yService.kt "GKD 当前无障碍连接和附加服务路径"
[G6]: https://github.com/gkd-kit/gkd/issues/883#issuecomment-2655451054 "GKD 成员说明已有无感保活，2025-02-13"
[M1]: ntfy-android-background-settings-20261011.md "本仓库已整理的 ntfy 与手机后台设置"
[M2]: android-direct-push-market-watch-plan-20261011.md "Market Watch 自有 APK 设备事件流集成计划"
[M3]: android-direct-push-open-source-20261011.md "ntfy / Gotify / OkHttp 源码对比"
