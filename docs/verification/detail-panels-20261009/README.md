# 数据中心统一详情面板验收

2026-10-09，Ubuntu `quant-server` 本机隔离 Docker，task/project `mw-data-center-review-20261008`。沿用进行中的验收实例，通过 `mw-docker` 和 `market-watch-ubuntu` builder 更新 web，保留实例供用户验收。

## 最终行为

自建行情、已建立组合、可建立候选取消行内三角展开，点击品种名或“查看详情”进入统一详情面板。自建列表直接显示来源、日界、状态和可用历史，详情保留周期、未知区间、维护错误、下次维护、打开图表、管理与删除入口。组合保留接续基线、确认尾部、策略状态、打开与管理；候选保留准确来源、建立条件及维护／配置操作。当前行高亮，桌面右侧分栏可直接选择其他行。

覆盖与质量中的实际观测、未知、闭市依据、观测冲突四种展开，以及已保存映射、映射复核依据、修订固定输入、技术错误详情，都使用相同面板。平台行情原来的底部详情也统一至右侧。两个输入折叠“高级维护设置／价格精度”改为表单内直接显示，继续使用原生字段、校验及提交逻辑。规则创建／回测页面的 SeriesPicker 不属于数据中心，此次未调整。

详情位于当前原生弹窗内容区，没有新增原生弹窗或复制许可组件。共享业务组件沿用原生壳、主题 token、边界与按钮样式；原生搜索和 Select 保留。内容宽度不足 900px 时面板覆盖内容区，列表保持挂载、暂设 inert；返回或 Escape 恢复列表与焦点，保留搜索、分页前缀及滚动。关闭详情不会关闭数据中心，原生 Select 打开时优先由它处理 Escape。完整维护／删除页仍沿原导航和返回上下文，删除确认保护不变。

## 验证

最终 **5 套件、44 组检查通过**，页面交互异常为空；TypeScript、构建、JavaScript 语法和 `git diff --check` 通过。所有交付验收使用已部署资源，未启用 LOCAL 资源替换。

报告：[详情 8 组](details-report.json)、[自建／组合 13 组](management-report.json)、[删除 9 组](delete-report.json)、[平台 11 组](platform-report.json)、[实际缩放 3 组](zoom-report.json)。[构建日志](build.log)、[实际运行服务](runtime.json)。

截图：[桌面亮色](panel-light-1440.png)、[桌面暗色](panel-dark-1440.png)、[375px 亮色](panel-light-375.png)、[375px 暗色](panel-dark-375.png)、[实际 200% 缩放](panel-zoom200-1024.png)。

- 详情专项：真实列表、左右分栏、换行及位置、单面板切换、深列表滚动、完整管理入口、组合候选、所有区间／映射／修订／错误详情、直接显示高级字段、深浅主题、1440／768／375px、Tab／Shift+Tab、Escape 和回焦、版本不匹配兼容窗口。
- 自建／组合搜索回归：配置范围、连续加载、失败重试、取消读取、筛选、滚动恢复、精确 ticker、单行 loading 与候选防重复。
- 删除保护：真实只读入口与局部写入 fixture，归档前置、取消、复核 token、引用阻止、已回收、并发冲突、失败重试及返回上下文。
- 平台行情：真实 Yahoo／Binance 目录、原生筛选、165 行连续加载、失败重试、取消请求、主题和尺寸、单行 loading、立即关闭并显示加载失败。
- 实际浏览器 200% 缩放：物理 1024／1440／1920px，检查标题、搜索、打开、详情、关闭回焦和列表滚动。

早期复验遇到旧存档启动阶段原生 `Value is null`，前版本也已记录；交互检查完成，但未将含此初始化错误的报告称为通过。最终专项、平台、自建／组合和缩放采用独立临时工作区，初始化完成后记录交互异常；finally 使用当前 revision 精确删除自建测试工作区，并核对其他工作区列表未变。没有删除真实历史或启动新维护。

## 地址与启停

验收：<https://192.168.7.232:19943/advanced-charts>，chart origin：<https://192.168.7.232:19944>。沿用原验收登录密码。任务进行中，未退役或回收卷；凭据、env、私钥、许可库及浏览器状态不提交。

在 `/home/quant/repos/market-watch-data-center-impl-20261008`：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml restart tls'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

专项复验：

```sh
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
node web/tests/chart-data-center-detail-panels.browser.cjs
```
