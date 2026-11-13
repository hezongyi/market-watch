# 手机数据页全流程方案

状态：实施中。2026-11-13 核对并形成方案后，已获“实施方案，并验证”授权；在独立分支 `feat/mobile-data-workflow-20261113` 实现。功能、浏览器夹具证据与真实环境缺项见 [执行记录](verification/mobile-data-workflow-20261113/README.md)。本文后续“待实现”用语保留为原始方案要求，不代表验收已经完成。

## 1. 目标与基线

让用户在手机数据页完成：**搜索原生品种 → 创建自建行情 → 准备与维护历史 → 开启实时接续 → 打开图表或加入自选**。常见流程不跳转桌面，不展示配置向导式的多级步骤。

- 项目：Market Watch。
- 本文所在工作树：`/home/quant/repos/market-watch-android-personal-v205`，分支 `feat/android-personal-v205`，当前提交 `3db23c0141cfa86b99383d92688229b26f985d6b`。
- 已合并基线：`v2.0.11`，指向 `e1d3cd8de3c76d6eba20b1ffeb820cd39f932d71`。本次核对的手机端、数据中心、创建、维护和接续文件与该 tag 无差异。
- 后续实现从 `v2.0.11` 新建独立 worktree/branch；不继续向已合并的 PR #131 推送。开始前检查 `main` 后续变更，发现相关接口变化时更新本文差异，不覆盖其他任务。
- 应用 `AGENTS.md` 和 `market-watch-mobile-ui` skill。既有 shadcn/Base UI、主题、抽屉、返回键、表单保护继续复用。
- 风险暂定 **F0**：新增手机端写操作入口及必要的兼容摘要字段；不改 schema、数据身份、后台采集规则和持久化协议。若实施需要改变这些边界，先说明范围升级。

## 2. 已核实的实现与限制

| 能力 | 当前实现依据 | 本次处理 |
| --- | --- | --- |
| 手机数据列表和详情 | `web/src/mobile/DataPage.tsx`，当前默认原生，原生/自建 Tabs；同时被自选搜索复用 | 独立数据主页改为自建；保护自选搜索用途 |
| 自建摘要 | `backend/alerts/dataset_summaries.py`、`data_center.py::_dataset_query` | 继续使用批量摘要，一份数据集一行，不混入目录身份或映射目标 |
| 创建目录与来源能力 | `CreationCatalog.tsx`、`history_catalog.py::creation_entry`、`history_creation_check.py` | 复用创建专用目录及能力，不把通用行情目录直接当可创建目录 |
| 创建与结果核查 | `DatasetCreate.tsx`、`history_commands.py::create_managed/lookup_creation` | 复用创建前检查、`create_only`、请求标识和结果核查 |
| 历史维护 | `MaintenanceSettings.tsx`、`history_maintenance.py`、`history_commands.py` | 手机补设置、立即更新、暂停/恢复、区间补数及任务控制 |
| 实时映射和开关 | `MappingForm.tsx`、`mapping.ts`、`DatasetContinuation.tsx`、`managed_continuation.py` | 手机补首次配置及开启/关闭；复用服务端规则 |
| 匹配规则 | `composite_matching.py::product_rule/check_match` | 产品属性使用服务端建议；不在手机增加自己的等价规则 |
| 开图和加入自选 | `mobile/dataMarkets.ts::loadManaged/actionableRow`、`DataPage.tsx::add/openRow` | 保留使用时解析；固定历史 `MWH:`，实时接续 `MWC:` |
| 服务端持续实时需求 | `market_usage.py::composite_targets` | 保存开启选择后由服务端持续采集，不要求手机停留此页 |

必须明确的现有边界：

1. 实时接续目前要求 **M1 基础 Bid 历史**及当前 OANDA Practice 账户的有效匹配；不是所有自建都支持。
2. 当前已核实规则具体覆盖 Dukascopy `EUR/USD`、`USD/CAD`、`XAU/USD` 到 OANDA 对应品种，以及当前 OANDA 账户这三个品种的同源匹配。是否可用还取决于账户目录、类型、精度与历史基线，最终以接口为准。Yahoo、AKShare、Binance、FXCM 自建仍可创建维护，本轮不扩大其接续能力。
3. 首次接续要有已发布且非空的 M1 产物，并在日界拼接点之前有历史基线。不能用“出现任意可用周期”替代此条件。
4. 黄金跨来源存在产品差异，必须保留一次明确确认；不是添加一段资料或勾选就能支持未知产品。
5. 历史定时维护、当前维护任务、实时接续独立控制。暂停定时维护不会停止当前任务，也不会关闭实时。
6. 实时开关按历史 `instrument_id` 保存。若多个数据集共享该身份，开关可能共同生效；不得在 UI 承诺绝对逐数据集隔离。需要时在开启/关闭确认中提示共享影响，不为此重做数据模型。
7. 新发布的历史不会自动替换既有接续的固定基线与拼接点；手机维护设置不应暗示会迁移已有图表和告警引用。

