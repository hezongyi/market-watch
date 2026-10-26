# 自建行情三种维护模式与 AKShare / Yahoo 接入实施任务书

日期：2026-10-24。交付状态：方案已形成，尚未实施。本文可独立交给其他 Agent，无须读取原会话或解释网页。

## 1. 目标、范围与已确定决策

项目为 Market Watch / 守望，个人使用、个人维护。增加以下能力，并保留现有 M1 自建数据和任务：

| 模式（API 值） | 直接采集 | 可选输出 | 约束 |
| --- | --- | --- | --- |
| M1 基础派生（`base_m1`） | M1 | 现有支持的派生周期 | 旧配置默认此模式，保持原行为 |
| D1 基础派生（`base_d1`） | D1 | D1、W1、MN | 不请求、存储或虚构 M1 |
| 原生多周期（`native_periods`） | 各周期原生 OHLCV | 来源与项目共同支持的周期 | 不自动派生、不跨周期拼接 |

原生模式默认选中“来源 / 品种 / 接口 / 价格口径的已验证周期 ∩ 项目白名单”，用户可以取消部分周期。当前项目白名单为 `M1,M5,M15,M30,H1,H4,D1,W1,MN`，保持不变。来源若仅提供 M3、M5、M15，只请求 M5、M15，不能新增 M3，也不能为了得到其他周期暗中聚合。

支持 AKShare 的 A 股、港股、国内期货候选接口；同时让已有 Yahoo 平台品种可以创建 D1 或原生多周期自建行情。股票默认推荐 D1 模式；需要积累供应商有限分钟历史的品种推荐原生模式。现有自建管理页面、调度器、版本、暂停、重试、归档与固定指标链路继续复用。

### 本次必须交付

- 通用 D1 基础与原生多周期自建能力，包含真实覆盖范围、按周期状态、长期保留和窗口滚动更新。
- AKShare 源注册、可搜索品种、按需平台行情读取、自建创建及维护；Yahoo 开放自建入口。
- D1 → W1 / MN 正确聚合；原生模式各周期直接采信来源结果，通过必要 OHLC / 身份 / 时间校验后保存。
- 固定历史图表和 Python 固定指标能读取 D1 / 原生周期，不依赖 M1 产物存在。
- 旧 M1 身份、数据、任务和消费者兼容；迁移与后台恢复验证。

### 明确边界

- 不接入 FXCM，不修改另一个 NR4/NR7、告警 UI 或其他在途任务。
- 不新增实时报价连接，不把自建后台变成全市场全周期扫描；不接入新的组合实时拼接或自动切换告警源。
- 不扩展周期白名单，不顺便开放 Yahoo 当前未实现的 M30 / H4。若另行开放，需独立验证与说明，不能作为本任务隐含范围。
- 三种模式是明确选择；本期不增加“原生 + 自动派生”的第四种混合模式。若某期货原生接口不提供 W1 / MN，则原生模式不展示它们为可用；可另建 D1 模式获得派生周/月线，并复用同口径 D1 采集。
- 不做全市场历史完整性保证，不以分钟齐全为使用门槛，不补造节假日、停牌或丢失 K 线。
- 仅正价格的现有业务约束保持。非正价格样本明确报不支持，不能截断、取绝对值或自动抬到正值；扩展负价格支持另立任务。
- 本文生成本身不授权业务实施、合并或生产操作。用户把本文交给执行 Agent 并要求实施后，可自动完成本地开发与验证；合并 main、正式 tag、Unraid 发布另需用户指令。

## 2. 仓库基线、工作树与开工命令

- 主仓：`/home/quant/repos/market-watch`；main 核查值 `59ed3a3f3fc727da76d13149934d999ebee04218`。
- 集成分支：`market-watch-integration-20261024`；基线 `7fc4fbb84e613e12e4540d7582ea78d137bfcdbd`；工作树 `/home/quant/repos/market-watch-integration-20261024`，方案核查时干净。
- 本方案工作树：`/home/quant/repos/market-watch-history-modes-plan-20261024`；分支 `docs/history-maintenance-modes-20261024`。这是文档工作树，不用来运行实现或数据库。
- 实施建议工作树：`/home/quant/repos/market-watch-history-modes-20261024`；分支 `feat/managed-history-modes-20261024`。
- 实施 task / Compose project：`mw-history-modes-20261024`。路径或名称已被占用时，核实归属后选新后缀，不覆盖其他任务。

执行 Agent 首先读取目标仓库 `AGENTS.md`。只读检查工作树、基线与主机资源。当前其他任务包括 alert-ui、confirmation-snapshot、fxcm-history、nr4-nr7、rolling-range-squeeze，不修改它们。

