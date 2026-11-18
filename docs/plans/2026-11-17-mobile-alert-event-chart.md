# 手机端触发记录直达图表位置：实施方案

日期：2026-11-17。交付类型：可直接交给执行 Agent 的 Markdown 任务书。本轮仅形成方案，未开始功能实现、测试或部署。

状态：已于 2026-11-17 接入[手机端待实现清单](pending/README.md)，第二优先，待实施。

## 1. 目标与完成后的使用路径

用户在任意一条告警触发详情中点“查看触发位置”，直接进入相同来源、相同品种、相同周期的专业图表，看到实际判定柱、发生时间、触发价及适用的当时阈值。点“返回触发记录”或 Android 返回键，回到同一条事件，继续决定是否处理。

主路径：

`触发详情 → 查看触发位置 → 加载原行情与事件附近历史 → 显示临时事件标记 → 返回同一触发详情`

通知入口沿用已有实现：

`点 ntfy 通知正文 → App 中指定触发详情 → 查看触发位置`

打开详情、看图、停止本次提醒、标记已处理、暂停规则仍为不同动作。查看图表不得主动调用确认、处理、暂停、编辑或重启接口。

## 2. 范围与风险

实施分类为 **F0**：兼容的手机 UI、事件导航与图表 runtime 扩展；计划复用已有事件查询和历史接口，无 schema、判定算法、通知协议或持久格式变更。最小检查为针对性逻辑回归、真实许可图表浏览器验证、桌面隔离回归、PR CI 和 Ubuntu `mw-dev` R1 smoke。

本次包括：

- 告警页“记录”、某规则的触发记录、全局事件记录“触发”页中的统一入口。
- 对事件快照的品种/来源/周期/时间/阈值解析。
- 指定事件的可恢复导航、图表定位、临时标记、返回原事件。
- 旧事件、离线、历史缺失、超时和快速切换时的真实反馈。

本次不包括图表内新建告警、任意图形绑定、历史行情版本重放、自动加载一整套事件指标、订单/持仓、后台供源改造、原生通知重做或全量工作区同步。预计只需网页更新，无需重建 APK；不得为此扩展 Android 协议。

## 3. 仓库基线、工作目录与并行任务

本方案所在工作树：

`/home/quant/repos/market-watch-mobile-product-priorities-20261117`

分支：`docs/mobile-product-priorities-20261117`。已核对远端 `main @ 1f2005c320171349bb25bb0268f2f638d86b38b9`，2026-11-17 重新 fetch 后未变化。方案与上一轮分析均未提交，不得通过 checkout/reset 清除这些文档。

实施时另建独立工作树，不在文档工作树或其他任务工作树实现业务：

```bash
git -C /home/quant/repos/market-watch fetch origin
git -C /home/quant/repos/market-watch worktree add \
  -b feat/mobile-alert-event-chart-20261117 \
  /home/quant/repos/market-watch-mobile-alert-event-chart-20261117 origin/main
cd /home/quant/repos/market-watch-mobile-alert-event-chart-20261117
cat AGENTS.md
git status --short --branch
git log -1 --format='%H %s'
```

如果上述分支/目录已存在，先只读核实其归属与改动，再复用本任务自己的工作树；不要覆盖已有工作。

主线外的相关候选已只读核对：

| 候选 | 本方案关心的能力 |
| --- | --- |
| `feat/mobile-chart-polish-20261117 @ ba10541f` | 图表加载、失败恢复、保存反馈、桌面隔离 |
| `feat/mobile-ntfy-settings-20261117 @ 5a776433` | 通知配置、App 直达指定事件、`AlertRecords.targetEvent`、重复点击与登录后落点 |
| `feat/mobile-chart-continuity-20261117 @ 28af65ba` | 图表历史交互及局部错误恢复，包含前述候选链 |

这些不代表都已合入主线，也不代表开发实例此刻一定运行这些提交。实施 Agent 开始时再次 fetch 并核对差异；已有能力必须复用。方案对通知分支**没有必须整支合入的代码依赖**：若实施基线仍缺少按事件 ID 打开详情，只补本功能需要的网页最小能力，复用既有 GET 接口；不把配置 ntfy、Android 深链等整批搬进本 PR。

