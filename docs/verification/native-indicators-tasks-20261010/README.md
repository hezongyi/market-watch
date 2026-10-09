# 原生指标分类与任务记录改版验收

2026-10-10（Asia/Singapore）完成实现和最终验收。运行于 Ubuntu `quant-server` 本机隔离 Docker，task/project：`mw-data-center-review-20261008`。验收实例保留。

## 指标窗口

真正的原生 `IndicatorsLibraryContainer` 负责指标查询、原生列表、星标、收藏存储和添加回调。在同一窗口增加左侧分类：全部指标、收藏、内置指标、我的 Python、当前图表已添加。窄屏使用原生 Select。收藏直接显示在当前窗口。

复用原生 `AdaptivePopupDialog`、`DialogSearch`、`DialogSidebarItem`、`Select` 和原生指标行。详情在右侧显示用途、计算和输入，窄屏覆盖列表内容区；返回、Escape、Tab、焦点和原生参数窗口返回保持可用。当前图表已添加按实例提供设置、显隐和移除。未完成的同一指标添加请求防重复，完成后仍允许有意添加多个实例；异步添加留在点击时的图格。

许可库版本固定为 `6b804c486857f27920cf761aa7eb6e29d9bb6362`。适配器包装模块 `217583` 的 factory，仅为该模块提供局部 React 创建元素代理，并扩展原生 controller；不替换全局 React、不复制或修改许可文件。该接入依赖当前版本的内部接口，升级许可库需要重新适配。原生依赖由原始 loader 加载，禁止提前执行未就绪的指标模块。

原生控制器默认排除应用 Python 包；适配器将其原始 metainfo 投影回原生行，保留 id、name、descriptor 和收藏 key（例如 `守望 Python SMA`）。保存恢复仍使用原身份。版本或资源不匹配时保留完整兼容窗口。

截图：[桌面亮色详情](indicators-light-1440.png)、[桌面暗色详情](indicators-dark-1440.png)、[375px 详情](indicators-dark-375.png)、[实际 200% 缩放](indicators-zoom200-1024.png)。[原生全列表截图](harness-native-list.png)来自真实许可库与合成行情的 harness，单独标明其数据边界。

## 数据中心：任务与记录

顶部保留页面名称，下面依次为整行原生搜索、状态标签（当前任务／需处理／已暂停／历史记录／全部）和表头来源 Select。列表紧凑显示品种、来源、日界、任务类型、状态、查询至时间、更新时间及主要操作；取消只在统一详情面板内提供，并需确认。

新增只读 `/api/market-data/center/task-feed`，旧分页接口继续兼容。按创建时间及 UUID 连续加载，无底部分页。使用时间边界及 keyset 游标阻止新插入任务打乱续读；已加载任务每 10 秒按 ID 更新状态，保持行和滚动位置，新记录提示刷新。状态筛选在刷新列表时重新应用，已加载行状态改变后暂留原位。它不是冻结所有任务状态的数据库快照。

筛选变化取消旧请求；续读失败保留已有行并可重试。按工作区和筛选缓存已加载列表及滚动位置，最多保留 8 个组合。从行情管理返回恢复具体任务。列表和详情共用每个任务的提交状态，防止两处重复操作；安全停止等待服务端状态反馈。错误展示沿用安全错误类型。

截图：[桌面列表](task-list-light-1440.png)、[375px 列表](task-list-light-375.png)、[桌面详情](task-detail-light-1440.png)、[375px 暗色详情](task-detail-dark-375.png)。这些截图中的任务为明确的受控 fixture，用于展示不同状态和验收操作，未向真实任务发送暂停或取消。

## 最终验证

最终部署后的 **5 套浏览器回归、40 组检查全部通过**，后端 **27 项通过**；另有真实许可库 harness 和 catalog/search 回归通过。报告交互异常均为空。TypeScript／Vite 构建、JavaScript 语法、相关 Ruff 检查及 `git diff --check` 通过。

| 套件 | 组数 | 范围与边界 | 报告 |
| --- | ---: | --- | --- |
| 指标专项 | 11 | 实际原生窗口、查询、收藏服务器持久化、Python 原身份、参数返回、实例操作、保存恢复、多图、深浅主题与 1440／768／375px；添加完成延迟使用受控测试 | [报告](indicator-report.json) |
| 任务专项 | 10 | 真实 task-feed 读取；70 条任务、续读故障、控制请求及延迟使用 fixture；原位更新、共享忙碌状态、管理返回、主题尺寸和键盘 | [报告](task-report.json) |
| 数据中心详情 | 8 | 真实自建／组合列表和管理入口；覆盖证据及技术错误使用 fixture；统一面板、原位滚动、回焦与兼容路径 | [报告](detail-panel-report.json) |
| 实际浏览器 200% 缩放 | 3 | Chrome tabs.setZoom，物理 1024／1440／1920px；原生指标及数据中心详情无横向溢出；组合行数使用布局 fixture | [报告](zoom-report.json) |
| 商品代码搜索 | 8 | 真实原生控件和来源／行情类型组合；连续加载、晚响应使用 fixture；准确 ticker、键盘及主题尺寸 | [报告](symbol-search-report.json) |

所有部署回归均串行运行，使用独立临时工作区；finally 读取最新 revision 精确删除自身工作区，并核对其他工作区列表未变。指标专项恢复自身改动的收藏位。harness 使用真实许可库和合成行情，不计入 Docker 全栈 40 组。

日志：[指标](indicator.log)、[任务](task.log)、[详情](detail-panel.log)、[缩放](zoom.log)、[商品搜索](symbol-search.log)、[后端](backend.log)、[harness](native-harness.log)、[catalog](catalog.log)、[静态构建](static-build.log)。

构建遵循 `mw-docker build`，显式 task/project/purpose=acceptance，builder 为 `market-watch-ubuntu`：[chart](chart-build.log)、[API](api-build.log)、[web](web-build.log)。更新三个验收服务后重启 TLS，等待 API ready，再完成最终回归。运行服务见 [runtime.json](runtime.json)，镜像 ID 见 [verification.json](verification.json)。镜像包含本轮未提交源码，标签基础 commit 是 `d353c6e`、dirty=true；交付提交记录最终源码与证据，不能把基础 commit 当作本轮完整实现。

## 访问、启动和停止

验收：<https://192.168.7.232:19943/advanced-charts>，chart origin：<https://192.168.7.232:19944>。沿用原验收密码。工具栏“指标”进入原生分类窗口；“数据中心 → 任务与记录”进入新版任务页。未发布到 unraid。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
# 启动现有验收实例
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml restart tls'

# 停止，保留数据
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

指标和任务专项可在同一目录按顺序复验：

```sh
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu node web/tests/advanced-native-indicator-dialog.browser.cjs
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu node web/tests/chart-data-center-task-redesign.browser.cjs
```

本实例继续用于用户验收，未退役或清理。env、凭据、私钥、许可文件及浏览器完整状态不提交仓库。
