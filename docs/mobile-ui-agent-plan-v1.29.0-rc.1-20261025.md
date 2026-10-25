# Market Watch 移动端首期实施任务书

> **历史方案，保留作参考。** 2026-10-25 从 `docs/mobile-ui-plan-20261025` / `ddbb1810` 收录。下文是基于 `v1.29.0-rc.1` 的原始任务书，不再作为当前开发启动指令。
>
> 当前集成基线为 `ba5407b2` / `v1.29.0-rc.3`；产品提交 `1c8a8ac8` 已包含移动端外壳、单图、原图格选择及相关交互代码。这里只确认已有实现，不代表原计划全部完成或整体验收通过。
>
> 实现已与原范围存在差异：当前有“保存当前图格”入口，而原计划禁止手机保存工作区。后续开发应从当前集成分支另建任务，先按现有代码和用户最新要求确定剩余范围；不要直接执行第 8、10 节的旧基线命令。
>
> 本文旧 worktree 路径为历史记录，两个计划/原型分支及 worktree 已归档清理。原型的假数据不是功能验收依据，线上静态预览保持。归档及恢复说明见 [整理记录](validation/mobile-ui-branches-20261025/README.md)。

原计划编写时状态：方案已定稿，尚未实施。原交付日期：2026-10-25。

本文是可独立交给开发 Agent 的执行依据，不要求读取原会话。用户已认可移动端布局方向，本期采用一套 Web 应用、一套均衡导航，复用桌面的行情、图表、Python 指标、告警和持久化逻辑。没有必须补充的产品澄清；下文默认规则由执行 Agent 直接采用。

本次交付仅为方案。只有用户后续要求执行本文，才开始产品开发、构建与隔离验收；本文不构成合并或生产发布授权。

## 1. 固定基线与参考材料

| 项目 | 固定值 |
| --- | --- |
| 仓库 | `/home/quant/repos/market-watch` |
| 基线标签 | `v1.29.0-rc.1` |
| 基线完整提交 | `71e13ae3234650b8c11c599be207c42a1dffee54` |
| 本任务书 worktree | `/home/quant/repos/market-watch-mobile-ui-plan-20261025` |
| 本任务书分支 | `docs/mobile-ui-plan-20261025` |
| 建议实施 worktree | `/home/quant/repos/market-watch-mobile-workspace-20261025` |
| 建议实施分支 | `feat/mobile-workspace-20261025` |
| 静态原型 worktree | `/home/quant/repos/market-watch-mobile-ui-preview-20261025` |
| 静态原型提交 | `e30f8a9a`；仅作视觉参考 |
| 已发布原型 | <https://pages.kookvv.com:8443/sites/market-watch-mobile-ui-preview-20261025/?variant=A&mode=single> |

以原型 A 的四项底部导航、信息层次、深浅配色、列表与详情布局为视觉依据。只做一套“图表 / 自选 / 告警 / 更多”；不实现 B、C，也不提供布局风格切换。原型中的所有行情及业务数据均为假数据，不能作为实际功能或性能证据，不能直接移植原型 JS 作为业务实现。

可选背景材料：`/home/quant/repos/market-watch-mobile-web-analysis-20261024/docs/mobile-web-capability-analysis-v1.29.0-rc.1-20261024.md`。本文已包含执行所需边界，背景文档不存在不影响开工。

实施前阅读本 worktree 的 `AGENTS.md` 和 `deploy/ubuntu/README.md`。不得把主目录或集成分支的最新提交当作本任务已批准的新基线，不改其他 worktree、已有验收实例或生产实例。若交付时目标分支已前进，单独记录差异并验证兼容；合入目标分支仍遵守合并检查点。

## 2. 首期交付范围

| 必须交付 | 用户操作与完成标准 |
| --- | --- |
| 手机外壳 | 四项底部导航；系统消息铃铛独立；深浅主题、safe area、软键盘与横竖屏适配；各入口使用真实业务数据 |
| 工作区与原图格 | 选择已有工作区，选择“原图格序号 · 品种 · 来源/系列 · 周期”；仅挂载一张所选原图格，保留其已保存指标、参数、画线与图表设置 |
| 临时看盘 | 复用搜索、周期切换及历史浏览；从自选打开当前品种；显示临时浏览状态；再次选择原图格恢复其保存状态 |
| 自选维护 | 切换已有列表，搜索加入、移除、上移/下移排序；设置/清除旗标；沿用现有共享偏好、版本冲突与失败草稿处理 |
| 告警阅读 | 全屏“规则 / 日志”，复用现有筛选、未读、详情、状态和分页/加载行为；返回恢复列表筛选与滚动位置 |
| 告警处置 | 单次事件“停止本次后续提醒”（现有 ack）；规则“暂停 / 恢复”；提交状态以服务端返回为准 |
| 告警定位 | 从事件选择“查看图表”，按关联工作区及原图格定位，再展示事件时点与临时价格标记；返回原事件/日志 |
| 系统消息 | 铃铛进入共享消息面板；保留未读、已读、已处理、详情及提示设置语义 |
| 更多与设置 | 工作区入口、通知/声音、账户/密码、历史加载详情与容量；复用原设置页与返回上下文 |
| 数据状态 | 只读查询现有行情目录、可用周期、覆盖区间、交易日历、后台任务与来源状态；不启动维护任务 |
| 图表空间 | 普通全屏/收起导航操作；退出后回到同一原图格与视区，不另设“看盘优先”模式 |

