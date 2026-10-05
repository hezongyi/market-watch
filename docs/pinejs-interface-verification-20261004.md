# PineJS / Pine Script 接口核查（2026-10-04）

结论：**PineJS 是图表库自定义 JavaScript 指标的辅助 API，不是接收、编译、执行 Pine Script 文本的接口。** 当前安装版本还支持 Pine 风格的 `StudyScript` 函数，但它仍然是 JavaScript 函数；不能据名称推断可粘贴 TradingView Pine 源码运行。

本次为 Ubuntu 本地源码与类型声明核查，并对两段独立函数进行 Node 执行验证。未部署实例、未启动完整浏览器图表、未验证生产运行状态。许可图表库仅只读查看，本文不复制其完整实现或许可资产。

## 1. 确认实际加载路径

- 项目 [advanced-host/index.html:23](../advanced-host/index.html#L23) 加载 `/charting_library/charting_library.js`。
- 当前本地 `charting_library.js:1` 的 bundle 列表指定 `bundles/library.e2f8b3a016c9e1a0b7a5.js`。库目录含其他历史 hash，因此结论针对这个入口指向的 bundle，不基于任意旧文件。
- [advanced-host/bridge.js:1217](../advanced-host/bridge.js#L1217) 配置 `custom_indicators_getter: (PineJS) => Promise.resolve(pythonStudies(PineJS, catalog))`。
- [advanced-host/indicators.js:2](../advanced-host/indicators.js#L2) 返回 `name / metainfo / constructor` 对象；计算数据通过 `MWPY_` 合成 symbol 输入，`main` 以 `PineJS.Std.time/close/volume` 映射数值。这里没有 Pine 文本编辑、编译链路。

许可库核查根目录：`/home/quant/repos/market-watch/advanced-host/charting_library/`（未纳入本次 worktree）。以下库行号均相对该目录。

## 2. 公开类型声明：两种 JavaScript 接口

| 证据 | 精简声明及含义 |
| --- | --- |
| `charting_library.d.ts:5186` | `custom_indicators_getter?: (PineJS: PineJS) => Promise<readonly (CustomIndicator \| StudyScript)[]>`；返回对象或函数，不是 Pine 源码字符串 |
| `charting_library.d.ts:6162` | `CustomIndicator` 有 `name`、`metainfo`、`constructor`，说明明确要求 ES5 constructor，包含 `main` 和可选 `init` |
| `charting_library.d.ts:17543` | `PineJS` 公开成员为 `Std: PineJSStd`；标准函数包括 OHLCV、ATR、RMA 等 |
| `charting_library.d.ts:30227` | `export type StudyScript = (ctx: ScriptContext) => void`，仍为 JavaScript 回调 |
| `charting_library.d.ts:20158` | `ScriptContext` 有 `input`、`ta`、`request`、`plot`、`fill`、`indicator` 等 Pine 风格成员；这些成员不等于完整 Pine 语言支持 |

实际 bundle `library.e2f8b3a016c9e1a0b7a5.js:853` 给 getter 传入 `{Std:Gy.Std}`，遇到函数就调用 builder。`:808` 的 builder 直接以 `e(t)` 执行传入的函数，再构建 `metainfo / constructor`。这证实 `StudyScript` 路径执行 JS 函数，没有把 Pine 源码字符串送入编译器。

因此需要更准确地表述：项目可以选择传统 `CustomIndicator` 或这个版本的函数式 JS 指标接口；当前 Python 桥接使用前者。**存在 Pine 风格 API，但没有可用的 Pine Script 文本执行接口。**

## 3. 排除容易误读的接口名称

实际加载 bundle 中：

- `:780` 的 `createStudy` 对字符串按已注册指标名称查找；对非字符串转入 `_createStudy`。因此将 Pine 源码作为字符串传入，也不会把它识别为源码。
- `:785` 的 `_createStudy` 返回 `Promise.reject("Pine Script® and java studies are not supported")`。这里的拒绝是特定对象形式入口，不应扩大解读为所有内置或自定义 JS 指标都不能创建。
- `:790` 的 `pineEditorTestApi(){Hy()}` 调用 `:788` 的 `Hy`，后者 `throw new Error("not implemented")`。单纯在 bundle 中搜索到 Pine 编辑器名称不能证明编辑器可用。

以 Node 读取当前 bundle 并提取上述两个方法及 `Hy` 独立执行，结果：

```text
isolated pineEditorTestApi: not implemented
isolated _createStudy rejection: Pine Script® and java studies are not supported
```

这是**独立函数执行验证**，不是完整 widget、浏览器或线上验证；对公开接口边界的结论主要由类型声明和真实 loader 指向的实现共同支持。

## 4. 与 SuperTrend 方案有关的新发现

当前加载 bundle `:126–127` 已包含内置 `SuperTrend`，ID 为 `SuperTrend@tv-basicstudies-1`，默认 `Length=10`、`Factor=3`；声明了主图线、颜色映射及上下箭头，并标记 `isTVScript: false`。这说明可以优先评估现成指标是否满足看图需求，无须为普通查看先移植完整 Pine 文本。

但尚未验证当前窗口是否显示该项，也未证明该内置算法与用户的 Pine 版本、pandas-ta 或 TA-Lib 路径逐根数值一致。正式实现应使用相同行情输入核对 ATR 平滑、初始化、方向编码、翻转边界与未收盘 K 线行为。

bundle `:129` 有内部 `supertrend` 实现，但公开 `PineJSStd` 类型未声明同名方法。**不建议依赖未公开的内部 helper**；自维护 Python 体系应通过稳定的项目适配协议返回趋势值、方向及信号，由图表元数据描述线、颜色及箭头。

## 5. 官方文档参考与网络限制

与本地类型声明对应的一手官方入口：

- [Custom indicators](https://www.tradingview.com/charting-library-docs/latest/custom_studies/)
- [Custom indicator constructor](https://www.tradingview.com/charting-library-docs/latest/custom_studies/custom-indicator-constructor/)
- [CustomIndicator API](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.CustomIndicator/)
- [PineJS API](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.PineJS/)
- [Charting Library types](https://www.tradingview.com/charting-library-docs/latest/api/modules/Charting_Library/)

本轮尝试访问官方页面返回 `URLError: [Errno 101] Network is unreachable`。这些链接为一手复核入口，不声称本轮已成功读取网页最新内容；上述结论依据本地实际安装版本源码和声明，不依赖未经读取的网页转述。
