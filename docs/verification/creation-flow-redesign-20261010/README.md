# 添加自建行情流程与指标细节改版验收

2026-10-10 完成实现与验收。实例运行于 Ubuntu `quant-server` 本机 Docker，task/project 为 `mw-data-center-review-20261008`，独立网络、PG volume 和端口；验收实例保留。未部署到 unraid。

## 已交付行为

- 指标：打开及点击搜索框不再出现蓝色焦点矩形；保留键盘焦点提示。原生行内显示“内置 / Python · 主图 / 副图”，与指标名称垂直居中。原生列表、收藏、添加及参数窗口保持原行为。
- 添加自建行情：两步“选择品种 → 配置并创建”，成功后显示结果。选品复用实际原生商品搜索的搜索框、类别标签、表头来源 Select、结果行和滚动加载；仅提供 Dukascopy / OANDA Practice。合并重复选品入口，无底部分页，手工登记为次要入口。
- 配置：所选身份只读，缺失精度才要求输入；日线划分、交易日期、所需周期及更新方式集中配置，摘要实时更新。返回选择保留搜索、筛选、所选品种和配置草稿。M1 固定选择，其他周期使用原生 Checkbox；跨 React root 的事件值先捕获再更新，避免读取恢复后的旧值。
- 预检查只读取数据库与已缓存目录，不访问供应商、注册行情或启动实时采集。目录身份、来源精度、日期与日界检查由后端完成；日期错误关联到具体字段。缺省日界与显式日界使用同一换算规则。
- OANDA 未配置连接与目录待刷新分别说明；目录刷新由用户显式触发。配置存在不代表连接健康，目录可选不保证历史覆盖，实际下载和发布仍由后台验证。
- 重复创建：预检查提供管理已有行情入口；新界面提交 `create_only:true`，后端在 collection 行锁内阻止覆盖既有维护计划。旧调用默认 false，保持兼容。相同提交标识重放先返回原结果，未知网络结果先查本次记录再重试，保留原始提交内容。
- 创建成功可查看任务、管理行情、返回列表或继续添加；已有发布版本且周期可用才显示打开图表。关闭窗口后晚响应不会替换新页面。
- 删除工具栏自定义“创建告警”按钮。原有告警 bridge、菜单和上下文能力保持。
- 删除“来源与能力”页面、导航与任务页依赖链接。旧 `tab=sources` 地址归一到自建行情。任务配置异常改为就地处理说明；平台行情只对实际支持的来源提供添加自建入口。
- 空结果时原生搜索保留的上一批节点被裁剪，仅保留表头；适配器将这些行操作禁用并从 Tab 顺序移除，避免隐藏行可操作。

原生 UI 接入仍固定许可库版本 `6b804c486857f27920cf761aa7eb6e29d9bb6362`。复用 `SymbolSearchItemsDialog`、`DialogSearch`、`InputControl`、`Checkbox`、`Select` 及既有原生设置窗口容器；日期为浏览器日期输入。创建步骤、摘要与结果是业务组件。未复制或修改许可文件；内部接口升级需要重新适配。

## 验证结果及边界

| 检查 | 通过 | 证据与范围 |
| --- | ---: | --- |
| 后端 | 35 项 | [日志](backend.log)：目录、预检查、日界、事务回滚、幂等、维护、task-feed；SQLite 单元环境 |
| PostgreSQL | 2 项 | [日志](postgres.log)：真实 Ubuntu PG 独立随机 schema，预检查及幂等重放、并行不同请求只提交一份计划；finally 删除自身 schema |
| 添加行情 | 10 组 | [报告](creation-report.json)：部署原生选品、真实目录和预检查、日期字段、M1、周期、已有身份阻止、重复点击、未知结果、成功、继续添加、125 行续读、草稿返回、深浅主题及 1440/768/375px、晚响应 |
| 原生指标 | 11 组 | [报告](indicator-report.json)：无蓝色框、行内元信息对齐、收藏持久化、键盘、添加、保存恢复、多图、详情及兼容路径 |
| 任务记录 | 10 组 | [报告](task-report.json)：真实 task-feed、受控任务状态/控制、说明替换、续读、原位更新、管理返回、深浅主题和小屏 |
| 商品搜索 | 8 组 | [报告](symbol-search-report.json)：实际原生控件、来源/行情类型、准确 ticker、键盘、续读和晚响应、主题尺寸 |
| 平台操作 | 4 组 | [报告](platform-actions-report.json)：配置返回、创建预填和原始平台筛选返回、目标图格保护、完整兼容搜索 |
| 实际浏览器 200% | 3 组 | [报告](zoom-report.json)：Chrome `tabs.setZoom(2)`，物理 1024/1440/1920px；创建选品和配置操作、其他列表、指标详情均可达且无横向溢出 |

浏览器均访问部署后的 Ubuntu Docker 资源。各套件串行运行，需改动工作区的套件只创建并精确删除自身临时工作区，指标套件恢复原收藏位。浏览器创建 POST、故障、125 行目录、任务状态和控制使用受控 fixture，未创建真实供应商下载任务或控制现有任务；真实提交事务与并发由后端和 PG 测试覆盖。组合行数在缩放套件中为布局 fixture。

平台操作报告单独记录两次页面导航阶段的许可库 `restricted-toolset.componentWillUnmount: Value is null`，发生在初始化/刷新旧图表销毁阶段；稳定 ready 后四组交互无异常。其他部署专项报告交互异常为空。未将该导航异常描述为本轮已修复。

相关 Ruff、JS 语法、TypeScript/Vite（Docker web 构建）及 `git diff --check` 通过。构建通过 `mw-docker build`，显式 task/project/purpose=acceptance，builder 为 `market-watch-ubuntu`。web 必须显式传 `VITE_ADVANCED_CHART_ORIGIN=https://192.168.7.232:19944`。

运行服务：[runtime.json](runtime.json)，最终镜像：[images.json](images.json)，API：[ready.json](ready.json)。所有应用容器实际 Image 与最终构建 ID 一致，包括四个后台 worker。镜像标签的基础 commit 是 `4359206` 且 dirty=true，源码及验收证据由本轮交付 commit 固定。

截图：[桌面配置](config-light-1440.png)、[暗色小屏配置](config-dark-375.png)、[暗色小屏选品](catalog-dark-375.png)、[创建结果](result-light-1440.png)、[行内指标信息](indicators-dark-1440.png)、[实际 200% 创建配置](browser-zoom200-create-config-1024.png)。

## 访问、启动与停止

验收地址：<https://192.168.7.232:19943/advanced-charts>，chart origin：<https://192.168.7.232:19944>。沿用原验收密码。数据中心 → 自建行情 → 添加行情进入新版。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
# 启动现有验收实例；等待结束后再访问
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml restart tls'
curl -ksS --fail https://192.168.7.232:19943/readyz

# 停止并保留数据
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

实例仍供用户验收，未退役、删除资源或完成 Docker 生命周期 task。私有 env、凭据、TLS 私钥、许可资源及浏览器完整状态均未提交仓库。
