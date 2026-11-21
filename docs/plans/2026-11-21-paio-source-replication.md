# PAIO（Price Action All In One）源码复刻实施方案

日期：2026-11-21。状态：方案已形成，尚未实现，未加入待实现索引。用户本轮授权为“形成方案”。本文件是独立可执行的实施任务书；开始实现、合并与发布是后续动作。

## 1. 目标、基线与交付物

在 Market Watch 的手机/桌面共用图表中新增一个 **PAIO 价格行为组合指标**，复刻用户提供的 Pine v6 源码：Gap Series、Bar Index、Moving Average、Previous Values、I & O Bar、H & L Count 六组功能及原有 10 个告警条件。

**判定以源码为准，不替换为此前建议的 Brooks 标准定义。** 不默默修复疑似问题，不仅实现 ii/iii 就宣称完成整套复刻。内部按模块开发，用户入口保持一个组合指标。

| 项目 | 记录 |
| --- | --- |
| 项目仓库 | `/home/quant/repos/market-watch` |
| 方案工作树 | `/home/quant/repos/market-watch-paio-plan-20261121` |
| 分支 | `docs/paio-replication-plan-20261121` |
| 已 fetch 的远端基线 | `origin/main@f4a3279aff0bd75ed4e2ab48e67bc898fc69af9a` |
| 原件 | [paio-fengyangsi-v6-20261118.pine](../references/paio-fengyangsi-v6-20261118.pine)，336 行 |
| 原件 SHA-256 | `6793dc1349ed61698c569b17447b9930e7868ea89ab7742a2f5ae25640cd1b78` |
| 来源与许可 | 用户 2026-11-18 提供；© fengyangsi，MPL 2.0；未提供上游发布 URL |
| 本次风险等级 | P0，仅文档及参考源码 |
| 实现预判等级 | F1：新增可持久恢复的指标状态、多周期依赖与后台告警计算；默认无数据库 schema 迁移 |

实现交付包含 Python 算法与检查点、图表显示与设置恢复、原有条件的告警接入、同源输入对照数据、Ubuntu Docker 验收记录与 Draft PR。直接移植的文件保留作者、来源、MPL 2.0 说明，新增许可文件说明移植文件范围；不改写整个仓库许可证。

本方案不依赖其他工作树里的研究文档。原件已逐字节复制到本工作树，实施时随计划一并带入实现分支。

## 2. 范围与兼容承诺

### 2.1 包含

- 六组功能全部纳入，保留原分组、默认参数、颜色、透明度、字体大小、线型、三组 EMA 独立 offset 和 Previous Values 两种显示方式。
- II/OO/IOI 的精确比较与连续标签更新，包含 iii、iiii、ooo、ioii 等原脚本产生的文字，不新增独立 iii 算法。
- 图表盘中预览、收盘提交、历史分页、数据修订、重启恢复和多实例隔离。
- 原始 10 个 `alertcondition` 可通过现有告警框架创建，后台不依赖图表开着。
- 同源品种、同一价格口径、同一交易时段的多周期取值。
- 当前项目已支持的时间型周期 `M1/M5/M15/M30/H1/H4/D1/W1/MN`，包含请求周期低于、等于和高于图表周期。默认 15m/60m 在 H4/D1 图上仍需要正确工作。

### 2.2 产品宿主边界

TradingView 特有能力不会因移植这个脚本而自动获得。以下是明确边界，设置界面与验收记录应准确说明，不算已支持：

- 不新增秒线、tick、Renko/Heikin Ashi 或任意自定义周期。未支持周期必须禁选或明确报错，不替换成接近的周期。
- EMA Source 首期提供内置价格来源 `open/high/low/close/hl2/hlc3/ohlc4/hlcc4`；默认均为 close。不增加 TradingView `input.source` 的“任意其他指标输出”绑定能力。
- 使用当前行情身份的实际 session；已有 RTH 图表按其 bar 计算。不为本指标新增交易时段编辑器，也不把全时段数据伪称 RTH。
- 字体度量、自动字号、上下 bar 的像素间距依宿主图表实现；保证文字、时间锚点、方向、颜色与生命周期一致，不承诺 TradingView 像素级相同。
- 不新增缺口回补管理、趋势评分、突破成功率、自动交易、H2/L2 交易解释或更多 Brooks 形态。

以上边界不删减六组算法。若后续明确要求扩展宿主能力，应另立范围，不藏在 PAIO 实现中。

### 2.3 必须保留的源码行为