部署前再读 `mw-dev` 当前版本与私有 launcher。不能用纯主线候选镜像覆盖开发实例已部署的通知、图表或其他任务改动。先形成能保留现有候选的可追溯集成版本；如不能安全证明兼容性，停在部署前报告具体版本差异，由用户协调。不要为绕开冲突新建常规验收实例。

## 4. 已核实的实现事实

| 文件/入口 | 当前事实及影响 |
| --- | --- |
| `web/src/mobile/AlertRecords.tsx` | 统一触发列表与详情，已有处理、投递重试和详情轮询；最合适的新增入口位置 |
| `web/src/mobile/AlertsPage.tsx` | 主记录及规则记录各有 `AlertRecords`，另持有全局 `RecordsSheet`；需要覆盖所有入口 |
| `web/src/mobile/RecordsSheet.tsx` | 全局事件分类，触发页再次复用 `AlertRecords`；返回时须保留所属入口 |
| `web/src/mobile/MobileApp.tsx` | 根导航、`chartTarget`、`select`、Android 返回、会话与本机选择 |
| `web/src/mobile/MobileChart.tsx` | 保留单一 widget；`target` 目前只带品种、周期、token；`mobile-command` 可扩展 |
| `advanced-host/chart-runtime.js` | 手机 `symbol` 命令目前依次 setSymbol/setResolution；共享 runtime 的新逻辑必须限制在 `mobileMode` |
| `advanced-host/mobile-chart.js` | 手机原生工具栏、dataReady/画面就绪、预览与生命周期；适合接入事件展示控制器 |
| `advanced-host/series.js` | `MWSeries.encode/decode` 是实际行情编码语义，managed 为裸 ID、provider 为 `MWP:`、composite 为 `MWC:`；不要照抄其他入口的简化三元表达式 |
| `advanced-host/viewports.js` | 已用公开 `dataReady`、`setVisibleRange`、`getVisibleRange`，有超时等待实践 |
| `advanced-host/build-assets.mjs` | 宿主脚本为显式文件列表；新增控制器要加入构建 |
| `web/src/advanced/chartAlerts.ts` | `AlertEvent` 已有 `evidence.config`、`rule_version`、`observation`；部分后端快照字段尚需补兼容类型 |
| `backend/alerts/chart_alert_application.py:events` | 事件接口返回精确价格/阈值字符串、发生时间及完整 evidence；可直接按事件 ID 查询 |
| `backend/alerts/chart_alert_service.py:consume` | 不可变 evidence 含 market_identity、条件、price、threshold、unit、observation；不能用当前规则替代 |
| `backend/alerts/price_alert_close.py:evidence` | 收盘事件带 `observation.bar.start/end`；occurred_at 是判定柱结束时间 |
| `backend/alerts/chart_alert_worker.py` | 指标等事件也带观察 bar；收盘发生时间为 bar.end，盘中为 observed_at |
| 本机 `advanced-host/charting_library/charting_library.d.ts` | pinned API 支持 Promise createShape、setVisibleRange 和临时绘图选项；窄屏可能忽略 range.from，故必须核对实际范围 |

上述后端文件原则上只作语义依据，无需修改。

## 5. 已确定的产品行为

### 5.1 入口与显示

触发详情增加一个“查看触发位置”按钮，复用现有 Button，放在事件摘要后、处理动作前。标题、抽屉、主题、返回与退场沿用现有控件。

事件身份不完整时保留详情，按钮不可用并就地说明具体原因。离线时允许阅读已缓存事件，查看图表入口显示“联网后可查看触发位置”，不假装已经完成历史定位。

进入图表后，外层提供紧凑事件摘要：当时条件、周期、发生时间、触发价；价格规则额外显示“当时阈值”，指标规则显示指标观察值及阈值。提供“返回触发记录”，定位失败时原位提供“重试定位”。需要当前行情时提供“查看最新”，清除临时标记并结束事件定位，仍保留返回本条记录的入口直到离开图表。

