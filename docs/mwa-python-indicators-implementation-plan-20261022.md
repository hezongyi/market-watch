# MWA 自建／组合行情 Python 指标实施方案

日期：2026-10-22。状态：**用户已确认并要求实施，2026-10-22 开始开发**。本次授权覆盖方案阶段 1—5；PR 提交、合并与生产发布仍按用户单独指令控制。

## 1. 基线、范围与交付方式

- 集成基线：`integration/mwa-20261022` / `3bcf5e77005e71d1faeb9d4753fbb2cafb9c66ee`，关联 Draft PR #93。
- 本方案记录位置：`/home/quant/repos/market-watch-integration-20261022`。实施者从届时确认的集成 HEAD 建立独立 worktree/branch，不恢复已清理的旧开发 worktree。
- 验收对象：Ubuntu `quant-server` 的既有 mwa，主入口 `https://192.168.7.232:18280`，Chart origin `https://192.168.7.232:18281`，Compose project `mw-issue75-v2-20261018`。
- 整批按 **F1** 准备：除显示缺陷外，建议增加独立的图表输入政策及持久化计算状态语义。即使无 schema 迁移，也须验证缓存／检查点隔离与旧应用兼容。
- 用户控制 PR 提交频率。开发和本地验证后先在 mwa 验收；不因 CI 等待延迟 mwa 验收。不擅自另建或更新 PR；用户要求提交时集中提交，提交后停止，不等待 CI。合并、正式 tag、生产发布另行授权。
- 本方案已于 2026-10-22 获用户“实施”授权；执行时保留真实数据、版本、映射、组合及工作区。

## 2. 已确认事实与复现基线

2026-10-22 在现有 mwa 以临时 Playwright context 真实登录，比较同一 EURUSD 的平台／固定历史／组合，覆盖 H1 与 D1。未保存工作区，前后完整工作区相等；后台指标请求会正常创建计算需求及缓存，本次并非数据库零写入观察。

| 场景 | 实际观察 | 判断 |
| --- | --- | --- |
| 平台 EURUSD H1／D1 | Swing 原生线值、统计卡片正常 | 登录、Python 指标目录及基础渲染可用 |
| 自建 EURUSD H1 | 接口完成计算，106 个返回点中 high 有 72 个有效值、low 有 58 个；统计卡片缺失，最后点为空 | 不能把末点为空误报为整条指标没有结果 |
| 组合 EURUSD H1 | 接口返回有效值，部分线可见，统计卡片缺失 | 同样存在展示缓存匹配问题 |
| 自建／组合 EURUSD D1 | 任务完成，图表值为空，统计卡片缺失 | 展示缺陷与输入资格问题叠加 |
| EURUSD 固定历史 D1 | 208 根中完整 13 根，最长连续完整 3 根；真实算法回放有效输出 0 根 | 默认 Swing 5／5 需要 11 根有效输入，持续重置 |
| XAUUSD 固定历史 D1 | 所查版本 206 根中完整 0 根，真实算法回放有效输出 0 根 | 覆盖资格持续不满足 |

观察版本：EURUSD `63bc01d4-3943-45cc-93a5-b04c3caaab16`，XAUUSD `4fc005ce-ecff-484e-8fcb-7157cecb453c`；组合 `8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb`。这些是复现定位，不是要求实施时绑定或更换用户品种；先核对当时实际工作区。

### 2.1 确定缺陷：Swing 展示身份不一致

原生图表将 MWH／MWC 身份转成大写。`bridge.js` 的 coordinator presentation 回调把原始 ticker 写入 `swingSnapshotStore`；`chartSwingDisplay` 读取时经 decode／encode 转成小写。`swingSnapshotKey` 直接比较字符串，造成已存在记录不能被展示层读到。

实际浏览器以及最小 VM 探针均得到：大写键 lookup=true，规范化键 lookup=false。该缺陷解释统计卡片和展示层辅助线缺失，不解释所有算法的数值为空。