| 源码行为 | 实施规则 |
| --- | --- |
| II 排除最后两根完全同区间，前一对没有同样排除 | 原样保留，不能改成 Brooks 包含等号的统一 inside 连续计数 |
| OO 仅对最后一对要求至少一端严格越界 | 原样保留；前一对可完全同区间 |
| IOI 没有严格比较条件 | 三根区间全等也成立；不追加第四根 inside 要求 |
| 连续 II 会改写旧标签为 iii/iiii | 复现标签 ID、原时间锚点与更新文字；另外记录实际检测时间 |
| IOI 标签锚在完成柱的前一根 | 按原坐标显示，不能把告警时间也前移 |
| Gap 开关及排除规则只控制绘图 | 原始 gap 条件仍计算、仍可告警 |
| II/OO/IOI 的 use 开关只限制绘图分支 | 关闭绘图仍保留各自原始条件；保留标签分支间相互影响 |
| 向下 Body 的两个 Except 开关与向上不对称 | 按第 60 行逻辑保留，覆盖非默认开关组合 |
| Bar Index 指定编号分支绕过 bi_use | 保留 `AND` 高于 `OR` 的实际条件，不加括号“修正” |
| Bar Index Step=2 用 `%3` | 实际每三根显示；Length 只是显示上限，不是计数重置长度 |
| Previous Values 非图表分支没有 `[1]` | 不替换成固定上一根高周期值；按 request.security 的实际映射实现 |
| 非图表 CurrentOpen 映射到 close | 按 `parserSource` 保留，不换成 open |
| H/L 同一 outside bar 可以双触发 | 按源码先后顺序执行，不猜测盘中路径 |
| H/L useHLC 参与状态推进 | 不是单纯隐藏文字；参数更改按新参数从固定起点重放 |

如 TradingView 实际运行显示与静态推断不同，应以原脚本在明确 Pine v6 上的证据修订兼容说明，不自行选择“更合理”结果。

## 3. 输入、数值与输出契约

### 3.1 指标身份与设置

- 新增 `PAIO_V1`，版本字符串 `1`；搜索别名 `PAIO / Price Action All In One / 价格行为 / fengyangsi`，主图指标。
- 新增算法版本 `paio-fengyangsi-v6-state-v1` 与显示 profile `paio_v1`。原有指标 ID/检查点不变。
- 实现阶段先从原件全部 `input.*` 生成设置对照表，保留默认值及依赖；不可只登记常用参数。三组 EMA 和三组 Previous Values 独立设置。
- 凡影响数值、是否执行算法分支、对象创建/删除、500 配额或标签合并的参数，均纳入规范化计算 spec。包括各组 Use/Except、编号筛选、PV Display/LineDraw 与 HLC Interval。
- 字体、颜色、线宽等纯样式可留在 `display_inputs`。参数分界不能只凭 Pine 中属于“显示选项”判断；改变它若影响对象队列就必须重放。
- `bi_specific` 按 `str.split(..., ',')` 的实际字符串匹配，不擅自 trim、解析为整数或去掉前导零。
- 当前计算参数已有 bool/enum，但不等于支持任意字符串；为 `bi_specific` 增加明确的有长度上限 text 参数声明及前后端校验，不将其塞进 enum 或由前端单独计算。保持旧参数类型的校验不变。
- Pine 中实际可用的输入范围与项目容量上限分开记录。EMA Length=0 等会触发原函数错误的值须明确拒绝；不能静默改为 1。过大参数若被项目限制，应明确显示上限，不声称无限等价。

### 3.2 输入上下文

统一输入至少包括：原始 OHLC、bar.start/end、chart_time、complete、有效数据间断标记、行情身份、日历/session/时区、固定计算起点、输入 revision、图表尾部 `last_bar_time` 和请求观察时刻 `as_of`。

价格比较使用原始行情精度，不将 EURUSD 舍入到 4 位或 JPY 舍入到 2 位，不默认添加一个 tick/pip 容差。这与独立头寸计算器的简化位数无关。

EMA/均值用现有 float64 数值路线；不引入 Decimal 全量行情运算或新数学库。布尔/计数/对象 ID 必须精确；EMA 对照以 `rtol=1e-10, atol=1e-12` 起步，若供源导出精度不足，记录其精度并单列误差，不能放宽到掩盖初始化错误。

正常休市、周末、缺少少量 M1 是实际 bar 序列，不凭分钟数不齐就复位。显式未知依赖段沿用框架的数据质量策略，绝不填造 OHLC；与同输入 Pine 比较时区分“Pine 也没这根 bar”和“项目数据尚未取得”。

### 3.3 数值与显示结果分离

固定有序数值输出至少包含：

```text
gap_open_up, gap_open_down, gap_wick_up, gap_wick_down,
gap_body_up, gap_body_down, specific_bar,
pattern_oo, pattern_ii, pattern_ioi,
ema_1, ema_2, ema_3, pv_1, pv_2, pv_3,
bar_number, h_count, l_count
```

前 10 项与原 `alertcondition` 一一对应，为 `1/0/null`：true/false/尚无足够输入。II 在 iii 阶段仍可为 1；不得把它转换成仅第一次 ii 为真的脉冲。不新增“iii 告警”冒充源码已有条件。

