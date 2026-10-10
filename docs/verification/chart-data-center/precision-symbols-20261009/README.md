# 品种显示统一与 Yahoo 价格轴验收

日期：2026-10-09，Asia/Singapore。源码基线 `f83ca06` 加本报告同提交的修改。

## 结果与实现边界

- 外汇和贵金属的 `eurusd`、`EUR_USD`、`EUR/USD` 统一显示 `EUR/USD`，`XAU_USD` 显示 `XAU/USD`。
- 加密交易对保留完整报价币，例如 `BTCUSDT` → `BTC/USDT`；Yahoo `EURUSD=X` → `EUR/USD`，`JPY=X` → `USD/JPY`。
- 股票、ETF、指数和期货保留证券代码，例如 `MSFT`、`^GSPC`、`CL=F`；已有明确报价分隔的 OANDA 指数使用斜杠。未知代码保留，不按长度任意切分。
- 共用后端显示规则覆盖平台目录、自建/组合列表与详情、任务、来源目录、映射、图表标题、原生搜索与报价名称。输入字段、供应商请求代码、ticker、逻辑品种和数据集身份保留原值。`EUR/USD`、`EURUSD`、`EUR_USD` 搜索均能找到对应品种；SQL 的 `%`、`_` 仍按文字匹配。
- Yahoo 价格轴使用来源 `priceHint`，旧元信息按类型回退：股票默认两位、外汇默认五位。价格绝对值小于 1 时增加显示位数，上限八位。真实 MSFT 验收为两位、EUR/USD 当前来源建议为四位、WTI 期货为两位。
- 通过公开 `custom_formatters.priceFormatterFactory` 设置默认显示，Yahoo 数据精度和 `pricescale=100000000` 保持完整。原生手动精度优先；指标、画线和原始价格数据不做舍入。负价格、低价格、微小涨跌和负零均有检查。

价格轴原问题由存储精度八位直接用于显示引起，见[修改前价格轴复现](precision-browser-red.log)。品种显示与斜杠搜索的修改前测试见[symbol-tests-red.log](symbol-tests-red.log)。

## 本轮验证

| 范围 | 结果与证据 |
| --- | --- |
| 后端显示、搜索、来源代码/身份、分页与文字匹配、Yahoo 元信息、原生参数、自建/组合和保留引用 | 144 项通过；[日志](symbol-regression.log)，独立 Docker 容器、内存 SQLite、禁用网络 |
| 原生 MSFT 默认两位、手动四位/返回自动、外汇/期货建议、Binance 原精度、明确保存后刷新恢复 | 6 组通过；[报告](yahoo-precision-report.json)、[日志](precision-browser.log) |
| Yahoo/OANDA/Dukascopy 三种搜索写法、数据中心名称、原生搜索/解析、Binance 打开和保存刷新、自建/组合固定身份、来源目录选择保留输入代码 | 7 组通过；[报告](symbol-presentation-report.json) |
| 原生弹窗深浅主题 × 1024/1440/1920、图标与入口顺序、刷新；五分区/未保存保护；Yahoo/Binance 真实打开；固定版本、目标图格、原生配置、维护编辑、全屏 | 22 组通过；[串行日志](symbol-browser-regression.log)、[UI](native-ui-report.json)、[窗口](browser-report.json)、[平台](platform-report.json)、[流程](flows-report.json) |
| 价格格式的符号、负值/负零、微小变化、低价格、手动覆盖、其他来源回退 | `node web/tests/chart-price-format.cjs`，11 项通过 |

35 组浏览器验收的六份报告均 `passed=true`、`errors=[]`。浏览器串行使用 Ubuntu 验收实例和真实公开原生图表接口；刷新前明确保存，遵循现有工作区保存设置。UI 对照检查等待按钮颜色的 160ms 过渡完成后再取样。

TypeScript/Vite、三组件 Docker 构建、桥接脚本语法和 `git diff --check` 通过。新增价格格式脚本已加入 Docker 文件清单与内容哈希打包；许可库未修改。

截图：[MSFT 两位价格轴](yahoo-precision-msft.png)、[Yahoo](symbol-yahoo.png)、[OANDA](symbol-oanda.png)、[Dukascopy](symbol-dukascopy.png)、[Binance 图表](symbol-binance-chart.png)。

## 实际运行环境与启停

Ubuntu 22.04 `quant-server` (`192.168.7.232`) 本机 Docker，task/project 为 `mw-data-center-review-20261008`。
独立 Compose 网络、PG14 volume、数据库和 19943/19944 端口；沿用该任务验收数据。没有使用 unraid 或生产目录。
API、web、chart 通过 `mw-docker build`、`market-watch-ubuntu` builder、`purpose=acceptance` 构建并更新。
九个服务运行，API/PG 健康；镜像 ID、资源归属和状态见[runtime.json](runtime.json)。构建标记基线 `f83ca06`、`dirty=true`，包括本报告同提交的源代码。

访问：<https://192.168.7.232:19943/advanced-charts>；旧地址 <https://192.168.7.232:19943/market-data> 兼容。
图表 origin：<https://192.168.7.232:19944>。登录密码保持不变；私有密码、Compose/env、证书私钥、许可资源和浏览器状态不提交。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

实例继续运行供用户验收，生命周期任务仍进行中。验收结束后再按明确 task/project 预览 retire，备份并实际恢复校验后精确退役；本轮未清理运行实例或执行全局清理。