空工作区状态允许继续提示先到桌面建立工作区，并提供已有工作区列表刷新；不把“手机新建工作区”带入首期。自选列表的新建、重命名、删除也不在首期，先维护已有列表；没有列表时采用现有默认列表语义。

以下明确后置，不因原型有按钮就实现：新建价格告警、指标添加/参数编辑、绘图编辑、“另存手机工作区”、手机首次创建工作区、完整多图编辑与同步、复杂告警编辑/复制/删除/重新启用/重建基准/修复关联、数据映射/回补/重建/维护开关/删除。首期隐藏这些主动操作入口；从旧深链进入时说明尚未开放并提供返回。

不接入新行情源，不新增实时连接链路、后台 worker 或通知系统，不建立独立手机 App，不修改数据库 schema、工作区文档或偏好的持久格式。历史演练等兼容功能不扩展，只保留现有可用入口。

## 3. 已定的交互和状态规则

### 3.1 设备策略

在进入专业图表路由时，取主指针类型及初始视口：`(pointer: coarse)` 为真，或初始宽度 `< 768 CSS px`，进入手机浏览会话。会话模式维持到离开路由/刷新；旋转或放大窗口不自动获得工作区编辑权限。触屏平板本期也单图浏览。

触屏判定用于触控目标与手势，CSS 视口用于布局适配；二者不要继续被一个 `readonly` 包办。已从宽屏进入的桌面编辑会话缩窄时，不自动转单图、不丢弃未保存编辑；继续做 CSS 适配，重新进入路由才采用初始宽度规则。把这些行为写入测试，避免 resize 意外改变持久化策略。

这是一项普通界面策略，不新增角色权限系统。保留图表库需要的 `readonly`，但另用少量显式操作判断开放自选、旗标、告警控制和数据读取。不能全局设置 `readonly=false` 来开放手机。

### 3.2 导航与返回

- 图表：标题提供工作区和原图格选择；报价旁可见来源、系列及周期，价格沿用当前品种元数据与现有 formatter。
- 自选：点一行进入当前单图的临时品种浏览；行内菜单提供移除、旗标、上移/下移，长按不是唯一入口。
- 告警：规则/日志是同一业务面板的两个页签；事件详情、查看图表、返回日志形成明确返回链。
- 更多：数据状态、现有设置与账户入口；通知配置与声音设置说明沿用现有文案。
- 系统返回/可见返回先关闭最上层抽屉或详情，再返回列表或上一个主屏；不要拦截图表手势或首次进入时的正常离站。
- URL 继续沿用现有专业图表路由与告警深链；手机 tab、详情与返回状态可保存在当前会话，不新增永久导航配置。

首次打开工作区默认选择原图格 1；同一会话再次进入该工作区恢复上次所选原图格，告警深链显式指定的目标优先。临时换品种沿用当前周期；若目标系列不支持该周期，展示可用周期供选择，不自动更换行情源。原图格目录在加载工作区时从当前保存版本建立，显式刷新/重新加载才采用更新后的保存版本。

核心触控目标至少 44×44 CSS px，不能依赖 hover/右键。采用 `100dvh` 及 safe-area inset，避免双重页面滚动；输入框、错误与提交区域可在软键盘下滚动到达。处理焦点回归、Escape/返回及 `prefers-reduced-motion`。主导航不遮盖图表价格轴或列表底部操作。

### 3.3 保存边界

| 状态 | 保存规则 |
| --- | --- |
| 桌面工作区布局、指标、画线、同步、原关联 ID | 手机浏览绝不保存/覆盖/删除，不写工作区草稿，不执行自动修复关联 |
| 手机所选原图格、临时品种/周期、视区、列表位置 | 当前会话内使用；刷新重新读取工作区，不写回桌面文档 |
| 自选与旗标 | 共享用户偏好，手机与桌面同步；复用原版本与冲突流程，保存失败不能显示同步成功 |
| 告警规则 | 只提交 pause/resume，保留 version、control_revision、request_id 与忙碌/重试语义 |
| 单次告警事件 | 复用现有 ack，停止该事件后续提醒；不暂停规则，不撤回在途通知 |
| 系统消息 | 阅读、已读、已处理按原语义；不等于交易事件 ack 或故障恢复 |
| 通知、声音、密码、历史容量 | 沿用已有设置保存范围；历史容量不是临时手机设置，会影响以后打开的工作区 |

## 4. 必须守住的技术约束

### 4.1 原图格身份与单图展示

当前 `advanced-host/bridge.js` 的 `rebuildMobileSingleChart` 仅做 `setLayout("s")` 和内存 save/load，未显式选择保留哪一原图格。`advanced-host/chart-alerts.js` 则按工作区 ID、原图格 ID、来源、系列与周期关联告警。只新增列表、再把手机唯一图当成原图格 0，会破坏其他原图格的告警关联。

执行 Agent 必须先做第 6 节 S1 验证，再大规模改 UI。使用项目当前已许可图表库的公开 API 与本地 typings 验证选中原图格、单图加载、指标与画线保留。不得猜测 `setLayout("s")` 总保留活动图格，不按未经验证的 vendor JSON 字段拼文档，不发布许可库材料。

