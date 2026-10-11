# 商品交易状态与详情时间：接续审查

审查日期：2026-10-11（Asia/Singapore）。结论：已有实现骨架可以继续使用，但需求契约存在明确错误和遗漏，当前不能作为全部完成或待直接发布的实现。此次保留原产品改动，只新增审查与复现记录。

## 已恢复的上下文

- worktree：`/home/quant/repos/market-watch-market-session-details-impl-20261010`。
- 分支：`feat/market-session-details-20261010`；HEAD 与本地 `origin/main` 都为 `8c65edfdee15f0281750e888711cf8ecd20de1a0`。
- 本轮 `git ls-remote origin refs/heads/main` 成功，远端 main 仍为同一基线；本地名为 main 的分支较旧，不应用它代替本次基线。
- 需求：工作区父目录的 `market-watch-market-session-details-plan-20261010.md`；交接：同目录的 `market-watch-market-session-details-handoff-20261010.md`，以末尾 §13–14 为最新记录。
- 产品实现全部尚未提交；审查范围为 `git diff HEAD` 加未跟踪的 `market_calendar.py`、`test_market_calendar.py`、`CalendarView.tsx` 和实施记录。HEAD 上没有本任务新增提交，因此三点式 HEAD 对比不能代表本次改动。
- 已有：四来源注册表、报价新增字段、provider M1 失败回退、host 时区事件、活动图表事件、交易日历 API 和页面。保持 chart session 不变并关闭误导性原生状态图例的路线符合方案允许的能力降级路径。
- 原生状态图例的公开 feature 和时区／活动图表事件可以在固定许可库的类型声明中找到；类型声明不能证明真实详情文本在浏览器里完整、可见或跟随切换。
- 交接前半段的完成勾选与后半段的未验证记录矛盾。末尾明确：实际浏览器主要验证交易日历；空 provider 历史导致完整 ready、多图 UI 与周期切换尚未断言。不能把这些项目记录为通过。
- 本轮未访问生产、未修改 unraid、未提交、合并、打 tag 或发布。许可库仍应保持 ignored。

## Standards

本轴对照 `AGENTS.md`、`CONTEXT.md` 和 ADR 0002；两个硬性问题均为 P1。没有需要单独阻断的代码气味建议。

1. **实际身份没有参与 OANDA 规则认证。** `backend/alerts/market_calendar.py:161` 从待验证 profile 自身构造 identity，再让 `live_session` 与同一 profile 比较，属于自我比较。实际通道、环境、账户指纹不参与判定。违反 `CONTEXT.md` 的数据集身份及闭市证据适用范围定义。合成 fixture 已复现：`live`／账户 A 的规则被用于 `practice`／账户 B 的 `native_identity`，结果仍为 `calendar_verified=True`。应使用实际行情身份，身份缺失或不匹配时保持 unknown。

2. **观测与闭市证据的冲突逻辑相反。** `backend/alerts/market_data.py:1018` 把“现在闭市、最后观测在开市时间”标为冲突；实际在闭市区间内发生的观测反而不报。违反 ADR 0002 对来源观测与闭市证据冲突的处理约定。冲突应该由观测发生时间／完整分钟范围与同一身份的证据确定，不能由当前时间与旧报价的不同状态确定。

## Spec

本轴对照需求方案，保留独立判断；与 Standards 重复的问题不合并计数。

1. **P1：冲突条件写反。** §6.3 要求“若来源报价与闭市规则冲突……标记……待核实”。`market_data.py:1018` 实际输出：周六保留周五正常报价 → 冲突；周六闭市区间内的报价 → 无冲突。`test_market_calendar.py:108` 还固化了错误条件，应一并纠正，并测试当前已开市但先前观测发生在闭市区间的情况。

2. **P1：建议复核日期被当作适用性失效。** §6.2 要求“超过建议复核日期显示待复核提示；超过实际适用范围才……降级”。`market_calendar.py:190`、`:205` 将 `review_due` 全部变成 unknown。2026-11-14 周末仍在 Dukascopy `valid_until=2027-03-31` 内，却不再显示闭市。`test_market_calendar.py:47` 同样认可了错误行为。复核提示与证据有效性需要分别表达；例外未核实不能抹去仍有效的独立周末证据。