复用当前 UI 语言，不引入新的整页视觉方向或遮住原生工具栏的大卡片。适配 375/412px、深浅主题、150% 字号；长条件渐进展开。

### 5.2 导航与返回

新增网页落点 `/m/chart?event=<event_id>`，URL 只含事件 ID，不携带来源、价格、备注或序列化快照。身份与条件从已认证事件接口读取；相对路由在 React 内为 `/chart?event=...`。

- 同次会话保存一个小型返回描述：原路径、记录入口类型（主记录/规则记录/全局触发页）、规则 ID（如有）、所属分类、查询/筛选与滚动位置。列表页与已有分页状态尽量保持挂载，复用原状态，不另建通用导航快照系统。
- 抽屉先完成退场，再显示图表；“导航关闭”和用户主动关闭要区分。不要让原 `onClosed` 把本次仍需返回的事件及记录状态全部清掉。
- 返回通过指定 event_id 重开同一事件；即使它不在已加载第一页也要可读取。按通知候选已有 `targetEvent` 模式复用/补齐，并加一次打开 token，避免同事件 ID 的去重标记阻止返回重开。
- 原生返回先交给图表当前参数弹层/原生菜单；没有内部弹层时返回事件。页面上的“返回触发记录”也必须走 `canLeave/flush`，保留脏表单确认，不能绕过。
- 浏览器返回与页面按钮行为一致，避免回到空自选页或在图表/详情间形成 history 循环。导航进入图表用一次 push；页面返回用原历史位置或 replace，按来源编写测试。
- 直接打开该 URL、页面刷新或进程重建后，重新认证并读取事件；没有内存返回描述时，退回“告警 → 记录 → 同一触发详情”。可采用 `/alerts?signal=<id>`，与现有通知网页落点统一；主线缺该能力时补最小网页适配。
- 会话失效先走现有登录流程，认证成功后继续当前 event_id；主动退出、换服务器、换用户则清除事件、返回描述、临时标记及在途定位。
- 从图表主动切换底部其他主导航，视为退出本次事件模式；不阻止用户离开，不跨账号或跨服务器记忆返回路径。

### 5.3 事件事实与当前图表

使用 `event.evidence.config` 和 `evidence.market_identity`；显示身份可复用 eventPresentation/eventIdentity，但不使用“当前规则详情”来决定跳转目标。规则后来编辑、到期或归档，都不应改变旧事件的落点。

| 事件系列 | 图表 ticker |
| --- | --- |
| composite | `MWC:` + config.instrument |
| provider | `MWP:` + config.instrument |
| managed | config.instrument，裸 ID |

按 `MWSeries` 现有契约实现一个小型类型安全转换，使用 `sameChartSymbol` 归一化比较。`MWH:` 指固定历史 UUID，不是所有 managed 事件的通用前缀。未知系列或缺失 instrument/timeframe 不猜测。

事件快照固定当时的来源、basis/账户口径、周期与修订信息。历史读取仍使用当前可读的同一行情系列；本期不承诺读取已冻结的旧行情版本。显示简短说明：“条件取自触发时记录，历史行情可能有修订”。

如来源身份已无法解析，展示不可用并返回事件，不改用同名品种。若同一系列仍可读但版本已变，应明确“行情版本已更新”；在已验证同源同口径的前提下允许查看当前可读历史。身份相同不代表历史版本相同；证据不足时不声称已核实。

### 5.4 时间定位

**后端事件和 bar 的时间单位是毫秒；原生图表 range/shape 时间为 Unix 秒。只在图表边界转换一次。**

按以下顺序确定锚点：

1. 若事件有合法 `observation.bar.start/end`，以 bar.start 定位判定柱，摘要中的发生时间仍用 occurred_at。
2. 盘中价格事件缺 bar 时，以 occurred_at 定位相邻真实 K 线；在当前加载历史中依据真实 bar 区间匹配，精确边界使用 `[start,end)`。
3. 老收盘事件缺 bar 证据时仍可到 occurred_at 附近，但明确“判定柱待核实”，不能将下一根柱标成已核实判定柱。

禁止将 detected_at/通知收到时间作为市场触发时间。禁止统一通过 UTC `floor(timestamp / interval)` 推算 D1/W1/MN 柱；交易日历、夏令时与月长不支持这种推断。