```bash
git -C /home/quant/repos/market-watch worktree list --porcelain
git -C /home/quant/repos/market-watch-integration-20261024 status --short --branch
git -C /home/quant/repos/market-watch-integration-20261024 rev-parse HEAD
git -C /home/quant/repos/market-watch worktree add \
  -b feat/managed-history-modes-20261024 \
  /home/quant/repos/market-watch-history-modes-20261024 \
  7fc4fbb84e613e12e4540d7582ea78d137bfcdbd
cp /home/quant/repos/market-watch-history-modes-plan-20261024/docs/managed-history-modes-akshare-yahoo-implementation-plan-20261024.md \
  /home/quant/repos/market-watch-history-modes-20261024/docs/
```

命令存在依赖，按顺序执行。若基线已有新提交，先比较差异：无冲突可在最新明确集成基线上创建实施分支，并记录真实 SHA；不要静默改从 main 起步，也不要把旧基线作为必需退回点。计划中符号名与新代码可小幅调整，但不得更改本文行为合同。先建立包含范围、F1 分类和验收矩阵的 Issue 草案，再实施；本轮计划不创建外部 Issue。

## 3. 已核实事实与需由 Agent 完成的接口核实

### 一手资料

- 股票文档：<https://akshare.akfamily.xyz/data/stock/stock.html>。
- 期货文档：<https://akshare.akfamily.xyz/data/futures/futures.html>。
- 源码基线：<https://github.com/akfamily/akshare/tree/2ea08ff44512a9b0c008cd4ff77463b940959c7e>。
- 发布元数据：<https://pypi.org/pypi/akshare/json>，核查版 1.19.3，要求 Python >=3.11，与项目一致。默认固定该版并更新 `requirements.lock`，若实际兼容问题需换版，记录原因和新锁定值。
- AKShare 为 MIT 代码库；上游数据使用范围不由代码许可证统一授权。只按个人项目用途接入，不设计公开行情转售。

| 市场 | D1 / W1 / MN 候选接口 | 小周期候选接口 | 当前已知限制 |
| --- | --- | --- | --- |
| A 股 | `stock_zh_a_hist(period=daily/weekly/monthly)` | `stock_zh_a_hist_min_em(period=1/5/15/30/60)` | 分钟仅近期；M1 文档限近 5 个交易日且无复权；历史开盘价可能为 0 |
| 港股 | `stock_hk_hist(period=daily/weekly/monthly)` | `stock_hk_hist_min_em(period=1/5/15/30/60)` | 近期分钟窗口、延时；样例包含 0 开盘价；代码需保留前导零 |
| 国内期货 | `futures_zh_daily_sina`（只声明 D1） | `futures_zh_minute_sina(period=1/5/15/30/60)` | 分钟调用无历史起止参数；连续合约与到期合约有别 |
| Yahoo | 复用 `provider_yahoo.py` 的已实现周期 | 当前 M1、M5、M15、H1 | 现有保留天数属于请求策略估计，不是供应商长期保证 |

2026-10-24 08:48 UTC 最小公开接口探测：RB0 D1 返回 4266 根，标签范围 2009-03-27 至 2026-10-23；RB0 M5 返回 1023 根，标签范围 2026-09-24 14:05 至 2026-10-23 23:00，两者 HTTP 200。只证明当次可达与窗口不同；未验证整段行情正确性、分钟标签起止含义、盘中延迟或全部品种。

执行 Agent 应在自己的隔离环境为 A 股、港股、期货、Yahoo 各选至少一个有效代表品种，核实 endpoint、代码、时区、交易日、OHLC、成交量单位、价格精度、最后 bar 是否结束、窗口与分页。建议候选为 A 股 000001、港股 00700、期货 RB0、Yahoo 0700.HK / ES=F，实际可替换为仍有效的品种。记录脱敏证据，不需要用户指定这些常规测试样本。

不要把一次空响应当作“不支持这个市场”；先核对代码、休市、网络、限流与解析。某接口数据不合格时可在相同市场内换用经验证的 AKShare 官方接口，但不得静默混合上游；身份与能力表必须随之更新。若某个目标市场始终无法验证，保留其他成果，报告该市场未完成，不能全部宣布成功。

## 4. 数据与产品合同

### 4.1 模式、身份和周期

- 创建时固定模式、价格口径、来源及日历；已有数据集切换模式或复权应创建另一数据集，不重解释已发布历史。修改所选周期或维护时间不改变数据集身份。
- M1 旧身份继续使用原七字段 canonical JSON 与 key，字节 / 哈希均保持。新增身份使用明确 v2 格式，加入 mode、base frame（原生为空）、实际供源族、价格调整和交易日标签规则；新增字段默认值不能进入旧 key 计算。
- 每个直接采集的周期具有独立 SourceIdentity，包含 native timeframe、确切 endpoint / 上游、adjustment、session、timezone、规则版本。日线与 M5 的内容寻址和请求共享不能串用。
- `native_periods` 冻结创建时已验证的默认交集；能力表以后多出周期不自动扩大既有维护计划。UI 可显式勾选新增能力，历史快照记录当时规则。
- 原生窗口不同时，不能将所有周期统一裁成最短范围。每个周期展示实际 first / last / last_success / 状态；请求目标范围与实得范围分开。

### 4.2 合法 K 线与时间语义

