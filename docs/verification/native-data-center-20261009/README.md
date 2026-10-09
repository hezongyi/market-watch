# 数据中心原生 UI 实施与逐项验收

2026-10-09，Ubuntu 22.04 `quant-server`，基线 `4dfdf5b`。

## 实现结果

数据中心使用当前许可图表 v31.1.0 的真实 `AdaptivePopupDialog`、`DialogSidebarWrapper/Item`、`DialogSearch`、`InputControl`、`Select`、`Checkbox`。标题为图标＋数据中心，入口紧随指标；原生关闭、拖动、主题与弹层保留。桌面窗口最大 1120×720，侧栏 200 px，五个分区保持既有业务能力。小窗口和低高度时用“筛选与搜索”收拢筛选，原生搜索／下拉不变；表格独立滚动，分页及标题可见。

业务 React 19 在图表文档渲染；每个原生控件使用独立 vendor React root，避免跨 React runtime 传 hooks 树。所有内部模块、冷加载和版本检查集中在 `advanced-host/native-ui.js`。不打开真实图表设置作初始化，不借用设置的撤销事务。认证、Cookie、CSRF 和 HTTP 留在可信主应用，通过校验来源／session／请求 ID／大小／路由的 RPC 执行。

创建与实时映射的原生选择器只返回来源目录身份填入草稿；删除最终确认复用公开 `showConfirmDialog`，影响清单、引用保护及冲突校验仍由后台控制。业务表格、日期、文本域、维护任务和未保存保护由应用管理。单行打开反馈和防重复提交保留；主机接受后立即关闭窗口，后台加载／错误／重试显示在图表，只作用于捕获的目标图格。关闭取消未完成读取，已发出的变更继续；旧结果不能导航或覆盖新窗口。

汉堡菜单右侧的原生商品搜索接入平台、自建固定历史、组合三类，来源和资产类型筛选在分页前执行，真实游标分页无首屏截断；结果保留不同类别的唯一 ticker。重复“行情搜索”入口不再加载。交易对用 EUR/USD、BTC/USDT，股票保留 MSFT、AAPL。

## 验收矩阵

最终浏览器套件串行运行，直接访问部署后的 Docker 静态资源，未启用 `LOCAL` 源码替换。已提交的 JSON 是脱敏结果；复杂破坏性／故障场景明确使用局部 fixture，不实际删除既有历史或调度来源任务。

最终结果：**9 个浏览器套件、53 组验收全部通过，报告页面错误为空；价格／主题 60 项单元校验、后台 31 项及 PostgreSQL 5 项回归通过。** 构建、JavaScript 语法与 `git diff --check` 通过。11 个最终套件的运行时间和退出码见 [final-suites.json](final-suites.json)。

| 验收范围 | 证据与结果 |
| --- | --- |
| 冷打开、真实原生壳／侧栏／搜索、单标题、无重复入口、五分区浏览不切图、暗／亮、375–1920 宽度、拖动／关闭回焦、草稿保护和释放 roots | [界面报告](native-integration-report.json)，7 组 |
| 目标图格失效、接受后立即关闭、图表侧错误、迟到请求无效、原生输入／下拉校验、Dukascopy 超首屏分页、真实主搜索取消 | [操作报告](native-actions-report.json)，6 组 |
| 来源选择器类型过滤与取消、表单验证、原生复选框状态、仅一次提交、已发变更继续和旧结果不导航新窗口 | [创建报告](native-create-report.json)，3 组；提交响应局部 fixture |
| 真实 Yahoo MSFT 重试成功／只变目标格、自建与组合唯一 ticker、固定历史打开、OANDA 精确映射选择、自选表取消／添加、真实比较选择、指标参数品种搜索取消 | [联动报告](native-linked-report.json)，7 组；映射 POST 局部 fixture |
| 四个行情请求占满时管理可用、关闭取消读取／重开不覆盖、真实指标／画线／范围保留、实际触屏只读无管理入口 | [生命周期报告](native-lifecycle-report.json)，4 组 |
| 删除入口、取消回焦、先暂停归档、原生确认取消／一次提交、引用／空历史阻止、清单冲突保护、归档失败重试、返回上下文 | [删除报告](delete-report.json)，9 组；破坏性命令局部 fixture |
| 单行打开状态／重复忽略、Tab 与 Shift+Tab、原生菜单 Escape、中文输入、真实图表设置取消／比较／指标窗口、版本失配和资源失败的兼容及重试 | [兼容报告](native-compat-report.json)，5 组 |
| 真实 Chrome tabs.setZoom 200%，1024／1440／1920 物理宽度，主操作可见、25 行组合／候选表滚动、标题和分页保持可见、Escape 收拢筛选和回焦 | [缩放报告](zoom-report.json)，3 组；25 行数据局部布局 fixture |
| 刷新后的画布／工具栏／轴一致、关闭 autosave 仍保存主题、旧布局恢复、同主题自定义背景保留、原生加载和双图格主题 | [主题报告](theme-restore-report.json)，9 组；工作区与设置写入内存 fixture |
| 来源目录、资产类型分页、统一游标覆盖所有类别、查询变化／畸形游标拒绝、HTTP 认证、读取不启动采集、SQL qualification | [后台日志](backend-unit.log)，31 项；[PostgreSQL 日志](backend-postgres.log)，5 项 |

