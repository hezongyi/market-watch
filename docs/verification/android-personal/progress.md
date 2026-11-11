# Android v2.0.5 / A06 实施进度

当前基线：**v2.0.6 → `d2a3e0925175376746170e2597c6fa675d2fa43d`**（用户于 2026-11-11 要求变基；下方 v2.0.5 记录是历史实施证据）。

日期：2026-11-11。**A/B/C 代码已实现并在验证；真机与真实供源/ntfy 门槛尚未通过，D 未完成。** 本文件记录工程进度，不替代唯一任务书或冻结规范。

## 基线与隔离

- 实现工作树：`/home/quant/repos/market-watch-android-personal-v205`。
- 分支：`feat/android-personal-v205`；应用基线：`1bb935bdf1195c4da532cb2e6f62faca2198e6c4`（v2.0.5）。
- 文档源：`89d10fe3fcbc71380b12af3dc21aefdcd756758b`；只导入约定 docs 路径并单独提交。
- 风险 F1（新增本机持久格式、SW 更新和原生外壳），见 [Issue 草案](issue-draft.md)。B 新增兼容只读 API；没有 schema 改动。
- 未合并、未推送或创建 PR、未打正式 tag、未生产发布。未访问 Unraid，未修改其他任务工作树、数据库或实例。

## 本次真实代码

1. Vite 多入口中的独立 `/m/` 页面；Nginx `/m` 规范跳转、手机深链接及 SW 路由。保留桌面入口。
2. 真实会话/CSRF、当前服务器已存在组合目录和单图选择；五项导航容器。自选、完整数据/更多和告警仍明确为后续阶段，不冒充已交付功能。
3. 共享 widget/datafeed/marketRuntime 的明确 mobile 模式；真实 getStudiesList、原生指标选择器/参数、副图、原生触屏 tracking 十字线。无预览数据、模拟图层或固定 12 项目录。
4. 单份实际 captureChartLayout 序列化结果在 IDB 原子替换；300ms 防抖、实际变化、失活 flush；参数窗口未完成时不写布局。手机设置适配不经过服务器偏好、工作区、最近桌面状态或通用草稿。
5. IDB 以 origin/subject/schema 隔离，缓存真实读取页及读取时间。明确 401 卸载图表；离线只读上次内容。退出清理内容；浏览器离线无法确认服务端会话撤销时，本机 signed-out 标记阻止自动复用遗留 HttpOnly cookie，原生壳另清 Cookie。
6. Vite manifest 生成最小 SW 壳，作用域仅 `/m/`；不缓存 API、SSE、许可库或 K 线。壳固定对应的 chart-assets 清单；输入/本机写入未完成时不刷新，安装不完整保留旧壳。
7. 共享 providerSubscriptions 的可选 open/message/显式 heartbeat/error 观察钩子，无新增连接。手机头部/自选统一 transport 的接入仍属于 B。
8. 新 Kotlin 工程：可信 HTTPS 来源、主框架 WebMessageListener v1、外链交浏览器、返回/键盘、旋转保留 WebView、release 关闭调试。仅源代码和固定 Gradle wrapper；尚未编译或真机验证。

## 已运行证据与边界

- [完整前端构建](build-a.log)：TypeScript、Vite、固定许可库 patch/build、mobile shell 生成成功。
- [IDB 定向检查](cache-a.log)：身份/schema 隔离、失败事务保留上一份、图表局部重置、按服务器退出清理、离线退出标记。
- [Transport 定向检查](transport-a.log)：真实 open/message/heartbeat/error 分开记录、重开不沿用旧心跳、共享连接和迟到事件关闭。
- [既有单前端 unit 回归](desktop-unit-a.log)：`npm run test:single-frontend -- --unit` 通过。另运行 advanced-watchlists、advanced-native-workspaces、advanced-preferences-conflict、advanced-provider-subscriptions，均通过。
- 桌面实际库：`advanced-native-indicator-categories.browser.cjs` 通过，包含项目 SMA 注册、搜索/分类/收藏、添加、原生设置返回及尺寸/主题检查；使用受控行情。
- [手机实际库浏览器记录](browser-a.json)：真实构建页面与许可 widget，**API 为受控测试替身**；107 项是该测试空项目 catalog 下的实际内置目录，不能当作真实服务器项目指标目录已验收。包括真实参数取消/副图/十字线、本地恢复、20 次切换单实例、375/412/横屏与 150% 字号、SW 离线重载/更新/安装失败、401 清理及禁止服务器布局/偏好写入。
- `sh -n mobile/client/gradlew`、`git diff --check` 通过。JDK 为 17。

