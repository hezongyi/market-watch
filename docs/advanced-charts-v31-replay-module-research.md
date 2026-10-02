# TV v31.1.0 包的回放能力与原生图表接入评估

核查日期：2026-10-02。对象：`/home/quant/repos/research/TV_v31.1.0_0430.zip` 与当前仓库。证据来自 ZIP 原始条目、随包类型声明和项目源码；本次仅静态核查，未实施接入，未进行浏览器回放验证。

项目对照基线：`v1.5.0`（`37cf4048ca10f3206963c1aec67f49b38140f5a8`）。本文随 v1.5.1 文档修订整理；功能现状按该固定源码核查，不表示运行环境已升级。

当前入口 `charting_library.js:1` 实际加载 `runtime.d6871abde1090b0329fe.js` 和 `library.e2f8b3a016c9e1a0b7a5.js`。ZIP 内另有旧版 bundle；本文以实际加载版本为主要实现证据，旧版只作交叉参考。

## 结论

**这个包里的 TradingView 原生 Bar Replay 不是完整可用模块。** 能找到回放状态、工具栏位置、界面文案及内部订阅字段，但实际回放 API 明确抛出 `not implemented`，切换回放的关键方法为空或抛出 `Not implemented`。不能仅加 `enabled_features: ["replay"]` 就获得官网式回放。[S1][S2][S3]

**项目自身已有实际实现的历史演练功能，可复用其后台，把回放数据呈现在原生图表上。** 这属于新增项目回放入口和 datafeed 适配，不是启用包中现成的 Bar Replay。当前原生图表使用的库清单来自同一 ZIP，因此再换一次这个包不会补齐缺失实现。[S4][S5][S6]

## 原始包证据

| 检查项 | 原始代码 | 判断 |
|---|---|---|
| 内部回放 API | `async replayApi(){Hy()}`；`Hy()` 的函数体为 `throw new Error("not implemented")` | 有方法名，实际调用直接失败 [S1] |
| 回放服务字段 | `_replayApi=null` | 没有在该入口创建回放服务 [S1] |
| 主序列切入/退出回放 | `switchToReplay(e,t,i){throw new Error("Not implemented")}`；`switchToRealtime(){throw new Error("Not implemented")}` | 核心路径未实现 [S1] |
| 图表模型/包装层切换 | `switchToReplay(e,t){0}`；`switchToRealtime(){0}`；`onReplayModified()` 断言 `"Replay not implemented"` | 多层空实现，不能据方法名推断可用 [S1] |
| 工具栏位置 | `Replay="header-toolbar-replay"`；只在 `e.Replay` 存在时渲染该组件 | 提供渲染槽位，不证明回放组件和引擎存在 [S2] |
| 公开类型契约 | 三份随包 `.d.ts` 中只有 `charting_library.d.ts:103` 的 `Status.Replay = 11` 命中 `replay`，没有公开启动、播放、单步、定位 API；`ChartingLibraryFeatureset` 不包含 `replay` | 状态枚举不是回放功能 API [S3] |
| 包中首页尝试开启 | `enabled_features` 填写 `"replay"`，注释明确为“尝试启用”；两处 `addReplayButtonToToolbar(widget)` 实际调用都已注释 | 示例配置没有完成接入 [S4] |
| 首页自定义回放辅助脚本 | 整个 ZIP 的 JS/HTML/Python/TS 搜索 `addReplayButtonToToolbar` 只在 `static/index.html` 命中；页内检查失败时打印“函数不可用” | 包中未找到该辅助函数实现，日志“回放按钮已添加”也不能当作运行成功证明 [S4] |

上述结论并非只凭“文件名里没有 replay”：已经直接检查实际库中的关键 API 和主序列切换路径。其他 bundle 的内部订阅/回放交易调用同样不能绕过这些空实现；没有证据支持通过加载某个隐藏 chunk 即能获得完整回放。也不能将其归因为“只差配置 UDF 或 WebSocket 后端”：行情协议可以提供历史数据，不能实现这里被删空的回放控制路径。[S1][S2][S3]

## 当前项目已有的回放与可行接入

