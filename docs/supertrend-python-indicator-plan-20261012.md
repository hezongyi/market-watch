# Supertrend Python 指标实现方案

日期：2026-10-12。以下为冻结的实施前契约；实际实现与验收状态见 [验收记录](verification/supertrend-20261012/README.md)。

## 1. 目标、来源与范围

以用户提供的 Pine v4 `study("Supertrend", overlay=true, format=format.price, precision=2, resolution="")` 源码作为算法基准，在 Market Watch 新增独立 Python 指标，复现上下趋势线、断线、圆点、Buy/Sell 标签与半透明区域。用户已认可移植路径，并要求形成方案。

截图：[EURUSD 日线示例](references/supertrend-user-reference.png)。截图为 FXCM；正式价格使用用户此前确定的 OANDA，使用图表选中系列的同一价格基准和交易日历。禁止平移或修正 OANDA 价格来匹配 FXCM。绘图行为按截图验收，跨供源的数值、翻转日期不要求相同。

本任务是图表指标。输出趋势与翻转信号，为未来复用保留稳定数值契约；暂不扩展告警模块、发送通知、加入 BOS/OB/回踩交易规则或部署生产。保留现有内置 SuperTrend；本指标搜索结果显示来源 Python，与内置项可辨认。

没有需要用户回答的阻塞问题。以下默认规则作为 V1 实施契约，技术验证见第 7 节。原始完整 Pine 文本在当前会话中；实施前将它作为参考文件保存并记录内容 SHA256，不以另一个 Supertrend 实现替代。不要擅自补写未经确认的作者或许可证。

## 2. 身份与设置

建议算法 ID：`SUPERTREND_PINE_V1`。study ID：`MWPythonSUPERTREND_PINE_V1@market-watch-1`。中文名称：`超级趋势 Supertrend（Pine 复现）`。未来改变初始化或翻转规则需另设语义版本，不能静默改变已保存工作区。

| 设置 | 默认 | V1 规则 |
| --- | --- | --- |
| ATR Period | 10 | 整数 1–500，覆盖周期 1 的边界 |
| Source | HL2 | 可选 open、high、low、close、hl2、hlc3、ohlc4；不支持引用其他 study |
| ATR Multiplier | 3.0 | 正数 0.1–100，输入步长 0.1 |
| Change ATR Calculation Method? | 开启 | 开启为 Wilder/RMA，关闭为 SMA(TR)；以 `atr_method="wilder"|"sma"` 表达后端参数 |
| Show Buy/Sell Signals? | 开启 | 只控制文字标签，圆点始终按翻转事件显示 |
| Highlighter On/Off? | 开启 | 控制趋势线与 OHLC4 之间的区域填色 |

周期、源和 ATR 方法属于计算参数；标签与填色开关属于展示参数，不改变数值结果、不进入计算缓存键。颜色、线宽、透明度及 plot 可见性复用原生样式。

源码显示精度为 2，默认照此设置。显示精度不参与计算：EURUSD OHLC、ATR、边界和比较保持原始数值精度。用户以后调整显示精度时也不得修改信号。

## 3. 计算契约

### 3.1 输入与 ATR

每根 K 线输入 O/H/L/C、start/end、complete、gap_before。Source 选择使用本根相应 OHLC 算术组合，独立于 ATR 的 TR 输入和填色参考 OHLC4。

有效前收盘存在时：

```text
TR[t] = max(H[t]-L[t], abs(H[t]-C[t-1]), abs(L[t]-C[t-1]))
HL2[t] = (H[t]+L[t])/2
HLC3[t] = (H[t]+L[t]+C[t])/3
OHLC4[t] = (O[t]+H[t]+L[t]+C[t])/4
```

必须区分 Pine v4 `atr(N)` 与裸 `tr` 的首柱语义：预期内置 ATR 在无前收盘时以 H-L 计算首个 TR，而 `sma(tr,N)` 的裸 tr 在无前收盘时为空。这会影响首个 ATR 的位置，不能直接共用现有 TA-Lib ATR 初始化。实施时以可复核的 Pine 参考结果或官方定义验证该预期，并将结论和夹具留存。

Wilder/RMA：以首批 N 个有效 TR 的算术平均初始化；之后 `ATR[t]=(ATR[t-1]*(N-1)+TR[t])/N`。SMA 分支取 N 个有效裸 TR 的算术平均。预热期间 ATR 与依赖边界输出为空，保留源码状态行为；不得以零代替空值。若首柱语义验证推翻上述预期，应按原 Pine 修订方案与夹具，不能宣称原样一致。