- 保留原 `MinuteRow` / `CandleBatch` 读取兼容；增加周期明确的 `NativeBarRow` / `NativeCandleBatch`，不要让 D1 冒充 60000ms 的分钟。
- 新行包含项目 timeframe、规范 start / end、OHLC 的十进制字符串、volume、source label、必要的 trading_date、complete / confirmation 依据；规范 start 的图表标签规则与真实交易时段分开。
- 分钟供应商若用收盘时刻标记，要核实后归一化并保留原标签；不能一律当开盘时刻。D1 保留供应商交易日；中国期货夜盘不按本地自然日直接派生交易日。
- 新增明确的 exchange / source-trading-date 日历语义，D1 周/月归组按对应市场交易日及周/月规则。不得直接把 A 股 / 港股塞成 UTC 24×7 或 NY17。
- 价格必须有限、满足现有正价格范围与 OHLC 极值关系，按数据集精度应用现有价格规则。0 开盘价不能补成 close 或 prev_close；受影响周期不列为已验证支持，并显示原因。有效其他周期继续可用。
- 成交量口径固定：A 股候选文档为手，港股为股，期货为合约；可统一换算，但必须记录规则。持仓量是独立字段，不能当成交量。不可用量为 null，不能编造成 0 或报价次数。
- 严格区分观测到数据、时间已结束、来源已确认。末根进行中 bar 可用于明确标示的预览，但不能成为已闭合固定指标输入；缺乏确认标记时依据已验证 session / 下一根 / 后续日更新规则保守判断，并记录规则。

### 4.3 D1 派生与原生读取

- D1 模式只有一个输入流；D1 直通，W1 / MN：O 为区间第一根有效日线，H 最大，L 最小，C 最后一根，V 为同单位有效量之和；量不可用时保持明确语义。
- 不制造休市日或停牌 bar，不按理论分钟数拒绝聚合。当前周 / 月可保留进行中预览；闭合状态不能仅由“已经有最后一根日线”推断。
- 原生模式每个输出周期等于该周期来源数据；W1 / MN 即使与 D1 聚合结果不同，也不为了对齐而重写。读图与指标记录 `native` 或 `derived + parent frame + rule`。
- 新 D1 / 原生数据不因为没有 M1 产物而从搜索或图表消失；图表支持周期从实际已发布产物取得。切周期仍钉住同一固定版本，不自动跨版本拼接。

### 4.4 长期归档、更新与错误

- 首次：取实际可得历史，保存真实边界；不可回溯窗口记录“来源当前范围之外”，不无限重试。没有日期参数的接口取一次快照再有界切块，不能对每个月重新拉全量。
- 后续：保留旧区间，合并同周期重叠新结果并去重，可信修订写新版本。来源窗口不再返回旧行不代表撤回，不删除旧历史。
- 默认复查原生小周期当前可获取窗口；可分页接口采用有界页。完整 D1 / W1 / MN 默认获取已维护目标范围并比较内容，避免调整或历史修订仅发生在 overlap 之外。
- 失败、限流、超时、短时空结果保留前次有效数据；某一周期失败仍可发布其他周期。新快照内失败周期继承上次有效内容并标记 stale；首次失败且无历史的周期为 unavailable，不伪造产物。
- 有部分成功就形成可用固定快照并显示“部分成功”，失败周期下轮独立重试；重试结果构成后续新版本，不能回写已经发布的部分成功版本。全部失败不推进活动有效版本。未变化且成功可只更新维护成功事实，不能因此删旧数据。
- 暂停、取消、重试、进程退出、租约接管后恢复均按周期 checkpoint。取消后在途响应不能覆盖已固定或更新后的任务；网络等待不占数据库事务。
- 停采超过来源窗口时保留已有数据并标明不可补回区间；行情正常稀疏与已知采集中断分开，不将每个未出现的分钟自动视为故障。

### 4.5 价格调整默认值

- 新 AKShare 自建默认不复权；Yahoo 新自建默认禁用额外 `auto_adjust` 并记录供应商原口径。原 Yahoo 平台股票默认自动复权保持原行为。
- D1 模式允许用户显式选择接口支持的复权口径；调整值进入身份。全历史重拉校验、生成新版本及受影响周/月与指标后缀重算必须实现，不能只回补最近两天。
- 原生多周期一期默认维护未额外复权的系列。对超出上游窗口的历史，若没有可验证的因子与重算能力，不开放会改写历史基准的调整选项；说明原因即可，不要求用户先决定复权工程。
- 接口某周期不支持请求口径时从该口径能力交集排除；例如 A 股 M1 不能标成 qfq。非正价格历史按明确边界报告，不转换成假价格。

## 5. 存储和发布的实施结构

采用“一次版本固定多个周期的快照，周期分别采集，统一 manifest 发布”的路线，复用 `history:<version_id>` 及消费者；不要另建整套历史管理服务。以下为需要实现的最小结构，命名可遵循现有风格：