- 后台有真实的创建、单步和定位接口：`POST /api/replays`、`POST /api/replays/{id}/step`、`POST /api/replays/{id}/seek`。创建时校验周期/范围和历史数据；当前最多 20000 根。单步推进虚拟时间并执行模拟预警策略。[S5]
- 返回浏览器的普通回放响应只包含 `end <= cursor` 的 K 线，最多最近 2000 根；前端已有播放、暂停、下一根、前进 10 根和时间定位，并在现有 `<Chart>` 中显示。因此项目的“演练”与包里的空 Bar Replay 是两件不同的能力。[S5]
- 随包公开 datafeed 提供 `getBars`、`subscribeBars`；图表提供 `resetCache()`、`activeChart().resetData()`。据此可开发独立的回放 datafeed，将后台已走过的 K 线送入原生图表，并由项目自己的按钮控制推进。[S7]
- 接入必须限制所有历史查询到虚拟游标，停止该回放图的实时订阅，隔离实时/回放缓存与迟到的异步结果。后退定位时清除相关图表和 datafeed 缓存，防止提前显示未来 K 线；单纯改变可视区间不能满足这一点。当前 `bridge.js` 的 `getBars`/`subscribeBars` 面向行情服务，尚不是回放适配。[S6][S7]
- 第一版宜复用**自建行情**和既有演练周期。项目说明明确平台 ticker 不可提交给演练。演练按收盘事件推进，不能直接宣称具备逐笔或 K 线内成交重播；任意原生指标的显示也不代表后台会按该指标进行策略回测。[S5][S8]

本次未验证回放中多图、比较品种、指标重算、图上选择起点、倒退后图形恢复及浏览器性能；这些属于后续接入验证。结论仅适用于该 ZIP 与当前源码，不扩大为其他授权版本或 TradingView 官网能力的结论。

## 证据索引

ZIP 引用按原始换行计算行号；下文 `Z/` 代表 ZIP 内 `TV_v31.1.0_0430/static/`。压缩 JS 的长行引用不采用重新格式化后的行号。

- **[S1]** `Z/charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js:400`（Series 切换抛错）、`:666`（模型切换空实现及 `Replay not implemented` 断言）、`:687`（上层切换空实现）、`:788`（`Hy()` 抛错）、`:790`（`async replayApi(){Hy()}`）。旧版 `library.0dbcc224ae24ceb827f2.js:388/653/674/772/774` 有相同未实现路径，仅作交叉参考。
- **[S2]** `Z/charting_library/bundles/header-toolbar.c73521c33c31f7a2f740.js:5/7`（toolbar 标识和条件渲染）；回放状态与工具栏槽位不能绕过 [S1] 的核心未实现路径。
- **[S3]** 全文核查 `Z/charting_library/charting_library.d.ts`、`datafeed-api.d.ts`、`broker-api.d.ts`；唯一 `replay` 命中为 `charting_library.d.ts:103`；公开 `ChartingLibraryFeatureset` 定义自 `:29467` 起，不含 `replay`。
- **[S4]** `Z/index.html:146`（尝试启用注释）、`:154`（feature 配置）、`:187–193`（辅助函数检查与注释掉调用）、`:218–219`（第二处注释掉调用）；脚本加载声明位于 `:18/20/22/65`。辅助函数只在该页命中。
- **[S5]** [backend/alerts/api.py](../backend/alerts/api.py#L945)（响应游标过滤）、[创建](../backend/alerts/api.py#L1007)、[单步](../backend/alerts/api.py#L1086)、[定位](../backend/alerts/api.py#L1121)；[backend/alerts/service.py](../backend/alerts/service.py#L297)（实际单步与策略推进）；[web/src/main.tsx](../web/src/main.tsx#L1050)（现有图表和播放控件）。
- **[S6]** [advanced-host/library-manifest.json](../advanced-host/library-manifest.json#L2)（原包 SHA-256 `e4eabc20e156000b2a8fda7747044fd82b95c714526c7ab7f34bcfe62abaf9ee`）；与 [前次包一致性核查](advanced-charts-v31-alert-module-research.md) 使用同一基线，前次已核对 2928 个条目全部匹配；[advanced-host/bridge.js](../advanced-host/bridge.js#L403)（行情 getBars）、[订阅](../advanced-host/bridge.js#L541)。
- **[S7]** `Z/charting_library/charting_library.d.ts:10903`（resetData）、`:12426`（resetCache）、`:12747`（getBars）、`:12758`（subscribeBars）；`Z/charting_library/datafeed-api.d.ts:340/351`（datafeed 对应声明）。
- **[S8]** [docs/chart-dual-dataset-user-guide.md](chart-dual-dataset-user-guide.md#L9)（预警与演练的系列边界）；[docs/advanced-charts-user-guide.md](advanced-charts-user-guide.md#L68)（原生图表尚未接入交互回放）。
