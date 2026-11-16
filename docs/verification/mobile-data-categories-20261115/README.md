# 数据页分类导航与下拉刷新

2026-11-15。工作树 `market-watch-managed-live-rollover-20261113`，分支 `feat/managed-live-rollover-20261113`，HEAD `17af8e2533eb8ffd4b152135223f51aaa164ecef`。保留此前未提交实现。本轮风险 F0：增加兼容的只读查询参数、手机端分类/分页/刷新状态，无 schema、保存身份、维护任务或实时接续策略变更；完成 Ubuntu R1 与浏览器全流程检查。

## 行为

- 标题下复用 shadcn/Base UI 的线形 Tabs。只展示完整自建范围内实际存在的类别，横向滚动；无统计数字、彩色底块或新增管理入口。
- 分类为全部、外汇、贵金属、A股、美股、港股、加密、指数、期货、ETF、基金、其他股票、商品、债券、期权、其他。未存在的分类不展示。A股合并深A/沪A/北A，行内仍保留准确标签；股指与指数放同一导航页，行内保留原标识；ETF/基金不归进股票。
- 分类依据与行内标识相同的真实目录/保存身份元数据，在分页和排名前完成，不能只筛首屏 25 条。全局类别不受来源和“需要处理”等筛选影响；查看已归档时使用已归档范围。
- 类别内每次读取 25 条，上滑自动加载，保留可访问的加载/重试按钮；取消原列表的上一页/下一页。每个类别/筛选组合保留已加载范围与会话内滚动位置，导航返回保留位置；重开应用恢复本机上次分类与该类别已缓存内容。
- 来源/状态筛选叠加在当前类别上；叉号清除这些筛选，保留类别。搜索继续负责添加自建，创建/定位后转“全部”并定位对象。
- 列表在顶部下拉时出现“下拉刷新 / 松开刷新 / 正在刷新”，复用自选已有手势与动效。刷新保留当前类别、筛选和已有内容，按已加载范围整体更新，完成或失败后立即收回提示。失败原位显示，旧内容保留；短拉、横向滑动、非顶部拖动不触发。
- 切分类、离开页面或进入后台会取消旧读取并收回刷新提示，迟到结果不能覆盖新类别。系统断网立即禁用下拉和分页，恢复后重新读取。实时开关的提交锁、丢失响应核查及新鲜读取版本控制继续保留。
- 已认可的列表两行身份和大号实时开关保留。滚动区给开关扩展触摸范围留出空间，375px/150% 字号不会出现横向滚动。

## 实现与兼容性

- `backend/alerts/dataset_summaries.py`：可选 `category` 和 `include_categories`，只为选择分类或请求分类栏的调用增加目录分组读取。分类只批量读取自建元数据，不读取全目录历史产物；每页原有摘要仍有界读取。
- `backend/alerts/history_api.py`：将可选参数传给摘要查询。未传参时保持旧响应形态，不增加 `categories`；网页端获取策略保持原状。
- `web/src/mobile/useManagedList.ts`：类别/筛选隔离缓存、取消、完整已加载范围刷新、自动分页、离线只读快照和命令后读取版本。
- `web/src/mobile/DataManagedPage.tsx` / `data-controls.css`：分类导航、滚动容器、刷新动效与生命周期；布局样式限定数据页。
- [最终文件指纹](source-hashes.json)。任务开始的来源副本位于本机 `/tmp/mw-data-categories-baseline/`，用于区分本轮与分支此前实现。

## 验证结果

