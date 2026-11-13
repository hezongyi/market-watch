# Market Watch 个人安卓应用实施方案（v2.0.5 / A06 收口版）

日期：2026-11-11。用户已基本认可 A06 UI，并授权本轮收口方案。**本轮交付文档，不开始 App 开发、构建 APK、启动实例或发布生产。** 下文执行指令供后续获授权的实施 agent 使用。

本文件是唯一实施任务书；[UI 冻结规范](android-ui-freeze-a02-20261111.md) 是唯一界面规范；[基线接口核对](research/android-v205-contract-audit-20261111.md) 保存代码证据。历史讨论由 Git 历史保留，不继续维护互相覆盖的版本条款。

## 1. 固定基线和设计依据

| 项目 | 固定值 |
| --- | --- |
| 应用实现基线 | `v2.0.5`，commit `1bb935bdf1195c4da532cb2e6f62faca2198e6c4` |
| 标签对象 | `36a433a3fd7d6ddef65bb270e7f0899121039e2d`；本地与 origin 标签解引用一致 |
| 设计版本 | A06，预览源码 commit `2a548a90e62e03f6bd8a69aef803729d8f8e6bcf` |
| 不变预览入口 | https://pages.kookvv.com:8443/versions/market-watch-android-ui-preview/20261111T052506-b224aebfd7/ |
| 当前预览入口 | https://pages.kookvv.com:8443/sites/market-watch-android-ui-preview/ |
| 预览源码目录 | `docs/prototypes/android-a-freeze-20261111/`，仅为设计依据 |
| 目标设备 | OPPO Find X8；实施时记录真实 Android / ColorOS / WebView 版本 |
| 本轮文档工作树 | `/home/quant/repos/market-watch-android-ui-preview`，`prototype/android-ui-20261111` |

实现分支从上述 v2.0.5 SHA 新建，不从旧预览分支的应用代码起步，不合入其他 agent 的未合并代码。更新基线必须记录新的准确 SHA 与影响，不能把 `origin/main` 浮动状态冒充本方案基线。

## 2. 产品范围与技术路线

采用现有 **React / TypeScript / Vite + Kotlin WebView 外壳 + Market Watch 后端**。同源 `/m/` 为手机专用入口；手机浏览器和 APK 使用同一套页面。服务器采集行情、聚合、执行告警和投递 ntfy，手机只展示及发出日常业务操作。

- 固定五项导航：**自选 → 图表 → 告警 → 数据 → 更多**，自选为首页。
- 自选：共享已有列表，搜索、添加/移除、分组增删改、排序、撤销；当前分组与滚动位置仅存手机。
- 图表：真实单图、横竖屏、缩放、供应商/系列实际支持的九周期、完整实际注册指标目录、原生参数与十字线。本地一份设置自动记忆。
- 告警：固定价格规则的创建/编辑/暂停/恢复/归档、状态、结果和确认；其他现有规则查看，不增加复杂画线或指标组合编辑。
- 数据：平台/自建/组合的列表、筛选、中文描述、详情、实际周期、开图、加入自选、维护和来源状态查看。固定历史版本可从相应详情打开，不另加第六导航。
- 更多：连接、ntfy 后台通知说明和状态、记录、主题、版本、退出与换服务器。手机布局入口及重复“数据”入口移除。

六源目录和周期沿用 v2.0.5 已实现的边界；九周期为 M1、M5、M15、M30、H1、H4、D1、W1、MN。手机不直接请求供应商，不扩市场、不补目录任务。批量补齐、自建/组合创建维护、凭据和数据库管理继续在桌面操作。首期沿用 ntfy，不新增 App 后台推送服务、保活服务、离线写入队列或应用商店/自动升级系统。

## 3. v2.0.5 已确认的契约及必要适配

表中 `/api/...` 为实际 HTTP 路径，同栏简写沿用其前缀；`web/src/api.ts` 的调用参数需去掉 `/api` 前缀。请求保持 Cookie、CSRF、已有 revision、request_id 及原错误码。

