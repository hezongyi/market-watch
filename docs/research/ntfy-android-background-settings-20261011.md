# ntfy Android 正常后台运行：设置与官方 issue 核查

> **归档说明（2026-10-11）：** 历史通知排查：保留设置、版本和上游 issue 研究；建议未在本次执行，issue 状态仅代表查询当日，不能作为当前 Find X8 已修复的证据。当前 APK 界面分析排除后台通知。当前范围与选型见 [讨论总览](android-apk-discussion-record-20261011.md)。

核查日期：2026-10-11。用户设备为 OPPO Find X8 / ColorOS 16，当前要求是**不主动划掉 App，让 ntfy 在后台正常接收告警**。本文核查 ntfy 原作者的文档、仓库 issue、发布说明和设置源码，并补充 OPPO 社区后台管理指南；不把强行停止作为当前问题，也不开始安装、修改设置或发送通知。未找到能核实 ColorOS 16 全部菜单路径的官方资料，因此以下按设置名称指引。

## 结论

有明确的官方建议和与此现象接近的讨论。优先核对 **即时投递、真正的电池优化例外、后台活动/数据权限，以及当前版本**，再根据实际连接状态判断是否用 HTTP JSON 做对照。不能仅从“App 没划掉”或“后台允许”四个字推定实时订阅正常。[D1][I1][I2][S1]

本次 GitHub latest 稳定版仍为 **1.25.2，发布于 2026-07-21**。1.25.0 曾引入离线停止前台服务、联网后启动受限导致收不到消息的缺陷；作者明确给出修复，1.25.2 发布说明包含该修复。此前实机记录已经是 Play 1.25.2；若目前仍是这个版本，无需把「升级版本」重复当成待办。[R1][R2][I3][I4][L1]

## 建议先核对的设置

| 项目 | 应检查的状态 | 第一方依据与限制 |
|---|---|---|
| 即时投递 / 实时推送 | 订阅启用 Instant delivery。中文版本可能叫「实时推送」或「即时交付」。 | 官方说明即时投递使用前台服务维持连接。**F-Droid 版所有订阅默认即时投递，界面不显示这个开关**；自托管订阅也不使用 Firebase。开关主要出现在含 Firebase 的版本对 `ntfy.sh` 的订阅中。[D1][S2][S3] |
| 电池优化例外 | 关闭对 ntfy 的电池优化，允许不受限制的后台使用。优先用 ntfy 首页的电量提示「现在修复」进入系统授权。 | 原提示明确「请关闭对本应用的电量优化以避免通知推送问题」；按钮实际请求 Android `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`。协作者在 #1547 明确说关闭电池优化是对所有用户的推荐。[S1][S2][I1] |
| 后台活动与后台数据 | 系统允许 ntfy 后台活动、移动数据/Wi-Fi 在后台使用；若厂商另外提供自启动/自动启动限制，也应核其状态。 | #104 贡献者建议「enable background usage without restrictions」，并指向厂商特殊省电设置资料。ntfy 自己没有一个可以代替全部厂商限制的「自启动」开关；ColorOS 的实际位置和组合不能从其他手机 issue 推断。[I5][I12] |
| 通知权限与主题状态 | 允许 ntfy 通知；主题未暂停/静音，最低优先级不高于实际消息，系统对应通知渠道可展示。 | 这些影响展示/声音，与实时连接分别检查。主题和全局设置原本就有静音、优先级与通知渠道配置。[D1][S2][S3] |
| 连接协议 | 正常情况下官方推荐 WebSockets。若 Android 16 锁屏后卡在重连，可切换「设置 → 高级 → 链接协议 → HTTP 传输的 JSON 数据流」做对照。 | HTTP JSON 是长时间保持的 HTTP 响应，并非改成隔几分钟才查一次。#1634 的用户切换后反馈改善，但只是案例；官方当前设置仍推荐 WSS，不能说所有 Android 16 都必须换 JSON。[S2][I6][I7] |
| WSS 的闹钟和提醒能力 | 使用 WSS 时，若 ntfy 提示无法后台重连，检查「设置 → 高级 → 精确闹钟」或系统「闹钟和提醒」。 | 作者说明这项用于后台重连 WSS；JSON 不需要这项重连授权。授予电池优化例外后，作者和协作者实机发现精确闹钟能力已可用，因此 ntfy 会隐藏该菜单；**看不到菜单不等于权限缺失**。[I8][I9][S4] |
| 连接断开示警 | 排查阶段可选「设置 → 高级 → 连接断开时示警 → 5 分钟后」。 | 1.25.2 默认为关闭，作者测试说明用 5 分钟提示连接异常。它用于发现故障，**不增强存活、不保证识别每种假连接，也不能在进程已消失后自行报警**。[R1][I19][S2] |
| 记录日志 | 「设置 → 高级 → 记录日志」开启；发生迟收后复制本地日志检查连接和服务生命周期。 | 官方排障入口。日志最多保留 1000 条；可用「复制到剪贴板（屏蔽敏感信息）」遮盖服务器/主题，通知正文仍需要自行核对。没有必要自动上传日志。[D1][S2] |

