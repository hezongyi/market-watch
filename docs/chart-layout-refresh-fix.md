# 专业图表保存后刷新变成 EURUSD 自建行情

修复基线：`d3b91ea4555a5649ecb8917fec492cbc850ee0aa`（文档版 v1.5.1，
功能代码仍为 v1.5.0）。修复分支：`fix/layout-refresh-series`。

## 根因与复现

原生保存接口的 `data.symbol` 使用已解析的显示名称。例如平台行情
`MWP:BTCUSDT` 被写成顶层 `document.symbol=BTCUSDT`；四图中焦点位于
`MWP:EURUSD` 时，顶层品种则为 `EURUSD`，与首图实际品种不同。
这些裸标识在本项目表示自建行情。

保存的布局正文没有丢失原来的主序列标识。但是刷新初始化时，桥接同时向
原生 widget 传入 `saved_data` 和顶层 `symbol`；后者覆盖首个 MainSeries。
这两步共同造成“保存成功，但刷新后单图或首图变为另一品种/自建行情”。

使用真实许可图表库和产品 bridge、resolveSymbol、保存适配器、视区恢复代码
复现；行情数据和父窗口 RPC 使用隔离内存 fixture，未连接生产。
固定四图为黄金平台 H4、BTC 平台 H1、EUR/CHF 自建 D1、EURUSD 平台 M5，
焦点在第四图。旧代码保存后顶层品种为 `EURUSD`，布局正文首图仍为
`MWP:XAUUSD`；刷新首图成为 `EURUSD`，其余三个图窗保留原品种。
旧代码的单图 BTC 平台行情刷新后也变成裸 `BTCUSDT` 自建行情。

单变量探针仅移除有保存正文时的构造参数 `symbol`，在保持错误顶层
`EURUSD` 元数据的情况下，四图按原来的完整品种标识恢复。这确认了覆盖入口；
不是自选列表初始化造成的切换，也不是存储端改写布局正文。

## 修复

- 已保存且包含图窗的布局初始化以正文为准，不传会覆盖首图的构造参数
  `symbol`。已有错误顶层元数据可以直接按完好的正文恢复，无需修改数据库。
- 后续保存从同次公开 API 快照的首图取得完整 ticker 和周期，再生成顶层
  元数据；不采用原生保存参数中的显示名称或另一个焦点图窗的品种。
- 新建尚未保存的工作区继续使用配置的初始品种。

正文如果已在错误首图出现后再次保存，该次保存反映的就是当时的图窗；
本修复不会推测此前用户选过的品种。历史缓冲政策属于另一任务，本次不改变。

## 回归范围与结果

`web/tests/advanced-layout-refresh.browser.cjs` 提供单命令复现，并自动清理
自己的浏览器与随机端口服务。7 组均通过：

| 场景 | 图数 | 覆盖 |
| --- | --- | --- |
| BTC 平台 / EURCHF 自建 | 各 1 | 平台前缀、带命名空间的自建标识 |
| 黄金平台 + EURUSD 平台 | 2 | 焦点品种与首图不同 |
| EURUSD 平台 + EURUSD 自建 | 2 | 同品种、不同来源 |
| 黄金平台首图，EURUSD 平台焦点 | 4 | 用户报告的首图覆盖症状 |
| EURCHF 自建首图，EURUSD 平台焦点 | 4 | 自建首图及混合来源 |
| OANDA 平台首图及混合来源 | 8 | 多品种、多周期、来源不串线 |

每组均检查原生保存后刷新、故意设置错误顶层 EURUSD 元数据的旧 raw 状态与
legacy content envelope、原生 Load 路径、所有图窗的完整 ticker/周期及首图画线。
旧布局的只读恢复断言存储正文和 revision 不变；同时检查浏览器和 bridge 错误。
周期覆盖 M5/M15/M30/H1/H4/D1/W1/MN。行情 fixture 用于验证持久化与恢复，
不作为真实平台网络、行情精度、首屏性能或历史缓冲验收。

从已安装许可资产及依赖的仓库运行：

```bash
cd web
LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu \
  node tests/advanced-layout-refresh.browser.cjs
```

独立 worktree 可设置 `CHARTING_LIBRARY_ROOT` 指向已有许可库。
复查旧实现可设置 `LAYOUT_REFRESH_HOST_ROOT` 指向固定基线的 `advanced-host`，
并使用 `--case=single-provider` 或 `--case=four-provider`；两种旧实现均出现
`refresh must preserve saved instrument AND provider/managed identity` 断言失败。

原始运行输出保留于 `/tmp/market-watch-layout-refresh-single-red.txt`、
`/tmp/market-watch-layout-refresh-red.txt`、`/tmp/market-watch-layout-refresh-green.txt`。
这些文件是本机临时证据，回归脚本是可重复验证的正式入口。

其他检查通过：6 个现有 JS 回归（视区、原生保存竞态、工作区版本/只读、
series identity、autosave 竞态及开关），后端 `test_advanced_workspace.py`
和 `test_provider_workspace.py` 共 5 个测试，前端 `npm run build`、JS 语法检查
及 `git diff --check`。构建仍有既有的大 chunk 提示，后端有依赖弃用提示。

本次未修改许可库、标签、生产服务、密码或用户布局；修复尚未部署生产。
