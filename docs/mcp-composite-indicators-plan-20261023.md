# MCP 组合行情指标取数实施方案

状态：原始方案已转入实施，进度与实际证据见 [实施任务](verification/mcp-composite-indicators-20261023/task.md) 和 [R1 runbook](verification/mcp-composite-indicators-20261023/README.md)。以下保留原方案约定；不以方案文本宣称验收完成。

基线：`main` / `6f74951ce3b9b3158e0cd0e80bfeb40f961a17ac`，2026-10-23。

## 1. 已确定的目标与范围

扩展现有 `indicators_calculate`，支持基于指定组合修订计算指标，在一次响应中返回对应 K 线、指标值和计算依据。复用网页后端的组合输入、历史起点、指标算法和后台任务。

用户已明确：**不需要跨次复算。** 本期保证每次响应内部同源、同版本；不承诺不同调用、重试或不同分页响应之间保持同一快照。再次调用按该次请求重新选择输入，调用者应以该次返回的依据为准。

本期包含：

- 已建立组合的指标查询，沿用单次 1–12 个指标、最多 2000 根可见 K 线。
- 可指定组合修订；可选择后端已经保留的确认输入修订，省略时取本次可用确认输入。
- 默认 `provisional=false`，指标只使用符合后端规则的已确认、已收盘输入。K 线保留各自的收盘、确认和覆盖事实。
- 显式 `provisional=true` 时复用现有组合展示快照，在本次响应中标明临时输入及临时指标。
- 返回未完成计算的状态与已完成部分，不以缩短历史预热代替完整初始化。

本期不增加跨调用快照输入、版本保留策略、数据归档、回放系统或任务查询工具。平台 `provider` 与原有 `managed` 查询保持兼容；固定历史 `history` 的 MCP 指标支持另行安排。

文档变更分类为 P0。后续实现预定 **F0：兼容的读取能力扩展**，不增加数据库 schema、持久格式或算法；最小检查为现有 CI、自审、定向 PostgreSQL 一致性验证及一个 Ubuntu R1 smoke。若实现必须修改持久格式、算法或重要后台调度，重新按 F1 分类并补齐对应检查。

## 2. 接口约定

### 2.1 输入

工具名保持 `indicators_calculate`；权限保持 `analysis:read` + `market:read`。

仅在 `IndicatorsQuery` 扩展类型和字段，**不修改 `QuoteQuery`、`BarsQuery` 的取值范围**，避免顺带改变 `market_get_quote`、`market_get_bars`。

| 字段 | 约定 |
|---|---|
| `series_kind` | 增加 `composite`；原有 `managed` 默认值保持不变 |
| `instrument` | 组合 ID；允许将 `MWC:<组合 ID>` 规范化为同一个 ID；须显式指定 `series_kind="composite"` |
| `composite_revision_id` | 新增可选字段，对应现有 `composite_get_bars.revision_id`；省略时在本次查询中解析当前活动修订一次 |
| `input_revision` | 新增可选非负整数，只对组合适用；通常省略，由本次查询选取并返回；指定时须同时提供 `composite_revision_id` |
| `timeframe`、`before`、`limit` | 沿用现有周期、排他游标及数量；组合游标为 UTC 毫秒 |
| `indicators` | 沿用名称、版本和参数；组合分支预先校验指标具备现有固定输入计算能力 |
| `provisional` | 默认 false；true 与显式 `input_revision` 互斥 |

组合查询拒绝 `published=true`、非空 `dataset_start` 和非空 `calculation_origin`。组合计算历史起点由所选固定基线及现有指标规则决定。`composite_revision_id`、`input_revision` 在其他类型查询中非空时拒绝。

不开放 `provider_snapshot_id`、`display_snapshot_id` 或 `run_id` 输入。返回的快照和任务 ID 用于解释本次结果，不成为跨次复算协议。

调用示例，尖括号内容须替换为实际已保存组合的信息：

```json
{
  "instrument": "<64位组合ID>",
  "series_kind": "composite",
  "composite_revision_id": "<所选组合修订ID>",
  "timeframe": "H1",
  "limit": 300,
  "provisional": false,
  "indicators": [
    {"name": "EMA", "version": "1", "params": {"period": 20}},
    {"name": "RSI", "version": "1", "params": {"period": 14}}
  ]
}
```