`h_count/l_count` 是状态值，不默认构成告警；H/L 标签创建事件放在显示记录中。`pv_*` 要区分原始选定值、线段坐标和经过第 243–245 行处理后的 plot 值，不能用同一个数组近似两种绘图模式。

主图实际 plot 只暴露三组 EMA 与适用的 PV 曲线；boolean、计数及中间坐标不画成价格线，不把 0/1 拉入主图价格缩放。它们保留为可查询数值输出和告警条件。

显示输出采用 PAIO 专属、版本化 schema（实施时创建），包含：

- 本批输入身份/依赖 revision、`as_of`、`last_bar_time`、确认/预览状态及各模块 readiness。
- 当前保留对象的快照，或有序 create/update/delete 操作及必要分页恢复快照。
- 对象 ID、种类、归属模块、创建序号、原锚点、几何/文字、`detected_at`、样式引用。
- 内部创建序号单调递增，修改文字不改变创建顺序；回滚/更正有独立输入 revision。

`series_presentation_v1` 当前校验与 Swing SR 绑定，不能直接塞入 PAIO 对象。新增 `paio_presentation_v1` 并独立校验；不要把旧 Swing 输出规则放宽成任意 JSON。

## 4. 六组算法的移植要求

### 4.1 Gap Series（原件 8–63 行）

Open 比较相邻两根完整高低区间：向上 `L[t]>H[t-1]`，向下 `H[t]<L[t-1]`。Wick 比较 t 与 t-2，Body 比较 t 与 t-2 的实体上下沿；保留 `if / else if` 顺序。

矩形仅覆盖原始两端 bar 之间，不延展、不判断回补。上下坐标严格按原件传入值形成等价矩形；全体 gap 共享 500 boxes 配额。绘图过滤与数值条件分别输出。

### 4.2 Bar Index（64–80 行）

从固定数据起点按 Pine `var` 初始化，目标周期改变时置 1，其余逐根递增。首根和缺失前值按 Pine v6 语义，不把载入窗口首根当成新交易日。`From/Length/Offset/Step/Specific Bars` 使用原公式，指定编号告警独立于常规显示条件。

### 4.3 Moving Average（81–126 行）

每组独立请求其周期 EMA，`gaps_on`。请求无值时按 `last + (source-last)*2/(length+1)` 生成临时值，临时分支不更新 last；请求有值才更新 last。

Pine `ta.ema` 初始化、na 跳过与首个有效值必须建立对照；不能直接复用 TA-Lib EMA 的 SMA 初始化来假定等价。关闭 EMA 显示不跳过源码中无条件执行的请求或改变其状态。

offset 是绘图 bar 偏移，不是时间加 offset 分钟，不改变计算时序或告警检测时间。未来位置使用宿主 bar 映射，不补造周末 bar。

### 4.4 Previous Values（128–249 行）

图表分支精确重放每组的 current/last OHLC 状态及切换次序；中途开始的首个周期维持原初始化行为，不凭空补出开盘。支持 close/high/low/open/hl2/hlc3/ohlc4/hlcc4/CurrentOpen 对应原表达式。

非图表分支按 `request.security(...gaps_off)` 和 `parserSource` 映射；没有 `[1]`、CurrentOpen 返回 close 都保留。LineDraw 模式使用切周期当根的原值创建 line；plot 模式另外执行值变则 na 的断线逻辑。

`Today/TimeFrame/All` 用当前完整图表历史的最后 bar 时间判断；不能用当前 API 分页最后一根，不能用服务器自然日。`time_close(tf,-1)` 需要日历推算下一期端点，包含休市、隔夜与 DST。高低周期边界落在单根 chart bar 内时，遵循 Pine 的实际选择规则，不凭累计 chart OHLC 伪造更小周期。

### 4.5 I & O Bar（251–296 行）

```text
I(t) = H[t] <= H[t-1] AND L[t] >= L[t-1]
W(t) = H[t] >= H[t-1] AND L[t] <= L[t-1]
N(t) = H[t] != H[t-1] OR L[t] != L[t-1]
II(t)  = I(t) AND I(t-1) AND N(t)
OO(t)  = W(t) AND W(t-1) AND N(t)
IOI(t) = I(t) AND W(t-1)
```

分支顺序为 OO → II → IOI。last-label 引用、get_x/na 的结果、前缀串构造、删除后引用都按原件与 Pine 运行证据实现。不能仅显示“连续 inside 的长度”替代原标签过程。

允许用连续 `patternII/OO` 计数代替反复 while 回扫，但要证明包含 use 开关、间断和重叠时输出等价。预期逐根增量为 O(1)，不是每次 O(n) 回扫；对象快照成本上限由 1500 个保留对象限制。