### 2.2 输入口径：已显示 K 线不等于完整 M1 覆盖

`history_artifacts._finish` 以覆盖、时间闭合、来源确认共同决定 `complete`。`swing_sr.SwingState.step` 遇不完整确认柱重置窗口并返回 null。其他递归／窗口指标也存在相应初始化门槛。

实际历史存在已闭合且来源确认、但覆盖未核实的柱：EURUSD 有日内少数分钟未观察，XAUUSD 有 observed=1380、expected=1440 的样本。所查黄金来源会话 profile 为空，不能据此直接证明缺少的 60 分钟全部是合法维护；亦不能把 NY17 聚合日界当作已审核交易时段。

平台使用供应商原生周期柱，固定历史使用 M1 聚合，不能要求不同来源得到相同数值。确认任务 complete 仅表示计算遍历完成，不能表示输入完整或每个输出都有有效值。

## 3. 建议确认的产品口径

**建议：图表 Python 指标以该图实际采用的已观察 OHLC 序列进行展示计算；严格确认结果继续用于预警、策略、回测及默认固定导出。** 这是本方案提出的新口径，须随方案确认，不声称此前已获授权。

不增加日常配置步骤或每次添加指标的确认弹窗。图表自动使用展示口径；覆盖未核实时在指标旁显示简短状态，点击可查看原因。平台现有行为保持，本轮重点接入 history／composite，兼容 bare managed 标识。

| 使用场景 | 输入政策 | 输出含义 |
| --- | --- | --- |
| 专业图表展示，含历史分页 | `observed_display_v1` | 对当前已接受价格快照的可用 OHLC 精确计算；依赖未核实覆盖时明确标记，不能称作严格确认信号 |
| 预警／策略／回测 | `strict_confirmed_v1` | 延续既有完整覆盖和确认要求；缺依赖继续等待或拒绝 |
| 默认固定 CSV／研究导出 | `strict_confirmed_v1` | 保持原行为，不因图表展示放宽而改变已有数据含义 |
| 形成中实时柱 | 展示政策下的独立预览 | 可撤回，不推进已闭合展示检查点，更不进入严格确认状态 |

### 3.1 展示政策的确定规则

1. 从同一已接受价格输入读取 OHLC、源时间、图表标签和质量证据；不得从像素、legend、显示舍入价格重建输入。
2. 源内有观测且 OHLC 合法的已闭合完整周期桶，即便内部 M1 覆盖未核实，也可作为“观察柱”参加图表计算。仅有部分首尾区间的历史残柱不等同于该周期完整观察，标记 partial，不能纳入闭合展示检查点。
3. 计算序列是图上非空观察柱的有序序列，不补造缺失分钟／周期，不插零，不拿前值填充 OHLC。时钟上的空档可跨越，但保留 unknown／已证实闭市证据；unknown 不能升级为闭市或严格覆盖。依赖跨越 unknown 时结果保留质量标记。
4. 无效价格、来源明确报告不可用／损坏的输入构成硬断点，撤回受影响输出并重新初始化。历史起点不足、合法 warmup、没有满足严格极值的形态允许 null，不制造 Swing 信号。
5. 默认 Swing 5／5 在图上至少有 11 根可用观察柱才可能产生首个极值；存在 11 根不保证一定出现严格极值。周线可按已有观察柱计算，10 根月线仍应提示样本不足。
6. 已闭合但覆盖未核实，与形成中 provisional 分开：前者可进入独立的展示检查点；后者始终从展示确认前缀复制状态、随 tick 撤回。不得把所有不完整柱都当作永久 provisional，导致长期累计统计永远不能前进。
7. 沿用既有 Swing 对称窗口、High／Low、回绘偏移、确认延迟和累计间隔规则。标记回绘到 pivot 不表示该时刻已经知道结果。
8. 质量随真实依赖传播：SMA／LWMA 等有限窗口在未核实依赖退出后可解除标记；EMA／RSI 等按其状态依赖保留；Swing 统计与当前形态分别反映各自依赖，不能只看最后一根柱就清除标记。
9. 未核实输入上的算法结果可以准确反映该观察序列，但不代表真实市场高低点已完整重建。UI、API 和运行证据不得将它标成严格确认或完整覆盖。