| 页面/能力 | 现有入口 | 实施动作 |
| --- | --- | --- |
| 会话 | `/api/login`、`/api/session`、`/api/logout` | 复用；`subject=admin`，不新增账户系统 |
| 共享自选 | `/api/advanced-charts/preferences`、`/preferences/save`，`setting / mw.watchlists.v1` | 手机控制器复用现有 lists 格式及 revision，保存保留服务器 active |
| 目录和详情 | `/api/market-data/series/page`、`/resolve`、`/center/datasets`、`/center/datasets/{id}`、`/composites/{id}` | 搜索分页；保留 ticker/类型/修订；复用现有详情契约 |
| 来源/维护 | `/api/market-data/sources`、`/catalog/directory-status`、`/live/status`、`/live/provider-status`、`/datasets/{id}/maintenance`、`/center/tasks` | 按页按需读取，不把目录完整当行情完整 |
| 最新报价 | `POST /api/market-data/quotes` | symbols 为规范 ticker，单次现有上限 100；沿用价格/涨跌幅和 freshness 事实 |
| 图表历史 | `/api/charts/data`、history-capabilities / history-loads 及现有 market runtime | 复用正常 datafeed、历史加载与错误处理，不复制采集逻辑 |
| 行情增量 | `/api/charts/stream/subscribe`、`/unsubscribe`、`/events?client=...`、`/accept` | 复用 providerSubscriptions；同一页面共享 transport |
| 价格告警 | `/api/chart-alerts/capabilities`、列表/详情、创建、`/{id}/edit`、`/{id}/lifecycle` | 完整按真实 capabilities；见第 7 节 |
| 触发记录 | `/api/chart-alerts/events` | 触发价格、检测时间、通知关联和投递状态使用返回字段 |
| 系统/异常/恢复记录 | `/api/notification-center/events`、详情/timeline、changes、stream、observations | 复用通知中心，按事件 ID/游标去重；不要把触发列表当全部异常记录 |
| 健康/通知配置 | `/api/health`；现有通知配置读取 | 使用脱敏健康/配置状态，不缓存 topic/token 等配置值 |

### 三项必须新增或调整的能力

1. **手机本地单图适配。** 当前 workspace runtime 和 nativeWorkspaces 默认写服务器，coarse pointer 还有限制。新增明确 mobile 入口模式及本地布局适配，复用 widget/datafeed/序列化，关闭手机路径的服务器布局、最近桌面工作区和通用设置写入。桌面入口行为保持原契约。
2. **SSE 观察信息。** 后端行情流有可见的 `heartbeat` 事件，当前 providerSubscriptions 的 Stream 类型及回调未提供标题所需的最近心跳时间。扩展共享 transport 的可选状态观察接口，记录真实 open/message/heartbeat/error，供手机头部读取；不能另开一条只用于头部的连接，也不能拿 `/api/events` 注释心跳更新时间。
3. **轻量 sparkline 读取。** 现有 `/market-data/history/cache` 仅支持 managed；`/charts/data` 的 provider 通路可能请求上游，不能直接当全自选的小图缓存接口。增加一个有界、只读缓存的 `POST /api/market-data/sparklines`，契约见第 6 节。无新表、无采集任务、无日历管理；浏览自选不触发完整历史下载。

其余后端默认复用。新增接口和兼容字段按实际 F0/F1 分类，不能用“只做 UI”跳过必要验证；也不顺带改告警执行引擎。

## 4. 本地数据和状态所有权

采用 **IndexedDB 一种业务本地存储**。首期不加入 SQLite、Room 或原生数据桥；Kotlin 私有设置只保留服务器地址等外壳必要配置，登录仍由 WebView Cookie 管理。

