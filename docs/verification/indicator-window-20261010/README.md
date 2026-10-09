# 指标窗口改版与最终回归

2026-10-09 完成实现及部署验收；2026-10-10（Asia/Singapore）核对所有最终报告并收口。运行环境为 Ubuntu `quant-server` 本机隔离 Docker，task/project：`mw-data-center-review-20261008`。实例保留供用户验收。

## 最终界面与行为

- 使用原生 `AdaptivePopupDialog` 外壳和 `DialogSearch` 搜索框，标题为图标＋指标，保留已修改的工具栏指标图标。
- 整行搜索下方使用分类标签：全部、内置指标、我的 Python、收藏、当前图表已添加。连续列表显示名称、原名／缩写、来源、主副图以及详情／添加操作。
- 取消行内三角展开；点击名称或详情打开右侧面板，展示用途、计算、输入、版本及添加按钮。表头随详情面板调整，当前行高亮。
- 内容宽度不足 850px 时，详情覆盖列表内容区；列表暂设 inert，Tab 保持在详情中。返回或首次 Escape 恢复列表与焦点，继续保留查询和滚动；再次 Escape 关闭指标窗口。
- 当前图表已添加列表保留每个实例的设置、显隐和移除；添加后可直接打开原生参数设置，关闭后返回原查询。收藏仍使用原生窗口及原有存储，关闭后回到当前分类。
- 同一指标的添加请求未完成时禁用重复提交，完成后允许有意重复添加。点击时捕获当前图格，异步完成不转移至后来切换的图格。指标名称、实例 ID、参数和原生保存／恢复方式保持兼容。

原生组件通过数据中心共用的加载适配器复用；业务列表和详情由应用实现，没有修改或复制许可库。内置指标输入缺少可靠默认值时显示“添加后设置”，Python 默认值读取 catalog.params。原生资源或版本不匹配时使用完整兼容窗口，恢复资源后可回到原生路径。

截图：[桌面列表](list-light-1440.png)、[亮色详情](details-light-1440.png)、[暗色详情](details-dark-1440.png)、[375px 列表](list-dark-375.png)、[375px 详情](details-dark-375.png)、[实际 200% 缩放](indicators-zoom200-1024.png)。

## 最终检查结果

**5 套件、43 组检查通过，另有 catalog/search 单元回归通过。** JavaScript 语法及 `git diff --check` 通过。报告中的交互异常均为空。

| 套件 | 组数 | 验证范围与数据边界 | 报告 |
| --- | ---: | --- | --- |
| 部署后的指标专项 | 10 | 实际部署资源及真实 API；冷启动原生壳／搜索、详情、内置与 Python 添加、参数返回、显隐移除、收藏、多图、保存恢复、深浅主题、1440／768／375px、兼容路径；延迟添加使用受控测试 | [报告](indicator-report.json) |
| 部署后的数据中心详情 | 8 | 真实列表；覆盖证据及错误使用受控 fixture；详情切换、滚动、管理入口、所有详情类型、主题尺寸、键盘与兼容路径 | [报告](data-center-report.json) |
| 部署后的商品代码搜索 | 8 | 真实原生窗口及双 Select、真实平台／自建／组合筛选；分页和延迟响应使用受控 fixture；键盘、准确 ticker、主题尺寸 | [报告](symbol-search-report.json) |
| 实际浏览器 200% 缩放 | 3 | Chrome tabs.setZoom；物理 1024／1440／1920px；数据中心和指标详情均可访问，无横向溢出；组合行数使用布局 fixture | [报告](zoom-report.json) |
| 真实原生库交互 harness | 14 | 真实 v31 原生库、拦截静态资源、合成蜡烛；添加、十字线数值、设置返回、实例操作、多图、原生保存恢复；此套件不作为 Docker 全栈验收 | [报告](native-library-report.json) |

部署后的四套件共 **29 组**，均在最后一次表头对齐与当前行高亮修正构建部署后运行，未启用 LOCAL 替换；另 14 组 harness 在最终源码上通过。四套部署回归均仅创建独立临时工作区，finally 读取最新 revision 精确删除自身工作区，并核对其他工作区列表未变。未删除用户历史或启动新的行情维护。

日志：[指标](indicator.log)、[数据中心](data-center.log)、[商品搜索](symbol-search.log)、[缩放](zoom.log)、[catalog/search](catalog.log)。部署证据：[合法构建入口日志](build.log)、[最终运行服务](runtime.json)。构建使用 `mw-docker build`，显式 task/project/purpose=acceptance，builder 为 `market-watch-ubuntu`；最终 chart 镜像部署后重启 TLS，并完成上述回归。镜像构建时包含未提交工作树，标签中的基础 commit 为 f26b107、dirty=true；交付提交记录最终源码及验收证据。

## 验收访问与启停

验收地址：<https://192.168.7.232:19943/advanced-charts>；chart origin：<https://192.168.7.232:19944>。沿用原验收登录密码。点击工具栏“指标”打开新版窗口。未发布到 unraid 生产环境。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 运行：

```sh
# 启动现有验收实例
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml restart tls'

# 停止现有验收实例，保留数据
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

专项复验：

```sh
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
node web/tests/advanced-indicator-redesign.browser.cjs
```

此实例仍用于整体验收，未退役、未回收镜像或数据卷。凭据、env、私钥、许可库及浏览器状态不提交仓库。