### 3.2 来源会话修正另成数据任务

本次使已有图表可计算，不以重建所有历史版本为前置条件。实施中只读输出来源／周期覆盖报告；来源官方时段、产品／账户及有限适用区间审核后，才可登记新日历身份、生成新历史版本。

旧历史、旧组合修订、固定接续点、已有校验和均保留。没有官方依据时继续保留 unknown；不批量修改 `complete`，不自动把旧组合改绑到新版本。后续数据重建及切换须另列范围，由用户安排。

## 4. 实施设计与文件落点

### A. 统一展示身份，先关闭确定缺陷

涉及 `advanced-host/series.js`、`swing-sr-display.js`、`bridge.js`。

- 在 Swing store 的公开入口规范化基础行情身份，使 publish／get 对合法大小写等价的固定标识使用同一键；不能简单对所有 ticker 全部小写。
- 保留 series_kind、周期、参数、revision／generation 隔离，平台／自建／组合不可互相命中。
- coordinator、旧 MWPY 兼容链路、HTTP／SSE 都走同一入口，不只改一个调用点。
- 保留旧修订拒绝、迟到响应、参数切换、多图隔离及边界回撤。输入为空时也可展示合法的样本不足统计状态。

阶段 A 本身即可恢复已有有效 Swing presentation 的卡片和辅助绘图，但不得宣称日线数值问题一并解决。

### B. 在后端实现独立展示输入政策

主要落点：`chart_api.py`、`series_access.py`、`fixed_indicators.py`、`indicator_state.py`、`fixed_indicator_display.py`、`display_indicators.py`、`display_indicator_jobs.py`。

- `DataQuery` 增加可选 `indicator_input_policy`，默认 `strict_confirmed_v1`；新专业图表请求 history／composite 指标时显式发送 `observed_display_v1`。
- 观察模式仅是图表数据入口的能力。预警、策略、回测和默认 export 在服务端明确传 strict，不从 workspace、前端请求或已有缓存推断政策。显式 input_revision 固定确认读取继续 strict；错误组合返回结构化校验错误。
- 新增一个纯输入适配模块，统一输出观察柱准入、partial／provisional、硬断点和质量依赖；复用现有算法，不另写浏览器版指标公式，不在原始 Bar／历史产物上改 `complete`。
- 完整观察柱按独立展示状态顺序推进；真实当前桶在复制状态中计算。不能直接取消 strict 引擎的 reset，也不能简单把全部行 `complete=true`。
- 历史绑定 history_version＋产物规则／校验和；组合绑定 revision＋input_revision＋已接受 display_snapshot。不同快照不得把新指标覆盖到旧价格上。
- 计算与裁剪分开：递归指标从真实起点或合法检查点推进；Swing 统计以该价格快照评估末端为准。向左翻页只裁剪输出，不把翻页末端当成新的实时评估末端，不读逐步回放游标之后的数据。

### C. 复用现有持久任务，但严格隔离状态

优先使用现有 `market_fixed_indicator_runs`、blocks、需求租约和展示 suffix 任务，**不新增任务系统或配置页面**。建议不新增表或列：利用现有 `algorithm` 标识及 state JSON 隔离新状态，实施前核实其长度和所有读写点。