## 3. 界面结构：三个核心界面

### 3.1 数据主页：只显示自建行情

- 标题“数据”；右上角仅一个搜索图标，可访问名称“搜索并添加行情”。移除原生/自建 Tabs、常驻来源下拉和解释性副标题。
- 每行显示：代码、简明中文名、来源、数据截至时间；右侧只突出当前需要关注的状态，例如准备中、更新失败、维护已暂停、实时运行中。
- 一行按 `dataset_id` 标识，不因固定历史/实时接续拆成两行。不同来源、日界或价格口径的数据集允许同代码并存，必要时补一条区分信息。
- 默认显示未归档的全部自建，包括暂停、失败、准备中及一次性历史。归档项进入列表次级筛选“已归档”，可以恢复，不以删除替代归档。
- 列表上方保留一个轻量“筛选自建行情”输入；来源、需处理、已归档筛选收进旁侧筛选按钮。与右上角打开原生目录的动作明确区分。
- 空态：“还没有自建行情”，唯一主操作“添加行情”；筛选无结果时使用不同文案及“清除筛选”。
- 点击整行进入详情。不在每行堆放更新、编辑、实时三个按钮。任务与来源移到筛选/次级菜单，不再常驻抢占标题栏。
- 复用分页与本机快照。新增后用摘要接口的 `anchor=dataset-<id>` 读取 `anchor_position` 并计算所在页；若被当前筛选排除，返回默认列表后定位，避免“添加成功却找不到”。

### 3.2 搜索添加：选一个品种，再确认一次

搜索使用全高 Drawer，返回恢复原列表、筛选和滚动位置。目录结果只显示代码、中文名、来源及必要能力提示。

1. 点击搜索，进入“添加行情”。搜索框配来源筛选，资产类别收进筛选，不先让用户选择原生/自建。列表按需分页，不下载全目录。
2. 点击品种，**原位置切到创建确认界面**，不再叠第三层抽屉。来源、代码、价格口径等已知信息自动带入。
3. 默认展示“历史起点”“维护周期”“自动更新”三项；具体维护时间显示一句摘要，在“更多设置”内修改。底部唯一主按钮“创建并准备历史”。
4. 必要字段缺失时在当前界面补全；来源不支持、连接未配置或能力验证失败时，直接显示原因及修复入口。
5. 创建成功返回列表并定位新行，显示“准备中”；可立即进入详情查看任务，无需守候或确认完成。

默认值决策：

| 模式 | 历史起点 | 周期与更新 |
| --- | --- | --- |
| M1 基础派生 | 默认近 30 个日历日，明确展示并允许改早；以创建前检查返回的交易日边界为准 | 默认 M1/H4/D1；M1 不可取消；每日 00:15 UTC，沿用既有规则 |
| D1 基础派生 | 使用目录 `default_start_date`；缺失时必须选日期，不猜最早历史 | D1/W1/MN；只有验证 D1 可用后才允许创建；沿用来源交易日 |
| 原生多周期 | 默认近 30 日，允许调整；这只是请求起点，不保证来源全部返回 | 默认选已验证周期中的 H1、D1；若均不存在，选首个已验证周期；至少一个。更多周期可手动选择 |