指定已有输入修订是本次查询的输入选择；本期不因此增加保留时长、恢复旧数据或不同调用数值相同的承诺。

### 2.2 输出

保留现有顶层与 `page.bars`、`page.indicators` 结构。为 `indicators_calculate` 建立明确的 `IndicatorsResult` / `IndicatorsPage` 输出模型，复用现有模型并补充以下可发现字段；既有扩展字段继续透传。

| 层次 | 必须能表达的依据 |
|---|---|
| 顶层 | `instrument`、`series_kind`、`source`、`timeframe`、`price_type`、`queried_at`、质量、缺口及游标口径 |
| `page` 价格输入 | `composite_id`、`revision_id`、`input_revision`、`history_version_id`、`history_checksum`、`seam`、`rule_version`、`basis`、`calendar`、`as_of` |
| `page.bars[]` | 原有 OHLC，以及 `time_closed`、`source_confirmed`、`coverage_complete`、`segments`；保留拼接和混合来源标记 |
| `page.indicators[]` | 名称、参数、指标版本、数值序列，保留 `presentation`、`break_before`、`provisional` 与依赖信息 |
| `calculation` | `run_id`、`status`、`visible_complete`、`calculation_origin`、`algorithm`、`coverage`、`required_coverage`、`cursor`、`target_end`、`error`、`next_at` |
| `calculation.input_evidence` | 所选 `revision_id`、`input_revision`、`history_version_id`，展示模式下的 `display_snapshot_id` |
| `dependencies[]` | 已有 `dependency_origin`、`seam_dependency`、`initialized`、`provisional`，保留对应时间 |

`history_checksum` 从所选历史版本的现有 manifest 读取，不另建持久记录。`history_revision` 仍是已有变化标记，可能包含计算进度，不把它解释为可重放的数据版本。

平台已有的 `calculation.input_evidence`、`provider_snapshot_id`、`cache_revision` 和 `calculation_origin` 也须在新的指标输出 schema 中可发现，但本期不开放额外平台输入。

现有 `ValuePoint` 基类默认忽略未声明字段；扩展输出模型时将点模型改用允许扩展字段的基类，使 provider 的 `break_before` 和 `provisional` 等质量信息不会在 MCP 序列化时被丢弃。自定义 composite bar 保留 `chart_time` 和 `segments`，不因响应 schema 丢字段。

不复制完整私有配置或完整 manifest。返回来源标识、校验和及规则版本足以描述依据；实际递归历史可能长于返回的可见 K 线。

### 2.3 一致性约束

每个响应遵守以下约束：

1. 组合身份、权限、组合修订和确认输入修订在共享组合读取中各选定一次，然后传入后续步骤，不重新读取 `active_revision_id` 并猜测“当前版本”。先取身份元数据和 K 线再分别默认选择活动修订违反该约束，即使两次操作在同一个事务函数里。
2. K 线、历史基线、日历、价格口径、拼接点和指标计算依据必须对应同一个所选组合修订。查询非活动修订时，元数据也来自该修订。
3. 每个指标的输入修订与 `page.input_revision` 一致；依赖的历史基线与 `page.history_version_id` 一致。临时模式另绑定本次展示快照。
4. 指标数值时间属于返回 K 线的真实 `start`；日、周、月图表标签 `chart_time` 另保留，不混作源时间。
5. 缺口、拼接和未初始化沿用现有算法；不从当前返回的 300 根重新开始计算 EMA/RSI，也不把 null 转为零。
6. 多个指标可处于不同进度；一个指标待计算不能使 K 线和其他已完成指标被丢弃。

## 3. 计算状态与错误

冷启动继续使用现有固定指标任务。首次查询可登记共享计算任务、读取缓存和已有结果；不在 MCP 中另写算法，也不在请求内循环跑完整历史。