### 3.2 边界递归与方向

下面表达式保留 Pine 执行顺序，U 为源码 up（下边界），D 为源码 dn（上边界）：

```text
base_U[t] = Source[t] - Multiplier*ATR[t]
base_D[t] = Source[t] + Multiplier*ATR[t]
U1 = nz(U[t-1], base_U[t])
D1 = nz(D[t-1], base_D[t])

U[t] = C[t-1] > U1 ? max(base_U[t],U1) : base_U[t]
D[t] = C[t-1] < D1 ? min(base_D[t],D1) : base_D[t]

Tprev = nz(T[t-1],1)
T[t] = Tprev == -1 and C[t] > D1 ? 1
     : Tprev ==  1 and C[t] < U1 ? -1
     : Tprev
```

初始方向为 1；比较为严格大于/小于，价格等于边界不翻转。空值和 nz 处理按 Pine 语义，不使用 Python 对 NaN 的隐式布尔转换。不按报价 tick 或显示精度提前舍入。

买入翻转：`T[t]==1 and T[t-1]==-1`；卖出翻转对称。启动看涨状态不是 Buy 事件。信号位置取本根更新后的 U/D，方向翻转比较使用上一根 U1/D1；这两个价格不能混用。

### 3.3 输出

所有输出是与输入等长的数值序列，非有效值序列化为 null，顺序固定：

| key | 定义 | 用途 |
| --- | --- | --- |
| up | 看涨时 U，否则 null | 绿色趋势线 |
| down | 看跌时 D，否则 null | 红色趋势线 |
| buy_price | Buy 翻转当根的 U，否则 null | 圆点与 Buy 标签共同使用 |
| sell_price | Sell 翻转当根的 D，否则 null | 圆点与 Sell 标签共同使用 |
| fill_reference | OHLC4 | 无可见主体的参考 plot，供填色 |
| direction | 1 或 -1，未知区间为空 | 数值状态，默认不绘制 |

buy/sell 不输出长时间持续的 1；价格序列仅在事件当根有效。前端不能重新计算 ATR、边界或信号。无需为每个图形生成重复的后台计算结果。

## 4. 原生绘图契约

本机实际图表库声明已确认：`LineStudyPlotStyle.LineWithBreaks=7`；Shapes 支持 `shape_circle`、`shape_label_up/down`；style 支持 `text`、`size`，位置支持 Absolute；`filledAreas` 支持 `plot_plot`、透明度、fillgaps。这是接口存在的证据，尚不是浏览器通过证据。

| 元素 | 映射规则 |
| --- | --- |
| 上涨趋势线 | up，绿色、2px、LineWithBreaks；不与 down 拼成一条变色线 |
| 下跌趋势线 | down，红色、2px、LineWithBreaks |
| 翻转圆点 | buy_price/sell_price 对应绝对价格，tiny、绿/红、不透明 |
| Buy | label_up，锚定 buy_price，白字绿底，tiny，受 showsignals 控制 |
| Sell | label_down，锚定 sell_price，白字红底，tiny，受 showsignals 控制 |
| 填色参考 | OHLC4；按 Pine 的 circles、linewidth=0 效果处理，不能显示成一条额外价格线 |
| 上涨填色 | OHLC4 与 up 之间的绿色半透明区域 |
| 下跌填色 | OHLC4 与 down 之间的红色半透明区域 |

初始颜色可采用 Pine 命名色对应值 green `#008000`、red `#FF0000`、white `#FFFFFF`，再核对截图所用 TradingView 主题/命名色实际值；标签、线与填色必须使用一致的方向色。fill 默认透明度以 Pine v4 默认值为参考起点，截图取样和真实图表验证后固定，不把猜测认作已经匹配。

Source 代码两次 fill 的非活动色/关闭色为 white，但非活动趋势 plot 同时为空。开关目标是截图中的启闭效果，必须核实该分支及 fillgaps 默认行为，避免跨非活动区间出现白色块、颜色串段或长距离错误填色。不要未经验证就认为 `fillgaps=false` 等于原脚本。

圆点和标签必须对齐同一个绝对价格，不使用 AboveBar/BelowBar 自动位置替代。需要浏览器验证 Absolute/AbsoluteUp/AbsoluteDown 与上下标签锚点组合；核对标签尖角和圆点间距、字号及缩放。