最小状态模型仅在内存中维护：

```text
原工作区快照：workspace_id + revision + 完整 document（不变）
原图格目录：original_index + original_chart_id（如有）+ 行情身份 + 展示摘要
当前单图：workspace_id + 原图格身份 + load_generation + 临时探索标记
```

1. 原图格序号始终指桌面保存时的序号；手机展示槽位 0 不参与替代原身份。
2. 原文档保留完整 `_mwAlertCharts` 等元数据；手机投影副本即使只放一格，也不能回写缩短后的列表。
3. 手动切原图格和告警定位调用同一单图加载函数。只有最新 workspace/session/generation 的异步结果能提交。
4. 从搜索/自选切品种或改周期后，标记临时探索；不能继续把不匹配的行情当成原关联图格或展示错误的告警画线。再次选择原图格或定位事件时，从原保存状态恢复。
5. 老文档没有稳定图格 ID 时，仅复用现有严格的 legacy index + 行情身份校验，不凭手机槽位补写 ID、不做静默关联修复。
6. 原图格当前保存配置与告警来源/系列/周期不匹配时，说明“原图格行情已变化，无法精确定位”；不选同名其他图格、不假装恢复历史桌面布局。缺失/删除工作区或图格同样给出明确结果。

### 4.2 告警定位流程

```text
事件/规则 → 读取原关联 → 按需加载关联工作区 → 选择原图格
→ 校验来源 + instrument/series_kind + timeframe + 原身份
→ 等待最新图表与数据就绪 → 复用原定位/画线投影 → 事件时间与价格标记
```

定位前保存当前日志筛选、事件与滚动锚点；跨工作区时使用既有 workspace-load 通道并更新父层 scoped RPC session。旧 session 的响应必须作废，不可为跳转放松 origin/window/channel/workspace 校验。返回时重新建立有效作用域，再恢复原日志位置。

事件时点以真实事件字段为准；复用已有可见时间范围与临时标记逻辑。标记禁用保存/撤销/拖动；线型、线性/对数模式按既有逻辑投影。目标历史数据不可用时明确提示，不能把当前柱当成事件柱。只承诺当前保存图格 + 历史事件定位，不承诺还原事件发生时的全部指标版本或桌面布局。

### 4.3 共享业务状态和资源

- 继续使用现有图表 host、行情请求、`MWSeries` 身份比较、指标协调器及 `chart-tab.js` 报价逻辑，不新增手机轮询报价。
- 原图格切换后只存在一张活动业务图；销毁/解除旧指标、报价、需求租用、事件监听与过期请求。不得在后台保留全部原图格来实现“切换”。
- `nativeAlertUI.tsx` 已经维持每个 host 的一个 React 告警业务根，`ChartAlertsPanel` 的 `useAlertData` 已有轮询和过期响应保护。手机只改变容器/展示与操作 gates；不要再挂载一个手机告警数据实例。
- 手机告警可用项目自有全屏容器，延续 native shell 的 mount/open/close/destroy 接口；桌面继续原侧栏。优先使用现有 HTML controls fallback，避免新增对 vendor 私有 DOM 的依赖。
- 手机外壳建议从现有 `build-alert-ui.mjs` 入口引入，并与共享告警业务根协作；导航状态与单图控制留在独立小模块，不塞进告警业务规则中。重新挂载工作区先清理旧 owner，禁止两套并行轮询。
- 系统消息继续现有 `MWNativeNotifications`/`NativeSystemMessages` owner；铃铛与未读分别使用正确计数。数据状态按打开时读取，离开取消；初期可手动刷新，不加后台常驻轮询。
- 手机会话会增加实际渲染和请求开销，不能宣称零开销。以单图、按需面板、切换前后订阅/轮询数量作为验收依据，不指定未经测量的性能承诺。

## 5. 开放操作的具体边界

### 5.1 父层请求控制

保留 `AdvancedWorkspace.tsx` 现有消息来源、窗口、channel、session、workspace、请求大小及路径检查。在 UI 和父层双重限定本期新增操作；不要仅隐藏按钮。

| 通道/对象 | 手机允许 | 仍拒绝 |
| --- | --- | --- |
| 工作区 | list/load | create/save/delete、手机快照/草稿覆盖桌面文档 |
| `chart-alert-ui-rpc` | 既有读取、capabilities、事件 ack；`/chart-alerts/{uuid}/lifecycle` 仅 `action=pause/resume` | create/edit/geometry、restart/rebaseline/archive 等其他生命周期动作 |
| 旧 `chart-alert-rpc` | 不新增手机写入例外 | geometry/edit/lifecycle 等旧写路径 |
| 偏好 | `kind=setting,name=mw.watchlists.v1,tool` 为空的 save 及该 key 的必要草稿操作 | 其他偏好写入、模板/图表样式保存、任意 preference ID 删除 |
| 旗标 | 现有 symbol-flags 通道中 `mw.symbol-flags.v1` 的版本化读/写 | 利用旗标通道保存其他 key |
| 数据中心 | 下述精确只读白名单，`body===undefined` | 管理操作、任意来源配置、需求/任务创建及未列出路径 |