### 4.6 H & L Count（298–336 行）

原样保存 HCount/HLastL/BullPB/BullPBL 与 L 分支对应状态，按源码顺序更新。H 的回撤低点高于上次时置 1；L 的回撤高点低于上次时置 1。无额外趋势/EMA过滤，无交易日重置，可能同根双标签。

`SMA(high-low,100)*HLCInterval` 只控制坐标；前 99 根没有有效距离时仍须推进状态。验证 Pine 对 na 坐标 label 的创建和对象配额，不自行忽略其逻辑存在。

## 5. 多周期取值与状态设计

### 5.1 PAIO 专用依赖装配

新增 PAIO 专用上下文装配模块，不开发通用 Pine 解释器。先列出当前 spec 真正执行的 request：三组 EMA 的请求一直存在；PV 依赖由实际 BaseChart 分支决定，具体以 Pine v6 的分支执行证据为准。

- 通过现有 source/history/composite 读取入口装配同身份 OHLC、请求周期与交易日历。
- 图表周期较低时，有正确边界才可聚合为高周期；source-native 与 chart-derived 分别保留身份，不能互相偷换。
- 图表周期较高时，读取实际低周期依赖，按 request.security 的 intrabar 选择规则返回单值。只靠 H4 bar 不能恢复 15m EMA。
- 数据读取沿用现有有限历史需求、取消、容量与质量机制。缺少的周期显示具体模块等待/不支持，不用其他供源代填，不无限追溯供源。
- 算法在数据库连接释放后计算；多周期依赖在同一观察版本冻结，避免计算中查询到另一版前缀。

当前通用纯数组 calculator 只拿到字段数组与 params，无法凭空取得多周期和日历。为 PAIO 增加显式 rows/context 路径，参照 NR4/NR7 的专用分支，不修改所有旧 calculator 签名。上下文由服务端已核实的行情身份装配；API 调用者不能上传任意对象状态、供源替身或检查点来冒充可信计算结果。

依赖身份至少纳入 spec、源 OHLC revision（包含 open）、所有请求周期 revision、日历/session、固定计算起点、as_of 与历史/实时映射模式。现有仅看单周期或只包含 HLC 的缓存键不足以证明 PAIO 等价；修改必须针对新增依赖，不清空其他指标全部缓存。

### 5.2 request.security 必须先建立的对照

建立一份“Pine 语义确认表”，至少验证：默认 lookahead、gaps_on/off 在历史/实时各阶段的返回、相等周期、低周期 intrabar 选择、未完成高周期值、请求周期换界及历史重载。

不能把“始终取已完成高周期”作为兼容捷径。Pine 历史重载与实时观察可能不同；对照要分别记录二者。若同一低周期柱在高周期提交后发生映射修订，按依赖修订重算图表；不能为了不改历史而冻结错误值，也不能把重算变成新告警。

起点由现有固定计算源/检查点决定，记录所有请求序列的起点。回放对照必须使用相同输入前缀；不能用几十根 warmup 近似 EMA 后声称完全一致。

### 5.3 状态与盘中回滚

状态包含各模块累积量、短 OHLC 窗口、100 根 range 队列、每组 EMA/PV 状态、连续 pattern 计数、last-label 引用、共享对象队列和依赖 cursor。仅保留有明确用途的状态；不存无限 bar 历史。

每个确认 chart bar 从前一确认检查点推进一次。未收盘 chart bar 在检查点副本上执行，更新/删除/创建都作用于副本；下一次 tick 从确认状态重算，不在上次临时状态上继续计数。请求周期也有确认/临时副本，不能因 chart bar 已收盘就错误提交尚未结束的高周期。

检查点带算法版本、规范化 spec 和依赖身份；不匹配则从固定起点或有效旧检查点重放。分页与窗口缩放不改变起点。对 `Today/TimeFrame` 的尾部过滤可以重建显示视图，但不重新改变历史检测时刻。

readiness 分模块：gap 和 II 预热短，EMA/PV/HLC 有各自条件；不能要求全部输出非 null 才允许图表和告警使用已准备好的条件。

## 6. 对象与图表适配

一个 PAIO 实例全局共享：500 lines、500 boxes、500 labels。Bar Index、I/O 和 H/L 共用 label 队列；不能每组各保留 500。按原创建顺序淘汰，文字更新不续期，显式 delete 撤出队列。na 坐标对象与被淘汰后 last-label 引用的行为先对照 Pine 再定；不根据图上不可见就推断没有对象。

后端负责对象 ID、文字、价格/时间坐标和生命周期。前端只渲染并应用纯样式；`yloc.abovebar/belowbar` 的像素布局可由宿主处理，禁止前端另算形态、EMA 或 H/L。