- 完整 Docker Web 构建通过，包含 TypeScript、Vite、手机壳与专业图表资源：[最终构建](logs/build-web-r6.log)。API 构建：[日志](logs/build-api-r1.log)。无新增 UI 依赖。
- 后端摘要、统一标识和新增分类合同：**42 passed**，[日志](logs/backend-final.log)。覆盖 28 个外汇在其他品种之后的完整分页、排名、来源叠加、全局类别、定位/批量成员约束、A股三市场、美国/香港、ETF与基金、归档以及默认网页响应兼容。
- 实际 Ubuntu PostgreSQL 独立临时 schema：**3 passed**，[日志](logs/postgres.log)。测试没有修改验收实例的业务数据。
- 分类与刷新专项：**10 组检查、19 张截图**，[结果](browser-final/proof.json)、[日志](logs/browser-final.log)。覆盖 56 条外汇自动加载三页、去重、类别/导航位置保留、重开恢复、来源叠加与清除、失败保留/恢复、刷新中切类别、横向多分类、断网和字体主题矩阵。通过 Chromium 输入通道实际分步发送 touchStart/touchMove/touchEnd，核对“松开刷新”和松手请求；其他阈值/方向场景使用显式 TouchEvent。
- 原数据全流程：**17 组检查、56 张截图**，[结果](workflow-final/proof.json)、[日志](logs/workflow-final.log)。创建、丢失响应防重、维护冲突、直接实时开关、失败回退、核对来源、归档/恢复、版本/图表身份、嵌套返回、脏表单、缩小视口及离线写保护通过。所有写操作均发生于显式 HTTP 夹具。
- 375/412px、深浅主题、14/21px 字号的最终截图均已检查。首轮修正 Tabs 的页面作用域布局；后续修正开关触摸区域带来的内部横向滚动，再验证多分类和大字号。
- 实际 Ubuntu 实例：**25 张只读截图**，[结果](runtime-proof.json)、[日志](logs/runtime.log)。11 个现有自建品种完整分入外汇2、贵金属1、A股4、美股1、港股1、加密2；所有类别并集等于全列表，类别间无重复。实际列表、六类切换、筛选、下拉中/完成及字体主题矩阵通过；无页面错误、API 5xx 或行情配置写入，`readyz` 200。
- 真实检查复现脚本：[runtime-check.cjs](runtime-check.cjs)，从现有任务的私有凭据文件读取登录信息，登录后拦截所有非 GET 请求。未将凭据写入仓库。实际列表中的实时认证异常按后台原状态展示，本轮不修供源认证。
- `git diff --check` 通过。本轮未改自选主体、sparkline、专业图表拉取策略、告警或后台维护/轮换机制。未运行远程 CI、更新 PR、提交、合并、打正式 tag 或操作 Unraid。

[真实全部列表](runtime/all-light-375-14.png) · [真实外汇大字号](runtime/forex-light-375-21.png) · [真实A股](runtime/category-a-stock.png) · [实际刷新动效状态](runtime/pull-refresh.png) · [完成收回](runtime/pull-settled.png)

## 本地检查命令

从仓库根目录：

```bash
PYTHONPATH=backend python -m pytest backend/tests/test_dataset_summaries.py backend/tests/test_mobile_data_categories.py backend/tests/test_mobile_identity.py -q
```

PostgreSQL 检查从任务私有 `test-env.json` 读取 `TEST_POSTGRES_URL`，运行 `backend/tests/test_mobile_data_categories_postgres.py`；不要在终端打印连接串。

在 `web/` 下，先使用完整 Docker Web 产物填充 `dist/`，再运行：

```bash
MOBILE_DATA_CATEGORIES=1 MOBILE_DATA_OUTPUT=../docs/verification/mobile-data-categories-20261115/browser-final node tests/mobile-data-workflow.browser.cjs
MOBILE_DATA_OUTPUT=../docs/verification/mobile-data-categories-20261115/workflow-final node tests/mobile-data-workflow.browser.cjs
```

真实只读检查从仓库根目录运行：

```bash
node docs/verification/mobile-data-categories-20261115/runtime-check.cjs
```

浏览器触摸模拟与截图不替代 Android 真机的实际手感、系统字号和手势返回；这三项仍请用户在已安装 APK 中确认。

## 验收入口与回退

实际运行于 **Ubuntu 本机 Docker**，Compose project `mw-managed-live-rollover-20261113`。

**https://192.168.7.232:18447/m/data**。已安装 APK 连接同一实例时重新打开即可，**不需要安装新 APK**。

仅替换本项目的 `api` 与 `web`，其他服务、数据库、volume 及其他项目保持不变。固定镜像和旧镜像见 [deployment.json](deployment.json)。实际容器 image ID 已与记录核对。配置备份保留于任务私有目录的 `run.json.before-mobile-data-categories-<stamp>` 与 `compose.json.before-mobile-data-categories-<stamp>`。

启动/停止：

```bash
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh
/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh
```

回退时保留当前配置，将该任务 `run.json` / `compose.json` 的 `api` 与 `web` image 恢复成 `deployment.json` 的 `previous` 值，然后只对同一 project 执行 `up -d --no-build --no-deps api web`。无数据库迁移，不回退或删除数据卷。