截图：[Yahoo 列表](native-yahoo.png)、[暗色](native-dark-1440.png)、[亮色](native-light-1440.png)、[窄窗口](native-narrow-375.png)、[微软真实图表及自适应两位价格轴](native-open-msft.png)、[统一商品搜索](native-unified-search.png)、[真实 200% 缩放](browser-zoom200-1024.png)、[组合长列表](browser-zoom200-composite-1440.png)。

发现并修复：原生搜索被全局 box-sizing 裁切；独立 roots 下 Tab 越出窗口；侧栏 SVG 的基线偏移；200% 缩放时筛选挤占表格；旧搜索桥接强制首屏 25 条；资产类大小写映射不一致。每项修正后重跑相关场景。

## 版本与边界

固定内部版本 `6b804c486857f27920cf761aa7eb6e29d9bb6362`（TT v31.1.0）；内部组件不是厂商稳定公开接口，图表库升级须重新适配。版本失配或原生资源加载失败时清理部分 roots，自动打开可用业务 iframe 兼容窗口；恢复后可重试原生路径。未修改或提交许可库。原生主搜索及比较／自选表仍走各自的标准动作；实际触屏图表沿用原有只读模式。

## 实际运行环境和启停

验收网址：<https://192.168.7.232:19943/advanced-charts>，图表 origin：<https://192.168.7.232:19944>。密码沿用原验收密码，私有凭据、env、TLS 私钥与完整浏览器状态未提交。

Ubuntu 本机 Docker，task/project `mw-data-center-review-20261008`，独立网络、PostgreSQL volume 和数据库；19943／19944 专用端口。API／web／chart 镜像经 `mw-docker build --purpose acceptance` 和 `market-watch-ubuntu` BuildKit 构建。未操作 unraid 或生产。脱敏运行状态见 [runtime.json](runtime.json)。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml restart tls'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

实例保留供用户验收，Docker 生命周期 task 仍进行中。本轮没有退役、删除数据库卷或全局资源回收；实际验收结束后按 `mw-docker retire` 查看精确清单，备份并实际恢复校验后退役。

## 复验

需本机许可资源、`artifacts/data-center/login.json` 私有验收凭据、已有 Ubuntu Docker 服务和 Chromium。浏览器套件分别在 `web/tests/chart-data-center-native-*.browser.cjs`、`chart-data-center-delete.browser.cjs`、`chart-data-center-zoom.browser.cjs` 和 `chart-theme-restore.browser.cjs`。例如：

```sh
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
node web/tests/chart-data-center-native-integration.browser.cjs
```

价格／主题单元校验：`node web/tests/chart-price-format.cjs`、`node web/tests/chart-theme.cjs`。后台检索／目录／权限／游标测试 31 项，PostgreSQL 专用隔离 schema 回归 5 项；无 public 行情数据变更。
