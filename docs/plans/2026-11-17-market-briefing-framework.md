# 定期市场简报：基础框架与每日涨跌概览实施方案

日期：2026-11-17。状态：已于 2026-11-17 接入[手机端待实现清单](pending/README.md)，已实施并部署 Ubuntu mw-dev，本地与R1验证通过，Android真机复核待验收；见[实施记录](../verification/mobile-pending-20261117/README.md)。

## 1. 目标与已确认需求

每天定期检查用户选定的观察范围，输出可以快速阅读、长期保存的简报。公共链路稳定，具体分析栏目以后逐步增加。

用户已明确确认：

- 品种来自用户指定的自选分组，自动跟随分组内成员增删；无需逐个配置简报品种。
- 北京时间每天 **08:00** 发送，时区使用 **`Asia/Shanghai`**，不跟随服务器或手机时区。
- 沿用现有手机推送，点击后进入 App 查看该期全文。
- 首期先搭建框架，以**最近交易日涨跌概览**跑通全流程。
- 四周突破只是未来设想，**首期不实现、不要求现在明确其定义**。以后可通过指标结果接入。
- 后续逐步增加指标栏目；周报、每四小时简报是未来扩展方向，首期只交付每日晨报。

不需要继续澄清即可形成并执行本方案。下文未由用户逐项指定的行为属于本方案的实施默认值，执行 Agent 可以在保持范围与产品语义的前提下调整内部细节，并在交付中记录。

背景：[需求分析与代码依据](../analysis/market-briefing-20261117/README.md)。

## 2. 仓库、基线、工作目录与风险

- 项目：`/home/quant/repos/market-watch`。
- 编写方案的基线：`main@1f2005c3`。
- 当前文档工作树：`/home/quant/repos/market-watch-briefing-analysis-20261117`。
- 当前分支：`docs/market-briefing-analysis-20261117`；本方案与分析文件目前均未提交。
- 实施前重新读取根 `AGENTS.md`、核实最新远端 main 和部署候选，保留本工作树文档，基于最新 main 建立独立实施分支／工作树。不要覆盖其他任务或默认合入其他未完成分支。
- 本次文档工作为 **P0**。未来实现为 **F1**：增加持久化表、后台定时职责、通知类型及 Android 链接入口，必须验证迁移、重启恢复、既有告警回归和适用的独立 Standards／Spec review。
- Ubuntu 本机 Docker 开发与验收；常规 R1 复用持久实例 `mw-dev`，HTTPS 18443。破坏性迁移／并发测试使用独立测试库。
- 不从方案或开发授权推断 main 合并、正式 tag、Unraid 发布和永久数据删除授权。

## 3. 首期产品范围

### 3.1 一个晨报计划

首期只提供一个“每日晨报”计划，减少管理界面。配置为：启用开关、指定分组。支持选择一个或多个**已存在的真实分组 ID**，不提供“全部自选”这种会悄悄扩大范围的隐式目标。

时间固定展示为“每天 08:00 · 北京时间”；首期无需时间编辑器、cron、任意频率或任意指标配置器。保存计划时使用版本号避免覆盖另一端已保存的配置。首次默认未启用，用户选组并启用后生效。

新建或重新启用计划时，下次自动执行为下一个未来 08:00，不自动补发启用之前的晨报。可使用“预览”立即查看当前数据；预览不发推送。

### 3.2 App 入口、正文与历史

入口为 **更多 → 简报**，复用现有手机控件与主题，不增加底部导航项。

- 首页展示计划状态、选中分组、下次时间，以及按新到旧排列的报告历史；历史使用游标分页，每页 20 条。
- 可修改分组、启用／暂停计划，提供“预览”操作。预览通过后台任务生成，复用同一计算链路，明确标为预览，与正式报告区分。
- 正文显示报告日期、计划时间、实际生成时间、分组快照、行情覆盖情况与分类涨跌列表；逐行保留来源、价格口径、实际交易日。
- 涨跌按资产类别分组，组内默认涨跌幅降序；提供简单的升／降排序，完整条目可查看，避免仅显示截断排行。摘要只选少量代表项。
- 行可打开相同 ticker／来源／口径的 D1 图表；返回时保留报告与滚动位置。首期不依赖尚未实施的事件时间定位。
- 无分组、空分组、配置失效、生成中、部分完成、读取失败分别展示。离线可以读取**曾成功缓存的报告**；未缓存正文给出就地提示，不承诺首次离线生成。
- 普通保存成功原位体现；错误就近显示并写现有日志，不新增顶部提示浮窗。