偏好草稿的 write/check/drop/failed/resolve 同样必须验证归属到允许的 watchlist key；仅开放 save 而仍封住失败草稿，会破坏现有持久化。保留桌面留下的其他偏好/工作区草稿，不自动迁移、删除或覆盖。手机需要能提示并重试本期允许 key 的保存失败；可复用现有草稿面板的受限呈现。

暂停/恢复不得复用“重新启用已完成规则”；状态冲突重新读取服务端，保留错误和重试入口。超时是结果未知，按现有 request_id/版本流程核对后重试，不盲目生成新请求。

### 5.2 数据状态白名单

使用现有 `/market-data` 请求传输及 session，以下为逻辑 API 路径（网络仍带现有 `/api` 前缀）。执行时复核被调用函数确为读取；不得按“所有 GET 都只读”开放通配路径。

| 读取路径 | 用途 |
| --- | --- |
| `/market-data/sources` | 已注册来源能力；无采集开关 |
| `/market-data/live/status` | 现有实时状态快照；基线主要是 OANDA，不伪造其他源实时状态 |
| `/market-data/center/platform` | 已有平台品种目录，按需分页与查询 |
| `/market-data/center/datasets`、`/market-data/center/datasets/{id}` | 已有自建数据集目录与状态 |
| `/market-data/versions?dataset_id={id}` | 该数据集已有版本 |
| `/market-data/versions/{id}/artifacts`、`/market-data/versions/{id}/coverage` | 已有周期产物与覆盖；只读，不 POST 生成产物 |
| `/market-data/center/calendars` | 已登记交易日历、适用身份与审核状态 |
| `/market-data/center/task-feed` | 现有任务、结果与更新时间；无暂停/恢复/重试任务按钮 |

ID 按后端真实格式验证，查询参数使用现有字段和分页限制；拒绝绝对 URL、路径穿越及未列出子路径。不要开放 `history-catalog/refresh`、`live/demand`、`charts/provider/configure` 或整个数据集详情管理页。

小型只读状态视图可复用 `market-data` 的类型、展示与读取 hooks，通过已有 data-center bundle/transport 提供；不复制整套数据管理业务。不要求把数据中心全部页面手机化。进入状态面板本身不能新增维护任务、修改配置或创建额外供源需求；正常查看图表产生的既有行情需求另按原机制运行。

## 6. 文件落点与执行顺序

### 6.1 已验证的落点

以下路径相对实施 worktree；实施时按符号定位。

| 现有文件 | 本期职责 |
| --- | --- |
| `web/src/advanced/AdvancedWorkspace.tsx` | 会话模式、受限操作 gates、scoped RPC、工作区跳转、偏好草稿、数据读取与返回链；保留忽略手机工作区快照的保护 |
| `advanced-host/bridge.js`、`workspaces.js` | 单图选择/装载、原图格目录与生命周期；工作区原文档/修订隔离；传递手机 shell 所需回调 |
| `advanced-host/chart-alerts.js` | 让当前单图解析为原图格身份；沿用来源/系列/周期校验及事件/画线定位，不改后端绑定 |
| `web/src/advanced/nativeAlertUI.tsx`、`ChartAlertsPanel.tsx`、`NativeAlertControls.tsx` | 共享状态 owner、手机呈现、细分操作能力、列表返回；只允许 pause/resume 与 ack |
| `web/src/advanced/chartAlertUiApi.ts`、`advanced-host/native-alert-shell.js` | 受限请求与手机全屏 shell；保留桌面协议及控件行为 |
| `advanced-host/watchlists.js`、`symbol-flags.js`、`preferences.js` | 共享清单/旗标服务，手机列表调用同一保存链；补必要的 subscribe/dispose，不再另写一套保存逻辑 |
| `web/src/notifications/NativeSystemMessages.tsx`、`Panel.tsx`、`native.tsx` | 共享消息入口和小屏容器，保持 read/handled 的既有语义 |
| `web/src/market-data/*`、`advanced-host/data-center.js` | 受限状态视图、原读取 transport、取消与错误反馈 |
| `web/src/main.tsx`、`web/src/app/navigation.ts`、相关 CSS | 原设置入口和返回图表上下文；无需复制设置页面 |
| `web/scripts/build-alert-ui.mjs`、`web/scripts/build-data-center.mjs` | 实际存在的 bundle 入口；按需扩展现有构建 |
| `advanced-host/index.html`、`advanced-host/Dockerfile`、`advanced-host/build-assets.mjs` | 新 host 资源实际纳入脚本/CSS、COPY 与 hash 构建，避免本地有文件而镜像漏打包 |
| `.github/workflows/ci.yml`、`web/tests/*` | 接入相应单元/bridge 回归，保留桌面既有检查 |

建议新增的文件（基线尚不存在，可按项目习惯小幅调整并在交付记录对应关系）：

- `web/src/advanced/MobileWorkspaceShell.tsx`、`mobile-workspace.css`：导航、手机布局和轻量交互，不拥有另一套告警/行情业务。
- `web/src/advanced/mobileWorkspacePolicy.ts`：确有需要时提取少量可测试的手机操作判断，不建立泛化权限框架。
- `advanced-host/mobile-chart-view.js`：原图格目录、单图投影及选中身份；使用现有 lifecycle 回调。
- `web/src/market-data/MobileDataStatus.tsx`：只读状态视图，接入现有数据中心 bundle。
- 第 7 节列出的测试、夹具及 `docs/verification/mobile-workspace-20261025/` 脱敏证据。