| 情况 | 返回行为 |
|---|---|
| 所需结果已可读 | 正常返回 K 线、指标值、依据和覆盖范围；是否可用以可见范围覆盖为准，不要求整个历史任务先完成 |
| 指标初始化中或只算完部分 | `isError=false`，保留 K 线及已算完值，返回原有 `calculation`、`indicator_progress` 和 `pending` |
| 后台暂时失败、正在重试 | 保留现有任务状态、`error`、`next_at` 及已完成结果，不声称计算已成功完成 |
| 已计算但预热不足或缺口后未初始化 | 保留 null，并结合 `dependencies.initialized`、缺口和覆盖信息说明不可用；不冒充后台尚未计算 |
| 稀疏信号没有触发 | 保留合法的 null 或空事件；不能仅凭“全为 null”认定历史不足 |
| 默认模式下最后根尚未收盘 | 返回原始 K 线及状态，指标不生成已确认值；不填入其他版本结果 |
| 组合未建立、无可用价格或历史已回收 | 明确 `DATA_UNAVAILABLE`；已建立组合无 K 线但已有准备任务时，在错误 context 中附可安全表达的准备状态 |
| 修订不属于组合、输入修订越界、参数冲突 | `INVALID_ARGUMENT`；不自动换成其他修订或平台行情 |
| 缺少 scope / 超过配额或预算 | 沿用 `FORBIDDEN`、`RESOURCE_LIMIT`、`DEADLINE_EXCEEDED`；保留原有审计和取消规则 |

`run_id` 仅为诊断关联。用户再次取数调用原工具即可；那是新的输入选择，不要求还原上次快照。后台任务、进度读取与缓存共享不构成跨次复算产品能力。

组合分支在登记任何指标任务前校验全部指标规格。保留原有 `pending`、`partial`、`complete` 及进度字段，不新增持久任务状态。`visible_complete` 表示可见范围的结果覆盖，不表示每个值都有交易信号；null 的解释同时检查对应 K 线状态与依赖信息。

MCP 不传网页 `client` 或指标消费者租约，不创建组合、不续订实时行情、不触发供应商补数。允许的持久副作用限于现有计算任务、计算结果和审计。现有后台调度已会处理无前台租约的固定指标任务，本期复用该行为。

## 4. 代码改动清单

| 文件 | 具体改动与完成条件 |
|---|---|
| `backend/alerts/capabilities/models.py` | 仅扩展 `IndicatorsQuery`；添加跨字段校验、显式 page/计算状态输出模型和允许质量扩展字段的 `ValuePoint`；`tools/list` 可见新参数和计算依据 |
| `backend/alerts/capabilities/actions.py` | 为指标查询增加明确分派；managed/provider 继续原路径，组合进入共享固定输入路径；组合不执行普通 `Instrument` 身份查询或全 null 即报错逻辑 |
| `backend/alerts/series_access.py` | 在组合读取中一次解析所选修订与输入；元数据与 K 线、指标使用同一选择；返回所选基线校验和及完整现有依据 |
| `backend/alerts/chart_api.py` | 按需调整共享组合读取入口的参数传递，保留 `query_chart` 的取消、deadline 和执行预算；网页沿用同一业务路径 |
| `backend/tests/test_composite_mcp.py` | 增加协议发现、请求校验、共享结果、状态和无实时需求副作用的行为测试 |
| `backend/tests/test_series_access.py`、`test_series_access_postgres.py` | 覆盖指定非活动修订的元数据，以及同一调用内的修订选择一致性 |
| `backend/tests/test_native_mcp.py` | 回归旧查询及 provider 的动态计算依据在 MCP 输出中完整保留；普通报价/K 线参数未扩大 |
| `scripts/verify_composite_indicators_mcp.py`（新增） | 固定、脱敏的 Ubuntu R1 验证入口，检查真实协议响应、价格/指标依据对应关系及冷启动到可读状态 |
| `docs/native-mcp-usage.md` | 增加组合示例、版本选择、计算状态、临时模式、单次一致性边界及资源副作用说明 |

组合 handler 调用共享 `query_chart(DataQuery(...))`；数值计算仍落到 `series_access.chart_data` / `fixed_indicators.chart_results`。不修改 `mcp/server.py` 协议层，不新增独立组合指标工具。

当前共享读取有一处已识别的同源风险：`series_access._metadata` 初始读取活动修订，而 `chart_data` 后续另外读取活动修订，且身份元数据未完整承载实际选中的修订。实现时从组合定义进入共享读取后先确定显式或默认修订，再按此 ID 选择输入版本；之后将固定选择贯穿该次读取，并用同一修订生成来源、精度、映射、日历与历史基线，不能只修正响应中的版本 ID。专门的并发测试在这两步之间切换活动修订，以捕获旧分支误读。