历史首期不自动清除。每天一份对个人使用规模有限；分页读取，避免为未确定的保留期增加清理任务。旧报告不随分组、行情或参数变化而重新计算。

### 3.3 动态分组

从 `AdvancedPreference` 中读取 `kind=setting, name=mw.watchlists.v1, tool=''` 对应的 `content.value.lists`，沿用服务器已保存版本。不要另建影子品种清单，也不要依赖手机当前选中的分组。

- 每期创建时固定组 ID、名称、preference revision 和成员 ticker；出报过程中的修改下期生效。
- 同一期对 canonical ticker 去重；同名但不同来源／口径的品种不能合并。用现有 `chart_series.decode/encode` 处理身份。
- 新增品种下一期直接展示最近交易日涨跌；移出品种不再出现。首期没有信号基线或历史事件补推。
- 部分选中分组已删除：保留仍有效的组，报告配置异常；全部被删除：生成配置失效记录，不回退到其他组，界面要求重新选择。
- 分组存在但合计成员为空：生成“本期无扫描品种”的报告及简短摘要，方便识别实际配置；不能写成“没有机会”。

## 4. 涨跌概览的数据合同

### 4.1 确认日线与计算

每个品种使用同一来源、日历、价格／复权口径的最近两根**确认 D1**：

```text
change = latest.close - previous.close
change_pct = change / previous.close × 100
```

使用 Python `Decimal` 接收原始十进制字符串计算；不要先按显示精度截断价格再计算。结果保存为十进制字符串，最终显示百分比两位小数；负零规范为 0.00%。分母非正、非有限值或 OHLC 无效时，不展示误导性百分比，保留原因；允许显示有效的绝对变动。

“昨日”在产品中写成“最近交易日”，显示两根柱的实际交易日标签。周末、节假日沿用最近正常完成的交易周期，并标注日期；不同市场允许不同日期。

只选择 `complete/confirmed` 合法且真实结束时间不晚于本期数据截止的柱。不能拿 UTC／交易所日期标签直接当真实结束时间，也不能仅凭“柱日期小于今天”确认。优先复用各源的 `NativeBarRow`／既有完成判断和日历，不自行改写日界。

### 4.2 本期时间含义

- `scheduled_for`：本期北京时间 08:00 对应的 UTC 时间戳。
- `cutoff_at`：正式报告默认等于 `scheduled_for`；预览为预览创建时间。只纳入在此时刻以前结束的交易周期。
- `collected_at`：抓取／读取时间，可能晚于 cutoff；这不代表行情事件发生在抓取时刻。
- `data_end/trading_date`：每个品种实际最新确认柱的时间和交易日，必须保留。

08:00 是后台触发时间；允许有限的数据读取时间，默认目标 08:03 前完成首期选定范围的生成并入投递队列。不是承诺所有来源与移动网络都在 08:00:00 到达；验收分别记录触发、生成、ntfy 接收及手机实收时间。

在读取窗口中允许接收“截止前已结束、但稍后才发布”的确认柱；不混入截止后的新周期。

### 4.3 状态与覆盖

每个 ticker 至少返回：身份、名称／资产类别、来源与口径、两根柱时间／收盘值、绝对和百分比变动、数据时间、状态及原因。

状态使用有限集合：`ok`、`not_updated`、`insufficient_history`、`unsupported`、`source_error`。正常休市为可解释的 `ok`，不以统一“超过24小时”规则判过期。

“尚未更新”依据该源日历和预期完成周期判断；无法可靠判断预期交易日时，只展示实际日期与“新鲜度未核实”，不要猜测正常更新。过旧值允许在明示日期的参考区域展示，但不计入本期有效排行。

覆盖数量分开统计有效、尚未更新、历史不足、不支持与失败。只要部分有效就正常发布 `partial` 报告；全部无法计算为 `failed`，通知应说“简报未完成”，不能说“市场没有变化”。