电池提示被点击「暂时不管」只是隐藏提示，没有给予系统例外；源码分别处理隐藏提醒与实际授权。缺少提示横幅本身不能证明授权完成。[S1]

## Find X8 / ColorOS 16：可操作的配置清单

以下按系统设置名称核对；可先长按 ntfy 图标进入应用信息，也可使用手机设置的搜索功能。菜单名称随系统地区与版本变化，未核实的路径不写成必然存在。

1. **允许后台活动**：在 ntfy 对应的耗电/后台管理中允许后台运行；如果存在「无限制」或类似选项，选择允许持续后台使用。
2. **关闭 ntfy 的电池优化**：优先使用 ntfy 的电量提示「现在修复」完成实际 Android 例外授权。这与第 1 项分开确认。
3. **允许自动启动/自启动**：若本机有该项，允许 ntfy；应用自行恢复或重启后的启动不应被厂商额外拦截。
4. **允许后台联网**：允许 ntfy 使用移动数据和 Wi-Fi；若开启流量节省，检查 ntfy 的后台数据限制。
5. **最近任务锁定**：在最近任务中锁定 ntfy，作为额外保护。即使用户不主动划掉，也可核对该选项；它不能代替前面的电池例外。
6. **通知可见且有声音**：允许通知、锁屏展示和实际告警优先级对应渠道的声音。排查阶段保留「订阅服务」通知，方便观察持续监听/等待网络状态。