1. `HistoryVersion` 仍表示数据集一次固定快照；v2 manifest 写 mode、rules、每个输入周期的实际边界、结果、观测时间、来源和 checksum。现有 start/end 仅作为兼容包络，不能代表每个周期都覆盖整段。v2 不使用单一 M1 cursor 判定完成。
2. 新增 `HistoryFrameRun`（`version_id,frame` 联合键）：记录每周期固定请求窗口、cursor / page token、状态、尝试数、retry_at、observed_at、继承来源版本和错误。沿用版本任务租约顺序推进各周期，不添加并发队列服务。各周期重试有界，失败不能永远挡住队列后面的周期。
3. `HistoryChunk` 增加 input timeframe，旧行默认 M1；唯一约束改为 `(version_id,timeframe,start)`。`HistoryReadAttempt`、attempt id、`SourceFetch` 及查询身份均覆盖周期，防止同时间不同周期碰撞。旧查询显式选 M1，避免漏过滤。
4. 新增或等效保存 `DatasetFrameSource(dataset_id,frame,source_id)`，让新模式绑定多个周期采集身份；旧 `DatasetSource` 的 M1 绑定保留。共享 fetch / blob 必须按真正周期身份隔离。
5. `DatasetMaintenance` 增加必要模式 / 调度字段或读取固定数据集身份；保留旧 daily / once 值及其默认值。原生模式允许周期级 schedule，默认 daily；较短窗口可选择 interval，默认 60 分钟、下限 15 分钟。首次不验证出可靠窗口时提示“历史连续性未保证”，不编造保留天数。
6. 各周期独立配置 target start / overlap / next_due / last_success（可存在维护计划 JSON 和对应 frame run 中，避免另建冗余状态表）。定时一次只更新到期周期，其他周期复用旧快照；手动“全部更新”请求全部已选周期。
7. `HistoryArtifact` 继续唯一 `(version_id,timeframe)`。原生周期用该 frame 原始块直通；D1 模式走 D1 直通和周/月 reducer；M1 仍走旧规则。失败且已有历史时复用原块构成新快照的产物，并记录旧观测时间，不冒充刚采集成功。
8. 内容复用优先共享 `SourceBlob` 和未变化块，不复制全历史。发布前核实块完整性与 checksum；同一版本 manifest / artifact 只能固定一次。将新周期引用纳入 `history_retention.py` 的回收入口和 `history_reclamation_impact.py` 的影响报告，保留 pinned 版本及仍被引用的块。

新迁移放 `migrations/versions/`，按实际 Alembic head 追加，不猜 revision。SQLite bootstrap 与 PostgreSQL Alembic 都要适配。旧 JSON / 行不强制重写为 v2，不批量重算旧身份，不借迁移自动创建采集任务。迁移、块格式和读者共同作为 F1 验证对象。

## 6. 接口、调度和适配器

### 6.1 既有 API 的兼容扩展

优先扩展现有 `/api/market-data` 路由，保留旧请求字段：

- `/sources`、`/history-catalog`、`/history-catalog/search`：返回 supported modes、native frames、base frames、adjustment、时区、真实窗口依据；保留 `history_m1`，不能为让 Yahoo 入口通过而谎报它。
- `/center/datasets/check` 与创建：接收 mode、所选周期和明确价格口径；未传 mode 的旧请求继续 base_m1。校验能力交集为空时 422；来源未启用时返回明确原因。
- `/datasets/{id}/maintenance`：保存分周期调度与范围。旧 `overlap_minutes` 仅用于旧语义；D1 使用交易日 / bar 复查，不能把“2天”当作缺少 2880 根分钟。
- `/datasets/{id}/tasks` 与任务状态：返回各周期阶段、真实进度、已知可得范围、更新状态；支持 partial。更新 configured revision 字段集合，保持已有多窗口编辑 409 冲突行为。
- 固定版本 bars / chart / series metadata：仍以固定版本读取，返回真实 frames、各周期 range、provenance、freshness、版本输入依据。检索入口不再硬性要求发布 M1。

### 6.2 调度与负载

- 复用 `history_versions.worker_tick` / `history_maintenance.schedule_tick`；不新增常驻实时流或第二个独立 scheduler。
- D1 默认按市场本地时间每日 18:00 维护，现有数据集配置不变；期货以来源已结束交易日为准，不能把正在进行的夜盘写成最终日线。用户仍可改维护时间。
- 原生模式新建时默认各周期每日一次；已实测小周期窗口不足 2 个交易日的，默认小周期 hourly，D1 / W1 / MN 仍 daily。未知窗口不自动宣称日更足够；提供周期级间隔和简短提示。
- 用共享 source request slot / cooldown；AKShare 默认并发 1、请求间隔至少 1 秒，平台页和自建共用。只采用户保存或当前确有平台阅读需求的品种。
- AKShare 官方部分函数没有 timeout 参数。调用用可终止、可回收的受控子进程执行单次端点请求，默认 30 秒 deadline；超时终止并回收后才释放源资源槽。禁止通过无限后台线程绕过 deadline，也不要全局 monkeypatch requests。实现为模块内调用机制，无新常驻服务。用脱敏结构化协议返回 bars / 状态，不把原始异常、代理或 env 输出给前端。
- 记录实际请求数、每周期行数、耗时和失败码。平台预热不得因注册一个新源而自动拉全周期深度历史；按图表需求读取，调度维护受已保存计划约束。