股票保留复权说明；连续期货保留换月／拼接口径提示；不跨源补价，不把黄金期货与黄金 CFD 混成同一品种，不把当地价格变动包装成美元账户收益。

### 4.4 读取路径与成本

新增的 `briefing_inputs.py` 对外只暴露有限读取入口，返回确认柱和数据依据，隐藏不同 series kind 的细节：

- `provider`：复用供应商元数据、缓存与原生 D1 读取。先查已提交缓存，必要时按现有有限页读取路径补一小页，首期目标最近 10 根内取得 2 根确认柱，不遍历全历史。
- `history`：读已发布 D1 产物，保留版本／checksum。固定版本本来不向前更新，应在正文显式标为固定历史，不伪装当前市场。
- `composite/managed`：只读取现有可用的确认 D1，固定本次版本／修订；关闭实时或历史未接续时照实标注。不能为了简报开启实时开关、创建组合、登记维护计划或补建 M1。
- 身份解码使用 `chart_series`；provider 元数据走 `provider_chart.metadata`，固定／组合元数据走 `series_access.metadata`。不要把 `market_data.resolve()` 当纯解析器，它可能创建 Instrument，且不接受所有 provider 类型。

实施时优先用 `provider_cache` 已有的提交／确认与资源预算路径；不要在简报里重复实现各源 HTTP 适配。`provider_chart.cached_page()` 本身会使用前台 lane，直接调用不能证明满足后台优先级；复用／提炼底层函数时要让简报请求明确使用现有 `history` lane，并验证源级配额生效。

不要构造浏览器 session／NativeHistoryLoad 消费者心跳来维持后台简报。也不要在网络 I/O 期间占住报告写锁或数据库连接。

默认后台读取并发不超过 2，受现有更严格来源限流约束；单请求遵循现有各源预算并受本期剩余预算限制，总生成预算默认 180 秒。先快速读取所有已缓存项，再补取不足项，避免开头的慢来源吞掉全部机会；超预算的条目明确记录原因。默认不增加第三方调度、计算或队列依赖。

## 5. 栏目扩展方式

新增 `briefing_sections.py`，用一个简单注册表映射栏目 ID 到普通计算函数，首期只有 `daily_change`。不要建插件发现、动态 import、任意脚本或用户表达式引擎。

最小合同如下，名字可以按现有项目风格调整：

```python
# 草案；实施时创建类型并落地，不是现有 API。
SectionSpec(id, version, parameters, required_frames)
BriefingContext(report_id, members, window_start, cutoff_at, deadline)
SectionResult(id, version, title, items, coverage, issues)

compute(context, inputs, parameters) -> SectionResult
```

栏目只计算和返回结构化事实；不自行推送、保存报告、访问 App 状态或修改分组。共享 `inputs` 按数据身份／周期缓存本期有限读取结果。框架负责隔离栏目错误、组织结果、持久化、摘要及 App 通用展示。

栏目条目包含稳定的 ticker、数据时间、指标值或变化值、可显示的简短说明。首期只需要基础表格行；为未来特殊栏目留出 `kind/version` 判别，不提前建设全套任意布局渲染器。

以后增加指标：确定算法与参数 → 复用图表指标计算 → 增加栏目函数及必要的薄层条件判断 → 注册 → 验证。指标值不一定等于事件，届时再明确期间事件还是当前状态；需要扫描进度、去重或入组基线时再增补持久化。

验收扩展点时可以注入测试用的第二个栏目，证明一个失败不阻止另一个返回；不得为了验收把四周突破偷偷做成产品栏目。

## 6. 持久化与后台执行

### 6.1 两个新增模型

使用 `storage.py` ORM＋一条 additive Alembic migration，按实施时真实 head 分配 revision，不复用其他任务 revision。

| 模型 | 主要字段与约束 |
| --- | --- |
| `BriefingPlan` | 稳定 ID、workspace scope、enabled、group_ids JSON、timezone、local_time、section_specs JSON、revision、next_run_at、created_at、updated_at |
| `BriefingReport` | UUID、plan_id、mode（scheduled/preview）、scheduled_for（预览可为空）、cutoff_at、status、attempt、成员／配置快照 JSON、正文 JSON、摘要 JSON、started_at、finished_at、notification_id、error |