视窗初始目标约为事件前 60 根、后 20 根的上下文，窄屏优先保证判定柱可见。可用观察 bar 的真实跨度估计视窗长度，**此估计只用于视窗大小，不用于判定柱归属**；缺跨度时使用现有周期元数据。先用现有历史读取和原生 range API，不拉取“事件至现在”的无限完整历史。

`dataReady` 只代表图表某次数据可用；`setVisibleRange` Promise 完成也不单独代表定位成功。完成后核对当前 ticker、resolution、实际可见范围及目标附近真实数据。窄屏无法放下整段 range 时允许缩减上下文，不能把已在视窗外的事件标成成功。

### 5.5 标记规则

只创建本次事件的临时展示，数量保持有界：

- 已核实判定柱：时间竖线或旗标，清楚标为“判定柱”；精确发生时间显示在摘要。
- 盘中事件：定位真实所属柱，显示发生时间与触发价；不重建未观测 tick 路径。
- 价格规则：用事件返回的 `threshold` 显示一条“当时阈值”虚线，绝不重新用当前参数/ATR 计算。区间事件返回的是实际触发边界，第一版只强调该边界。
- 指标规则：显示时间标记及摘要中的指标观察值/单位/阈值，**不将 RSI/MACD 等阈值画成主图价格线**。也不自动修改用户已有指标、参数或副图。
- 画线/ATR 事件：只标实际触发时点的已记录阈值；不克隆关联图形，不借当前图形重新解释历史。

图形创建使用 pinned 公共 API 与 `lock:true`、`disableSelection:true`、`disableSave:true`、`disableUndo:true`、`showInObjectsTree:false`，每次记录自有 entity IDs。退出、切目标、取消和 dispose 时仅移除这些 ID；禁止 removeAllShapes。

临时图形不进入图表保存、撤销栈或用户画线对象。不要全局压制 drawing_event 或 autosave，以免丢失真实编辑。事件模式下暂停普通预览截图写入，避免带事件标记的画面混进普通品种/周期预览；旧预览可保留，退出后恢复原流程。

本机正常的品种/周期选择及用户真实修改，仍按原自动保存规则保存。事件 ID、临时实体和返回描述不新增到 IndexedDB 的 chart 文档。无需承诺返回事件后把图表恢复到进图前全部历史视窗。

### 5.6 生命周期、竞态与失败

定位状态采用一个有界流程：`reading-event → waiting-chart → locating → located / unavailable / error`；新目标或离开时进入 cancelled。状态用于控制当前操作，主界面不逐段展示技术文案。

- 每次用户定位生成单调 request token，作用域绑定 profile generation + event_id + ticker + resolution。
- 先等待原生 symbol/resolution 切换和数据，再设 range/创建标记；检查原生 setSymbol 返回 false 的情况。
- 新事件 B 到达后，A 的迟到请求、range 完成和 createShape Promise 都不能改写 B；已迟到创建的 A 标记要清理。
- 图表准备/范围定位使用可取消订阅与有界超时，优先复用现有请求取消机制；range 调用显式 `rejectByTimeout: 20000`。超时给原位重试，不后台无限循环。
- 定位成功后不因 SSE、尾柱更新、详情轮询或普通前台恢复反复居中。用户拖动图表后不抢回视窗；若定位尚未结束时主动操作或换品种/周期，取消旧定位。
- 用户主动换品种或周期时移除不匹配标记，摘要提示“已切换图表”，可重新点定位或返回事件。不能把原事件标记留在另一来源/周期上。
- 图表短暂离线仍保留同一 widget、已显示 bars、指标与参数；后台继续沿用既有手机传输暂停策略。重新联网后沿现有恢复链路同步。
- 事件不存在、权限不足、来源不可用、历史超出保存范围、容量限制和读取失败均明确说明，保留返回/重试能力。原始事件详情仍可读时不随图表失败一起消失。

## 6. 文件与接口改动清单