- 日界默认：外汇/金属 NY17，加密 UTC0，Yahoo/AKShare 沿用来源交易日。其他类别无法确定时要求选择一次，不静默指定。
- D1/原生多周期默认每日当地 18:00 更新，采用目录提供的时区；没有时区时显示并使用 UTC。按周期计划默认每日、重叠复查两根，沿用 `editableFramePlan`；本轮不改后台调度规则。时区与时间始终在确认摘要可见。
- 精度已知时只读展示；缺失时提供一个必填输入。不猜精度，不把价格字符串截断当数据修复。
- Yahoo/AKShare 等需要验证归档周期的来源：缺少当前口径的验证结果时，界面自动发起一次必要验证，并显示“正在验证可用周期”；失败提供“重试验证”。改变价格口径或模式后重做必要验证，不在渲染或定时刷新中反复探测。默认不额外增加一个“验证”步骤。
- “自动更新”映射 `daily/once`，关闭表示只准备本次历史；首次准备始终提交。创建阶段不再加入“完成后自动开启实时”的隐藏流程。
- 更多设置只放确有意义的选项：模式、复权/价格口径、日界、维护时间/时区、按周期计划、重叠复查。已确定的只读身份信息不伪装成可编辑设置。
- 搜索使用创建目录 `/history-catalog/search`。若需历史不支持项的说明，可呈现目录返回能力；不将其变成可点击创建。
- 目录为空/过期时提供“更新此来源目录”；只有用户点击才同步，不在普通搜索自动刷新供应商全集。AKShare 同步按 A 股/港股/期货分区；Yahoo 精确代码补录收进“未找到品种？”入口，复用现有 discover 接口。暂不加入任意代码的手工登记表。
- 重复项由创建前检查决定，点击“查看已有自建”；提交时遇到 409 同样进入已有项，绝不覆盖已有维护配置。不能只按代码去重。

### 3.3 行情详情：历史维护与实时接续在同一处

详情为一个 Drawer，默认按内容撑高，达到共享高度上限后内部滚动；创建/维护编辑可使用全高。详情固定包含两个简明区块：

**历史数据**：可用范围、可用周期、最近成功/当前任务状态。主操作“立即更新”，次操作“维护设置”；有进行中任务时主操作替换为“查看进度”。

**实时行情**：当前是否开启、真实运行状态、来源。首次显示“开启实时”；已开启显示状态与“关闭实时”。准备中、闭市、恢复中、认证异常使用服务端事实，不以开关开启替代运行就绪。

底部保留“打开图表”和“加入自选”，继续使用既有选择分组及冲突保护。实时开启但未就绪时说明原因；查看固定历史作为显式次操作，不能悄悄退回固定历史。

历史版本、任务记录、区间补数/复查、归档/取消归档放“更多操作”；不将所有功能排成常驻按钮。本轮不迁移历史回收删除、接续修订切换和完整覆盖审计等桌面高级工具。

## 4. 维护自建：必要操作及准确语义

| 入口 | 操作 | 行为与反馈 |
| --- | --- | --- |
| 历史区主操作 | 立即更新 | 提交一个 update 任务；显示“已提交，后台更新中”，不等待下载完成 |
| 当前任务 | 查看进度 | 显示真实阶段、已处理范围/周期、错误；无可靠分母时不编百分比 |
| 当前任务 | 暂停/继续/重试/取消 | 按服务端任务状态及 `controllable` 展示；取消需简短确认，已发布历史保留 |
| 维护设置 | 日期、周期、每日/一次性、时间 | 一次保存；高级按周期计划渐进展开；不改数据身份 |
| 维护设置 | 暂停/恢复定时维护 | 不影响当前运行任务和实时；一句说明放在按钮旁 |
| 更多操作 | 区间补数/复查 | 同一表单切换任务类型，只输入起止交易日期；明确“结束日不包含” |
| 更多操作 | 归档/恢复 | 归档保留历史与引用；不当作关闭实时或取消任务的替代操作 |

- 维护编辑使用 `expected_configuration_revision`；409 保留输入，显示最新值，用户主动载入后再保存。隐藏的高级设置原样带回，不能用手机默认值覆盖桌面配置。
- 保存计划不等于立即更新；成功反馈可提供“立即更新”按钮，不能静默再提交任务。扩展历史起点同样需要显式执行更新或补数。
- 已有任务时进入该任务，不重复建任务。后台任务在退出页面或 App 进入后台后继续，手机只暂停轮询。
- “重试”依实际任务类型处理，尤其部分成功可能返回新的任务 ID；以接口返回为准更新状态，不硬编码继续跟踪原 ID。
- 若保留了旧固定历史且本次更新失败，同时显示“已有历史可用”和“本次更新失败”，不能整条标成无数据。
- 归档项的“取消归档”不会顺带恢复暂停计划或开启实时。关闭实时也不取消历史任务。

## 5. 开启实时：首次一次核对，后续直接开关