具体读取顺序为：在共享组合读取事务中加载 `MarketComposite` 与所选 `CompositeRevision`，从该修订的 `CompositePreparation` 选择确认输入修订，然后以明确参数传给元数据、K 线与指标读取。临时模式改由本次捕获的展示快照确定输入修订。固定输入已有不可变修订过滤机制，本期不依靠重读“最新”补齐同次响应，也不为此扩大所有查询的数据库隔离级别。

## 5. 实施顺序与交付门槛

| 顺序 | 工作 | 完成条件 |
|---|---|---|
| 1 | 在独立 feature worktree 建立任务清单，确认最新 main 与本方案差异 | 保留其他会话代码；确认无新增持久格式和算法改动，按 F0 执行 |
| 2 | 完成输入模型、校验和输出 schema | 组合参数可发现；managed/provider 请求兼容；报价及普通 K 线工具仍拒绝组合类型 |
| 3 | 接入组合共享读取并固定本次输入选择 | 指定活动/非活动修订均正确；每个指标依据与价格页一致 |
| 4 | 处理计算进度、null 和错误 | 冷启动不被误报为历史不足，混合就绪状态可读，错误不静默改用别的版本 |
| 5 | 完成测试、使用说明和 R1 验证脚本 | 定向行为测试及 PostgreSQL 检查通过，提供脱敏协议证据 |
| 6 | 自审、适用 CI、Ubuntu R1 smoke，形成 Draft PR | PR 写明 F0 理由、执行检查、结果和本次范围；证据齐全后再提交合并检查点 |

不将“旧版本经过任意新增、修正或版本切换后仍能跨调用重现”作为本期验收条件。并发验收只检查单次响应是否混入不同版本。

## 6. 验收用例

| 编号 | 场景 | 通过标准 |
|---|---|---|
| A1 | MCP 工具发现 | 工具名和权限不变，新增组合参数及依据字段出现在 schema；数量保持原集合 |
| A2 | 默认组合修订 | 返回已建立组合的 K 线、EMA/RSI；响应明确本次实际组合修订与输入修订 |
| A3 | 指定非活动修订 | K 线、指标、历史基线、日历、来源和精度均对应所选修订 |
| A4 | 同次响应中多个指标 | 每个指标的版本依据与页面一致，时间映射准确；参数不同的指标不会串用缓存 |
| A5 | 与网页共用算法 | 用隔离且不变的同一份输入、相同参数及收盘策略比较：K 线一致，指标按既有数值断言一致；不比较审计时间和缓存耗时 |
| A6 | 冷启动和部分完成 | 首次返回价格与真实进度；任务从原有完整历史起点初始化；可读部分保留；后台推进后新查询可读结果 |
| A7 | null、稀疏输出和缺口 | 分别覆盖长周期预热不足、缺口后重置、无买卖信号、未收盘最后根；不将这些统一当作待计算或零值 |
| A8 | 临时模式 | `provisional=true` 的价格与指标绑定本次展示快照；临时值有标记，不推进已确认状态；与显式输入修订同时使用被拒绝 |
| A9 | 请求校验与错误 | 未知组合、其他组合修订、越界输入、错类型参数、无固定状态算法、资源限制都有明确结果 |
| A10 | 无行情需求副作用 | 查询前后组合数量、活动修订、实时 `MarketDemand` 不变；调用供应商入口即视为测试失败；仅允许现有指标任务与审计写入 |
| A11 | PostgreSQL 并发 | 在输入选择后并发推进确认输入或切换活动修订，当前响应仍使用已选择修订；不把新确认尾部拼入旧指标依据 |
| A12 | 兼容回归 | 原有 managed/provider 指标和报价/K 线通过；provider 快照、输入修订、算法等扩展信息经过 MCP 输出模型后不丢失 |

测试优先复用现有 fixture、固定指标引擎和数值断言。新增测试聚焦接口行为与一致性，不复制已有算法测试。

本地检查命令，`python` 必须来自安装了 `requirements.lock` 的任务环境：