| 文件 | 计划变化 |
| --- | --- |
| 新增 `web/src/mobile/alertChartTarget.ts` | 从 AlertEvent 解析导航目标、时间锚点与价格/指标展示；导出纯函数和目标类型 |
| `web/src/advanced/chartAlerts.ts` | 兼容补充 evidence.market_identity、unit 及本功能真正使用的观察 bar 类型；不改变后端格式 |
| `web/src/mobile/AlertRecords.tsx` | 按事件打开详情的可重复 token、查看入口、错误反馈及导航关闭后的恢复 |
| `web/src/mobile/AlertsPage.tsx` | 所有触发列表传入统一 open-event-chart 回调；恢复规则记录/主记录状态 |
| `web/src/mobile/RecordsSheet.tsx` | 全局触发入口透传，保留/恢复来源分类及滚动 |
| `web/src/mobile/MobileApp.tsx` | event URL、单一会话上下文、返回描述、认证恢复、返回键编排与清理 |
| `web/src/mobile/MobileChart.tsx` | 事件目标、结果 token 校验、紧凑摘要及返回/重试/最新入口；普通 symbol 路径不受影响 |
| `web/src/mobile/chart-controls.css`、必要的记录作用域样式 | 使用现有主题变量及间距，保持工具栏与画布可达 |
| 新增 `advanced-host/mobile-alert-event.js` | 自有标记、range 定位、超时/世代控制及 dispose；不持有后端写接口 |
| `advanced-host/chart-runtime.js` | 在 mobileMode 接入 `mobile-command: locate-event / clear-event`，回传 `mobile-event-location` 结果 |
| `advanced-host/mobile-chart.js` | 事件展示期间预览采集暂停/恢复的最小接点 |
| `advanced-host/build-assets.mjs` | 在 chart-runtime.js 之前加入新脚本 |
| 新增针对性测试、适用 CI 入口 | 见下一节；必要时更新已有图表/通知夹具的完整 event schema |

建议通信载荷：

```ts
// 本功能内部新类型草案，执行时与现有类型合并；不直接作为 URL 数据。
type AlertChartTarget = {
  eventId: string;
  token: number;
  symbol: string;
  resolution: string;
  occurredAtMs: number;
  anchorMs: number;
  bar?: { start: number; end: number };
  anchorKind: "evidence-bar" | "intrabar-time" | "approximate-time";
  price: string;
  threshold: string;
  leftKind: "price" | "indicator";
};
// 发往宿主：mobile-command / action=locate-event / target。
// 宿主回传：mobile-event-location / token,eventId,symbol,resolution,status,reason?。
```

精确价格字符串留在摘要中；只在调用原生绘图 API 时转换 Number。发送给图表的载荷仅含展示所需字段，不发送 token 凭据、通知确认凭证或完整业务上下文。

## 7. 按依赖排序的实施步骤

1. **核实执行基线与环境。** 按第 3 节建工作树；读取 AGENTS.md、`web/components.json`、相关 mobile skill 参考；记录最新主线和需保留候选。只读检查当前 mw-dev 服务、端口、内存及磁盘。
2. **准备依赖与真实许可库。** 在本任务工作树 `web/` 执行 `npm ci`，安装本工作树自己的依赖。主仓库本机已有 `advanced-host/charting_library/` 固定许可库；核对其版本与项目 pinned commit 后，可将这一已授权本机资产复制到本任务相同的 ignored 目录。不要修改许可库或加入 Git，不借用其他任务可写 node_modules。使用已安装的 Playwright Chromium；缺失时通过项目现有安装方式补齐。
3. **实现事件目标解析并建立针对性测试。** 明确三种系列编码、ms/秒边界、close bar.end 与 bar.start、指标单位、旧事件降级、精确阈值和当前规则编辑后的快照隔离。先验证这些规则，再接 UI。
4. **先验证历史定位，再接统一详情与返回。** 先在真实 pinned widget 夹具中证明：目标事件不在最新已加载范围时，现有历史链路能加载到事件附近，且 setVisibleRange 的实际结果包含目标。此检查纳入后述浏览器脚本，避免做完入口才发现历史范围不支持。若需要改后端协议或长期历史维护才能完成，按第 9 节报告范围变化。验证成立后，给三个记录入口加入相同按钮，实现按 ID 重开、URL 落点及单一返回描述；用夹具证明读取/导航无确认写入。
5. **实现 mobile 事件定位控制器。** 按已有市场/历史读取链路加载目标范围；等待真实 widget 就绪；管理 token、超时、临时实体、预览隔离。不要改变后台采集、原生返回协议或桌面数据预取。
6. **补齐 UI 和错误路径。** 原位反馈、返回键、参数脏表单、历史缺失、旧事件及恢复；保留现有手机图表加载/失败修复。
7. **运行最小检查及截图。** 按第 8 节完成构建、逻辑/浏览器/桌面隔离回归。截图仅用于布局，不代替定位和无写入断言。
8. **Ubuntu R1。** 对照现运行版本准备保留已有候选的集成镜像与回退清单。使用 `mw-docker build/compose-build` 标注 task/project/用途；复用 `mw-dev`，不重建数据库、market-runtime、通知 worker 或 APK 下载目录。真实规则与事件只读验收，不制造触发。
9. **交付与 PR。** 整理源码 SHA、风险分类、自审、最小检查、实际主机/访问地址、启动停止命令、镜像和回退方式；建立/更新 Issue 草案及 Draft PR，CI 通过后报告。合并、正式 tag 和生产发布等待用户单独授权。