### 6.3 AKShare 与 Yahoo

- 新建 `provider_akshare.py` / `akshare_catalog.py` 或同职责模块；实际 import AKShare 延迟到启用路径。新增 `ALERTS_AKSHARE_ENABLED`，默认 false，隔离验收显式启用。不假装一个 AKShare 品种能覆盖所有接口周期。
- A 股采用带交易所的内部身份，港股保留 5 位代码；期货保存交易所、具体合约或供应商连续标识。显示代码与 provider_symbol 分开；旧 logical_symbol 仅字母数字且最多 10 字符，要提供稳定短别名而不是截断或丢前导零。
- 目录优先本地缓存；搜索可以刷新目录，不每次维护拉全市场行情。接口切换形成不同 source rules，不能作为静默 fallback 拼数据。
- Yahoo 复用既有 catalog、`_operation`、解析与共享限流；提供显式 adjustment 参数路径，不能复用 mutable 平台缓存当作固定归档证据，也不能改平台默认。
- 用户不需要申请 AKShare API 账户即可实施这些公开候选接口；若具体备用端点确需额外账户，将其排除本期默认范围，而不是暂停全部任务向用户索取账号。

## 7. 文件与改造位置

以下路径相对实施工作树；新增文件已标为“新建”，具体结构应保持模块职责简单。

| 文件 / 目录 | 动作 |
| --- | --- |
| `backend/alerts/market_contracts.py`、`source_registry.py`、`market_datasets.py` | v1 身份兼容、v2 模式 / 原生 bar 合同、分周期绑定、last/trade 与价格规则 |
| `backend/alerts/storage.py`、`migrations/versions/` | 周期状态、块约束、维护配置的迁移与 bootstrap |
| `backend/alerts/history_sources.py`、`source_history_store.py` | 多周期采集、按 frame 共享请求 / blob、D1 批处理，旧 M1 路径保留 |
| `backend/alerts/history_versions.py`、`history_maintenance.py`、`history_commands.py` | 周期状态机、固定截止、合并保留、partial 发布、调度和幂等 / 暂停 / 恢复 |
| `backend/alerts/history_artifacts.py` | 原生直通、D1 reducer、M1 旧产物兼容 |
| `backend/alerts/aggregation_policy.py`、`domain.py`、`calendar_profile.py`、`chart_data.py` | 显式交易日规则、周/月边界，避免 UTC0 / NY17 误用 |
| `backend/alerts/history_api.py`、`history_catalog.py`、`history_creation_check.py` | 模式与源入口、能力和创建校验、分周期范围与状态 |
| `backend/alerts/provider_capabilities.py`、`provider_chart.py`、`provider_service.py`、`provider_cache.py`、`market_resources.py` | AKShare 平台 dispatch、按需缓存 / 限流，避免全周期预热 |
| `backend/alerts/provider_akshare.py`、`akshare_catalog.py`（新建） | 端点路由、周期 / 口径映射、有效品种目录、受控 SDK 调用 |
| `backend/alerts/provider_yahoo.py`、`yahoo_catalog.py` | 显式归档读取口径、平台默认不变、修订处理 |
| `backend/alerts/series_access.py`、`fixed_indicators.py`、`managed_indicator_inputs.py` | 无 M1 历史可选、对应周期固定指标、修订依据 |
| `backend/alerts/history_request_evidence.py`、`history_comparison.py`、`history_retention.py`、`history_reclamation_impact.py` | 周期证据 / 比较 / 引用 / 回收语义，旧报告兼容 |
| `web/src/market-data/` 内 `DatasetCreate.tsx`、`CreationCatalog.tsx`、`PlatformMarket.tsx`、`SeriesPicker.tsx`、`types.ts` 及实际维护组件 | 模式选择、周期交集、调度、按周期覆盖与 partial 状态、AKShare / Yahoo 创建入口 |
| `advanced-host/bridge.js`、`web/src/instrumentPresentation.ts`、`web/src/market-data/CalendarView.tsx` | 来源文案、真实 frames、交易日标签；只在现有接口不足处修改 |
| `pyproject.toml`、`requirements.lock`、`Dockerfile`（必要时） | 固定 AKShare 及兼容依赖，检查 Linux wheel / 动态库；不意外升级无关依赖 |

前端复用当前样式。创建流程为：选来源与品种 → 选模式 → 展示可选周期 / 价格口径 → 配置维护。原生模式展示每周期原生范围，不用一个“全部完整”徽标掩盖差异。只显示用户需要的“原生 / 日线派生、覆盖范围、更新状态”，内部 hash / lease 不进入常规用户流程。

## 8. 分阶段执行顺序