| 内容 | 权威位置 | 手机本地处理 |
| --- | --- | --- |
| 自选及分组内容、规则、事件、维护状态 | 服务器 | 保存最后成功快照和读取时间；共享写操作经服务器确认 |
| 自选活动分组、滚动位置、主题 | 手机 | 自动记忆；分组被删除时退回“全部” |
| 单图布局、系列、周期、实际指标参数及必要显示配置 | 手机 | 一份原生序列化结果，原子替换最后成功版本 |
| 报价、小图、最近使用的目录页 | 服务器事实的副本 | 缓存当前自选和实际访问页；仅保留当前小图窗口，不复制整个目录/历史 |
| 告警表单、密码、未提交输入、SSE 连接状态 | 当前会话内存 | 不跨重新进入恢复；缓存不能声称已登录/已连接/已监控 |

本地业务记录以 `serverOrigin + subject + schemaVersion` 隔离，系列键必须包含真实 kind/id/必要 revision。`subject` 从实际登录或 session 返回，离线只允许使用此前成功验证并记住的同一 profile。当前单管理员场景无需引入用户管理或 token 哈希作缓存身份。

打开先显示上次快照，标明上次状态；后台核验会话、刷新及订阅。网络不可达时可继续只读缓存；明确 401 则进入登录并停止写入/订阅，不能用旧 Cookie 或快照绕过认证。退出、换服务器清理本机业务缓存与图表偏好、关闭连接并清除旧会话；离线退出仍先清除本机凭据和内容，服务端会话撤销是否成功据实处理。

共享自选保存必须保留最新服务器 `active` 和未知的兼容字段；以读入的内容为基线检测列表是否发生冲突，使用最新 revision 进行条件写。409 停止，不自动合并用户操作或循环覆盖。手机切分组不写共享 active。撤销也是正常服务器写入，失败要显示未完成。

有效图表操作在短防抖后序列化并写 IDB（初值 300ms）；onAutoSaveNeeded/实际变化事件及页面失活尽早 flush，不能只靠 unload。快速退出或被强杀只承诺恢复最后成功提交的本地快照。写入失败保留上一份完整状态，浮窗说明当前更改未记住；不制造草稿列表或保存按钮。取消的参数表单不进入布局。损坏/不兼容文档只重置手机图表设置并说明，不清空其他缓存。

## 5. 最小离线页面壳与更新

继续使用可信同源 HTTPS 的 `/m/`，`/m` 规范跳转至 `/m/`。使用一个作用域限定 `/m/` 的 Service Worker，缓存手机入口 HTML 及其必要 JS/CSS/图标的构建清单，使**成功在线打开过一次后**，断网冷启动仍能打开手机页面并读取 IDB。

- Service Worker 文件放 `/m/sw.js`；同源可缓存手机入口所依赖的根目录 hash 资源，不能拦截桌面页面导航。所需构建清单由 Vite 输出生成，不手写易过期文件列表。
- 不拦截/缓存 `/api/*`、登录响应、通知流、凭据、ntfy 配置、许可图表库或全部 K 线。专业图表离线冷启动与完整历史离线浏览不属于首期承诺；无图表资源时保留已缓存列表和可读状态。
- 完整安装新壳后才替换旧壳；安装失败保留上一份。无未提交输入且图表本地写入完成时可重载新版本；有输入时只提示有更新，避免强制刷新。使用当前壳版本的 chart-assets 清单，不混装新旧 runtime/库。
- 不从线上网页任意下载原生代码。消息协议只处理必要返回/窗口行为，带版本号；不兼容时明确提示更新 APK，不能静默执行。
- A 阶段必须在 Find X8 的实际 WebView 验证 SW/IDB/离线导航和在线更新。若目标 WebView 无法满足，记录具体失败并重新评估页面壳方案；不能将浏览器 HTTP cache 成功当作该项通过。

这是离线**读取**和单份图表偏好，不含离线业务提交、后台同步队列。网络恢复重新从服务器对齐；本地缓存不是第二个业务数据库。

## 6. 自选报价、sparkline 与 SSE