图例、当前值与价格轴按原 plot 语义映射：up/down 非活动侧保持空值；OHLC4 参考不得被误画成独立曲线，是否显示其参考数值按源码/截图验证；direction 默认不进入图例或价格轴。不通过删除所有参考值来掩盖映射问题。

## 5. 接入现有项目

| 模块 | 实施内容 |
| --- | --- |
| 新增 backend/alerts/supertrend_pine.py | 纯递归状态、ATR 两分支、批量计算；单一算法核心供全量与增量调用 |
| backend/alerts/chart_indicators.py | 注册稳定 ID；白名单 source/atr_method 参数；可选 OHLC 输入与绘图配置声明 |
| backend/alerts/indicator_state.py | 新指标状态/检查点支持，复用固定起点、历史修订、缺口及临时副本机制 |
| backend/alerts/fixed_indicators.py | 复用任务/分块/发布流程；核实新状态的存储与恢复，不新建独立任务服务 |
| backend/alerts/api.py | 沿用已有启动注册点，显式注册新指标 |
| advanced-host/indicators.js | 为此 profile 映射断线、圆点、标签、fill_reference、filledAreas、设置开关及显示精度 |
| advanced-host/bridge.js | 复用现有 MWPY_ 取数、空值标记、实时更新、缓存；仅补必要映射 |
| advanced-host/indicator-picker.js | 复用目录、中文名称/别名、Python 来源；显示与内置项的区别 |
| advanced-host/preferences.js 等 | 复用 workspaces/study_templates，验收设置和样式恢复 |

不改许可库源码、不调用未公开 supertrend helper、不引入 Pine 编译器。

当前注册 calculator 输入固定为 high/low/close；建议增加显式 `input_fields` 白名单声明，默认保持原三项和顺序，新指标声明 open/high/low/close。框架按声明传只读数组，旧指标调用不变；不强迫已有 HLC 测试夹具增加 open。只对声明需要 open 的指标校验它。

参数校验扩展允许受限制的枚举，禁止任意字符串；ATR 方法虽在界面是布尔开关，后端规范化为枚举，映射明确。显示布尔声明单独保存在原生 study 输入中，合成品种 spec 只传计算参数；不能用用户可见的 0/1 数字假装布尔控件。

数值输出继续复用原等长数组协议。增加可选白名单 `render_profile="supertrend_pine_v1"`、展示输入和 plot 映射，不开放任意执行代码或任意元数据透传。一个 buy_price 可同时映射圆点和标签；方向可保留为隐藏输出，图表渲染不需要订阅每个诊断字段。无需为本指标引入 Swing 的结构化事件/统计结果接口。

已有接口将 null 转为占位价格 0 并以 volume=0 标记，indicators.js 再恢复为 NaN；必须沿用该有效性标记，不能把 null 画在零价，不能把合法零值误判为空。

固定历史实例目前只允许 IndicatorState.SUPPORTED 中 8 个指标，所以只注册 calculator 不足以在所有行情类型工作。新指标必须同步声明初始化、检查点算法和恢复兼容策略；如变更公共 ALGORITHM，需要评估现有任务键/检查点迁移，避免无必要重算所有旧指标。不得仅靠有限 ATR 预热承诺完整 Supertrend 状态一致。

与 Swing 方案可能涉及同一注册/绘图接口扩展：实施前查看当时仓库状态，复用已经合并的展示输入和 OHLC 接口；不要从旧研究 worktree 覆盖他人实现。前述文件定位按 2026-10-12 本地 base repo 核查，实施时重新确认实际部署基线。

## 6. 历史、实时与状态

从同一固定行情起点或有效检查点计算，然后裁剪到可见页。拖动/缩放不重置趋势；左扩历史、修改参数、切 source、历史修订需按同源依赖使缓存失效。缓存身份包括行情来源/报价基准、周期、起点、revision、算法及计算参数；展示开关不改变计算缓存。

检查点至少保存前收盘、ATR 初始化累计/窗口、当前 ATR、上下边界、方向及前一方向所需状态；SMA 分支保存有限 TR 窗口。全量与增量都调用同一 step 逻辑。

当前 K 线使用现有 provisional 机制：从已确认检查点复制状态计算，不持久推进。可暂时翻转并显示标签，也可撤回；重复 tick 不重复累积 TR。新增下一根后按确认状态接续。

真正缺数依现有 gap_before 分段重置并重新预热；正常周末休市不重置、不补假 K 线。gap reset 的初始看涨不能产生 Buy，跨缺口不连趋势线或填色。该缺口处理是 Market Watch 数据质量政策，不声称原 Pine 会自动按同样方式重置。