不要使用不存在的 `Dockerfile.web`、`build-native-alert-ui.mjs` 或另造告警入口；Web Dockerfile 是 `web/Dockerfile`，共享告警入口是 `web/src/advanced/nativeAlertUI.tsx`。

### 6.2 分步任务与完成条件

**S0：隔离与复核。** 按第 8 节创建实施 worktree，核对 HEAD 与工作区状态，建立需求/Issue 草案并判定 F0。列出本期能力与禁止写入清单。只读核对本机许可库和构建依赖，不使用生产凭据或生产库。完成条件：基线、隔离标识、预期文件及最小验收明确。

**S1：先打通原图格单图路径。** 用隔离实例保存一个至少四格工作区，包含同品种不同周期、不同指标/画线及后续图格告警。通过本地许可 API/typings 验证读取原图格目录和选择第 2/4 格转成单图；记录所用公开 API、转换顺序及保留字段的证据。接通原身份 resolver 和共同加载函数，并测试快速 A→B→A 的过期结果隔离。开始与结束对工作区文档 canonical hash、revision、告警 association 做只读比较。完成条件：只有一张活动图，所选原图格身份、指标、画线、来源/系列/周期正确，服务器原文档不变。

S1 即可先建立 fixture helper 和浏览器测试的 `--stage=projection` 入口，按第 8.2 节构建/启动本任务实例，再用第 8.3 节相同环境运行原图格专项验证；不必等待手机外壳与全部测试写完。后续代码变更重建同任务候选后，再跑完整验收，不能用专项通过代替完整通过。

若公开 API 无法满足保留已保存指标/画线的单图选择，先检查项目现有文档 adapter 与已验证转换方式。仍无法做到时保留最小复现与证据，报告这个具体阻塞及可行替代；不要降级成只切品种、修改 opaque vendor 格式或先堆完整手机 UI。

**S2：外壳与共用告警容器。** 实现单一均衡导航及手机全屏告警呈现，保留单个告警状态 owner；连接工作区/原图格选择、临时搜索/周期与全屏。隐藏后置功能。完成条件：四屏可达，切主屏不丢当前单图/列表状态，不增生告警 poller，桌面侧栏行为保留。

**S3：自选、旗标和受限持久化。** 手机控件调用现有 watchlist API 与偏好保存链，支持已有列表切换、增删品种、上下移动、旗标；同时放开父层的精确 key、必要草稿及冲突处理。补清单订阅销毁。完成条件：手机重开和桌面重新读取一致；409/断网有可恢复反馈，其他偏好和桌面草稿保留。

**S4：告警处置与定位。** 在共享面板开放 pause/resume，保留 ack，父层同步限制动作。接通关联工作区→原图格→真实事件定位，以及返回日志。完成条件：第二/后续图格和跨工作区都能准确定位；过期会话及错误身份不能发请求或串图，缺失关联说明原因。

**S5：消息、设置与只读数据。** 连接原消息 owner 和设置返回上下文；接入数据状态小视图及精确白名单。完成条件：消息计数/语义正确；设置保存仍遵守原范围；看数据不创建任务、不修改来源、不触发需求注册。

**S6：验证与交付。** 执行第 7–9 节，完成最小 Ubuntu Docker R1、桌面回归、自审及可用 CI；更新使用说明和真实验证证据。用户要求执行本文后，Agent 可自动推进到 Draft PR，远端不可用时交付本地提交、完整 PR 文本和阻塞事实。合并、正式 tag 与生产发布留给明确授权。

步骤可在同一个实施分支按职责提交，不拆成必须协调的多 Agent 工程；不要求为每个简单 CSS 改动编写测试。风险测试围绕身份、持久化、异步生命周期与操作语义。

## 7. 测试与验收合同

### 7.1 先准备可复现夹具与测试入口

在任务实例中创建独立测试工作区/告警/偏好；不修改仓库内固定 D1 seed，不连接上游真实账户。D1 只有四个合成品种、M1/H1 各 720 条，不能直接充当完整实时或多源历史证据。

至少准备：W1 四格（同一品种 H1 + 指标 A、同品种另一个已有可用周期 + Swing/画线、其他品种、另一来源/系列的同名品种）；W2 有独立原图格及告警；事件关联第 2/4 格和 W2。另备有/无 `_mwAlertCharts`、原图格删除/改配置、数据缺失及暂停/已完成规则状态。

优先用真实任务 API/UI 保存工作区、规则和偏好。需要固定事件、故障、延迟或第二来源资料时，新增任务专用、幂等、可重复运行的 fixture 工具，只准指向本 task 数据库；可通过既有模型插入合成事件/数据，或用浏览器 transport fixture 验证分支。真实链路与 stub 结果分开记录；不能把网络拦截伪造结果写成真实供源验证。通知保持关闭，不发送测试通知。

新增下列入口（命名可微调，但先建文件再写执行命令）：