### 固定显示规则

- 外汇/黄金：America/New_York 当地 17:00 至次日 17:00；其余含未知类型：UTC 00:00 至次日 00:00。
- 从已有明确资产元数据选择两类，不按代码字符串猜国家/交易日历；组合沿用其明确定义的资产类型，未知即 UTC0。图形窗口不改变服务器日 K、交易日、涨跌幅口径。
- NY17 按相邻当地日期换算，覆盖 23/25 小时 DST 窗口。欧/美参考线分别为伦敦当地 08:00、纽约当地 08:00，不标文字，仅外汇/黄金显示。
- 横轴固定全窗口，未来留白、缺口断线、不压缩休市、不补造价格；当前窗口无数据保持空图，不拿上一天续上。无底部短竖线。
- 固定布局占满品种与价格列之间空间；小屏/放大字按 UI 规范，不能按已有数据跨度自动拉宽曲线。

### 新的小图接口（计划新增，基线尚无此路由）

请求：`POST /api/market-data/sparklines`，`{items: [{ticker, composite_revision_id?}]}`；单次最多 20 个真实系列。服务端用自身当前时间与标准时区确定固定窗口，不接受任意历史区间。响应包含 `as_of` 及逐项 `ticker / revision / window_start / window_end / timeframe / points / status / last_data_at`；时间统一 epoch 毫秒，价格遵循现有精度序列化。`points` 为按时间排序的 `{time, price, gap_before}`，`time` 是实际日内时间，不用 D/W/M 显示日期标签；`status` 为 ready/partial/empty/unavailable，附可读原因，缺口和不足窗口不写成完整。单项失败不抹掉其他项。

- 只读取本机已存在的 provider 缓存、managed 有效行情、固定历史/组合已可读取的数据；不注册系列、不创建组合、不增加下载或指标需求。可复用现有只读 helper；若 helper 会隐式注册/发需求，抽出最小查询部分，不能调用有副作用的整段 datafeed。
- 在当前窗口已有的日内周期中，优先 M1，其次 M5/M15/M30/H1；只读取一种，单项最多 1600 点。该上限容纳 25 小时 M1。无日内数据则返回 empty/unavailable，报价和开图正常；D1/W1/MN 不伪造分时曲线。
- 返回有序时间点及缺口边界，保留服务器已有有效性语义；前端按周期相邻性断线，不穿过未知区间。只抽稀绘制密度，不压缩时间、不跨缺口连接。
- 前端先缓存、后后台读取；只处理可见行及少量预取，同页最多 2 个小图请求并发。同一窗口请求合并；离屏/切分组取消或丢弃旧响应。窗口切换立即停止显示旧日曲线。
- 小图初次和每次回前台更新，可见自选页最多每 60 秒刷新一次；行情增量提供可信点时可补入当前尾部，不为每行再建 bars 订阅。后台和离开自选页停止小图计时器。
- 验证 cold cache / warm cache 的 DB 查询及任务数量，小图读取前后采集/历史任务和 indicator demand 不增长。该接口缺缓存只说明本地当前可用性，不宣称供应商不支持该品种。

SSE 头部使用同一行情 transport 的真实事件/显式 heartbeat 最近接收时间；初始无活跃订阅时不展示“已连接”。open 仅说明通道打开，消息/心跳时间独立记录；error/重连/后台暂停如实显示，重开不恢复旧“已连接”。不得以本地定时器更新时间冒充通信。

手机应用级使用一个行情 client/transport，真实图表和可见自选共享；通知中心仍使用自己的既有记录同步机制，不为此合并后端协议。

行情新鲜度来自每行 source/received/as_of/fetch_status 等真实字段；SSE 正常也可能有单行灰色。重新连上先对齐快照及 generation/sequence，再解除相应灰色。快照迟到不能覆盖较新的流数据。

## 7. 告警与通知的实际边界