正式报告唯一约束 `(plan_id, scheduled_for)`；预览不占用正式计划时间。报告状态收敛为 `pending/running/ready/partial/failed/skipped`。正文内部包含 schema_version、栏目版本和输入依据。

报告发布后正文不可被刷新或读取接口改写；投递状态通过现有 Notification／Outbox 关联读取，不写进不可变市场事实。生成失败后的恢复只适用于未发布报告，不重算已发布一期。

计划与自选均沿用当前单用户 workspace 权限体系。API 仍需登录与写入 CSRF 校验；未来不能从伪造的 report ID 访问其他权限范围。

### 6.2 定时与恢复

在现有 `notification_runtime.build_loops()` 加一个小型 `briefing_generation` loop；复用 notifications runtime 的单所有者约束，不增加 Compose 服务、Redis、Celery 或宿主机 cron。

- 使用 `zoneinfo.ZoneInfo('Asia/Shanghai')` 计算下次本地08:00，持久保存 UTC `next_run_at`；空闲检查最长30秒，避免空转。
- 到时用短事务锁计划，唯一插入本期 report，固定分组、成员与栏目配置，推进下次执行时间；离开事务后读取行情与计算。
- 保存最终正文、创建 `Notification(kind='briefing')` 和唯一 Outbox 在同一事务中完成。生成重试不能创建第二条报告或第二个 Outbox。
- 报告 claim／完成沿用现有短事务和 attempt fencing 模式：领取递增 attempt，发布时核对仍是本次 attempt。不要开发通用分布式任务平台。
- 进程重启后恢复未发布任务，保留原成员快照与 cutoff；限制生成尝试次数，默认最多2次。超过该期预算后发布已有有效项，或记录明确失败，不无限等待。
- 对“到时服务未运行”的情况：默认只补当天08:00的一期，补发窗口到北京时间10:00；不补发过往多天。超过窗口记 skipped 并展示原因，下一期照常。创建／重新启用时间晚于08:00的计划不适用启动前补发。
- 补生成时仍以原08:00为 cutoff，标明“补发”和实际生成时间；不把恢复时刻之后的新周期纳入原晨报。恢复后的总预算仍有限。
- 暂停计划后不创建新自动报告；若本期已经在生成，完成保存正文但取消尚未发送的自动推送。已被服务端接收的消息不能撤回。已发布历史仍可查看。
- loop 的真实读取、计算和保存进度接入 `runtime_health`；核对新角色 expected_roles、deadline 和空闲周期。长请求必须有有限 timeout，不能因正常65秒级源预算触发虚假60秒超时，也不能只靠空心跳伪装进展。

请求严重异常不应阻塞已有 notification_delivery／projection 线程；本次仅增加受监督的独立 loop，不改告警判定语义。

## 7. 简报专用投递语义

复用当前 `Notification`／`Outbox`／`DeliveryAttempt` 和 ntfy 连接配置，在 `notify.py` 增加明确的 briefing 分支：

- 摘要：报告日期、有效覆盖数、少量分类涨跌代表项、点击查看全文。无有效结果时改为简短失败说明；不把错误堆成长消息。
- ntfy 优先级默认3；不使用高优先级连续响铃，不带“确认后停止提醒”按钮，不创建 AckGrant，不占未处理告警数量。
- HTTP 已接受后状态为 `server_accepted`，保持 Outbox accepted，不因用户未读而再次发送；不宣称手机已实收。
- 仅失败／结果未知时有限重试：默认最多3次发送，间隔30秒、120秒；401/403直接 blocked。旧晨报自动重试截止到计划时间后2小时，避免全天反复送旧报告；预览从不进入此分支。
- 重试复用报告ID与通知ID。网络请求超时存在“服务端已收、客户端未知”的情况，不能保证 ntfy 严格恰好一次；防止应用重复入队，并保留真实尝试记录。
- 明确尊重既有全局 delivery_enabled、ntfy配置与静默时段；静默期结束已经超过投递有效期时，不再推送，正文仍保留。App 就地显示未推送原因，不暗中改用户通知设置。
- 不把简报伪装成 signal/system 类型，不调用告警确认接口；现有系统通知、测试通知、告警与 companion 消费者仍按原类型处理，补充跨类型回归。