- strict 的旧 run ID／group key／algorithm／checkpoint 保持原样。
- observed 使用独立 algorithm 标识，例如 `observed-display-state-v1`；group／run／内存缓存键包含政策、实际指标算法版本和既有输入身份。
- observed checkpoint 带政策及格式版本，与底层指标状态一并存储。只允许同政策、同算法、同参数、相容前缀复用；parent／lineage 查询明确限制政策，不能继承 strict checkpoint 作为 observed seed。
- 新 worker 按 run.algorithm 分派到对应适配器；旧 worker 的支持列表不包含新标识，不能误领展示任务。检查所有 claim、恢复、清理、导出和按 ID 读取路径，不能只验证主 tick。
- 展示 suffix 按所属 run 的政策运行，保留同快照、generation、租约、容量限制及异常退避。静态 history 不为复用接口伪造 composite DisplaySnapshot。
- ≤6000 根可复用有界前台精确回放；更长输入按既有 2000 根页后台推进。观察政策改变不能使 API 同步全扫 M1、扩大既有容量上限或绕过公平调度。
- 静态闭合历史没有新输入时不反复创建任务；实时更新只推进／修复相应后缀，不因每个 tick 重算完整前段。

实施审计补充：旧固定 worker 按算法筛选，但旧 `DisplayIndicatorTask` worker 不按算法筛选，故观察口径不创建该旧表任务。长基线仍按既有固定任务分页推进；可变快照后缀从同政策检查点有界回放，最多 4000 根，超过上限立即返回 `DISPLAY_SUFFIX_CAPACITY_EXCEEDED`，不无限 pending、不让旧 worker 误领。该限制覆盖正常近端快照；超长未确认后缀须等来源确认收敛或另行实现有兼容围栏的后台路径。

若实际读写审计证明现有 schema 无法可靠隔离，先修订本节并补最小 additive migration 及真实 PG 验证；不得把新语义偷偷塞入 strict 状态，也不扩大为第二套调度平台。

### D. 结果质量和页面状态合同

后端每个指标的 `calculation` 增加向后兼容字段：

```json
{
  "input_policy": "observed_display_v1",
  "value_status": "ready",
  "reason_code": null,
  "input_quality": {
    "coverage": "unverified",
    "provisional": false,
    "dependency_origin": 1767218400000
  }
}
```

- `value_status`：`preparing | ready | insufficient_input | unavailable | failed`。
- `reason_code` 使用有限枚举，例如 `WARMUP_REQUIRED`、`PARTIAL_PERIOD`、`UNKNOWN_INPUT_GAP`、`INVALID_PRICE`、`INPUT_RECOVERING`、`CAPACITY_EXCEEDED`；质量原因不直接等同计算失败。
- calculation.status／visible_complete／history_complete 继续表示任务、可见计算覆盖和完整回放进度；不再用它们代替数据质量。旧字段准确性标签也必须绑定本政策及其 oracle，不能暗示 strict 认证。
- 页面正常完成即显示结果；观察依赖未核实时使用简短“覆盖未核实”标识，详情说明按已有 K 线计算。形成中显示“预览”；样本不足显示“样本不足”，详情给需要／已有根数。可同时有观察质量和 provisional。
- 复用 `advanced-host/indicator-coordinator.js`、`bridge.js`、`swing-sr-display.js` 与 `web/src/advanced/AdvancedWorkspace.tsx` 的现有状态通道，不加新的常驻大面板或阻塞弹窗。
- 不足／未核实不显示“重新计算就能解决”的重试按钮；网络／任务失败可重试。存在合法全 null 结果时不得永久显示 loading，也不得按有无非空数值判定请求是否完成。
- 数据质量状态是当前图格／参数状态；切品种、切周期、删指标时清除，不沿用上一个图格的结论。