**v2.0.5 新建和编辑告警仅支持 composite，旧 provider/managed 规则只可查看、暂停、归档。** 固定历史不能建实时规则。手机按 capabilities 和 composite price_modes 决定触价/收盘能否启用，固定价格模式应读取对应 `price_modes[mode]`，不能用旧通用 `available` 字段一概替代。不能为了让按钮可点而另建兼容执行路径或自动换成同名组合。

新建固定价格规则的 `association` 为空，绑定真实组合及后端要求的修订。`validate_association` 已允许不关联 workspace；不为手机创建服务器布局或编造 workspace/chart UUID。编辑既有带关联的规则保留原关联与真实几何/配置；不能因手机本地布局不同清除旧关联。能力/关联不满足时只读说明。

- 规则状态使用 `status + execution`，包括 preparing、monitoring、closed、recovering、blocked、settling、expired/settled、paused、archived、completed；不压缩成“启用=监控中”。列表主标签依照后端 label/message，休市不是故障，结算中不能写成已完成。
- 接管与进展读取 `taken_over_at / last_checked_at / last_evaluated_at / last_input_at / expected_input_at / position`；缺口和事件读取 `last_gap / incident / notification`。展示监控整体健康时同时读取 `/api/health.chart_alerts`，避免 worker 已失联仍沿用旧绿色状态。未知/过期标待确认，不由手机复制 watchdog 判定。
- 触价与收盘分别遵循真实输入/补判契约，不承诺断线期间的所有价格路径可重建；按服务端结果显示无法判定区间和人工处理原因。
- 创建同一次请求保留相同 `request_id` 防重复；生命周期操作使用 request_id/version/control_revision；编辑使用 version。超时可能已提交，先用原请求或重读确认结果，不创建第二个 ID 盲重试。编辑重读发现 version 已变化时不能自动覆盖。
- ntfy 配置用 health 和 `execution.phone_configuration`；服务接收、手机送达、用户确认分开。App 关闭不停止服务器监控；ntfy 自身的锁屏/后台设置在真机单独验证。
- 触发详情来自 chart-alert events；异常/恢复通过通知中心的 alerts audience 及执行事件呈现。确认分别复用现有 notification ack 或 notice handled 操作；关闭浮窗只消除展示，不写成已处理。
- 同一事件按服务端 ID 和游标去重。重连不重复弹，进入时可汇总未处理项一次；底部角标/列表始终可查。复用现有通知 runtime/store，不另写独立事件总线、投递队列或声音策略。
- 前台进入/提交后刷新规则及健康；告警页可见时采用单一低频刷新（初值 15 秒），记录增量仍复用通知中心。后台暂停，回前台重新核验。价格检测始终在服务端。

## 8. 实施顺序和文件落点

每阶段结束交付可核验结果；A 是技术验证门槛，不用静态预览的假图或模拟状态替代。以下新文件均为计划位置，按现有模块边界适当合并，避免制造空框架。

| 阶段 | 工作及主要文件 | 完成条件 |
| --- | --- | --- |
| A：最小真机链路 | 新 `web/src/mobile/MobileApp.tsx`、`MobileChart.tsx`、`cache.ts`；改 main/navigation；mobile 模式的 chart adapter/本地存储；`web/public/m/sw.js` 或构建生成器；新 `mobile/client/` Kotlin 工程 | v2.0.5 登录、真实组合单图、完整实际指标/参数、副图、十字线、IDB 布局、断网冷启动、返回/旋转；Find X8 实测 |
| B：日常看盘 | `web/src/mobile/` 自选/数据/更多/搜索和样式；共享 preferences/revision 逻辑；新增 `backend/alerts/sparkline_api.py`、`sparklines.py` 及 api router 注册；共享 providerSubscriptions 的观察钩子 | 五项导航按 A06；真实目录/身份/周期；自选共享但 active 隔离；小图无下载副作用，SSE 真实；缓存与失败分支可用 |
| C：告警与记录 | 复用 chartAlertUiApi/业务校验、通知 runtime/store，手机容器适配 | 实际可用组合触价/收盘完整闭环，旧来源只读/停用/归档；异常/结算/未知状态和通知证据正确 |
| D：交付与回归 | 新 `web/tests/mobile-app.browser.cjs` 及必要缓存/小图测试、`docs/verification/android-personal/`、签名 APK | 真机、桌面回归、覆盖升级；APK/hash/源码版本/测试记录/使用说明齐全 |