## 8. 验证命令与验收矩阵

以下新测试目前**尚未创建**，须在上述第 3、5、7 步实现后再运行：

- `web/tests/mobile-alert-chart-target.cjs`：目标解析的真实语义。
- `web/tests/mobile-alert-event-runtime.cjs`：可控延迟/范围/形状 Promise 下的 token、取消、清理及桌面无操作。
- `web/tests/mobile-alert-event-chart.browser.cjs`：实际构建、真实许可 widget 与明确 HTTP 夹具，检查实际可见范围、bar、图形和导航。

在实施工作树执行：

```bash
cd /home/quant/repos/market-watch-mobile-alert-event-chart-20261117/web
npm ci
npm run build
node tests/mobile-alert-chart-target.cjs
node tests/mobile-alert-event-runtime.cjs
MOBILE_EVENT_CHART_OUTPUT=/tmp/mw-alert-event-chart-20261117 \
  node tests/mobile-alert-event-chart.browser.cjs
node tests/mobile-alerts.cjs
node tests/mobile-alerts.browser.cjs
node tests/mobile-chart-resume.cjs
MOBILE_CHART_OUTPUT=/tmp/mw-alert-event-chart-resume-20261117 \
  node tests/mobile-chart-resume.browser.cjs
```

若执行基线包含图表打磨候选的专项模式，增加：

```bash
MOBILE_CHART_ISOLATION_ONLY=1 \
MOBILE_CHART_OUTPUT=/tmp/mw-alert-event-chart-desktop-20261117 \
  node tests/mobile-chart.browser.cjs
```

不含该模式时，先在本任务测试中补等价的真实桌面隔离场景，再运行；不能因为未知环境变量被忽略就宣称专项通过。若执行基线已有 `mobile-notification-link.browser.cjs`，补运行该脚本，验证通知→详情仍正常；若没有，不把新建 Android 深链纳入本任务。

完成后：

```bash
git -C /home/quant/repos/market-watch-mobile-alert-event-chart-20261117 diff --check
git -C /home/quant/repos/market-watch-mobile-alert-event-chart-20261117 status --short
```