| 新测试 | 验证对象 |
| --- | --- |
| `web/tests/mobile-workspace-policy.test.cjs` | 初始模式与旋转策略、允许动作/偏好 key/数据精确路径；伪造请求及拒绝操作不调用 API |
| `web/tests/mobile-chart-view.test.cjs` | 原图格 ID/legacy fallback、共享加载函数、临时探索解绑、generation 取消与销毁；库转换真实性仍由浏览器测 |
| `web/tests/mobile-workspace.browser.cjs` | `--stage=projection` 只跑 S1 原图格专项；无参数完整运行真实 Docker 登录、导航、四格选择、告警定位/返回、允许写入与禁止工作区写入、刷新同步、清理及桌面回归 |
| `web/tests/mobile-workspace-fixture.cjs` | 任务实例初始化/夹具与快照助手；要求显式 URL/凭据并拒绝不匹配 task，不输出秘密 |

沿用 Node/esbuild 与 Playwright 测试方式，不新增测试框架。重点扩展现有告警 RPC/bridge、自选、偏好冲突与旗标测试。调整 `advanced-mobile-readonly.browser.cjs` 的断言：检测“禁止的工作区/图表写入为零”，不能再断言手机所有 POST 都为零。

不要直接运行旧 `pro-charts-mobile.browser.cjs`：它的 support 使用历史固定端口/私有文件，可能访问别的任务。需要的覆盖迁入本任务显式配置测试，不能默用生产或长期验收实例。

### 7.2 必须通过的验收矩阵

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| M01 | 375×667、390×844、915×412 触摸 Chromium；深浅主题 | 四屏、抽屉/详情无页面横向溢出；目标尺寸、safe area、返回/焦点可用；横屏仍是单图与同一策略 |
| M02 | fine pointer 初始窄窗、宽桌面、coarse 平板 | 初始规则一致；桌面宽窗不变；桌面缩窄不丢编辑/转单图；旋转不开放工作区写入 |
| M03 | 手动选择 W1 第 2/4 原图格 | 来源/系列/周期/指标参数/画线/原 ID 均正确；未保存的临时探索不污染其他图格 |
| M04 | 手机浏览前后与跨工作区切换 | 原 workspace document canonical hash、revision、告警 association 完全一致；无工作区 save/delete/草稿覆盖请求 |
| M05 | 同名但不同来源/系列/周期；不同指标/画线 | 不按字符串或手机 index=0 错配；价格精度来自对应品种元数据 |
| M06 | W1 第 2/4 格事件、W2 事件 | 自动选择准确原图格，定位事件时间与价格；返回原事件/日志筛选、加载位置及滚动锚点 |
| M07 | 关联缺失/删除/旧配置改变/历史数据不存在 | 明确原因且保留返回；无错误图格标记，无自动重绑定，不声称还原历史布局 |
| M08 | 加载 A→B→A、快速连点、慢响应、离开路由 | 最终画面只属于最新会话；旧请求不能更新图、列表或请求作用域；监听与旧资源释放 |
| M09 | 读消息、标已处理、ack、pause、resume、已完成规则 | 各自作用准确；已读不停止告警，ack 不暂停规则，pause 不撤回在途事件，已完成规则不显示为可 resume |
| M10 | 告警双击/超时/版本冲突、伪造 restart/edit 请求 | 沿用幂等与版本语义，不重复提交；非 pause/resume 的手机生命周期及编辑在父层被拒绝；桌面原动作不受损 |
| M11 | 自选加入/移除/排序/旗标、刷新、跨设备重读 | 同一共享偏好可恢复；名称、来源身份和排列正确；失败不假成功 |
| M12 | 手机和桌面并发改偏好、409、断网、本地草稿失败 | 复用原冲突/提示/重试；不静默覆盖他端，不删除无关 key/草稿；可恢复允许 key 的失败保存 |
| M13 | 进入更多→数据、刷新/离开；伪造管理请求 | 白名单只读成功，未新增任务/配置/需求；写入及非列出路径被拒绝，关闭后无常驻数据轮询 |
| M14 | 设置与系统消息进出 | 原状态 owner 和未读语义正确；回到正确图表上下文；历史容量等保存范围未被改成临时 |
| M15 | 连续切图/主屏/告警各至少 20 次，再退出工作区 | 活动图为 1；告警业务 poller 不多于原单实例；报价/指标订阅不随次数累积；记录前后实际计数/请求证据 |
| M16 | 桌面多图加载、保存、图格告警定位、自选/偏好、设置 | 原功能回归通过，无手机 CSS/门禁泄漏；手机浏览后重开原桌面工作区内容相同 |
| M17 | Android Chrome / iOS Safari 真机 | 软键盘、手势、横竖屏、系统返回、安全区、断网恢复与深链逐项记录；无设备时如实标待验收，不冒充实测 |

R1 最低覆盖 M01–M16 中实际产品路径；延迟/故障分支可单列可控测试证据。真机 M17 不凭模拟推断通过，交付明确未测项；若用户把真机指定为上线门槛，则未测前不建议生产发布。

## 8. 可直接采用的执行命令

以下命令供后续实施 Agent 使用；本方案编写阶段不执行构建/启动。例子端口为候选，先检查冲突；发现占用换本任务端口并同步 web build arg，不停止其他实例。

### 8.1 独立 checkout 与本地检查

```bash
cd /home/quant/repos/market-watch
git worktree list
git rev-parse 'v1.29.0-rc.1^{commit}'
git branch --list feat/mobile-workspace-20261025
```