保留现有告警的优先处理。若简报增加后会排在过期简报重试前而延误实时告警，调整领取排序优先 signal/system，再处理 briefing；不为此建立第二套发送服务。

## 8. 点击推送进入 App：明确 Android 依赖

现基线 `mobile/client` 的 MainActivity 只加载已保存服务器的 `/m/`，Manifest 没有接收业务深链接的 intent-filter。单纯把 ntfy click 填成 HTTPS `/m/more?...`，通常只能证明浏览器可开，不满足已确认的 App 直达。

方案采用最小自定义 URI 入口，建议：

```text
marketwatch://briefing/open?origin=<编码后的可信HTTPS-origin>&report=<UUID>
```

- 在现有包 `com.kookvv.marketwatch` 的 Manifest 注册窄范围 VIEW/BROWSABLE 入口，处理冷启动和 `onNewIntent` 热启动，避免重复 Activity／重复 WebView。
- 只接受上述路径、合法 report UUID 和与 App 已保存服务器相等的正规化 HTTPS origin；不要接收任意跳转URL，不从链接更换服务器，不传登录token。
- 未配置服务器或来源不一致时，显示需要先连接相应服务器的就地说明；不自动切换，也不请求未知服务器。
- 统一网页落点为 `/m/more?briefing=<UUID>`。未登录时在当前服务器完成登录后继续进入该报告；对无权访问、404、服务不可达分别显示。
- 热启动优先通过受来源限定的既有桥接／网页事件请求导航，沿用未保存表单保护；不要直接 loadUrl 销毁正在编辑的页面。冷启动在页就绪后处理一次，不重复消费 Intent。
- Android 返回从正文回简报历史，再回更多；登录过程、页面刷新和重复点击不能丢失或重复堆叠目标。
- ntfy `click` 使用此 URI；摘要附加正常 HTTPS 正文地址作为无 APK 时的手动备用入口。必须核实当前 ntfy Android 客户端对该 click 的实际支持，不能仅凭 ADB 或浏览器结果宣称通知链路通过。

这会产生需要安装的新 APK。实施时核对实际待升级版本再递增 versionCode，记录候选 hash；不自行发布正式签名升级包或替用户安装。构建、URI校验单测和必要模拟器检查可在 Ubuntu Docker 完成；手机上真实 ntfy 点击的最终验收单独标记。

## 9. API 合同