1. **S0：盘点与建立证据。** 核实基线和 AGENTS，建立 Issue 草案；创建 `docs/verification/history-modes-20261024/`，记录旧身份 / 迁移 head / 现有测试入口，完成四市场最小接口核实。尚未核实的 frame 不登记为可用。
2. **S1：合同与迁移。** 实现 v2 身份、新 bar / batch、周期绑定与 frame run；先用有代表性的旧 M1 行和已发布版本验证升级读取和 key 不变，再进行新模式任务。
3. **S2：D1 模式。** 用 deterministic D1 fixture 跑创建 → 导入 → D1 / W1 / MN → 图表 → 固定指标。实现交易日、月跨年、进行中周/月与修订重算，不请求 M1。
4. **S3：原生多周期。** 实现周期交集、独立窗口与进度、滚动保留、重叠修订、失败继承 / partial 发布和调度。完成取消 / 重启 / 接管，不用真实网络模拟失败场景。
5. **S4：来源接入。** 接 Yahoo 显式归档读取，再接 AKShare 端点与受控调用；启用按需平台展示、目录与创建。复用 S0 确认事实；加入真实网络 smoke，不以 mock 代替四市场实际可用性证据。
6. **S5：前端与消费者。** 完成三模式入口、各周期范围 / 状态、配置冲突、图表选择和 Python 固定指标；确认旧组合 / 告警不被新日历或模式误接入。
7. **S6：F1 验证与交付。** 隔离 PG14.24 上做旧 schema 升级、断点恢复和 fixed snapshot 回归；运行相关测试、CI、自审和仓库要求的独立 Standards / Spec review，必要时定向 R2。创建 Draft PR，提交已验证证据和剩余限制，停止于合并前。

阶段可以分提交，不得只完成“源名字出现在下拉框”就交付。若拆成多个 PR，最后一个收口 PR 必须覆盖完整验收矩阵并列出依赖，不能把尚未实现的能力写为完成。

## 9. 验证命令与环境准备

### 9.1 本地依赖和快速回归

在实施工作树创建专用 venv，不修改主仓 / 其他任务的 `.venv`。Python >=3.11、Node 22。先修改和锁定依赖，再安装；以下命令中的新测试文件需在 S1～S5 创建。

```bash
cd /home/quant/repos/market-watch-history-modes-20261024
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install -e . --no-deps
.venv/bin/python -m alembic heads
.venv/bin/python -m pytest -q \
  backend/tests/test_market_contracts.py \
  backend/tests/test_source_registry.py \
  backend/tests/test_history_maintenance.py \
  backend/tests/test_history_versions.py \
  backend/tests/test_history_artifacts.py \
  backend/tests/test_source_history_store.py \
  backend/tests/test_series_access.py \
  backend/tests/test_fixed_indicators.py \
  backend/tests/test_managed_indicator_inputs.py \
  backend/tests/test_provider_yahoo.py
```

新建并运行有行为风险覆盖的测试，不要求机械镜像每个 helper：

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_history_modes.py \
  backend/tests/test_native_history_archive.py \
  backend/tests/test_provider_akshare.py
```

变更 Python 文件运行 Ruff；至少覆盖新增模块和实际修改文件，修复本次问题，不顺便整理全仓旧 lint。前端：

```bash
cd /home/quant/repos/market-watch-history-modes-20261024/web
npm ci
npm run build
node tests/advanced-history-empty-failure.cjs
node tests/swing-fixed-identity.cjs
node tests/native-indicator-identity.cjs
```

新增 `web/tests/history-modes.browser.cjs`，通过 `MW_HISTORY_MODES_BASE_URL` 和 `MW_HISTORY_MODES_AUTH_FILE` 配置验收地址与私有登录文件；禁止写死已有验收地址、生产地址或密码。浏览器测试覆盖 §10 的用户流程，不为静态文案单独建立脆弱快照。验收实例启动后，将这两个变量设为本任务的实际值，在 `web/` 执行：

```bash
node tests/history-modes.browser.cjs
```

### 9.2 Ubuntu Docker 与 PostgreSQL

风险为 F1：持久格式、迁移与后台链路。只能在 Ubuntu 本机 Docker 验证；不在 Unraid 启动调试服务。启动前只读执行 `docker compose ls`、`docker ps`、`ss -ltn`、`free -h`、`df -h`，按 `deploy/ubuntu/README.md` 检查余量，不自动停别的任务。

S6 创建 `deploy/ubuntu/history-modes.acceptance.yaml`（新建，下面引用前必须创建）：

- 独立 project / bridge network / postgres volume / 数据库 / 私有 env。PG 固定 `postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`，验证 server_version_num 140024。
- 服务限于 postgres、migrate、api、history-worker、web，UI 确需图表宿主才加 chart。worker 执行 `python -m alerts.history_versions`。设置有界 memory / CPU 与日志轮转，按主机余量估算后记录，不照搬所有生产 worker。
- 候选端口 api 18761、web 18762、PG 18763、chart 18764，均先核实空闲并只绑回环；冲突时 Agent 自行选空端口、统一更新配置与报告。
- `ALERTS_DELIVERY_ENABLED=false`、OANDA stream 关闭、不载入真实账户；验收显式 `ALERTS_YAHOO_ENABLED=true`、`ALERTS_AKSHARE_ENABLED=true`。真实端点 smoke 需要任务网络允许受控出网；默认 preview 的 internal 网络不能用于声称已完成联网验证。
- 新建迁移验证脚本 / 用例，旧基线数据库与候选新数据库均属于本任务。可在一个任务 PG 中使用不同测试库；禁止与其他任务共享可写库。旧版只读兼容验证与降级测试在独立副本完成。
- env / 代理 / 登录密码位于 workspace 外权限 0700 / 0600 的私有目录。Compose 采用 `--env-file`，不把凭据写进命令历史、测试报告或仓库。

API 镜像构建入口（从任务工作树）：

```bash
mw-docker build --repo . --component api \
  --tag market-watch-api:history-modes-20261024 \
  --task mw-history-modes-20261024 --project mw-history-modes-20261024 \
  --purpose acceptance