### 5.1 已有有效默认配置

点击“开启实时”直接提交；无重复配置表单。服务端校验成功后按返回状态显示“已开启 · 准备中”、运行中或闭市，不强制先显示准备中。关闭时使用一条简短确认：保留历史，依赖该实时接续的告警暂停判定；调用现有关闭接口，不篡改告警状态。

多份配置且无有效默认值时必须选择；原默认失效时提示重新核对，不悄悄换成另一份。

### 5.2 首次没有配置

1. 用户点击“开启实时”，同一详情切到“确认实时来源”。
2. 读取当前 OANDA 目录，按代码生成搜索提示；只作候选发现，不能据此断言等价。对选中准确目录项调用 `mapping-check`。
3. 单一已核实候选可直接预选；多个候选提供选择；无候选提供搜索或更新当前账户目录。最终确认前必须展示准确来源和品种。
4. 服务端 `suggestion` 自动填好标的、币种、产品类型和关系，普通用户只看两行摘要：“历史来源 → 实时来源”“价格口径与日界”。资料和完整身份收起，不要求手填已知产品属性。
5. 若返回黄金产品差异，展开差异文字及一个未预选确认框。用户确认后用 `reviewed=true` 再核对；无差异不增加通用勾选。
6. 底部唯一主按钮“确认并开启”。依次保存 mapping、调用 continuation 开启；复用配置幂等规则，成功后返回详情。不强制跳转图表。

这两个写入不是一个事务：配置保存成功而开启失败时显示“配置已保存，实时未开启”，下次重试直接使用该配置。不能显示全成功，也不能为了回滚删除已保存配置。

### 5.3 未就绪或不支持

| 实际情况 | 界面处理 |
| --- | --- |
| 首次历史准备中或缺少有效 M1 基线 | 提示“历史准备后可开启实时”，提供任务进度；服务端基线条件最终校验，不放一个无法解释的灰开关 |
| 历史太短，日界之前无基线 | 提示扩大历史起点，进入维护设置/补数；不偷偷改拼接规则 |
| 来源/模式不支持接续 | 显示“当前行情暂不支持实时接续”，保留创建维护和固定历史功能 |
| OANDA 未配置 | 显示“实时来源未配置”，可看来源状态；凭据仍由服务器配置，不在手机制作密钥设置页 |
| 账户目录未同步 | 提供“更新实时来源目录”，完成后重新核对 |
| 账户变化、映射失效、精度冲突 | 提供“重新核对来源”；不复用其他账户映射、不自动改写历史精度 |
| 已开启但准备/恢复/认证异常 | 开关如实显示已开启，同时显示对应状态与原因，仍可关闭；只有可恢复条件满足后才称运行中 |

实时开启选择保存在服务端。手机切导航或退后台，不关闭它；App 的前后台行情连接策略继续按既有规则运行。只有用户明确关闭才发关闭命令。

## 6. 接口使用清单

以下路径均省略 `/api`；写操作走现有登录/CSRF，不新增旁路请求。

| 用途 | 接口及关键输入 |
| --- | --- |
| 自建主页/定位 | `GET /market-data/center/dataset-summaries`，`query/source/status/page/page_size/anchor` |
| 详情 | `GET /market-data/center/datasets/{id}` |
| 添加目录 | `GET /market-data/history-catalog/search`，`source/query/symbol_type/offset/limit` |
| 刷新来源目录 | `POST /market-data/history-catalog/refresh?market=...`，`{source}` |
| Yahoo 精确代码补录 | `POST /market-data/catalog/discover`，`{symbol}`；仅显式触发 |
| 来源周期验证 | `POST /market-data/history-catalog/probe`，来源、准确品种、周期、口径与起点 |
| 创建前检查 | `POST /market-data/center/datasets/check`，目录身份、精度、日界、模式、周期、`start_date` |
| 创建并提交历史准备 | `POST /market-data/center/datasets`，`{request_id,create_only:true,dataset,maintenance}` |
| 创建结果核查 | `GET /market-data/center/creations/{request_id}`，同一次提交的完整身份查询参数 |
| 读取/保存计划 | `GET/POST /market-data/datasets/{id}/maintenance`，保存带 `expected_configuration_revision` |
| 维护生命周期 | `POST /market-data/datasets/{id}/maintenance/control`，`{action:pause/resume/archive/unarchive}` |
| 创建维护任务 | `POST /market-data/datasets/{id}/tasks`，`request_id`、`kind:update/backfill/recheck`，区间任务带 `start/end` |
| 任务和进度 | `GET /market-data/center/tasks?dataset_id=...`；需要稳定增量时复用已有 `center/task-feed` |
| 控制任务 | `POST /market-data/tasks/{version_id}/control`，`{action:pause/resume/retry/cancel}` |
| 实时事实与已有配置 | `GET /market-data/datasets/{id}/continuation`、`GET .../{id}/mappings` |
| 核对实时匹配 | `POST /market-data/datasets/{id}/mapping-check`，`{catalog_id,match:null}`，确认后再次提交完整建议值 |
| 保存实时匹配 | `POST /market-data/datasets/{id}/mappings`，`{catalog_id,match,snapshot,reuse_mapping_id?}` |
| 开启/关闭实时 | `POST /market-data/datasets/{id}/continuation`，`{enabled,mapping_id?}` |