借鉴 NR4/NR7 的异步对象隔离：ownerStudyId、disableSave、disableUndo、锁定、隐藏对象树；实例删除、切品种/周期后，晚到 promise 不得复活对象。指标对象不进入永久画线或工作区图形存档。

保留原颜色和透明度，Pine transparency=40 表示 40% 透明，不能误作 40% 不透明。EMA 默认绘制：1st 橙色线宽2、2nd 橙色圆点、3rd 橙色线宽2；PV 的线/plot 两条路径独立验收。字体 size.auto 采用宿主可实现的等价样式并记录差异。

设置保存在现有工作区/手机图表设置，不增加新的更多页入口。手机 375/412px 深浅主题验收参数窗口、密集文字与移除恢复；实施时应用 `market-watch-mobile-ui` 技能。若重启需要装配许可库，复用本机固定版本，禁止将许可库提交仓库。

## 7. 告警行为

10 个原始条件接入现有告警，不自动创建任何规则。名称及 message 保留原件对应关系，可增加中文展示名。

- 条件 1 为成立，0 为不成立，null 为未准备；展示隐藏、排除框不改变原条件。
- 默认选择“每根收盘确认”，用户可在现有框架支持时显式选择盘中模式；盘中模式不承诺信号不消失。
- 原件只声明条件，没有规定 alert frequency。沿用项目既有频率/去重，不擅自将连续为真的 II 只保留第一根；确认“每根 bar”的模式可在连续三根成立时各记录一次。
- 对于每根为真的条件，使用条件高于 0 的语义；不要默认用上穿 0，后者会丢失连续成立 bar。现有域若不能表达逐柱触发，仅扩展必要的逐柱判定，不绕开后台框架。
- 实际判定时间使用完成/观察柱，不能取 IOI 回画标签位置。
- 历史初始化、补数、修订和恢复不新增已发生时刻的推送；沿用既有事件游标和幂等。
- 第 7 项 specific_bar 依赖 spec 与交易日历。后台在图表关闭时仍能重建 bar 编号。
- `chart_alert_domain` 的名称/单位白名单、参数校验、UI 选择器、缓存指纹、后台依赖维护一并接入。10 个条件标为 boolean 单位，不能作为价格线去使用 ATR 偏移。

不添加 Gap 回补、H/L、EMA、PV 或“独立 iii”的额外告警模板。未来简报可消费相同输出，但本任务不改晨报框架或其首期范围。

## 8. 预计文件变更

以下新增文件目前尚未创建，除本文和参考原件外均由实施步骤创建。执行 Agent 可调整内部文件分割，须保持职责和验收目标。

| 位置 | 动作/职责 |
| --- | --- |
| `backend/alerts/paio.py` | 新增纯状态机，六模块与有界对象账本，不做数据库/网络 I/O |
| `backend/alerts/paio_inputs.py` | 新增 PAIO 专用多周期冻结、来源/日历上下文与 request 映射 |
| `backend/alerts/chart_indicators.py` | 注册、参数、数值顺序、PAIO 独立 presentation schema |
| `backend/alerts/indicator_state.py` | 算法版本、确认/临时计算与各模块初始化 |
| `backend/alerts/provider_indicator_inputs.py` | 多周期 revision/固定前缀、尾部时刻与结果身份 |
| `backend/alerts/managed_indicator_inputs.py`、`fixed_indicators.py` | history/composite 的依赖装配、检查点与对象显示结果 |
| `backend/alerts/observed_indicators.py`、`display_indicator_jobs.py` | 观察快照、临时对象、增量恢复；不能遗漏非 strict 图表路径 |
| `backend/alerts/chart_alert_domain.py`、`chart_alert_values.py`、`chart_alert_service.py`、`alert_indicator_worker.py` | 白名单、boolean 单位、缓存与后台周期依赖 |
| `advanced-host/paio-display.js` | 新增 PAIO 对象渲染与实例清理 |
| `advanced-host/indicators.js`、`indicator-coordinator.js`、`chart-runtime.js`、`build-assets.mjs` | profile、EMA plot/offset、PAIO presentation 传输、完整打包 |
| `advanced-host/native-indicator-dialog.js` | 原设置分组、输入恢复及多周期来源约束 |
| `web/src/advanced/ChartAlertDialog.tsx`、`chartAlerts.ts` | 条件名、boolean 输出和频率；必要时复用现有手机表单 |
| `backend/tests/test_paio.py`、`test_paio_inputs.py`、`test_paio_alerts.py`、`test_paio_postgres.py` | 新增数值/时序、依赖与后台持久恢复测试 |
| `backend/tests/fixtures/paio/` | 新增固定原始输入、期望值/对象操作、来源与 as_of 元数据 |
| `web/tests/paio-display.cjs`、`paio-restart.cjs`、`paio-native.browser.cjs` | 新增真实显示行为、异步清理、工作区和手机验收 |
| `.github/workflows/ci.yml` | 将必要的 PAIO Node 契约测试加入 CI |
| `docs/verification/paio-20261121/README.md` | 新增各阶段证据、兼容差异、候选与回退记录 |
| `docs/references/paio-fengyangsi-MPL-2.0.md` | 新增作者、许可 URL 与移植文件清单 |