```

web / chart 同样用 `mw-docker build --component web|chart` 和相同 task / project；web 的 `VITE_ADVANCED_CHART_ORIGIN` 必须等于实际 chart origin。许可资源缺失时沿用仓库合法资源准备方式，不复制或提交许可库。

创建私有 env 后，在当前 shell 设置非系统变量 `MW_HISTORY_MODES_ENV_FILE` 指向其绝对路径；此文件必须提供验收 Compose 需要的密码、镜像引用与端口。构建并核实镜像实际 ID 后写入，不能把别的任务镜像冒用成本任务。启动命令：

```bash
docker compose --env-file "$MW_HISTORY_MODES_ENV_FILE" \
  -p mw-history-modes-20261024 -f deploy/ubuntu/history-modes.acceptance.yaml config --quiet
docker compose --env-file "$MW_HISTORY_MODES_ENV_FILE" \
  -p mw-history-modes-20261024 -f deploy/ubuntu/history-modes.acceptance.yaml up -d --no-build postgres
docker compose --env-file "$MW_HISTORY_MODES_ENV_FILE" \
  -p mw-history-modes-20261024 -f deploy/ubuntu/history-modes.acceptance.yaml run --rm migrate
docker compose --env-file "$MW_HISTORY_MODES_ENV_FILE" \
  -p mw-history-modes-20261024 -f deploy/ubuntu/history-modes.acceptance.yaml up -d --no-build api history-worker web
```

启用 chart 时加到最后命令。PG 新库必须做 `alembic upgrade head`，不能只由 ORM create_all 掩盖迁移问题。设置 `TEST_POSTGRES_URL` 为本任务可达测试库，随后执行：

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_history_maintenance_postgres.py \
  backend/tests/test_history_artifacts_postgres.py \
  backend/tests/test_source_history_store_postgres.py \
  backend/tests/test_series_access_postgres.py \
  backend/tests/test_history_modes_postgres.py
```

`test_history_modes_postgres.py` 为 S6 新建。不能将 PostgreSQL 测试全 skipped 视为通过。`TEST_POSTGRES_URL` 及浏览器私有文件只在本地设置，不回传值。按 CI 要求执行全量 backend / web / compose 检查；CI 必需上下文全部通过后再进入交付。

停止本任务保留数据：

```bash
docker compose --env-file "$MW_HISTORY_MODES_ENV_FILE" \
  -p mw-history-modes-20261024 -f deploy/ubuntu/history-modes.acceptance.yaml stop
```

不执行 down -v / prune，不删除用户验收数据。是否退役按 AGENTS 与 `mw-docker retire` 清单、归档和恢复规则处理，不因实现结束自动销毁待用户验收的实例。

## 10. 必须逐项闭环的验收矩阵