优先不加新的操作接口。摘要当前已有 `active_version_id/task_error`，但没有足够完整的任务阶段；为可靠显示准备/失败/部分成功，可**兼容增加 `maintenance.task_status`**，批量读取并复用现有任务状态规则。不为每行发详情或 tasks 请求，不改旧字段含义。若源码基线已有等价字段直接复用。

## 7. 状态、请求与交互约束

- 创建、任务提交沿用固定 `request_id`；同一次不确定提交禁止改请求体并换 ID 重发。创建超时先核查结果；核查未找到再以原请求重试。409 进入已有项。
- 保存 mapping 响应丢失时通过 mappings 核对准确账户、目标、产品属性及备注；查到即复用。开启/关闭超时用 continuation 回读实际选择；任务控制/维护保存超时分别回读，未核实不显示成功。
- 写请求使用有上限的管理请求超时；参考 `web/src/market-data/api.ts` 的 20 秒管理写超时与目录/探测特例。不要直接使用可能无写超时的通用 `api` 后让按钮永久忙碌。
- 所有会话切换、服务器切换后检查 `profileActive`，取消旧读请求；旧响应不能更新新服务器页面或执行下一段写入。已在服务端提交的任务不因客户端取消而声称已取消。
- 断网保留本机只读快照并显示读取时间，所有创建、设置、任务控制、开关禁用；无离线命令队列。
- 列表按页读摘要，建议有进行中任务时每 5 秒更新当前页，无活动时每 15 秒刷新；详情只轮询当前数据集，忙碌阶段约 3 秒。仅前台且页面可见时运行，不重叠请求，退出后取消；回前台立即读取一次。
- 保存成功使当前数据集摘要、详情和相关任务缓存失效；必要时失效共用自选搜索缓存。不得在写成功后继续显示旧缓存“未开启”。
- 所有可编辑面板沿用脏表单确认、返回键、退出动效、关闭后卸载和软键盘避让。提交时防重复；错误保留输入。目录结果、详情和编辑之间切换避免多层抽屉堆叠。
- 375/412px、深浅主题、150% 字号都保持按钮和关键信息可达。主按钮高约 48px，图标触摸区至少 44px；减少动态效果遵循系统设置。
- 不修改自选价格布局、sparkline、图表加载/预取、网页原生指标窗口或既有历史解析策略。

## 8. 文件改动与实施顺序

建议文件边界如下；不为了凑目录引入状态管理库或通用工作流引擎。

| 文件 | 责任 |
| --- | --- |
| `web/src/mobile/DataPage.tsx` | 自建主页、筛选、分页与入口；保留 `searchMode` 为自选用途，不能把其“加入自选”改成“创建自建” |
| 新建 `web/src/mobile/DataCatalogSheet.tsx` | 创建专用目录、来源筛选、目录同步入口及转入确认 |
| 新建 `web/src/mobile/DataCreateSheet.tsx` | 简明创建表单、能力验证、创建前检查、提交与结果核查 |
| 新建 `web/src/mobile/DataMaintenanceSheet.tsx` | 维护设置、当前任务、区间操作；可拆局部子组件，不再堆入 DataPage |
| 新建 `web/src/mobile/DataContinuationSheet.tsx` | 已有配置、服务端匹配建议、差异确认、开启关闭及部分成功 |
| `web/src/mobile/dataMarkets.ts` 与必要的新 `dataOperations.ts` | 复用行情身份解析；后者承接有界管理请求、提交核查和失效通知，避免复制桌面表单 UI |
| `web/src/mobile/data-controls.css`、`DataStates.tsx` | 页面布局、状态与表单细节，沿用项目主题 |
| `backend/alerts/dataset_summaries.py` | 必要时补批量任务阶段；保持现有契约 |
| `web/tests/mobile-data.browser.cjs`、新增 `mobile-data-workflow.browser.cjs` | 旧浏览/自选回归、新全流程夹具和截图；新脚本尚未创建 |
| `docs/verification/android-personal/` | 本次实现与验收证据，区分夹具、Ubuntu 实际 API 和手机真机 |