```bash
python -m ruff check backend/alerts/capabilities/models.py \
  backend/alerts/capabilities/actions.py backend/alerts/series_access.py \
  backend/alerts/chart_api.py backend/tests/test_composite_mcp.py \
  backend/tests/test_native_mcp.py backend/tests/test_series_access.py

python -m pytest -q backend/tests/test_composite_mcp.py \
  backend/tests/test_native_mcp.py backend/tests/test_series_access.py \
  backend/tests/test_fixed_indicators.py backend/tests/test_fixed_indicator_display.py

# TEST_POSTGRES_URL 仅指向本任务的隔离 PostgreSQL。
python -m pytest -q backend/tests/test_series_access_postgres.py \
  backend/tests/test_composite_chart_postgres.py \
  backend/tests/test_fixed_indicators_postgres.py
```

另外对实际新增/修改的 Python 文件运行 Ruff，并在现有 CI 运行所要求的完整检查。本机旧 `.venv` 缺少 `mcp` SDK，之前协议测试未能启动；实施时先确认锁定依赖，不能用跳过协议测试替代通过。

## 7. Ubuntu R1 执行要求

实施任务建议命名 `mw-mcp-composite-indicators-20261023`。仅在 Ubuntu 本机建立独立 Compose project、internal 网络、数据库、volume、凭据和一个回环 HTTP 端口。启动前检查现有项目、端口、内存和磁盘；端口在执行时选择并记录。

最小运行集为 PostgreSQL 14.24、API 与网关；使用本地合成价格和隔离映射 fixture，不配置真实供应商凭据，关闭外部投递并阻断出网。无需 web 或许可图表库镜像。

实施中增加任务专用 Compose 文件及使用说明，放在 `docs/verification/mcp-composite-indicators-20261023/`。注意现有通用 R1 preview 的 `ALERTS_MCP_ENABLED` 硬编码为 false，不能直接启动后宣称已验收 MCP；本任务配置须显式启用 MCP 并核对 Host/Origin 配置，不扩大通用 preview 工具范围。

冷启动验证在本任务容器内以独立一次性进程调用现有 `fixed_indicators.indicator_tick(run_id)`，仅推进 fixture 的任务 ID；所需周期产物和组合聚合也使用现有离线构建入口准备。这样检查真实数据库、协议与后台执行路径，不需要启动可能调度真实历史维护的常驻采集服务。`chart-history` worker 不运行固定指标任务，不能替代此步骤。

镜像统一通过现有 `mw-docker build` 构建，显式设置 task、project、acceptance 用途；Compose 启动使用 `--no-build`。任务专用说明必须给出最终可直接运行的构建、启动、停止、seed、验证命令及私有文件位置。验收 fixture 与凭据不得覆盖其他实例。

交付证据至少包括：

- 实际运行主机、提交、固定镜像 ID、project、可访问回环地址及启动/停止命令。
- `tools/list` schema 和关键 `tools/call` 脱敏响应。
- A2–A8、A10–A12 的通过结果；冷启动阶段的价格、进度和后续可读结果。
- 任务前后组合、活动修订和实时需求未改变的比较。
- 用例结果与未执行项目；不将未启动实例写成已验收。

本期不涉及生产操作。后续合并和生产发布分别按仓库 `AGENTS.md` 检查点执行。

## 8. 可直接转为 Issue 的任务清单

建议标题：`MCP：组合行情指标查询一次返回同源价格、指标与计算依据`。

- [ ] 将本方案转入实施任务，核对最新基线，按 F0 登记最小验收。
- [ ] 仅扩展指标输入/输出模型并完成参数校验。
- [ ] 接通组合共享查询，固定本次修订和输入选择。
- [ ] 补齐所选修订的元数据及价格/指标计算依据。
- [ ] 保留初始化、部分可读、重试及预热状态。
- [ ] 完成协议、固定输入一致性、无行情需求副作用及兼容测试。
- [ ] 完成定向 PostgreSQL 并发验证。
- [ ] 编写并执行 Ubuntu 隔离 R1 fixture、协议验证和 runbook。
- [ ] 更新使用说明、自审和 CI，整理 Draft PR 与验收证据。

完成定义：用户可以使用原通用工具查询已建立组合，指定组合修订或采用本次默认选择；每次返回的价格、指标及其依据对应同一输入，冷启动状态明确，原有平台/自建调用兼容。无跨次复算承诺。