| 场景 | 必须验证的结果 |
| --- | --- |
| 主记录/规则记录/全局触发页 | 都到同一事件图表；返回同一详情，原列表筛选与滚动保留 |
| 事件不在第一页、同事件重复打开 | 按 ID 可达，不受分页和 entered 去重阻断 |
| 规则后来改价、改周期、归档 | 仍使用事件旧快照及旧阈值 |
| 收盘发生在下一柱边界 | 定位 evidence.bar.start；不能误标下一根 |
| intrabar/UTC、ny17、DST、D1/W1/MN | 复用真实 bar 时间，不统一 UTC 取整；旧事件不确定性可见 |
| composite/provider/managed、大小写 UUID | ticker 编码正确，同名异源不混用；unsupported 明示 |
| RSI/MACD 与价格、区间/ATR | 指标不画主图价格阈值；价格采用事件真实阈值，不重算 |
| 历史未在当前首屏 | 真实历史请求覆盖事件附近，实际 range 包含锚点，有可验证真实 bar |
| 很旧事件、历史不存在、容量限制 | 有界失败/降级，说明原因，可返回；不伪造定位成功 |
| A 慢请求后再打开 B | A 不重定位 B、不残留实体，B 状态与标题一致 |
| 手动拖动/切周期/切品种、SSE 新柱 | 不抢回视窗、不在错误来源保留标记 |
| 离线/前后台/重连 | 同 widget 和已有数据保留，恢复不丢指标参数、不循环居中 |
| 参数编辑未保存、Android/浏览器返回 | 确认逻辑一致，取消保留参数与当前事件 |
| 刷新、登录过期、主动退出/换服务器 | 刷新可重建；过期登录后续接；主动换身份隔离清理 |
| 临时图形与用户画线 | 不进撤销/持久文档/普通预览，只删除自有标记；用户画线保留 |
| 只读语义 | 无 ack/handled/lifecycle/edit/retry 投递等业务写；允许现有只读订阅、历史/指标需求注册和本机保存 |
| 桌面隔离 | 无事件控制器效果，原工作区/指标参数/保存功能正常 |
| 375/412px、深浅、150% 字号 | 无横向溢出，摘要和操作可达，原生栏不裁切 |

逻辑测试可在本工作树使用 node/夹具；真实服务与部署验收按仓库约束仅在 Ubuntu Docker。不能把桌面 Chromium 移动视口称作 Android 真机验收。若没有真机证据，明确列出 Android 系统返回、切 App 与键盘的待确认项，不阻断已被浏览器证明的其他结论。

真实开发实例验收使用现有事件，只读记录规则 ID/version/run/count/control_revision 前后相等；不得创建会触发的规则、发送测试推送、代用户确认历史通知或停采集来制造场景。无合适真实事件时，真实 smoke 验证可读入口与隔离，完整业务场景由明确夹具覆盖并如实记录限制。

## 9. 完成条件与停止边界

完成条件：三个入口和刷新直达均可达同一事件；真实 widget 到达正确系列/周期/判定柱附近；阈值和单位正确；返回、保存、竞态、失败和桌面隔离检查通过；Ubuntu R1 记录完整；PR CI/self-review 证据齐全，Draft PR 可审阅。

以下情况保留现场并报告具体缺口，不自行扩大范围：

- 需要新增数据库结构、改告警判定或重建后台历史链路，才能完成定位。
- 原行情已不可读，想通过另一个同名来源替代，或需要真正重放旧行情版本。
- 必须修改原生 APK/通知协议、引入完整服务端图形身份或新的常驻后台连接。
- 本机固定许可库缺失或版本不匹配；不得用假的 widget 验收替代真实图表结论。
- 无法保留 mw-dev 当前候选、资源不足，或需要停止/覆盖其他任务实例。
- 准备合并 main、正式 tag、Unraid 生产发布、生产迁移、永久数据/资源删除。

文档形成不代表开始实施。执行此方案后，合并和生产发布仍遵守 AGENTS.md 的用户授权检查点。

## 10. 可直接交给执行 Agent 的启动指令

```text
请按 /home/quant/repos/market-watch-mobile-product-priorities-20261117/docs/plans/2026-11-17-mobile-alert-event-chart.md 实施 Market Watch 手机端“触发记录直达图表位置”。先重新 fetch 并核对主线、通知与图表候选，建立本任务独立 worktree。按 F0 最小流程完成事件快照解析、三个记录入口、真实图表定位和临时标记、返回同事件、针对性回归、桌面隔离、Ubuntu mw-dev R1、自审、CI 和 Draft PR。保留现有通知/图表候选、真实规则与数据；不发送真实推送，不确认真实告警，不合并、不发布生产。遇到方案第 9 节的范围、版本集成或授权边界时报告事实和唯一需要的决定，其他常规步骤自动推进。
```