## 5. 实施顺序与阶段完成条件

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| 0 | 核对集成基线、实例镜像和受保护状态；保存脱敏复现与质量统计 | 独立脚本能区分缓存缺陷、合法 null 和任务未完成；不以截图代替请求证据 |
| 1 | 身份规范化＋回归 | 大小写固定标识命中同一 Swing 记录；不同 series／周期／参数互不串值；真实 UI 卡片恢复 |
| 2 | 后端观察政策、算法隔离、有界任务及响应质量合同 | 完整／未核实／partial／形成中／硬断点各有独立用例；strict 结果完全不受影响 |
| 3 | 前端显式请求政策、展示质量和状态收口 | 实际 K 线有足够合法观察时正常绘图；不足可解释；失败可恢复；不会无限 pending |
| 4 | 独立 PG／浏览器／旧应用兼容、Standards＋Spec review | F1 必要证据齐全，发现项修复关闭；不以单元通过替代浏览器渲染 |
| 5 | 固定干净候选，更新现有 mwa 并人工验收 | 保留数据／配置／现场，三类行情对照通过；记录运行镜像与源码 |
| 6 | 按用户指令集中提交 PR／集成 | 未获提交指令保留本地提交和验收记录；要求提交后即停，不等待 CI |

阶段 1 可先完成，但只作为阶段结果，不单独增加小 PR。实施者若只完成身份问题，必须明确剩余高周期问题未收口。

## 6. 必须覆盖的验证

### 6.1 自动回归

- `web/tests/swing-sr-adapter.cjs`：MWH／MWC 大小写、同键发布读取、参数和周期隔离、旧 revision／ticket 拒绝；同时保留平台案例。
- `web/tests/native-indicator-identity.cjs` 及 coordinator 的实际批量提交入口：改参、切图格、迟到响应、相同 symbol 不同 series；检查结果和质量状态都隔离。
- 后端围绕真实调用链新增观察政策回归：同一固定输入 strict 为 null、observed 按已观察 OHLC 得到相应结果；包含独立 oracle 对照，而非只断言非空。
- Swing 5／5：已知严格极值的 11 根以上观察样本、单调无极值样本、10 根样本、未知内部分钟覆盖、未知周末空档、真实坏值断点、历史首尾 partial、形成中回撤。
- EMA／RSI：真实起点、checkpoint、完整段与缺依赖段；有限／递归质量依赖传播；返回旧参数和 stale snapshot 不能当作当前结果。
- 固定完整输入上的 strict／observed 数值一致；未核实输入只允许展示差异，不改变 strict 的 null／拒绝结论。不同来源仅比较各自 oracle，不能要求平台与自建价格相同。
- 缓存、group key、parent、suffix 与后台 worker 的政策隔离；长输入按有界页完成，lease 释放、超限、重试和故障恢复。
- 旧应用读取原历史／组合／strict runs；旧 worker 不认领 observed runs；导出／预警／策略不接受 observed 状态或检查点。
- 运行受影响 Python Ruff、diff 检查、Web 构建及现有相关 Node／pytest；新增测试进入现有 CI 分组，PG 用例显式执行，不将 skip 报作 pass。

### 6.2 Ubuntu 隔离 R1／PG

- 在实施 worktree 下建立任务独立 Compose project／PG volume／网络／端口及合成凭据，不共享 mwa 可写数据库。已有同任务隔离实例可在核实归属后复用。
- 固定 M1＋原生周期价格样本，构造完整、覆盖未核实、首尾 partial、坏值和实时预览；EURUSD／XAUUSD 均覆盖，周／月有样本不足案例。
- 真实 PostgreSQL 运行 strict 和 observed 两类长任务，验证输出、checkpoint、并发请求共享、修正继承、TTL 和旧 worker 行为；如果无 DDL 则明确记“无迁移”，仍验证新持久语义及回退。
- 浏览器真实添加 Swing／EMA／RSI，检查原生 study 实际提交值、可见绘图、统计卡片、质量标记、刷新恢复；使用人工已知形态及后端 oracle，不能只检查 HTTP 200 或 study 行数。

### 6.3 mwa 功能验收矩阵