当前代码依据：指标 profile/开放 OHLC 见 `chart_indicators.py`；已有状态机见 `indicator_state.py`；绘图对象见 `advanced-host/nr-breakout-display.js`；多周期日历先例见 `backend/alerts/nr_breakout.py`。这些先例不等于任意 request.security 已实现。旧指标维护文档部分限制已过时，执行应以基线实际代码为准。

## 9. 按依赖排序的实施步骤

### 步骤 A：冻结源码与可核查兼容表

1. 核对本方案、AGENTS、原件 hash；fetch 并记录执行时真实基线，创建实现 worktree/branch，不覆盖其他任务。
2. 创建验收 README、设置对照表、源码分支/输出映射及兼容差异表。
3. 确认有无可用的 TradingView 运行对照能力。能够读取时只使用已有合法访问；不购买、登录未知账号或索取凭据。
4. 构造人工可核算 OHLC 样例；复杂 Pine 语义以原脚本实测导出/回放验证。必要时创建仅附加数值输出的诊断 Pine 副本，不改原件。

产出：源码 hash 一致、设置与条件无遗漏、语义已核实/待核实有清楚标记。没有 TradingView 对照时可继续做确定逻辑，但不能将待核实部分标成兼容通过。

### 步骤 B：纯状态机与标签账本

先实现 gap、编号、I/O、H/L 和对象账本，写小样例验证边界、分支顺序与配额。再实现每组 EMA/PV 的纯状态推进接口。允许内部拆模块，单一 PAIO spec/生命周期不拆散。

产出：批量重放、逐根推进、序列化恢复和临时副本在相同输入上相同；未做 UI 也能看到清晰的预期数值与对象操作。

### 步骤 C：多周期上下文与完整计算路径

先验证低/等/高请求周期，再接 provider、managed/history、composite 的 strict/observed 路径。共享一致的输入冻结与算法，禁止为图表/告警各写一份 request 映射。

处理未完成高周期、input revision、last_bar_time、起点与缺失依赖；证明分页不会改变结果。新检查点不改变旧指标检查点格式。

产出：三组 EMA 和三组 PV 默认/非默认参数可对照，断线重连/服务重启能恢复，按真实缺失信息标 readiness。

### 步骤 D：图表呈现与完整设置

新增 paio_v1 渲染，接入数值线和共享对象。验证颜色、透明度、字体、EMA offset、PV line/plot、盘中 rollback、标签合并和 quota。参数更改重放与样式更改刷新分别处理。

产出：手机/桌面一个 PAIO 入口，设置恢复不遗漏，移除无残留，多实例不串状态。

### 步骤 E：后台告警

接入原 10 条件，保留连续 true、绘图关闭仍成立等语义。验证收盘默认、盘中显式模式、幂等、历史不补发与关闭图表继续评估。

产出：隔离测试通知适配器记录与事件快照一致，不发送真实手机通知。

### 步骤 F：源码对照与 Ubuntu R1

执行下面的验收矩阵和相关现有回归；确认开发实例当前候选、资源及运行模式后，部署到持久 mw-dev。记录主机、HTTPS 地址、实际 API/web image ID、源码基线、启动/停止命令和回退方式。

产出：有来源的数值/对象对照、深浅主题手机截图、后台恢复证据，未验证项不能由本地计算自证替代。

### 步骤 G：交付

完成 F1 所需 Standards/Spec 独立 review、适用 CI、自审、兼容与回退说明，创建 Draft PR。只有所有六组与十条件通过相应验收，才能写“PAIO 复刻完成”；分阶段候选必须注明尚缺模块。

## 10. 验收矩阵与通过条件

