# 数据中心入口与原生弹窗 UI 验收

日期：2026-10-08，Asia/Singapore。源码基线 `4996af5` 加本报告同提交的 UI、焦点与平台目录变更。
本轮使用 [ui-ux-pro-max](/home/quant/.agents/skills/ui-ux-pro-max/SKILL.md) 对齐实际原生图表弹窗，
并通过 [diagnosing-bugs](/home/quant/.agents/skills/diagnosing-bugs/SKILL.md) 的复现流程定位筛选焦点问题。
历史实现验收保留在[原收口记录](../completion-audit.md)，本目录仅记录这次调整。

## 用户反馈与结果

- 入口顺序为“指标 → 数据中心 → 行情搜索”；数据中心使用垂直居中的图标加文字。
- 弹窗左上角为同款图标加“数据中心”。标题栏、字体、黑白主按钮、导航选中行、边框、圆角、投影和深浅配色对齐当前原生设置/指标弹窗。
- 指标入口恢复 `18adbf1` 中四根柱形加上升折线的图标。旧 CSS 仅作用于已隐藏的内置按钮，本次将同一 SVG 轮廓装饰到公开接口创建的当前按钮。
- Binance 空目录源于列表仅读取 `MarketCatalog`，遗漏 `Instrument` 中已有的 BTCUSDT。现在合并可解析的旧平台身份，按来源/代码去重，排除显式自建历史身份，目录读取不创建采集需求。
- Yahoo 空目录源于验收实例未启用来源。本实例在私有配置中启用 Yahoo，沿用已配置代理，启动时建立 17 个预置品种。未刷新元信息的时间显示“—”，不把零时间戳显示成 1970 年。
- 修复筛选时路由变化将焦点移到标题的问题。仅进入分区/详情或返回指定行时恢复位置；同分区内改筛选、分页保持当前控件焦点。

Binance 当前适配范围为 BTCUSDT，不把这一目录描述为 Binance 全市场；Yahoo 本轮验证的是预置/已有本地目录，不宣称已枚举 Yahoo 全部证券。

## 验证结果

7 套浏览器验证共 42 组通过，报告 `errors=[]`；后端 18 项通过。
最后的目录身份边界调整后，再执行真实窗口与 Yahoo/Binance 流程 9 组，保持通过，见[最终 API 回归](final-api-regression.log)。

| 范围 | 证据 |
| --- | --- |
| 入口顺序、图标与文字居中、历史指标图标、标题图标、原生样式实测比较；深浅主题 × 1024/1440/1920；刷新、Tab/Esc/焦点 | [native-ui-report](native-ui-report.json)，7 组 |
| 五分区、纯读取、窗口关闭、未保存保护、浏览记忆 | [browser-report](browser-report.json)，7 组 |
| 固定版本、目标图格、原生参数、维护编辑、真实全屏 | [flows-report](flows-report.json)，6 组 |
| 指标/画线/布局/视区保留、最大化、指标弹窗协调、失败重试、竞态 | [resilience-report](resilience-report.json)，12 组 |
| 长文本、实测文字对比度 ≥4.5、空工作区、局部表格滚动 | [layout-report](layout-report.json)，5 组 |
| Chrome `tabs.setZoom(2)`，DPR=2，实际 CSS 宽度 512/720/960；组合 25 行 fixture、输入与 Esc 焦点 | [zoom-report](zoom-report.json)，3 组 |
| Binance BTCUSDT 与 Yahoo AAPL 的目录、来源筛选、真实解析、准确图表身份及 H1 周期 | [platform-report](platform-report.json)，2 组 |
| 平台旧身份、目录优先去重、分页/搜索、Yahoo 启用状态、显式历史排除、既有数据中心/搜索回归 | [后端日志](platform-tests.log)，18 项，独立容器内存 SQLite |

浏览器完整串行记录见[回归日志](browser-regression.log)。TypeScript/Vite Docker 构建、公开桥接 JS 语法和 `git diff --check` 通过。
本轮未修改许可 bundle。缩放组合列表使用浏览器网络 fixture；平台目录与图表解析使用真实 API。

焦点修复前，`chart-data-center-zoom.browser.cjs` 的“输入筛选、等待浏览器绘制、仍保持输入焦点”断言失败，见[修复前复现](focus-before.log)；
修复后同一断言及原 Esc 返回筛选按钮断言均通过。

截图：[深色](native-ui-center-dark-1440.png)、[浅色](native-ui-center-light-1440.png)、
[真实 200%](browser-zoom200-1024.png)、[Binance](platform-binance.png)、[Yahoo](platform-yahoo.png)。
对照：[原生深色弹窗](native-ui-reference-dark.png)、[原生浅色弹窗](native-ui-reference-light.png)。

## 实际环境与启停

实际运行在 Ubuntu22.04 `quant-server` (`192.168.7.232`) 本机 Docker。
task/project 均为 `mw-data-center-review-20261008`；独立 Compose 网络、PG14 volume、数据库/用户 `data_center` 及 19943/19944 端口。
该数据库从历史验收归档恢复，启动应用前 83 张表、149,894 行的数量和内容指纹一致。
本轮所有镜像通过 `mw-docker build`，purpose=`acceptance`，builder=`market-watch-ubuntu`。

访问：<https://192.168.7.232:19943/advanced-charts>；旧地址 <https://192.168.7.232:19943/market-data> 仍兼容打开窗口。
图表 origin：<https://192.168.7.232:19944>。本机自签 TLS；登录密码保持不变。
私有 Compose/env、密码、证书私钥、许可库及浏览器状态位于 ignored 目录，未提交。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

最终运行镜像 ID 与服务状态见[运行记录](runtime.json)。镜像构建标签的源码基线为 `4996af5`，`dirty=true`，包含本报告同提交的产品代码。

实例保持运行供用户验收，Docker 生命周期任务仍进行中。用户验收结束后，先按精确 task/project 预览 `mw-docker retire`，
再进行归档、实际恢复验证和精确退役；本次没有执行退役或全局资源清理。