新增 `briefing_api.router(authenticated)`，挂到 `/api/briefings`，沿用现有登录、CSRF与错误返回约定。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /plan` | 当前计划、revision、选组状态、下次执行与投递条件 |
| `POST /plan` | 保存 enabled/group_ids，核对 revision；冲突返回409 |
| `POST /preview` | 校验配置／分组并提交 preview report，返回id与状态，不推送；重复 request_id 不重复创建 |
| `GET /reports?before=...&limit=20` | 正式报告游标分页；默认不把预览混入晨报历史 |
| `GET /reports/{id}` | 已保存正文／状态与投递摘要；可读取本人创建的预览 |

GET 不触发行情补取或重算。生成中的报告由页面前台短间隔有限轮询读取；关闭、退到后台、切服务器或登录失效即停止／取消，完成后不再轮询。无需首期增加 SSE主题。

默认不提供“立即向手机发送预览”按钮，避免把预览与实际推送混用；未来有需要再独立增加显式发送动作。

## 10. 文件改动地图

下面是建议落点；执行时可在维持小模块与依赖关系的前提下合并紧密文件，不为文件数量拆层。

| 文件 | 预期改动 |
| --- | --- |
| `backend/alerts/briefing_service.py`（新） | 计划保存、分组快照、报告创建／完成、查询与幂等 |
| `backend/alerts/briefing_inputs.py`（新） | 多类身份解析、有限确认D1读取、日历与来源依据 |
| `backend/alerts/briefing_sections.py`（新） | 小型栏目合同、注册表、daily_change计算 |
| `backend/alerts/briefing_worker.py`（新） | 到期检查、预算、恢复、预览与逐栏目执行 |
| `backend/alerts/briefing_api.py`（新） | 上述受保护接口 |
| `backend/alerts/storage.py`、`migrations/versions/` | 两个模型、唯一约束／索引和 additive migration |
| `backend/alerts/api.py` | 挂载 router |
| `backend/alerts/notification_runtime.py`、`runtime_health.py` | generation loop与角色健康 |
| `backend/alerts/notify.py` | briefing领取、payload、优先级、有限重试，无ack分支 |
| `backend/alerts/provider_cache.py` 等既有读取入口（按需） | 提炼可由后台调用且保留history配额的有限读取；不另写供源SDK |
| `web/src/mobile/BriefingsSheet.tsx`（新） | 计划、历史与报告正文；可按复杂度拆分 |
| `web/src/mobile/briefings.ts`、`briefings.css`（新） | 小型API／类型、专属样式，不依赖告警store |
| `web/src/mobile/MorePage.tsx`、`MobileApp.tsx`、必要时`shell.ts` | 更多入口、路由目标、受控返回与可信壳事件 |
| `mobile/client/.../MainActivity.kt`、`AndroidManifest.xml` | 可信URI、冷／热启动、保持现有WebView与返回保护 |
| `mobile/client/.../BriefingLink.kt`及对应单测（新） | 可独立验证的URI解析，不导入业务缓存 |
| `mobile/client/app/build.gradle.kts` | 实施时按真实基线递增版本，避免覆盖并行APK候选 |
| `backend/tests/test_briefing*.py`、`web/tests/mobile-briefings.browser.cjs`（新） | 关键行为与算术／时间／投递／浏览器验证 |
| `deploy/ubuntu/briefing.contracts.yaml`（新） | 带任务归属的隔离PG与测试服务，不替代持久mw-dev |
| `docs/verification/market-briefing-<实际日期>/README.md`（新） | 命令、证据、候选、回退及真机状态 |

## 11. 按依赖排序的实施步骤

1. **基线与边界核查。** 读取 AGENTS 与相关手机 skill；同步远端，确定实施worktree。核实通知类型、当前MainActivity、真实watchlists JSON、迁移head与供源缓存路径；记录差异，保留其他候选。
2. **建立验证环境。** 新增上述任务专属 Compose，PG14.24沿用已固定digest，独立volume/network和测试凭据，禁止指向开发库或生产库。contracts使用候选后端镜像挂载候选源码；为浏览器／Android构建复用或准备有任务归属的Ubuntu Docker工具环境。记录实际环境，不拿旧任务镜像ID硬凑。
3. **先做数据与合同。** 实现身份／分组快照、输入读取与纯daily_change栏目；核对D1真实边界和小页预算，完成确定性算术、来源身份、日历与错误用例。
4. **迁移与报告服务。** 加两表与索引，完成plan/revision、报告不可变、创建唯一性、预览去重、原子创建Outbox；测试旧库升级与幂等bootstrap。
5. **后台执行。** 接入单个generation loop、08:00计算、补发窗口、预算、暂停、重启恢复和role健康；断点恢复不产生第二份报告。
6. **推送适配。** 增加briefing类型与有限重试，验证告警及测试通知不回归；使用隔离ntfy或HTTP替身，不向现有真实手机topic发测试消息。
7. **App界面与Android入口。** 复用现有 shadcn/Base UI、Drawer/Field/Checkbox/Switch等；按当前 `market-watch-mobile-ui` 控件模式实现，处理深浅主题、请求取消、未保存保护、缓存隔离与冷／热链接。
8. **最小回归与F1审查。** 跑第12节相关测试、迁移兼容性、自审和独立Standards/Spec审查；修复阻断问题。不要因纯规划阶段就创建实现中的空壳代码。
9. **Ubuntu R1。** 先检查持久实例候选和资源，按既有mw-dev切换入口部署，不覆盖另一任务。以真实选定来源样本读取确认日线，记录08:00等价时钟触发链路；真实推送验收如需发送到用户手机，单独取得这项明确授权。
10. **交付。** 输出候选与Draft PR、检查结果、Ubuntu实际地址、启动／停止／回退命令和Android待验收项。main合并、正式tag及Unraid发布按AGENTS检查点停止，不自动进行。

## 12. 验证矩阵与可运行命令

### 12.1 必须覆盖的行为

| 类别 | 必验用例 |
| --- | --- |
| 算术 | 同源两根确认D1；正／负／零变动；显示取整不影响计算；非正分母、非法数值 |
| 时区 | 主机UTC／纽约／上海下均为上海08:00；跨日、纽约夏令时、周末与节假日 |
| 行情 | 形成中柱被排除；source_date标签不当真实结束；固定历史不冒充实时；来源错误和缺历史分别计数 |
| 分组 | 增删下一期生效；同ticker去重；同名异源保留；删组、空组、分组revision快照 |
| 调度 | 开启后下一个未来08:00；最多补当天一期；10:00后skip；重启保留原cutoff；同时领取只生成一次 |
| 报告 | 发布后再读不重算；修改组／参数不改旧报；preview不占正式期、不发推送 |
| 投递 | 报告与Outbox原子提交；success后不因未读重发；超时有限重试；401/403阻断；到期停止；不开ack |
| 隔离 | 不改变实时开关／维护计划／告警确认；读取不创建订阅；供源限流仍生效；signal/system/test优先语义保留 |
| 栏目 | 测试用第二栏目失败时daily_change仍出报；增加函数不改调度／投递代码 |
| Web | 更多入口、历史分页、正文、source/日期、离线已缓存报告、登录后直达、返回、关闭取消请求 |
| Android | URI校验；冷／热启动；错服务器不自动切；未登录目标保留；未保存表单保护；重复Intent只消费一次 |

### 12.2 创建测试入口后执行

以下命令**在实施步骤2创建所列Compose／服务和测试文件之后**才成立，本轮不执行。全部服务运行在Ubuntu本机Docker，工具版本与依赖按锁文件准备；不得隐式build或用旧任务image替代候选。

```bash
# 在实施工作树根目录执行；变量不包含凭据。
export MW_BRIEFING_REPO="$PWD"
export MW_BRIEFING_API_IMAGE=market-watch-api:briefing-framework-candidate