| 验收维度 | 必测输入/操作 | 通过条件 |
| --- | --- | --- |
| I/O 边界 | 正常 ii/iii、仅同母 bar、单端等价、全等、OO 前对全等、IOI 全等 | 数值与源码逐项一致 |
| 标签生命周期 | ii→iii→iiii、oo→ioi、ioii、切换各 Use | ID、原锚点、文字更新与删除顺序匹配 |
| Gap | 六方向及每个 Except 组合 | 原始条件与绘图过滤分别一致；尤其 Body down 非默认组合 |
| 编号 | 默认 0,1、空格/前导零、Use=false、From/Offset/Step=0/2、跨周期 | 编号/标签/特定编号条件按公式一致 |
| H/L | 普通回撤、连续相同极值、重置、outside 双触发、use=false、前100根 | 状态次序与文字相同，坐标 readiness/配额不丢失 |
| EMA | 三组独立参数、source、长度1、非法0、offset正负、首个有效值 | 不误用 TA-Lib seed；不在临时值上递归 |
| 多周期 | M5→M15、M15→M15、H4/D1→M15/H1，历史/实时/重载 | 每个 request 值和映射时间有对照证据 |
| PV | chart/base security、全部 Source、两种绘图模式、All/Today/TimeFrame | 初始化、CurrentOpen=close 特例、断线和端点一致 |
| 日历 | Dukascopy 外汇/黄金、跨周末、DST 切换；可用的其他市场 RTH 样本 | 当前身份/session 边界一致，不按显示时区重分桶 |
| 状态 | 同输入全量/切页/重启/改变起点/修订高周期 | 固定起点时一致；修订只失效实际依赖；不同起点不假称相同 |
| 临时值 | 同根多次 tick、形态出现后消失、高周期未完成 | 确认状态不污染；临时对象撤回；不双计数 |
| 配额 | 混合创建超过500 labels/lines/boxes、修改旧对象、删除/na坐标 | 每类总额不超过500，淘汰顺序与原脚本匹配 |
| 性能 | 逐步放大历史、极长 II/OO 序列、默认全模块 | 无逐柱二次回扫/查询；增量成本不随全部历史线性增长；记录实际耗时与环境 |
| 图表 | 375/412px深浅主题、多图、参数保存、切品种周期、移除及晚到异步 | 无残留、无串实例、不污染永久画线，原模块全可用 |
| 告警 | 10条件、连续true、绘图关闭、收盘/盘中、图表关闭、补数重启 | 与数值条件相同；频率正确；不自动建规则，不发送真实通知 |
| 现有功能 | 指标注册/状态、NR4/NR7显示、observed、现有告警与工作区 | 无回归，旧 spec/checkpoint 仍能读取 |

对照数据分级：人工边界样例可作为源码公式证据；Pine 运行对照用于 seed/request/security/对象运行时语义；Market Watch 原行情仅证明实际接入可用。不同供源的同名 EURUSD 截图不能作为严格数值对照。

诊断导出需记录脚本 hash、设置、OHLC/所需低高周期输入、时区/session、固定起点、as_of、历史或实时模式和导出精度。不能把同一移植函数生成的期望值当独立 Pine oracle。

## 11. 环境准备与验证命令

本节命令供实施阶段执行；本次形成方案不运行应用测试、不构建镜像、不部署。所有应用开发/测试/验收均在 Ubuntu 本机 Docker。CI 是仓库要求的补充检查，不替代本机验收。

### 11.1 工作树与源码检查

```bash
cd /home/quant/repos/market-watch-paio-plan-20261121
git status --short --branch
git log -1 --oneline
sha256sum docs/references/paio-fengyangsi-v6-20261118.pine
git diff --check
```

实施分支从执行时已核实的 origin/main 创建；本文与原件目前未提交，应使用显式文件复制带入，不对未提交方案 worktree 做 reset/clean。若沿用本工作树实施，应先记录该决定及基线差异，不能误把方案完成当实现授权。

### 11.2 实施前只读检查与构建

```bash
docker ps --format '{{.Names}} {{.Image}} {{.Ports}}'
docker compose ls
df -h /home/quant/repos /var/lib/docker
free -h
python3 deploy/ubuntu/mw_dev.py status
mw-docker build --repo . --component api --tag market-watch-api:paio-20261121 \
  --task mw-paio-20261121 --project mw-dev --purpose development
mw-docker build --repo . --component web --tag market-watch-web:paio-20261121 \
  --task mw-paio-20261121 --project mw-dev --purpose development
```

构建前在实现分支准备固定版本本机许可库；不得提交。若任务标签已被使用，先核实归属并采用新的明确任务标签。测试不需要外部行情出网。完整 web Docker 构建会运行 TypeScript 与全部资源打包，只有 `build:ui` 通过不足以证明 PAIO 渲染器已随实际 App 加载。

### 11.3 数值与显示契约测试

先按步骤 B–E 创建第 8 节列出的测试文件，然后执行，以下不含尚不存在的测试脚本作为既成证据：

```bash
docker run --rm --network none --tmpfs /tmp \
  --mount type=bind,src="$PWD",dst=/workspace,readonly \
  --workdir /workspace --env PYTHONPATH=/workspace/backend \
  --env PYTHONDONTWRITEBYTECODE=1 \
  --env ALERTS_DATABASE_URL=sqlite:////tmp/paio-tests.db \
  market-watch-api:paio-20261121 \
  python -m pytest -q -p no:cacheprovider \
  backend/tests/test_paio.py backend/tests/test_paio_inputs.py \
  backend/tests/test_paio_alerts.py backend/tests/test_chart_indicator_contract.py \
  backend/tests/test_indicator_state.py backend/tests/test_chart_alert_domain.py
```