核对完整 commit 与第 1 节一致。实施路径/分支已存在时先检查归属和状态；不是本任务则选新后缀，禁止覆盖、reset 或删除。路径可用时执行：

```bash
git worktree add -b feat/mobile-workspace-20261025 \
  /home/quant/repos/market-watch-mobile-workspace-20261025 v1.29.0-rc.1
cd /home/quant/repos/market-watch-mobile-workspace-20261025
git status --short --branch
cat AGENTS.md
```

将本任务书复制到实施 worktree 的 `docs/` 留存，在基线上实现。只从授权的本机私有材料准备同版本完整许可库，核对 `advanced-host/charting_library/charting_library.js`、本地 typings 和 ignore 规则；不把库、凭据、完整 storage state 提交到分支。

开发及第 7 节测试入口完成后，从实施 worktree 执行：

```bash
cd web
npm ci
npm run build
node scripts/build-alert-ui.mjs /tmp/mw-mobile-20261025-alert-ui
node --test tests/chart-alert-ui-rpc.test.cjs tests/chart-alerts-bridge.test.cjs \
  tests/mobile-workspace-policy.test.cjs tests/mobile-chart-view.test.cjs
node tests/advanced-watchlists.cjs
node tests/symbol-flags.cjs
node tests/advanced-preferences.cjs
node tests/advanced-preferences-conflict.cjs
node tests/chart-tab.cjs
node tests/chart-tab-title.cjs
cd ..
git diff --check
```

构建输出放任务独有目录，不把生成 bundle 当手工源文件提交。把新增的无需私有库测试接入现有 CI，并保留相关桌面检查。适用检查通过后继续交付，不无目的扩大测试。

### 8.2 Ubuntu Docker 隔离实例

本期按 **F0：兼容 UI/API 使用方式，持久格式与后台语义不变** 验收：相关测试 + CI/自审 + 一个 Ubuntu Docker R1。若实际改动升级到持久格式/schema/重要后台链路，重新评估 F1 和兼容验证，不偷带进 UI 任务。

从实施 worktree 设定任务变量（若冲突，使用本任务的新后缀）：

```bash
export MW_MOBILE_TASK=mw-mobile-20261025
export MW_MOBILE_PROJECT=mw-mobile-20261025
export MW_MOBILE_WEB_PORT=18861
export MW_MOBILE_CHART_PORT=18862
export MW_MOBILE_API_IMAGE=market-watch-api:mw-mobile-20261025
export MW_MOBILE_WEB_IMAGE=market-watch-web:mw-mobile-20261025
export MW_MOBILE_CHART_IMAGE=market-watch-chart-origin:mw-mobile-20261025
docker compose ls --all
docker ps --format '{{.Names}} {{.Ports}}'
ss -ltnp
free -h
df -h . /var/lib/docker
```

核对 project、端口无冲突；依 README 复核空闲资源、负载及 Docker 实际分区。轻量 UI 默认 PG + API + web + chart + 网关，不额外启 worker；启用任何必要 worker 需记录理由并按 README 的较高资源门槛检查。保守启动门槛为磁盘 ≥23 GiB、可用内存 ≥3.25 GiB；有 worker 为 ≥26 GiB/≥5 GiB，仍以工具实际 preflight 为准。

构建采用仓库内 `mw-docker` 同源入口，避免主机安装版缺少 UI origin 标签；不覆盖主机安装工具，不绕过检查用普通 docker build。固定 PG14.24/Nginx 等基础镜像与 builder 需按 README 在本机可用；依赖缺失先处理依赖，不转去 Unraid。

```bash
python3 deploy/ubuntu/mw_docker.py build --repo . --component api \
  --tag "$MW_MOBILE_API_IMAGE" --task "$MW_MOBILE_TASK" \
  --project "$MW_MOBILE_PROJECT" --purpose acceptance
python3 deploy/ubuntu/mw_docker.py build --repo . --component chart \
  --tag "$MW_MOBILE_CHART_IMAGE" --task "$MW_MOBILE_TASK" \
  --project "$MW_MOBILE_PROJECT" --purpose acceptance
python3 deploy/ubuntu/mw_docker.py build --repo . --component web \
  --tag "$MW_MOBILE_WEB_IMAGE" --task "$MW_MOBILE_TASK" \
  --project "$MW_MOBILE_PROJECT" --purpose acceptance \
  --build-arg "VITE_ADVANCED_CHART_ORIGIN=https://localhost:$MW_MOBILE_CHART_PORT"
python3 deploy/ubuntu/mw_docker.py preview prepare \
  --task "$MW_MOBILE_TASK" --project "$MW_MOBILE_PROJECT" --repo . \
  --api-image "$MW_MOBILE_API_IMAGE" --web-image "$MW_MOBILE_WEB_IMAGE" \
  --chart-image "$MW_MOBILE_CHART_IMAGE" --port "$MW_MOBILE_WEB_PORT" \
  --chart-port "$MW_MOBILE_CHART_PORT"
python3 deploy/ubuntu/mw_docker.py preview up \
  --task "$MW_MOBILE_TASK" --project "$MW_MOBILE_PROJECT"
python3 deploy/ubuntu/mw_docker.py preview status \
  --task "$MW_MOBILE_TASK" --project "$MW_MOBILE_PROJECT"
```