真实发现并修复：手机不启用 header 时不能继续调用桌面 headerReady 相关 UI；隐藏 watchlist 后原生搜索页脚模块未预载，导致指标选择器回退。现在只在缺少模块时加载固定版本 compare-dialog chunk，并在浏览器中断言没有进入回退窗口。测试专用临时诊断已移除。

## 环境与未验门槛

- 本机根分区最初约 797 MiB 可用，创建约定 worktree 后约 149–223 MiB；不满足 SDK/APK/Docker 构建预算，已报告用户协调。未清理其他任务。
- npm 依赖、构建 staging/dist 暂置任务独立 `/dev/shm/mw-android-personal-v205-*`，不作为持久交付。重启后正常重新安装/构建。可执行 esbuild 临时复制在 gitignored `.tools/`；未借用其他任务依赖或可写 DB。
- 许可库本机只读使用既有安装：`/home/quant/repos/market-watch-dev/advanced-host/charting_library`。与基线 manifest 的差异只有两份已有受支持 patch 的 bundle；本次构建验证既有 native hooks/toolbar lifetime，未修改安装目录、未提交或发布库文件。
- 没有 Android SDK、adb 或已连接设备；没有运行 Gradle assemble/lint，**没有 APK**。工具链版本见 [外壳说明](../../../mobile/client/README.md)。
- 没有启动本任务 Ubuntu Compose project，故没有本任务真实验收地址。浏览器测试使用临时 loopback HTTP fixture（结束即停止），不是 Ubuntu 后端隔离部署或设备 HTTPS 验收。
- Find X8 系统/ColorOS/WebView、真实后端及完整项目指标、HTTPS Cookie/CSRF、返回/旋转/进程回收、设备 SW/IDB、冷启动/首图/重连耗时、覆盖升级、ntfy 实收均未验。
- 缺少上述证据，不能关闭 A 门槛或标目标完成。可继续不依赖这些资源的 B/C 代码，但不能用受控浏览器结果替代真实链路验收。

## 下一步

1. 资源满足后按任务书和 AGENTS 创建本任务独立 Ubuntu R1（建议 project/task `mw-android-personal-v205`），提供可信 HTTPS；不复用其他任务可写数据。
2. 安装 SDK 35/ADB，执行 `mobile/client/gradlew :app:assembleDebug :app:lintDebug`；Find X8 核对 A 阶段清单，记录设备版本与真实图表/离线/返回证据。
3. 按 B 实施完整共享自选及 revision/active 隔离、真实数据页面、只读有界 sparklines API、应用级行情 transport；再按 C 复用告警/通知。保持 A06 与 v2.0.5 来源能力边界。
4. 完成 D 桌面/真机/生命周期回归、独立 review、签名 APK 与交付记录后再更新完成审计。不合并、不生产发布。

## B 推进及环境更新（2026-11-11 07:25 UTC）

上述 A 阶段原始环境记录保留作为历史事实，当前状态如下：

