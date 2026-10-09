# 商品代码搜索双下拉框验收

2026-10-09，Ubuntu `quant-server` 本机隔离 Docker，task/project `mw-data-center-review-20261008`。只经 `mw-docker` 与专用 `market-watch-ubuntu` builder 构建更新本项目 chart origin；API、数据库结构及生产环境未改动。

商品代码搜索表头右侧采用与平台行情相同的原生 `Select`。第一个默认为“全部行情”，选项为全部行情／平台行情／自建行情／组合行情；第二个默认为“全部来源”，支持 Dukascopy、OANDA、Binance、Yahoo。重新打开恢复这两个默认值，原生资产类别标签保留其现有偏好。类型、来源、类别、关键词共同交给现有服务端搜索，不在前端过滤结果。

保留实际原生 AdaptivePopupDialog、DialogSearch、类别标签、结果行和提交／关闭流程。在已适配版本的惰性搜索模块开窗边界添加包装器，通过 SearchContext 隔离两个筛选状态，以 React portal 将 Select 放入原生表头。只存放宿主适配代码，不复制或提交许可源码。资源加载失败使用原商品搜索；自建映射的来源目录选择器，以及带自定义 renderer 的比较／自选表窗口保留各自业务逻辑。

切换筛选即时清除旧结果并取消旧请求，加载或空结果时仍显示表头筛选，重复选择当前值保持结果；回焦、Enter、上下箭头、Tab／Shift+Tab、Escape 经实际浏览器检查。全部行情继续用游标；单类搜索按服务端 next_offset 翻页，缓存按类型／来源／类别／关键词／工作区隔离。图表身份和打开动作继续由原生控制器负责。暗亮主题，1440／768／375 px 桌面响应式布局通过；实际触屏会话保持原有只读与无数据中心入口行为。

部署资源共 **6 套件、42 组浏览器检查通过**，未使用 `LOCAL` 资源替换。另有 **7 项桥接回归**通过。

- [双下拉专项 8 组](report.json)：首次打开默认值、重复选择当前值、三类实际行情与来源组合、原生资产类别／空结果、下拉及弹窗键盘焦点、准确固定历史 ticker 的键盘提交、125 行 offset 加载、全部类型游标复位、延迟旧请求不能覆盖新结果、暗亮与 375 px 布局。只在长列表及延迟请求检查注入局部 fixture，真实品种和选中加载使用实际 API。
- [套件汇总](suites.json)：商品搜索 8、原生整合 7、平台行情 11、兼容性 5、比较／自选表／指标与映射联动 7、请求生命周期及触屏只读 4。
- [桥接回归](bridge-test.log)、[运行服务](runtime.json)。JavaScript 语法与 `git diff --check` 通过。
- 商品搜索与生命周期检查各使用本轮独立工作区，finally 按 id 与当前 revision 精确删除，并核对其他工作区保持。原生整合工作区也已按报告记录精确删除；实例、卷和其他任务资源保留。

验证边界：兼容性首轮在重载时出现一次资源请求失败，完整重跑通过。此前存档工作区的原生重建在启动期会出现 `Value is null`，原构建也可复现；本轮商品搜索与生命周期交互检查使用独立工作区，并在初始图表与请求队列就绪后开始捕获异常，检查期间异常为空。本改动没有修改存档恢复流程。生命周期旧断言在启动请求尚未排空时只能占到 3 个请求槽，已将测试前置条件改为等待真实队列排空，再验证 4 路占满场景。

截图：[默认全部行情／全部来源](all-light-1440.png)、[375 px 亮色](filters-light-375.png)、[375 px 暗色](filters-dark-375.png)。

验收地址：<https://192.168.7.232:19943/advanced-charts>；chart origin：<https://192.168.7.232:19944>。沿用原验收密码，刷新页面后打开汉堡菜单右侧的商品搜索。实例仍保留验收，未退役。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 启停：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml restart tls'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

本机复验（需要私有许可资源、登录文件及 Chromium）：

```sh
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
node web/tests/chart-symbol-search-filters.browser.cjs
```

凭据、env、私钥及许可资源未提交仓库。