mw-docker build --repo . --component api \
  --tag "$MW_BRIEFING_API_IMAGE" \
  --task mw-briefing-framework --project mw-briefing-contracts --purpose acceptance

docker compose -p mw-briefing-contracts \
  -f deploy/ubuntu/briefing.contracts.yaml up -d --no-build --wait postgres

docker compose -p mw-briefing-contracts \
  -f deploy/ubuntu/briefing.contracts.yaml run --rm contracts \
  python -m pytest -q backend/tests/test_briefing.py \
  backend/tests/test_briefing_postgres.py backend/tests/test_briefing_migration.py \
  backend/tests/test_briefing_notifications.py \
  backend/tests/test_notification_outbox_postgres.py \
  backend/tests/test_notification_runtime.py

docker compose -p mw-briefing-contracts \
  -f deploy/ubuntu/briefing.contracts.yaml run --rm contracts \
  python -m ruff check backend/alerts/briefing_service.py \
  backend/alerts/briefing_inputs.py backend/alerts/briefing_sections.py \
  backend/alerts/briefing_worker.py backend/alerts/briefing_api.py

# web-checks 由步骤2准备工具镜像、可写工作目录及依赖，不在nginx最终镜像中运行。
docker compose -p mw-briefing-contracts \
  -f deploy/ubuntu/briefing.contracts.yaml run --rm web-checks npm run build

docker compose -p mw-briefing-contracts \
  -f deploy/ubuntu/briefing.contracts.yaml run --rm web-checks \
  node tests/mobile-briefings.browser.cjs

docker compose -p mw-briefing-contracts \
  -f deploy/ubuntu/briefing.contracts.yaml run --rm web-checks \
  node tests/mobile-more.browser.cjs

# android-checks 同样由步骤2准备 JDK17/SDK35，working_dir为候选mobile/client。
docker compose -p mw-briefing-contracts \
  -f deploy/ubuntu/briefing.contracts.yaml run --rm android-checks \
  ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

contracts 的 `PYTHONPATH` 指向候选 `/candidate/backend:/candidate/backend/tests`；`TEST_POSTGRES_URL` 及测试需要的数据库变量只指向新隔离postgres，不输出已有私有env。迁移测试要从旧head真实建库升级、验证旧通知／自选保留、新表可用及重复bootstrap；测试清库只限独立测试库。