`advanced-host/chart-runtime.js` 只加明确手机模式下的适配分支或必要小模块；继续复用 `viewports.js`、indicator-picker/native-ui 和 datafeed。序列化使用实际 widget.save/captureChartLayout 能力，加载使用实际支持的原生恢复接口。不可复制整个桌面页面、全局关闭 mobile 检查，或把 12 项 preview catalog/覆盖式十字线带入产品。

全量专业图表指标指运行时 getStudiesList 及已注册项目指标，不包含外部社区/Pine 市场。不得用后端有限的告警指标 catalog 当图表完整目录。A 阶段逐项确认组件对触屏十字线、原生参数弹层、副图的支持；无法支持冻结入口时提交真实组件适配证据再调整，不静默删功能或仿造原生能力。

原生壳：可信 HTTPS origin 白名单、外链交浏览器、禁明文/忽略 TLS/文件读取、release 关闭调试。仅在确有必要时加来源限定主框架消息接口；返回顺序为键盘→最上层弹层→详情→一级页→退出，未提交输入先提供继续/放弃。横屏/旋转保留状态，进程回收恢复最后成功本地设置。SDK 和 AndroidX WebView 工具链实施时核定；稳定 applicationId、私有签名、递增 versionCode，密钥和凭据不入库。

## 9. 工作树、验证命令与环境

本轮未运行以下实现命令。后续先读取 v2.0.5 的 AGENTS.md，并只读检查其他任务、端口、磁盘和内存。

```bash
git -C /home/quant/repos/market-watch rev-parse 'v2.0.5^{commit}'
git -C /home/quant/repos/market-watch worktree list
git -C /home/quant/repos/market-watch worktree add \
  -b feat/android-personal-v205 \
  /home/quant/repos/market-watch-android-personal-v205 \
  1bb935bdf1195c4da532cb2e6f62faca2198e6c4
```

将本收口文档、UI 规范和预览资产从文档交付 commit 带入实现树（仅 docs 路径）；不要 cherry-pick 整个预览分支。记录实际文档 SHA 后再开发。若名称已占用，保留原工作树，选择明确的新任务名。

Web 验证按触及范围运行；以下现有脚本已在 v2.0.5 树中核对，新 mobile 测试需实现后再执行：

```bash
cd web
npm ci
# 先按仓库根目录 scripts/install-advanced-library.py 的说明准备本机许可库，不提交库文件。
npm run build
npm run test:single-frontend
node tests/advanced-watchlists.cjs
node tests/advanced-native-workspaces.cjs
node tests/advanced-preferences-conflict.cjs
node tests/advanced-provider-subscriptions.cjs
node tests/mobile-app.browser.cjs
```

新增小图测试必须验证：四类系列不串、日期/DST、缺口/空窗口、批量上限、取消迟到响应，以及**无上游网络/新采集或历史任务**。复用现有后端 pytest 配置，在项目实际 Python 环境执行相关 `test_chart_alert_api.py`、`test_price_alert_execution.py`、`test_price_alert_reliability.py`、`test_market_stream_api.py`；新增接口测试放 `backend/tests/test_sparklines.py`。未修改的引擎无需为 Android 再建一套测试模型。

Android 工程建立后执行 `./gradlew :app:assembleDebug :app:lintDebug`；发行签名使用私有文件。真机测试记录 APK 与源码 SHA、系统/WebView 版本。