| 维度 | 最小覆盖 |
| --- | --- |
| 行情 | 平台、自建、组合；EURUSD、XAUUSD |
| 周期 | H1／H4／D1／W1；MN 验证不足样本状态 |
| 指标 | Swing 默认和一组人工参数、EMA、RSI；其余已发布 Python 指标至少做协议兼容检查 |
| 操作 | 原生菜单添加、删除、改参、切品种／周期、两次刷新、向左分页、多图同时使用 |
| 一致性 | 指标属于当前图格和价格快照；卡片、辅助线与 plot 共同一致；对其他图格无影响 |
| UI | 深浅主题、390px；状态简短、详情可读、无重复弹窗 |
| 数据保护 | 工作区与映射前后比较；临时 context 拦截 workspace／preferences 保存；受保护 profile 不连接、不覆盖 |

成功标准：有足够合法观察且 oracle 存在输出的场景必须真实绘图；合法无极值、warmup、partial 等场景明确说明。不得把没有市场极值的样本强改为有值来“验收通过”。仅验证 Swing 不足以宣称所有 Python 指标完成验收。

性能沿用 `docs/chart-indicator-parity-plan-20261016.md` 的对应已声明场景预算，明确区分普通／复杂指标、≤6000 根／长起点、冷／热；一次 smoke 不报告 p95 达标或长期稳定性。

## 7. mwa 更新、回退与提交边界

- 构建仅使用 `mw-docker`／`deploy/ubuntu/mw_docker.py`，标明 task／project／purpose；固定干净提交、真实镜像 ID 和 mwa 正确 Chart origin。
- 先检查实际容器、资源、ports、环境／挂载及所用 worker 路径。新政策涉及 API、执行指标任务的 worker、Chart 和 Web；根据实际调用审计列出必要服务，不能只更新 Web，也不能盲目整栈重建。
- 与持久运维入口的候选 overlay 同步，避免后续 start 降版。保存本轮专用 before／rollback overlay；仅替换核实必要的应用服务，不运行 seed／reset，不替换 DB volume，不调用历史整栈 rollback。
- 应用回退保留新展示缓存，旧服务不能认领或使用新 algorithm。回退前释放本轮浏览器租约；不删除原 strict 历史输出，也不原地转换 observed 检查点。
- 交付证据包含：确切源码／镜像、测试结果、Standards／Spec findings 闭环、实际 PG 兼容、浏览器值／截图、mwa 服务差异和保护对象核对、专用启停／回退命令。
- 当前方案不创建正式 tag、不更新生产。PR #93 的已有 review／CI 不自动覆盖未来实现；PR 更新频率及合并由集成 session 按用户指令控制。

## 8. 非目标与验收结论边界

- 不重写全部指标，不引入第二套前端算法，不重做数据中心 UI。
- 不把补齐来源会话证据、全部历史重建和生产级灾备纳入本次必交范围。
- 不改写已发布历史、组合修订、接续点、账户口径及现有预警行为。
- 不承诺不同来源价格或指标完全一致，也不保证每种周期都一定有 Swing 极值。
- 本方案若确认，阶段 1—5 构成完整实施范围；仅阶段 A 缓存修复不算本问题全部解决。观察展示口径若未被接受，应修订第 3 节为严格输入方案，并明确高周期仍可能没有可计算结果，不能暗中放宽后交付。

## 9. 关联文件

- 待办入口：`docs/mwa-ui-pending-20261021.md` 第 03 项。
- 身份／日历约束：`docs/adr/0001-explicit-market-dataset-identity.md`、`docs/adr/0002-session-evidence-and-aggregation-phase.md`。
- Swing 算法和评估边界：`docs/swing-support-resistance-indicator-plan-20261012.md`、`docs/provider-swing-evaluation-boundary-20261016.md`。
- 现有固定完整初始化与性能口径：`docs/verification/three-layer/fixed-indicators-stage.md`、`docs/chart-indicator-parity-plan-20261016.md`。
- 任务状态／输出：`backend/alerts/storage.py`、`fixed_indicators.py`、`indicator_state.py`、`display_indicator_jobs.py`。
- 覆盖／来源会话：`history_artifacts.py`、`history_versions.py`、`calendar_profile.py`、`domain.py`。