web-checks须能读取完整构建所需的已授权图表资源，依赖放任务工具目录／volume，避免修改他人node_modules；浏览器375/412px、深浅主题、150%字号、长品种／分组名、键盘和抽屉退场都需截图与交互证据。新样式限定简报作用域。

如现有并行任务改变受影响接口，增加对应回归而不把整个仓库无差别重跑。测试通过后再进入适用的Ubuntu R1。

### 12.3 持久开发实例与真实链路

只读核查入口：

```bash
python3 deploy/ubuntu/mw_dev.py status
docker ps --filter label=com.docker.compose.project=mw-dev
df -h /home/quant/repos
free -h
```

按实际运行状态核对source/frontend模式和候选来源。镜像模式下，使用 `mw-docker` 分别构建本任务api/web候选，在仓库外私有compose配置中仅调整核实后的镜像引用，再按既有入口迁移与启动；源码模式下先确认真实bind目录，不能切换到另一个任务的checkout。

`python3 deploy/ubuntu/mw_dev.py migrate` 会备份并停止现有写入服务，**不得在未检查当前候选和协调并行任务时直接调用**。部署前记录原镜像／源码与回退方法。暂停验收只停止经核实本任务相关服务，不停止其他任务；不能通过删除volume回退。

验收URL默认为实际Ubuntu主机的HTTPS18443，以运行时核实为准。验证记录必须写出实际主机、完整访问地址、所用compose/env路径（不含内容）、准确启动／停止命令、迁移结果、样本行情和报告ID。不能沿用旧文档18445隔离地址冒充当前默认实例。

真实来源样本至少包含Dukascopy外汇／黄金，以及一个原生慢更新市场品种；遇到源未启用或本次无授权数据，只记录限制，不暗中改全局源配置。用真实数据对比确认D1与报告，不能以HTTP替身证明真实行情正确。

时间／失败／重启场景在隔离测试库用可注入时钟和HTTP替身验证；不要改宿主机时间、停真实供源或制造mw-dev数据损坏。手机实收、锁屏点击、冷启动、已登录／未登录后全文的真实链路是独立Android验收，未实际完成必须标待验收。

## 13. 迁移兼容、回退与完成条件

- 新迁移只加表／索引，默认无启用计划，不改既有自选与告警数据。
- F1回退保留兼容API和新增表/报告，可回退Web与worker。旧API会把无ack的briefing计入未读，完整API回退必须先带上通知计数兼容修复；不要drop表。
- 回退前暂停晨报计划并处理尚未发送的briefing Outbox，避免旧版notify不认识新kind。新的普通briefing未被旧版领取不等于可以不验证；用真实旧候选验证旧类型仍可投递、不会产生告警未读异常。
- 本任务生成的测试volume和证据按AGENTS归档／退役，永久数据删除需另行授权。保留来源、代理、ntfy与登录配置。
- 完成实现必须满足：首期范围全部可用、适用检查通过、有迁移和重启证据、报告输入可追溯、原告警不回归、Ubuntu R1与Android状态明确、交付实际运行和回退入口。最终手机点击尚待用户真机时，不得写“全部端到端已验收”。

停止边界：不能证明数据身份／确认状态、当前候选冲突、迁移破坏旧数据、URI无法满足App直达或资源不足时，保留现场并报告阻断事实。常规实现细节由Agent处理；只有新增用户可见范围、生产操作或AGENTS规定检查点需要用户决定。

## 14. 可直接交给执行 Agent 的启动指令

```text
在 market-watch 项目按 docs/plans/2026-11-17-market-briefing-framework.md 实施。
先读取 AGENTS.md、方案和当前手机UI skill，保留文档工作树，核实远端最新main后建立独立实施工作树。
首期只做动态指定自选分组、北京时间每天08:00、涨跌概览、报告历史、现有ntfy摘要与App全文直达，以及简单栏目扩展接口。
四周突破、指标信号、周报和每四小时简报都不实现。
按F1执行迁移、恢复、通知回归与适用审查；开发和验收只用Ubuntu本机Docker，常规R1复用mw-dev，先检查正在部署的候选，不覆盖其他任务。
完成候选、测试证据、Ubuntu R1和Draft PR，明确Android真机待验收项。
不要逐步询问普通实现细节；不要合并main、发布正式tag、操作Unraid、向真实手机topic发测试消息或删除永久数据。
```
