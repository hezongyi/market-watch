# KLineChart Pro 之外的图表候选

调研日期：2026-09-29。仅基于官方仓库、文档和许可，未安装、运行原型或改动产品代码。不能据功能表断言某一项目“最佳”。

## 本项目的优先级

当前更合理的候选顺序是：**KLineChart 核心 + 复用/适配 Pro 工具栏**，与**现有 Lightweight Charts + 画线插件**对照验证。Pro 是加速起点，不应未经验证直接视为满足全部绘图、布局、联动、保存需求的完整产品。

此前已核实核心 Apache-2.0、正式版 v10.0.3；Pro Apache-2.0、最新 release v0.1.1（2023 年）。Pro 声明 peer >=9 不能证明 v10 实际兼容。主代理进一步检查 [Pro 工具栏源码](https://github.com/klinecharts/pro/blob/main/src/widget/drawing-bar/index.tsx)，发现 singleLine / moreLine / polygon / fibonacci / wave 分组；未找到可直接承诺的文字标注及多空风险收益工具，仍需按实际工具清单验证。核心 custom overlay 扩展能力不等于对应工具已实现。

## 真正值得补充比较的项目

| 项目 | 已验证优势 | 对本项目的局限 | 初步定位 |
|---|---|---|---|
| Tradiny | 注释线/曲线、尺子、斐波那契、保存图表；完整平台，GridHandler 支持图表网格；文档演示恢复绘图 | 不是只替换 React 图表组件；数据接入、现有预警边界和授权条件需适配；未验证同品种跨周期实时同步 | 值得看演示的完整平台候选，未证明更省集成成本 |
| TradeX-chart | 原生 JS/Web Component，框架无关；图表 state 导入导出；TA-Lib WASM 和扩展接口 | README 仍将 Custom Drawing Tools 标为 to be implemented；GPL-3.0；绘图完整度需实测 | 指标/状态接口有价值，但当前不优先于 KLineChart 画线路线 |
| React Financial Charts | MIT，React 原生；主代理核实 README 提供趋势线/Fibonacci/Gann/通道等交互组件 | 组件集合，需要拼工具栏、工作区和保存；最近 push 观测为 2024-03-09，不以此断言停止维护 | React 集成备选，不能等同开箱即用终端 |

### Tradiny 的许可证与维护证据

[官方 README](https://github.com/tradiny/tradiny) 声明上述绘图、160+ 指标、预警与扫描等功能。数量是项目声明，本轮未验收。内置 Polygon/Binance 不会自动继承 market-watch 的 OANDA NY17 分桶。

[绘图文档](https://github.com/tradiny/tradiny/blob/main/docs/docs/frontend/draw.md) 给出 `GridHandler.getChart`、`drawingData` 和 `unserializeDrawing`；证明有图表网格/绘图恢复机制，不证明跨图协同保存已满足本项目规则。

[LICENSE.md](https://github.com/tradiny/tradiny/blob/main/LICENSE.md) 与 [frontend/LICENSE.md](https://github.com/tradiny/tradiny/blob/main/frontend/LICENSE.md) 都是“AGPL v3 + 个人用户额外权利 / 商业许可”的双许可文本。明确个人分析/获利可不公开自有策略，条件是不再分发、不创建公众服务。不能写成 MIT/Apache，也不应因 GitHub metadata 显示 Other 就断言无许可。未来公开运营需重新核对条款。

[GitHub API](https://api.github.com/repos/tradiny/tradiny) 本次未归档、pushed_at 2026-09-09；[最新 release API](https://api.github.com/repos/tradiny/tradiny/releases/latest) 为 v1.0，2024-11-14。最近 push 与正式发布间隔应分别看。

### TradeX-chart

[README](https://github.com/tradex-app/TradeX-chart) 明确列 state 导入/导出、talib-web、React/NextJS 示例，也明确 Custom Drawing Tools 待实现；不能把可扩展推导为已具有完整专业画线工具。

[仓库 API](https://api.github.com/repos/tradex-app/TradeX-chart) 标记 GPL-3.0、未归档、pushed_at 2026-07-21。本轮 latest release API 返回 404，只能说明该 API 未提供最新 GitHub release，**不能推导没有 npm 版本或不维护**。[LICENSE](https://github.com/tradex-app/TradeX-chart/blob/master/LICENSE)

### React Financial Charts

主代理已核对 [官方仓库](https://github.com/react-financial/react-financial-charts) README、MIT 许可与维护元数据。其价值在 React 原生交互组件，工作区产品仍需应用层组装。没有验证到完整服务端持久化或本项目多周期画线共享。

## 其他常见名称为什么不直接优先

- **NightVision**：真实官方仓库是 [project-nv/night-vision](https://github.com/project-nv/night-vision)，GitHub 标 MIT。README 说明 Svelte 实现，是 TradingVueJS 思路的延续；roadmap 仍列 `Add tool overlays ???`、`Toolbar ???`、移动支持。因此不能当作更完整、现成的画线工作台。[API](https://api.github.com/repos/project-nv/night-vision) 本次 pushed_at 2024-06-29，未归档；latest release API 返回 404，未确认 npm 最新版本。
- **TradingVue.js**：[README](https://github.com/tvjsx/trading-vue-js) 被主代理核实明确标记 Not Maintained，不建议新增长期依赖。
- **Apache ECharts**：成熟的 Apache-2.0 通用可视化库，但从 K 线显示到专业画线编辑、撤销重做、跨周期保存仍需应用实现；通用图表生态强不等于本任务最省工作。[官方仓库](https://github.com/apache/echarts)
- **Highcharts Stock**：仓库可读不等于 MIT/Apache 开源；[官方 license.txt](https://github.com/highcharts/highcharts/blob/master/license.txt) 指向 Highsoft 授权方案。本轮未核实当前个人非商业条款，不能承诺免费适用；应单列为商业组件候选，而非本轮开源首选。
- **GoCharting / ChartX**：未核实到可对应“完整 TradingView 类图表工作台”的官方开源仓库及许可证。不能依据产品名称或第三方文章把它列为已验证开源替代。

## 如何选，而不是仅看演示或 stars

先验证同一套关键路径：实际需要的全部工具、编辑/删除/撤销、刷新恢复、M5/H4/D1 切换、2/4 图布局与规定的联动、休市及 NY DST 锚点、历史分页和未来延长线。对 KLineChart Pro 尤其确认核心版本兼容、底层 API 是否可访问、文字/风险收益工具是否补实现。

只要 KLineChart 核心路线通过上述门槛，它是当前较有根据的首选；Pro 本身不是已证明最优。若现有 Lightweight Charts 插件在相同验证中更稳定、工具更齐，保留现有引擎可能迁移成本更低。完整平台 Tradiny 可辅助参考布局和保存设计，无需为了图表替换已运行的后台预警系统。