删除/隐藏指标、切换行情/周期、改参数、恢复工作区、多图及多个相同指标实例均由原生 study 生命周期管理。没有独立持久化的标签对象；迟到响应不能更新其他图表或参数实例。

本任务只显示信号；Pine alertcondition 三项（Buy、Sell、Direction Change）对应事件已可从输出推导。接入通知另行定义确认频率和去重，不能将图上盘中标签当成已发送通知。

## 7. 验证顺序与验收矩阵

### 7.1 首先完成技术验证

1. 最小原生 profile 以固定合成序列验证两条断线、圆点+绝对定位标签、OHLC4 参考与两块填色；包括隐藏开关、转向处和空值。真实浏览器通过后接算法。
2. 核实 Pine v4 atr/tr/rma/sma 初始化、NaN/nz/条件分支及 fill 默认语义。优先同一 OHLC 的原 Pine 导出或明确参考夹具；只与内置 Supertrend 对比不能证明原脚本一致。
3. 验证原生布尔/枚举/source 输入与模板保存。检查显示开关不影响后台缓存键。
4. 固定历史路径、原生/管理系列路径均可计算 open 依赖和新检查点，确认日线时区/交易日历没有被图表显示时区改变。

若拿不到同 OHLC 的 Pine 执行对照，可先完成源码规则夹具与离线数值验证，但交付应注明尚未逐根与 Pine 引擎对照；不能把截图视觉相似当作逐根数值一致证据。用户不需要先补充数据才能开始实施。

### 7.2 必须通过的验收

| 项目 | 通过标准 |
| --- | --- |
| 默认计算 | 10/HL2/3/Wilder；ATR、U/D、方向、Buy/Sell 逐根核对 |
| 初始化 | 空历史、不足 N、恰好 N/N+1、周期 1；两种 ATR 首值及启动无 Buy 有夹具 |
| 严格边界 | close 等于上一边界不翻转；上一收盘等于边界时递归更新符合源码 |
| 旧/新边界 | 构造本根边界移动场景，确认翻转按 U1/D1 而非本根 U/D |
| 参数 | 所有 source、两种 ATR、周期/倍数边界；无 open 输入时只新指标报明确错 |
| 全量/分页/检查点 | 同固定起点结果一致；翻页与恢复不移动信号；历史修订修复后续状态 |
| 盘中 | 同根出现→撤回→再次出现，标签/线/填色同步；确认状态未被临时结果污染 |
| 缺口 | 真缺口断开并重置；正常周末继续；无零价长线或跨缺口填色 |
| 视觉 | EURUSD 日线，范围/主题/柱距与截图接近；2px双色断线、tiny圆点和上下标签、半透明区域对齐 |
| 开关 | showsignals 关闭标签但保留圆点；highlighting 关闭填色；不改变数值 |
| 数值显示 | 默认 precision=2，计算不舍入；参考 plot 无额外可见线；非活动方向为空 |
| 保存恢复 | 参数、两个开关及样式随工作区和 study template 恢复；多实例互不干扰 |
| 回归/负载 | 原有 8 个 Python 指标和内置 study 回归通过；同 spec 多 plot 不重复全量计算；历史/实时负载记录 |

没有运行上述数值/浏览器验收；当前仅完成本地接口静态核查。不要把当前文档或示意图当作实际部署验收。

## 8. 交付与环境

应用实现使用独立 worktree/branch，保留当前研究材料和其他任务代码；本方案位于研究 worktree，尚未提交/推送。实施代理应显式复制/引用本文件，普通 git worktree 不自动携带 untracked 文档。

开发、验证与验收仅允许 Ubuntu 本机隔离 Docker Compose project、网络、volume、数据库和端口，不复用生产目录。构建必须通过 `mw-docker build` 或 `mw-docker compose-build`，明确 task/project/purpose，使用 market-watch-ubuntu builder。操作说明见 [本地 README](../deploy/ubuntu/README.md)；用户提供的 market-watch-docker-lifecycle 路径此前不存在，实施时可重新核实。

交付实现代码、冻结夹具、测试结果、真实浏览器截图、Ubuntu 实际访问地址及启动/停止方式。源码对照证据与跨供源限制单独说明。生产部署未授权，不在 unraid 启动任何开发/验收/调试实例。凭据和许可资源不提交；任务结束按精确归属退役并完成数据库备份恢复校验，禁止全局 prune。