使用本机已有且核实来源的 `node:22-bookworm-slim` 运行不依赖浏览器的前端契约测试；缺少镜像时先按仓库规则准备，不在命令里隐式拉取：

```bash
docker run --rm --pull never --network none \
  --mount type=bind,src="$PWD",dst=/workspace,readonly \
  --workdir /workspace/web node:22-bookworm-slim \
  sh -eu -c 'node tests/paio-display.cjs
node tests/paio-restart.cjs
node tests/nr-breakout-display.cjs
node tests/indicator-snapshot-recovery.cjs'
```

`test_paio_postgres.py` 涉及恢复与依赖版本，实施时先创建任务专属隔离测试库/连接配置，再在 Docker 测试进程运行；使用仓库现有 `TEST_POSTGRES_URL`/`CHART_ALERT_TEST_DATABASE_URL` 约定。记录精确命令和库归属，不把它指向 mw-dev 持久业务库或生产库。不需要为没有 schema 迁移的改动做整库灾备演练。

### 11.4 持久 mw-dev 验收

依照 [Ubuntu 工具说明](../../deploy/ubuntu/README.md) 及 [AGENTS](../../AGENTS.md)。默认复用 Ubuntu `mw-dev`、HTTPS 18443，先核实当前主机/端口、候选、source/frontend 模式及其他任务；有占用冲突则协调，不覆盖。

实施 Agent 必须在部署前将“本次候选清单与确切切换命令”写进验收 README：当前 Compose 文件/私有文件路径（不含内容）、API/web 旧 image ID、新 image ID、source/frontend 模式、涉及服务及恢复命令。不能照抄 `mw_dev.py web` 的固定旧 task/tag 覆盖其他任务。

镜像模式按现有私有 Compose 配置替换本次核实的 API/web 引用，并对实际运行写入者进行一致切换；source 模式明确核实挂载目录后更新绑定。保留供源、凭据、代理、通知与数据，不执行 down -v、不重新 seed。对新算法无迁移时，回退旧候选可撤销运行版本；新 PAIO 配置需标明旧版本不识别，旧候选不能继续承担 PAIO 规则评估。

启动/停止沿用 `mw_dev.py up` 与 `mw_dev.py stop <本次已核实服务>`，确切服务列表必须写在验收记录；不停止整个共享实例作为例行清理。用 Ubuntu Docker 中的 Playwright 运行步骤 D 创建的 `web/tests/paio-native.browser.cjs`，读取私有认证文件而不输出凭据。后台通知使用测试 adapter/拦截 sink；没有明确授权不得发真实手机通知。

## 12. 完成条件、停止边界与 Agent 启动指令

完成条件：六组全部完成；原件保留与许可证留档；默认及关键非默认行为对照通过；十条件后台可用；分页/重启/临时值/多周期不串状态；完整 Ubuntu 图表候选与手机浏览器通过；CI、自审和适用 F1 review 齐全；Draft PR 与真实兼容差异记录可复查。

以下状态不能写成整套完成：只做 ii/iii、只支持请求周期不低于图表周期、拿普通 EMA 代替源码补值、无出处地声称 TradingView 对齐、没有测试标签修改/淘汰、未接后台告警。

需要停下的具体边界：

- 运行对照无法获得时，继续可确定模块，明确记录 seed/security/对象语义尚缺证据；若只剩这些且无法验证，报告唯一缺口，不编造通过。
- 原脚本在目标 Pine v6 自身编译/运行失败，保留原件与错误，提出最小修补清单，再由用户确定是否改兼容目标。
- 为完整兼容需要新增供源、外部付费服务、任意指标输出依赖或 unsupported 周期时，不擅自扩展；报告宿主边界与所缺能力。
- 无法复用 mw-dev 且存在其他任务冲突、资源不足或私有配置不明时，保留结果并协调，不自动覆盖他人实例。
- main 合并、正式 tag、Unraid 发布/迁移/回滚、永久删除按 AGENTS 的明确授权检查点执行。

Agent 启动指令（用户另行授权实施后使用）：

> 在 market-watch 项目按 `docs/plans/2026-11-21-paio-source-replication.md` 和 AGENTS.md 实现完整 PAIO。先核对原件 hash 与执行基线，以本次 Pine 源码为准，覆盖全部六组模块和十个原始条件，保留列明的特殊行为。复用 Python 指标、检查点、现有图表和告警，不引入 Pine 解释器。按步骤 A–G 完成实现、适用测试、同源对照、Ubuntu 本机 Docker 验收及 Draft PR；不要把中间候选写成整套完成。默认复用持久 mw-dev 并保护现有数据与配置，不发送真实通知。只有明确的范围/运行对照缺口、共享环境冲突、合并、生产与永久删除检查点需要我决定；其他步骤自动推进。