按依赖执行：

1. 建立独立工作树，核对基线和 skill；列出 UI 所需字段。先确定摘要任务阶段是否需要兼容补充。
2. 分离数据页管理用途与共用自选搜索；完成只显示自建的主页、空态和创建专用目录。
3. 完成创建及响应丢失核查，以一个普通 M1 来源和一个需周期验证来源贯通。
4. 完成维护设置、立即更新、任务进度和控制，再补区间补数/复查及归档恢复。
5. 完成已有配置开关、首次匹配与黄金差异确认；处理配置已保存但未开启、账户变化和不支持来源。
6. 联动刷新与身份解析，证明完整流程从创建直至实际实时接续，无需先开图来维持采集。
7. 真实构建后截图和交互打磨；检查共用搜索、网页端表单及手机图表回归；最后整理证据与待真机项。

## 9. 验证与完成标准

本节是将来实施后的检查，不是本轮已运行结果。优先验证实际用户行为，不为简单外观变化逐项写测试。

### 本地检查

从新工作树根目录执行，先确认依赖环境与锁文件；已有虚拟环境优先复用，不使用系统 Python 随意安装依赖。

以下命令仅在收到实施指令后执行。新路径和分支若已存在，先核对归属，不覆盖；将本方案复制到新工作树再开始开发：

```bash
git worktree add -b feat/mobile-data-workflow-20261113 /home/quant/repos/market-watch-mobile-data-workflow-20261113 v2.0.11
cp /home/quant/repos/market-watch-android-personal-v205/docs/mobile-data-workflow-plan-20261113.md /home/quant/repos/market-watch-mobile-data-workflow-20261113/docs/mobile-data-workflow-plan-20261113.md
cd /home/quant/repos/market-watch-mobile-data-workflow-20261113
```

```bash
git diff --check
PYTHONPATH=backend python -m pytest -q backend/tests/test_history_creation_check.py backend/tests/test_history_maintenance.py backend/tests/test_composite_matching.py backend/tests/test_managed_continuation.py backend/tests/test_dataset_summaries.py
```

若修改了摘要，增加对应有意义的回归并检查改动 Python 文件的 Ruff；未改后端时无需扩大整套后端检查。

从 `web/` 执行：

```bash
npm run build
MOBILE_DATA_OUTPUT=/tmp/mw-mobile-data-workflow-baseline node tests/mobile-data.browser.cjs
node tests/mobile-watch.browser.cjs
node tests/composite-mapping.cjs
```

随后**先创建**上述新脚本，再执行：

```bash
MOBILE_DATA_OUTPUT=/tmp/mw-mobile-data-workflow node tests/mobile-data-workflow.browser.cjs
```

新脚本至少覆盖：

- 创建 M1、创建 D1/原生多周期及验证失败；重复数据集、创建 201 丢失后的查询核实。
- 保存维护的版本冲突；隐藏高级设置无损；更新失败但旧历史可用；暂停定时维护与任务暂停互不替代。
- 有效配置直接开启、首次核对开启、黄金确认、多个配置、旧默认失效、账户变化、缺少 M1/日界基线、来源不支持。
- mapping 保存成功而开启失败；实时开关响应丢失后回读；关闭再开启不重复建映射或重置基线。
- 返回、取消、抽屉退出、软键盘、小视口、大字体、深浅主题；慢请求、断网和切服务器不串状态。
- 原生浏览不产生创建/采集写请求；自选搜索依然可添加原生或自建；开图身份正确且不暗中降级。

### Ubuntu 隔离验证