3. **P1：托管详情仍使用旧判定文案。** §3 要求已核实暂停显示“休市”，缺少规则显示“时段未核实”。`market_data.py:1212` 仍从聚合日历的 `scheduled_open` 生成“按日历休市”；新增 session 只进入字段。`advanced-host/bridge.js:99` 格式化时间但不渲染这些状态字段。结果可能是 `market_session=unknown` 与“按日历休市”并存，或实际暂停只显示“最近更新”。无柱时的 `报价准备中` 也没有附状态。应让统一展示读取新的 session 判定，报价新鲜度单独表达。

4. **P1：固定历史／组合未完成同一快照契约。** §3 要求“固定历史系列显示历史数据时间”，组合状态只取明确接续来源。`market_data.py:1040` 的历史分支只有名称，没有价格／数据时间；组合缺状态、日历版本和时间类型。组合 `confirmed_m1_close` 的 `observed_at` 来自 `composite_quotes.py:100` 的柱尾，又在 quote API 被当作 `quote_time`，host 因而称为“最后更新于”。这不满足来源 M1 使用起始标签、不得冒充精确事件时间的要求。补齐时必须保留修订、实时选择及 provenance 的绑定，不能重新抓取另一条序列拼接时间。

5. **P2：无时间及开市等待文案遗漏。** §3 要求“暂无行情更新时间”“等待新行情”。provider 路径及 `presentQuote` 没有明确处理；合成无时间快照最终只显示“报价准备中”。应保留旧行情时刻，单独表达正在等待或读取失败，首次失败不借用其他身份的价格。

6. **P2：日历页和详情未共享实际身份及规则。** §6.5 要求“状态……使用同一判定和规则版本”“未启用来源明确标记”“继承页面时区”。`history_api.py:172` 只输出静态注册表，不合并实际 account-bound profile、启用配置或当前品种映射；OANDA 详情可能已经按 profile 核实，而页面仍显示 pending 版本。页面只显示原始时区字符串。四个注册表行不能代替逐来源集中核实、当前品种映射和未来已公布例外的交付记录。

7. **P2：时区重排累计分钟说明。** §4.2 要求即时重新格式化已保存 epoch。`bridge.js:641` 缓存已经格式化的结果，`:109` 删除旧时间但没有删掉旧的“来源 M1 分钟数据”。第一次时区切换就出现两次该说明。应只缓存原始快照，让 formatter 对同一数据可重复调用。

两轴汇总：Standards 2 项，最严重的是实际账户身份认证缺失；Spec 7 项，最严重的是错误会话／观测语义和部分系列的快照契约遗漏。

## 主审补充复现

这些补充在上述两轴之外记录，不改变子审报告的计数。

- **P1：失败回退仍能跨实际账户。** `provider_chart.py:419–424` 从 `calendar_profile.source_session` 取缓存键里的通道／环境／账户，而非实际数据身份。默认无 profile 或只有 closures 时三项都是空。合成 fixture：账户 A 首次成功，切到账户 B 后读取失败，同一个 `OANDA:EUR_USD` 返回 A 的旧价格与时间。修复规则认证时也须修复这个键；原先“增加 account/channel/environment”不能据此算作隔离完成。
- **P2：多品种订阅时区刷新只重排最后一个事件。** `bridge.js:2146` 每个单品种推送都会整体覆盖 `quote.lastRows`；`:117` 优先用这个非空列表，不读其他品种的最新缓存。A/B 订阅最后收到 B 时，时区刷新仅回调 B，A 留在旧显示时区。应按身份合并原始快照，刷新时覆盖本订阅需要的所有品种。
- **P2：搜索未复用商品代码规范化。** `market_calendar.py:261` 直接比较字符串，`XAUUSD` 搜索为 0 行，`XAU/USD` 为 1 行；托管商品的常用显示代码无法命中。匹配中应使用规范化代码及显示别名。
- **UI 要求仍有缺口。** `CalendarView.tsx:34–35` 使用普通 input/select，没有复用已有 `NativeInput`／`NativeSelect`；例外对象的证据 source 没有渲染为链接。真实原生控件、明暗主题、200% 缩放与详情首屏可见性需要后续浏览器验收，不能由日历响应式测试代替。

## 本轮验证与环境

用户明确授权 `sg docker` 后确认 Ubuntu 本机 Docker 可访问。新任务 `mw-session-details-review-20261011`，project 标签 `mw-session-details-review-ubuntu-20261011`。通过 `mw-docker build --component api --purpose acceptance` 和 `market-watch-ubuntu` 构建当前未提交代码，没有复用其他项目的运行实例。

验证使用具名一次性容器、`--network none`、`/tmp` tmpfs，数据库由测试 fixture 在容器内建立 SQLite 内存库。没有 PostgreSQL volume、Compose 网络、服务监听端口或可访问的验收网址，因此这次是容器测试，不是完整 UI/API 实例验收。容器均 `--rm`，测试镜像在测试完成后通过 task 精确清理。没有数据库卷需要归档恢复。