Ubuntu 隔离实例按 AGENTS.md / `deploy/ubuntu/README.md` 和 mw-docker 创建，建议 task/project `mw-android-personal-v205`，独立数据库/volume/网络/端口，不复用其他任务可写库。先盘点预算再启动；开发与验收不能移到 Unraid。真实告警验证需运行实际 market/chart-alert/notify 等所属角色，不能用 API-only smoke 代替。给真机提供可信 HTTPS 的私网或 USB 转发地址，debug CA 仅 debug variant，不在 release 绕过证书校验。

## 10. 验收与停止条件

- UI：五项导航、层级和状态符合冻结规范；375/412 宽度、Find X8、横屏、150% 字体、深浅色、键盘/安全区、返回均可操作，无原型审阅按钮。
- 数据：真实 provider/managed/history/composite 样本、同名多源和修订不混淆，实际周期可选；缓存与最新状态区分；空目录和读取失败区分。
- 本地：重开恢复一份真实图表配置；断网冷启动显示上次列表；退出/换服务器清理正确；无跨重进草稿、无服务器手机布局或桌面最近状态写入。
- 并发/网络：重复提交、409、请求结果未知、断网恢复、服务重启、快切品种的迟到响应和进程回收都有可用结果；失败表单保留当前会话输入，关闭通知后仍有尚未保存标记。
- 图表：实际完整注册目录、主/副图及参数恢复；真实触屏十字线可用；看盘数据使用已有 feed，不伪造本地价格计算。
- 告警：可用组合新建→接管→判定→事件→ntfy 服务投递→用户确认；休市、恢复、blocked、结算和 worker 不可确认状态据实。真机锁屏实际收到 ntfy 单独记证据，不能用服务端 accepted 替代。
- 资源：主入口切换 20 次无 widget/订阅持续增长；自选可见行请求有界，sparkline 不触发历史任务；记录实际冷启动、首图、切品种和重连耗时，A 阶段据 Find X8/同设备 Chrome 建立预算，不凭空指定 SLA。
- 更新：同签名覆盖升级保留登录和手机选择；网页更新不清数据即可加载，无旧壳/新图表资产错配；不兼容原生消息版本有明确结果。

交付 APK、SHA-256、签名指纹、applicationId/versionCode、源码 SHA、环境及真机记录、安装/升级/已知限制说明。可形成 Draft PR；不能把模拟窄屏、静态预览、接口存在等同于实际验收。

本次文档 P0。实际 API/UI/外壳通常 F0；如引入持久格式、共享状态契约变更或迁移，按 F1 重新评估。最小检查遵循实际代码风险，不为个人应用增加通用多端框架或审批层。

只有实际超出既定范围（App 自有推送、全手机数据维护、桌面多图编辑）、真实组件无法支撑冻结交互、必要契约存在破坏性变更时，才报告具体证据并重新确定范围。许可库/设备/可信地址暂不可用时继续可独立部分，缺失验收明确留项；不宣称完成。合并、正式 tag、常驻实例切换、生产发布与永久删除须另获明确授权。

## 11. 后续实施 Agent 指令

> 先读本方案、UI 冻结规范、v2.0.5 接口核对和项目 AGENTS.md。仅在用户另行授权正式实施后，从 v2.0.5 的准确 SHA 新建隔离 worktree，按 A→D 推进。UI 以 A06 固定版本为依据；使用 React+Kotlin WebView、IndexedDB 和最小离线页面壳；手机单图仅本地保存，不创建服务器手机工作区。先在 Find X8 验证真实完整指标、原生十字线、序列化恢复、登录和离线启动。新建告警只接基线支持的组合能力，复用执行/异常/通知模型。仅为已确认缺口增加轻量小图缓存接口及 transport 状态观察，不扩大供应商/周期/维护/后台推送范围。完成针对性测试、Ubuntu 隔离验收、真实设备和 APK 交付，未验项据实列出；未经授权不合并、不打正式 tag、不发布生产。