- 先只读检查项目、端口、内存及磁盘；任务建议名 `mw-mobile-data-workflow-20261113`，端口现场选择，不占用旧手机验收实例。
- 使用 `mw-docker build/compose-build`，显式 task/project/purpose。需要独立 PG、api、web、data-worker、market-runtime、notification-worker 和 TLS；共用已有受控镜像可按规则评估，但数据库与网络不能共用可写状态。
- 默认 API-only preview 无出网且关闭实时，不足以证明此流程。先依据 `deploy/ubuntu/README.md` 及现有手机验收 Compose 创建本任务私有 env/override，配置任务所需供应商出网和有效测试连接；不输出凭据。
- 私有文件准备完成后，以下为可执行模板；`--env-file/--file` 路径必须在新任务目录中实际生成，不能当成已存在文件。镜像标签为验收用途，不创建正式 Git tag。
- `override.yaml` 必须替换基础 Compose 中各服务的 `env_file: .env` 引用、端口和不适用的外部资源，不能只依赖 CLI 的 `--env-file`；后者仅负责变量插值。构建前用本任务的 `docker compose config --quiet` 检查，确认全部服务只引用本任务配置；不要把展开后的私有配置输出到公开证据。

```bash
mw-docker compose-build --repo . --task mw-mobile-data-workflow-20261113 --project mw-mobile-data-workflow-20261113 --purpose acceptance --env-file /home/quant/.local/share/market-watch-docker/previews/mw-mobile-data-workflow-20261113/task.env --file compose.yaml --file /home/quant/.local/share/market-watch-docker/previews/mw-mobile-data-workflow-20261113/override.yaml
docker compose --env-file /home/quant/.local/share/market-watch-docker/previews/mw-mobile-data-workflow-20261113/task.env -p mw-mobile-data-workflow-20261113 -f compose.yaml -f /home/quant/.local/share/market-watch-docker/previews/mw-mobile-data-workflow-20261113/override.yaml up -d --no-build
docker compose --env-file /home/quant/.local/share/market-watch-docker/previews/mw-mobile-data-workflow-20261113/task.env -p mw-mobile-data-workflow-20261113 -f compose.yaml -f /home/quant/.local/share/market-watch-docker/previews/mw-mobile-data-workflow-20261113/override.yaml ps
```

该任务临时停止只用同一配置的 `stop`，不删除 volume。实际启动/停止命令、地址、镜像身份和验证结果写入交付记录，不发布私有 env。

验收以用户通过手机界面在任务专用库执行为准：

1. 搜索 Dukascopy EUR/USD → 创建近期 M1 自建 → 后台发布 → 手机立即更新/暂停恢复。
2. 手机首次核对 OANDA EUR_USD → 开启 → 确认 runtime 持续接收；离开页面后仍有服务端更新 → 关闭/重开 → 开图或加入自选。
3. 黄金验证必须确认差异；一个 Yahoo/AKShare 自建完成验证、创建和维护，实时区准确标为不支持。
4. 验证已发布历史与既有接续基线均未被手机维护暗中重绑；网页创建/维护/实时页面仍可正常使用。

若缺少有效 OANDA 配置或供应商不可达，夹具可以证明交互，不能宣称真实接续链路完成。保留已完成工作，报告具体缺项；不用生产实例冒充隔离验证。闭市期间可验开启/关闭、历史准备和闭市状态；“收到实时报价”必须有真实可交易时段证据。

完成要求：三个核心界面完成截图打磨；所列必要操作可在手机独立完成；相关检查通过；交付真实 Ubuntu 地址和待真机验收清单。浏览器测试不能代替 APK 内系统键盘、返回与触摸验收。PR/CI 在实现收口时按当前用户指令与仓库流程执行；合并、正式 tag 和生产发布另按授权节点处理。

## 10. 给执行 Agent 的启动指令

> 在 Market Watch 项目按 `docs/mobile-data-workflow-plan-20261113.md` 实施手机数据页全流程。先读 AGENTS.md 和 market-watch-mobile-ui skill，从 v2.0.11 建独立工作树；核对 main 后续相关变更。复用既有创建、维护、匹配及 continuation 接口，落实只列自建、搜索添加、维护设置/任务控制、首次核对并开启实时。保留黄金差异确认、账户和数据身份边界，保护自选共用搜索及网页端。只在 Ubuntu 本机隔离 Docker 验证；先用夹具覆盖异常，再用有效测试来源贯通真实链路，截图打磨后报告真实证据及待手机验收项。本文是方案，先前对方案的请求不构成实施或生产授权；获得实施指令后再改应用功能。