ntfy 官方与协作者支持即时投递、取消电池优化、允许无限制后台使用的方向。[D1][I1][I5] [Don't Kill My App 的 OPPO 页面][C1]列出了自启动、后台活动、最近任务固定和电池优化设置，但主要样本是 **OPPO F1S / ColorOS 6**，只能作为厂商限制的社区参考，不能作为 Find X8 / ColorOS 16 的实测证明。该旧指南的悬浮权限没有足够依据作为 ntfy 当前必需项，因此不列入清单。

**仅在夜间/长时间静置迟收时核对**：如手机有「睡眠待机优化」或同类深度省电选项，检查它是否限制网络。相关 [OnePlus 社区指南][C2]记载睡眠时断网导致迟收，但同样不是 ColorOS 16 的直接验证；不据此要求关闭全部系统省电功能。

GitHub 本次 `repo:binwiederhier/ntfy Oppo` / `ColorOS` 搜索只命中 #1491（厂商推送渠道诉求），Android 仓库的 Oppo 搜索无结果。找到了多条一般 Android 后台与重连讨论，**没有找到足够证据声称已有大量同款 Find X8 / ColorOS 16 的确诊案例**。

## 刷新后的 issue 证据

以下状态为 2026-10-11 GitHub API 查询结果。讨论中的「OWNER」是原作者 `binwiederhier`，「COLLABORATOR」为项目协作者；普通报告者和贡献者的设备经验不能自动提升为官方通用保证。

### #1709：正常后台突然退出，旧版已有明确修复

- [issue #1709][I3] 仍为 **open**，最后更新 2026-07-04。原报告来自 Android 15、ntfy 1.25.0 Play、自建服务器，明确描述更新后静默退出与通知迟到，不需要主动划掉 App 才发生。
- 作者在 2026-04-18 日志里看到 `ignoring optimizations = false` 和前台服务启动被拒绝，要求电池优化例外。报告者又说自己的系统界面已允许后台活动；这恰好说明**手机界面的允许后台与 ntfy 读取的实际电池优化例外需要分别确认**。[I2][I3]
- 作者 2026-07-02 明确留言「Fixed」，离线时只关连接、保留前台服务并显示 Waiting for network。[I4]
- [1.25.2 发布说明][R1] 明确记载离线保持服务、网络返回自动恢复即时投递，以及 Wi-Fi/移动网络/VPN 切换时强制重连。**issue 仍 open 不代表这一缺陷没有修复；也不代表新版在所有手机上已通过后台验收。**

### #1547 / #1456：电池优化是基础设置，精确闹钟菜单可能隐藏

[issue #1547][I10] 仍 **open**，最后更新 2026-01-18。协作者 2026-01-14 明确指出：关闭电池优化「which is what we recommend everyone do」，且这时精确闹钟/提醒权限可能不再出现在列表。[I1]

[issue #1456][I8] 已 **closed / completed**，最后更新 2026-01-03。作者和协作者在设备上分别验证：允许不受限后台后 `canScheduleExactAlarms()` 返回 true，菜单/系统列表表现变化。作者已提交界面修正，当前 1.25.2 源码也按 `isIgnoringBatteryOptimizations` 隐藏设置项。[I9][S4]

这不是让用户为看见该菜单重新开启省电限制。检查 WSS 的实际授权状态；若已获电池例外且没有精确闹钟提示，不能仅因菜单缺失继续折腾。

### #1634：Android 16 WSS 卡住，JSON 可作为针对性试验

[issue #1634][I6] 仍 **open**，最后更新 2026-03-08。报告来自 Android 16、ntfy 1.22.2 F-Droid、双层 Nginx 代理，状态长时间 CONNECTING，后台轮询却能取得消息。

报告者升级到 1.23.0 并使用 HTTP JSON 两天后反馈良好。作者要求完整生命周期日志，继续调查 Doze、重连定时器与失效状态检测，并明确 JSON stream 是类似 SSE 的持续 HTTP 响应。[I7][I11]

证据支持「有这种情况，JSON 可对照」，不支持「已确诊当前 Find X8 是同一 bug」「1.25.2 必然仍复现」或「WSS 在所有 Android 16 上不可用」。讨论包含作者转贴的 LLM 分析，本文仅记录作者确认的调查状态和源码行为，不把其中所有建议当成已验证修复。

### #104：移动网络后台迟收，近期报告更新了结论

[ntfy-android #104][I12] 仍 **open**，最后更新 2026-08-18。最初报告在 OnePlus 6/6T 的 LineageOS 上，Wi-Fi 正常、锁屏移动网络迟收，即便已设不限制电池和后台数据。

2025-08-26 贡献者建议无后台限制，并核服务器与厂商省电。2026-08-18 **原报告者**更新：改用自建 VPS，Android 1.25.2 F-Droid、LineageOS for microG 22.2 下，Wi-Fi/移动网络都立即收到；同时明确仅试了几天，数据不确定。[I5][I13]

这是更近的成功经验，说明不能从旧回复直接断言「ntfy 后台不可行」；它也不是 OPPO/ColorOS 16 的验收结果，不能据此要求本项目立即重部署 ntfy。

### #1834：疑似 Doze，后续实际定位到代理网络保活

[issue #1834][I14] 仍 **open**，最后更新 2026-08-24。早期用户描述手机静置后迟收，曾怀疑 Doze 和 WSS 重连闹钟。

原报告者在 2026-07-26 更新：代理与 ntfy 之间经过 WireGuard，防火墙 UDP conntrack 120 秒超时，与新版客户端 180 秒 ping 间隔不匹配；调整隧道保活或该超时后改善。2026-08-24 另一用户也报告调整后改善。[I15]

这说明即使 App 还在后台，连接链路也可能半失效。它是报告者定位出的特定配置原因，**不能把早期“可能 Doze”当作确定原因，也不能不查环境就改本项目生产系统参数**。

### #955 / #855：能发、能刷新，不等于实时订阅连接正常

[issue #955][I16] 和 [#855][I17] 均 **closed**。案例涉及自建代理/隧道；#955 原报告者修正 Cloudflare Tunnel 上游端口，其他用户启用 Nginx Proxy Manager 的 WebSocket 转发后解决。作者明确「持续显示 reconnecting 表示并未真正连上」，并要求 Android/服务端日志。[I18]

它们用于区分连接问题与后台进程问题，不能将这些服务器修复直接套到用户当前的 `ntfy.sh`。

## 对当前手机最有用的排查顺序

1. 核 ntfy 版本/渠道、主题的即时投递，以及电池优化例外和 ColorOS 的后台活动/数据设置。不要因为 F-Droid 没有即时投递开关而认为缺少功能。
2. 保持正常后台、不主动划掉，观察是否显示「正在监听通知」或「正在等待网络」。前台通知可在系统渠道设置里被隐藏，**通知图标消失本身不证明进程退出**；排查时保留它方便观察。[D1]
3. 如果服务仍在、主题状态却持续重连或只能手动刷新，先按官方入口看连接错误/日志。若用 WSS，核重连授权，再可对照 HTTP JSON；分别看锁屏 Wi-Fi、锁屏移动网络与网络切换恢复。
4. 若日志显示服务被停止/后台启动被拒绝，重点查真实电池例外和系统限制；若显示服务正常但流失效，重点查协议与网络路径。不要把两者混在一句「后台掉了」里。

此前实机记录为 Play 1.25.2，前台和短时锁屏接收成功，但未记录 ColorOS 电池例外/后台权限全部调整后的长时间结果。[L1] 以上是基于新证据的检查建议；尚未看到当前系统设置或对应故障日志，不能宣称已经找到其确定原因。本次未执行手机操作或告警测试。

## 来源

在线资料读取于 2026-10-11；设置源码固定在 `51730a0f06cebfad59f1b7bc0cb6d5c47082b032`。

[D1]: https://docs.ntfy.sh/subscribe/phone/#instant-delivery "ntfy 官方：即时投递、F-Droid、通知渠道与排障"
[R1]: https://github.com/binwiederhier/ntfy-android/releases/tag/v1.25.2 "ntfy Android 1.25.2：修复离线恢复及网络切换"
[R2]: https://api.github.com/repos/binwiederhier/ntfy-android/releases/latest "GitHub 第一方 latest 稳定发布 API"
[S1]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/ui/MainActivity.kt "电池横幅和实际例外请求、WSS 重连提示"
[S2]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/res/values-zh-rCN/strings.xml "中文设置、连接协议、电量提示、日志说明"
[S3]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/ui/DetailSettingsActivity.kt "即时投递开关可见性及主题通知设置"
[S4]: https://github.com/binwiederhier/ntfy-android/blob/51730a0f06cebfad59f1b7bc0cb6d5c47082b032/app/src/main/java/io/heckel/ntfy/ui/SettingsActivity.kt "精确闹钟权限读取和电池例外下菜单隐藏"
[I1]: https://github.com/binwiederhier/ntfy/issues/1547#issuecomment-3749538738 "协作者：推荐所有用户关闭电池优化"
[I2]: https://github.com/binwiederhier/ntfy/issues/1709#issuecomment-4273784602 "作者：日志显示电池优化例外实际未启用"
[I3]: https://github.com/binwiederhier/ntfy/issues/1709 "1.25.0 正常后台突然停止；open"
[I4]: https://github.com/binwiederhier/ntfy/issues/1709#issuecomment-4861634164 "作者 2026-07-02：已修复，离线保留前台服务"
[I5]: https://github.com/binwiederhier/ntfy-android/issues/104#issuecomment-3223152882 "贡献者：后台无限制、服务器与厂商省电检查"
[I6]: https://github.com/binwiederhier/ntfy/issues/1634 "Android 16 WSS 重连卡住；open"
[I7]: https://github.com/binwiederhier/ntfy/issues/1634#issuecomment-4004677627 "报告者：改 HTTP JSON 两天运行良好"
[I8]: https://github.com/binwiederhier/ntfy/issues/1456 "精确闹钟设置列表缺失；closed"
[I9]: https://github.com/binwiederhier/ntfy/issues/1456#issuecomment-3707189024 "作者实机：电池例外使 canScheduleExactAlarms 为 true"
[I10]: https://github.com/binwiederhier/ntfy/issues/1547 "后台/闹钟权限排障界面建议；open"
[I11]: https://github.com/binwiederhier/ntfy/issues/1634#issuecomment-4020216884 "作者：HTTP JSON 是持续 HTTP 响应"
[I12]: https://github.com/binwiederhier/ntfy-android/issues/104 "F-Droid 移动网络锁屏迟收；open"
[I13]: https://github.com/binwiederhier/ntfy-android/issues/104#issuecomment-5325155880 "原报告者 2026-08-18：1.25.2 与自建 VPS 后正常"
[I14]: https://github.com/binwiederhier/ntfy/issues/1834 "静置后迟收；open"
[I15]: https://github.com/binwiederhier/ntfy/issues/1834#issuecomment-5083078983 "原报告者 2026-07-26：WireGuard/防火墙保活原因"
[I16]: https://github.com/binwiederhier/ntfy/issues/955 "自建代理下需要刷新；closed"
[I17]: https://github.com/binwiederhier/ntfy/issues/855 "自建服务器收不到通知；closed"
[I18]: https://github.com/binwiederhier/ntfy/issues/955#issuecomment-1821026551 "作者：持续重连意味着未连上订阅流，需要日志"
[I19]: https://github.com/binwiederhier/ntfy/issues/1709#issuecomment-4879068370 "作者测试说明：连接失联示警与离线/联网恢复"
[C1]: https://dontkillmyapp.com/oppo "OPPO 社区后台管理指南；样本主要为 F1S 与 ColorOS 6"
[C2]: https://dontkillmyapp.com/oneplus "OnePlus 社区睡眠待机优化指南；不等同 ColorOS 16 实测"
[L1]: android-apk-discussion-record-20261011.md#历史验收摘要 "此前实机记录的归档摘要：Play 1.25.2、短时锁屏收到；后台豁免设置未完整记录；未新增测试"