预期地址为 Ubuntu 本机 `https://localhost:18861`，图表 origin `https://localhost:18862`；自签证书，仅回环绑定。按最终变量记录实际地址。默认关闭通知、Yahoo 和 OANDA streams、内部网络隔离。任务登录密码在 `~/.local/share/market-watch-docker/previews/<TASK>/credentials.json` 的 **`login_password`**；它不是旧浏览器脚本使用的 `password`。由测试脚本直接读取，不在终端打印，不使用历史生产密码。

### 8.3 本任务浏览器验收入口

新浏览器/fixture 脚本要求下列变量均显式给出，缺少时失败；禁止静默回退到旧端口、旧私有文件或生产。脚本校验 task 对应 preview 记录、两个 URL 的回环 host/端口与凭据路径匹配后再创建夹具。`MARKET_WATCH_TEST_SELF_SIGNED=1` 仅用于本任务自签名地址。

```bash
export MARKET_WATCH_TEST_URL="https://localhost:$MW_MOBILE_WEB_PORT"
export MARKET_WATCH_CHART_ORIGIN="https://localhost:$MW_MOBILE_CHART_PORT"
export MARKET_WATCH_TEST_CREDENTIALS="$HOME/.local/share/market-watch-docker/previews/$MW_MOBILE_TASK/credentials.json"
export MARKET_WATCH_TEST_SELF_SIGNED=1
export MARKET_WATCH_MOBILE_TASK="$MW_MOBILE_TASK"
export MARKET_WATCH_MOBILE_ARTIFACTS="$PWD/docs/verification/mobile-workspace-20261025"
cd web
npx playwright install chromium
node tests/mobile-workspace-fixture.cjs
node tests/mobile-workspace.browser.cjs
cd ..
git diff --check
```

允许 browser 登录直接读取 `login_password`。截图与 JSON 日志脱敏后放证据目录；完整 storage state、cookie、token、数据库连接和凭据文件留私有任务目录。测试 fixture 重跑复用同一组 task-owned 数据，不清空全库。

S1 尚未实现完整 UI 时，先运行 fixture，再将上述无参数浏览器命令替换为 `node tests/mobile-workspace.browser.cjs --stage=projection`。完整交付时必须执行无参数版本并覆盖验收矩阵。

验收后如停止观察实例：

```bash
python3 deploy/ubuntu/mw_docker.py preview stop \
  --task "$MW_MOBILE_TASK" --project "$MW_MOBILE_PROJECT"
```

停止保留 PG volume，可用同样 `preview up` 恢复；不自动 reset、不删除卷、不动其他实例。需要最终退役时另按 `AGENTS.md` 和 README 做精确归属、归档及实际恢复校验，不把删除命令作为本计划默认步骤。

## 9. 完成定义、证据和停止边界

实施交付应包含：

1. 独立分支的可审阅提交及 Draft PR（远端不可用则提交本地 PR 文本），说明 F0 理由、最终范围、主要改变与限制。
2. `docs/verification/mobile-workspace-20261025/README.md`：主机、HEAD、task/project、镜像 ID、实际端口/地址、启动/停止命令、夹具步骤、测试命令和结果。
3. 第 7 节验收矩阵的通过/失败/未测记录；竖屏、横屏、深浅主题、原图格选择、告警详情/定位/返回、自选保存与数据状态截图；真实 API 与模拟故障证据分开。
4. 手机浏览前后的工作区 canonical hash/revision 与告警 association 对比；允许/拒绝请求摘要、轮询/订阅前后计数；不得在证据中夹带秘密或完整私有工作区数据。
5. 原图格转换所用公开 API 的说明和浏览器验证；若未取得许可库/真机，明确相关未测项，不能报告全部验收通过。
6. 相关测试、CI、自审结果以及简短用户操作说明；不把静态原型发布当产品验收，不自动更新网页库或生产。

执行 Agent 可自行决定组件小拆分、CSS 与同等测试实现，不为可逆实现细节反复提问。需要停下的实际边界：S1 核心能力无法满足且替代会改变用户体验承诺；必须修改持久格式/告警语义或真实生产行为；无法证明任务隔离/资源预算；准备合并、正式发布或永久删除。保留已完成工作，按 `AGENTS.md` 给出具体证据和唯一需要的决定。

开发、隔离验收、提交及 Draft PR 不等于允许合并 `main`、创建正式 Git/Docker tag、发布 Unraid 或删除生产资源。没有本次明确授权时在这些节点停止。

## 10. 可复制的 Agent 启动指令

```text
请执行 /home/quant/repos/market-watch-mobile-ui-plan-20261025/docs/mobile-ui-agent-plan-v1.29.0-rc.1-20261025.md。
固定基线 v1.29.0-rc.1 / 71e13ae3234650b8c11c599be207c42a1dffee54；先阅读仓库 AGENTS.md，另建实施 worktree。
按任务书完成手机首期功能、最小必要测试、Ubuntu 本机 Docker 隔离验收、自审、CI 和 Draft PR。
先完成原图格身份与单图保留的 S1 验证，再做完整 UI；一套均衡导航，复用现有业务逻辑，不实现后置功能。
常规步骤自行推进，不逐步询问；仅在任务书列出的具体阻塞、范围冲突或仓库检查点停下。
不合并 main，不创建正式 tag，不发布生产，不删除其他任务及永久数据。
```