- 磁盘已恢复充足余量（未由本任务清理其他资源）。本任务独立 SDK35/platform-tools/build-tools 已安装；Gradle 8.11.1 官方 distribution 经固定 SHA-256 校验后执行。`assembleDebug` 和 `lintDebug` 成功，见 [Android 构建日志](android-build-a.log)。lint 0 errors / 12 warnings，没有基线抑制。
- Debug APK 真实存在：`.artifacts/android-personal-v205/market-watch-0.1.0-debug.apk`，SHA-256 `8572c9e3f468507e9e97f33239e1fb5c2d0459b86f466974907868928454d548`；APK v2 签名校验通过。Debug 签名证书 SHA-256 `ca8ee3bd68d2aa412119ea53b15f5393b3a2a9e57aea30f68f2e25b450e9fd33`。这是早期阶段候选，不是完整交付。
- 用户明确选择可以自行 Find X8 验收，无需先接 ADB。当前 `adb devices` 无设备，真机结果仍未获得。未据此关闭真机门槛。
- `192.168.7.232` 确认为本机 IP。18443 是既有 `mw-dev`，本任务未改动它。新建 task/project **mw-android-personal-v205**，独立 PostgreSQL14.24、API、Web、TLS、network、volume、凭据，地址 **https://192.168.7.232:18445**。操作入口：

  ```sh
  python3 deploy/ubuntu/mw_docker.py preview status --task mw-android-personal-v205 --project mw-android-personal-v205
  python3 deploy/ubuntu/mw_docker.py preview up --task mw-android-personal-v205 --project mw-android-personal-v205
  python3 deploy/ubuntu/mw_docker.py preview stop --task mw-android-personal-v205 --project mw-android-personal-v205
  ```

- 镜像通过 `mw-docker build` 构建；web 须显式 `--context . --file web/Dockerfile`，避免本机旧安装工具默认 web context。许可库已复制为本任务自己的 gitignored 安装，既有源安装保持不变。
- LAN/TLS 适配只改任务私有 preview 配置，见 [脚本](configure-lan.py)；独立开发 CA 公共证书仅加入 Debug 对此 IP 的信任，私钥不提交，release 不包含。4 个服务 healthy，CA 验证的 HTTPS `/readyz`、真实 Cookie/CSRF 登录、`/m/` 及 sparkline API 已通过。**后端使用固定合成 D1 seed，禁出网；不是供应商真实行情或告警通知证据。**
- B 后端：`POST /api/market-data/sparklines` 已实现。只读现有 provider/managed/history/composite，NY17/DST/UTC0、单一日内周期、1600点、缺口、空窗口、身份/account/revision、现有 managed 有效性、历史校验和组合展示观测。避开 ensure/datafeed/访问时间写入/display快照租约；不增加 demand/任务。
- [后端回归](backend-b.log) 106 项通过；小图专项 14 项，覆盖 SQL 只读观察、全表计数无增长、cold/warm 查询预算、网络禁止、DST、缺口与四类身份。最近补充参考线响应字段后需再跑专项/回归。
- B 前端仍在实施：共享自选控制器（保留最新 desktop active/未知字段、409停止）、应用级单行情 client、可见行报价、小图最多两请求/20项/迟到取消/60s/后台停止、真实数据目录与详情。新控制器专项已通过；完整页面浏览器测试仍在补充，不能宣称 B 完成。
- 部署镜像是已构建阶段快照，最新 B 前端和补充后端改动尚未全部重建进实例。交付前必须重新构建、更新和验收，不能以现地址 ready 代表最新源码已部署。


## B/C 代码与浏览器验证更新（2026-11-11）