| ID | 场景 / 操作 | 通过条件 |
| --- | --- | --- |
| A01 | 升级带旧 M1 数据、任务、产物的数据库 | 旧 key / 绑定 / checksum / 版本 ID 不变，原检索、任务、指标可用，迁移不触发新采集 |
| A02 | 股票创建 D1 模式，勾 D1 / W1 / MN | 全过程无 M1 请求或产物依赖；日周月可看可算固定指标 |
| A03 | 日线跨周、跨月、跨年、休市 / 停牌、当前未结束周月 | OHLCV 与预期 fixture 一致；无假 bar；进行中 / 闭合正确，稀疏不反复重置指标 |
| A04 | 测试来源能力仅 M3 / M5 / M15 | UI / API 只允许 M5 / M15，网络 spy 不出现 M3、M1 或其他派生请求 |
| A05 | 同品种 D1 多年、M5 近期 | 两周期独立显示正确范围，可读取；不裁成相同起点，不因无 M1 隐藏 |
| A06 | 上游窗口滚动；旧段不再返回；重叠含可信修订 | 旧历史仍在，新数据追加，时间键无重复；修订形成新固定依据，旧版本仍可复现 |
| A07 | M5 超时 / 限流 / 空响应，D1 成功 | D1 更新可用，M5 旧有效内容保留且 stale；显示部分成功，重试只处理应处理周期 |
| A08 | 所有周期失败 / 首次一个周期失败 | 全失败不推进有效版本；首次失败周期 unavailable，成功周期可用，不伪造空产物为成功 |
| A09 | worker 断开 / 接管 / 暂停 / 取消及重试 | 周期 checkpoint 可恢复，无跨周期覆盖；旧在途返回不能重写已取消任务 |
| A10 | 日更与 hourly 的到期判断 / 配置双窗口编辑 | 只取到期周期；暂停不再采集；旧配置幂等与 409 冲突语义继续成立 |
| A11 | 原生 W1 与 D1 reducer 故意返回不同结果 | 原生模式保留原生 W1；D1 模式输出派生 W1；元数据能辨认来源，不静默替换 |
| A12 | D1 前复权发生远期历史修订 | 全维护范围比较能识别；新周月 / 指标依据更新；旧固定版本不变；原生受限分钟复权不假装可全量修复 |
| A13 | A 股 / 港股 / 期货 / Yahoo 真实端点各一代表品种 | 端点事实、量单位、时区、标签与价格精度记录齐全；至少 D1 成功，小周期支持按真实可用能力登记；异常不被宣称为全市场支持 |
| A14 | 重复图表读取与一次维护并行 | 共用源限流 / 有效请求去重；不会因打开图表启动全周期深度预热；未保存品种无后台维护 |
| A15 | 清理缓存、历史回收与旧版本引用 | 平台短缓存清理不删除归档；仍被固定版本 / 指标引用的跨周期原块保留；任务只读状态查询无行情请求 |
| A16 | 0 开盘价、错代码、成交量异常、非正价格 | 不伪造、不改变价格；明确错误或该周期不可用；其他有效周期继续工作 |
| A17 | 任务隔离与成本记录 | Ubuntu 本地真实 PG14.24、独立 project / 端口 / volume；记录日线单品种及原生单品种请求数 / 耗时 / 资源，未触碰生产 |

确定性 fixture 的验收与 live smoke 分开。周六无法验证盘中延迟时明示该限制；不阻断已能证明的日线维护，也不能伪造实时验收。某个候选小周期 OHLC 不合格可不宣称支持，但必须说明；三种模式通用引擎的分钟行为仍需有效真实来源样例和确定性失败用例证明。

## 11. 完成、证据与停止边界

执行 Agent 交付：

1. 实施分支、提交列表、Issue 草案 / Draft PR；PR 说明具体行为、F1 原因、验证及接口限制。
2. `docs/verification/history-modes-20261024/report.md`：A01～A17 逐项结果与证据路径；单测 / PG / browser / live / CI 分开，不混用“未执行”和“通过”。
3. `provider-capabilities.json`：按市场 / 上游 / 口径 / 周期记录已验证能力、时间语义、窗口依据与未支持原因；避免把请求策略写成供应商 SLA。
4. 旧库升级前后身份 / 校验和比较、schema 迁移结果、固定版本复现与 worker 恢复报告；说明旧二进制对新模式数据的限制。回退默认保留原库与新数据，不能直接 DROP 新周期字段来制造“回退成功”。
5. Ubuntu 实例主机、实际 URL、精确启动 / 停止命令、任务资源与脱敏登录方式说明。密码仅存私有文件；不在文档中粘贴值。
6. 所有范围内必需检查通过，独立 review 结论收口后停止于准备合并前，向用户报告结果。生产 Yahoo 的长期启用要求保持，不修改历史 release 清单或生产 env。

Agent 自行解决：代码拆分、实际样本、可用端口、同市场官方端点选择、有界分页、锁定依赖兼容与受控请求实现。无须逐项询问用户。必要接口事实缺失时先研究和测试，不能把常规工程核实当成产品问题。

仅在以下情形停下报告唯一需要的决定：需求与仓库真实能力出现无法兼容的冲突；必须扩大为新实时流 / 新周期 / 不可逆迁移才能达标；隔离或资源无法满足；准备合并、正式 tag / Unraid；数据归属、备份或恢复异常。某来源临时失败时先完成通用引擎和可独立验证部分，并明确受阻范围，不以整项完成交付。

## 12. 可直接交给执行 Agent 的启动指令

> 阅读并执行 `docs/managed-history-modes-akshare-yahoo-implementation-plan-20261024.md` 和仓库 `AGENTS.md`。以文中集成基线建立独立实施工作树，按 F1 完成 M1 兼容、D1 派生、原生多周期归档、AKShare 与 Yahoo 接入、UI、测试、隔离 Ubuntu 验收、CI、自审、适用独立 review 和 Draft PR。常规技术核实自行完成，不逐步询问；不要改其他任务，不合并 main，不创建正式 tag，不发布生产。交付 A01～A17 的证据及可验收实例；只有文中停止边界触发时才报告需要我决定的一件事。