| 检查 | 本轮实际结果 |
| --- | --- |
| 容器 `test_market_calendar.py + test_market_data.py + test_provider_chart.py` | **115 passed, 1 failed**；见 [测试日志](verification/market-session-details-review-20261011/backend-container-tests.log) |
| 宿主日历及 quote fallback 子集 | 13 passed，56 deselected；已有错误语义断言仍能通过 |
| Web 构建 | 通过；见 [构建日志](verification/market-session-details-review-20261011/web-build.log) |
| Node 语法／既有价格格式测试 | 通过；价格格式 38 项检查通过 |
| 改动 Python 编译／`git diff --check` | 通过 |
| 合成后端复现 | 已实际运行当前构建镜像中的函数；见 [结果](verification/market-session-details-review-20261011/backend-reproductions.json) 和 [脚本](verification/market-session-details-review-20261011/reproduce.py) |
| 合成 host 函数复现 | 已实际运行源文件提取的函数；见 [结果](verification/market-session-details-review-20261011/host-reproductions.json) 和 [脚本](verification/market-session-details-review-20261011/reproduce-host.cjs)；不等于原生浏览器验收 |
| 本轮真实图表／活动图表浏览器验收 | 未执行，待修复后使用受控历史 fixture 完成 |

唯一容器测试失败是 `test_quote_quality_distinguishes_open_stale_from_weekend` 的 `test_market_data.py:636`：旧断言要求 `2026-09-25 21:00 UTC`，实现已按新需求显示柱起始时间 `20:59 UTC`。这是应该更新的旧时间契约断言；测试的失败不是改回柱尾的理由。同一输出还包含误报冲突，证实需要独立校验正确状态。

宿主完整套件因缺少 `yfinance` 出现环境失败；本轮容器依赖齐全，以上容器结果取代宿主结果作为相关套件的当前验证。此前文档中的 53／104 项通过为历史记录，不代表本轮当前代码完全通过。

## 从哪里接续开发

1. **先修会话证据与实际身份。** 从 `market_calendar.py::session_status`、`market_data.py::_session_observation` 和 `provider_chart.py::quote_page` 接续。实际来源身份作为显式输入；不能从规则反向生成验证身份。拆开 review_due 提示与有效性。按观测时刻和分钟范围判定冲突、保留合法边界观测。增加账户／环境不匹配、无 profile 账户切换、正常旧报价和闭市内新观测的回归；纠正现有两个错误语义测试。
2. **统一报价字段与可见文案。** 覆盖 provider、managed、history、composite。同一观测绑定价格、时间类型、区间、规则版本及修订；M1 起始标签与精确事件时间分开。由一个展示入口渲染状态、原因、无时间、等待、失败，不让旧聚合日历文案认证会话。更新旧柱尾时间断言，并验证 GET/quotes 不创建额外需求。
3. **修 host 原始快照缓存。** 只存原始 epoch 和字段；按 ticker／实际身份／修订合并推送。时区或活动图表切换重排全部对应快照，formatter 不累计说明；验证订阅替换、快速商品切换和迟到响应。
4. **补日历实际覆盖清单和页面。** 从运行配置与适用身份生成来源启用、品种映射及有效版本，复用相同判定；区分已核实、待复核、未映射和例外未知。复用原生控件，规范化搜索，展示例外证据、页面时区及官方原始时区。未确认的实体／交易所维持 unknown 并明确缺口，不伪造核实结论。
5. **最后做完整 Ubuntu 隔离验收。** 新 task/project，注入受控 provider 历史，让真实图表达到 ready。断言详情首屏状态和时间、原生图例隐藏、多图 activeChart 切换、UTC／UTC+8／纽约 DST／交易所时区、快速切换、失败及无时间。覆盖明暗主题、375/768/1440 和真实 200% 缩放。有 PG volume 时按规定预览退役、备份并实际恢复校验。
6. **审查收口后再提交与发布准备。** 保留当前 worktree，不丢弃未提交实现；更新完成勾选及证据边界，重新核对远端 main 后处理集成。合并、tag、生产发布和切换尚未执行，不从此次审查推断发布授权。

第一批开发可以限于步骤 1–2，先形成正确、可测试的会话和报价契约；随后步骤 3–5 补 UI 与验收。当前应保持“实现中，待修正及补验收”，而不是“只剩生产发布”。