- 自选：共享原格式、最新 active/未知字段保留、409 停止并保留输入；手机分组、组内和分组排序、移除/撤销；可见行报价、固定窗口断线小图、单一行情 client/SSE，后台暂停。数据页提供分页/迟到丢弃、详情/真实周期/修订、固定版本开图、目标分组添加、任务/维护/来源只读。更多提供连接、ntfy 脱敏状态、记录/主题/外壳版本。
- 告警：组合固定价格创建/编辑，按 price_modes 逐模式核验；新建 association=null、修订绑定；既有规则保留 association/几何。旧来源不开放创建或编辑。复用 useAlertData 的版本屏障；重复点击门闩、未知创建复用同一 request_id/config、未知编辑全配置及版本核查、409 保留输入，生命周期带 version/control_revision/request_id。
- 规则按 execution 呈现准备/监控/结算/缺口等事实，并结合 health 的 worker 状态；触发、异常/恢复、系统记录分开，确认走原有 ack/handled。手机实收始终独立待验，不将服务端接受当送达。
- 通知复用原 NoticeRuntime/NoticeStore。通过可选连接接入手机同一 mw-mobile IndexedDB；v1→v2 仅增加通知 object stores，原布局/缓存保留。新增事件提示按 ID 持久去重，关闭不标处理；后台暂停同步。桌面默认 store/runtime 行为保留。
- 完整构建、手机缓存迁移/清理、watchlists/sparklines/alerts 定向检查通过；[自选浏览器](browser-watch-c.json)和[告警浏览器](browser-alerts-c.json)使用真实构建页面与明确 HTTP 测试替身。A 实际许可 widget 浏览器重跑通过，见 [记录](browser-app-c.json)。这些都不是 Find X8 或真实供应商验收。
- 实际修复：测试服务器以 res.close 统计 SSE 后证实单连接；Window 上返回事件按注册顺序执行，应用层先让已打开的手机 dialog 处理，避免父页面抢先回首页；通知去重写入与游标刷新交错曾导致“已记见但没弹”，现串行处理提示登记。
- 服务器基线 health 不提供应用版本标识，更多如实显示“服务器未提供版本标识”；网页构建 hash 和 APK/WebView 版本使用实际值。完整告警记录分页/判断证据展示、真实后端多类样本和所有设备检查仍需核验。
- 此刻 18445 仍是早期镜像，尚未更新本段 B/C；独立 Standards/Spec review 和最新镜像重建待做。不因页面已接通而关闭阶段门槛。


## 独立审查收尾与 0.1.1 候选（当前状态）

- 上述“没有 APK/未部署 B/C/审查待做”属于此前阶段记录。当前 A/B/C 已实现，B/C 已部署过一次；本次审查修复正在更新同一任务实例，部署结果见候选说明。
- [独立 Standards/Spec 审查](review.md) 发现会话/缓存迟到、原生连接恢复、SSE 断线灰色、详情刷新和滚动记忆问题，已修复并复核关闭。修复引入的 busy 与 TLS 握手遗漏也已补齐。
- 追加验证：profile generation 跨退出/重新登录、延迟登录被 online 刷新取消后可重试、换服务器后晚到登录不激活；自选断线→新快照对齐及滚动重载；打开规则详情后台更新。浏览器仍是明确 HTTP doubles，实际许可 widget 的 A 回归通过。
- 本次完整前端构建、既有单前端 unit、共享通知 unit、Android assembleDebug/lintDebug 通过。新 APK 0.1.1/versionCode2 与 0.1.0 同签名；本次实际升级和故障入口待 Find X8 检查。
- 实例使用固定 D1 合成缓存，已通过真实登录/CSRF API 新建独立“D1 合成数据 · 非实时”自选，便于安装后进入实际图表；未启用供应商或投递。不会把旧日期缓存、任务健康或 UI 创建成功当作实时链路验收。
- 用户可自行验收，无需先接 ADB。全部真机事实仍等待用户反馈，目标仍 active；没有合并、正式 tag 或生产发布。


0.1.1 候选已更新至 Ubuntu 18445，四服务 ready。真实 API/PostgreSQL/实际许可库 smoke 通过；CA 校验的 APK 下载 hash 与本机一致。见 [候选及自验说明](candidate-0.1.1.md)、[部署记录](deployment-0.1.1.json) 和 [下载检查](delivery-check-0.1.1.md)。Find X8、真实供应商/完整告警与 ntfy、覆盖升级仍待验证。
