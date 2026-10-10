# 平台行情原生搜索布局验收

2026-10-09，Ubuntu `quant-server` 本机隔离 Docker，task/project `mw-data-center-review-20261008`。本轮沿用仍供用户验收的独立实例，不操作 unraid 或生产。

## 结果与实现

“平台品种”改为“平台行情”，导航与配置返回文案同步。内容区最上方显示“平台行情”标题，其下整行原生搜索，再下一行实际原生圆角类别标签；来源筛选在结果表头右侧，每行右侧显示中文类别及来源。结果行保留“打开图表”和“详情”；原生周期、M1 历史、更新时间、配置原生参数及添加自建行情收进详情区。平台列表移除页码和翻页按钮，触底加载，每批 50 条；末尾提示全部加载，失败保留已有结果并可重试同一批。

复用固定 TT v31.1.0 的 `SymbolSearchItemsDialog`、`DialogSearch`、原生 round tabs、来源选择界面、`SymbolSearchDialogContentItem` 及滚动触底观察器。没有克隆或提交许可源码；没有打开第二个商品搜索窗口。独立 vendor React root 继续由 `NativeSlot` 挂载，`contentItem` 的原生操作插槽承载应用动作；HTTP、认证与图表应用仍由已有可信主应用 RPC/目标图格保护执行。

来源选择采用数据中心独立状态，类别使用独立设置键，不改主商品搜索筛选。查询变化取消旧读取，取消错误转换为 native renderer 识别的 `AbortError`；关闭后迟到结果无效。请求失败和空结果有独立反馈。已加载页数仅用于恢复列表前缀，不显示分页 UI；切页/管理返回保留查询、来源、类别和滚动位置。接受打开后立即关闭窗口，只有点击行显示打开反馈。

当前版本内部组件仍有版本边界：升级图表库必须重新验证；已有版本/资源失配的业务 iframe 兼容窗口保留，也使用连续列表。其他分区保留现有管理布局及分页。

## 验收

最终套件访问部署后的 Docker 镜像资源，未启用 `LOCAL` 替换。长列表、目录故障、变更提交使用局部 fixture；未删除已有历史或启动新来源维护任务。

专项覆盖：实际 Yahoo MSFT、Binance BTC/USDT；类别/来源联动；主商品搜索状态和图表身份不变；真实 Dukascopy 超过首批 50 条；165 行连续加载、失败保持结果、同页重试、末尾停止和唯一身份；筛选清空结果；旧读取取消/迟到返回；列表前缀与滚动恢复；详情维护入口与焦点返回；Tab/Shift+Tab/Escape；暗亮主题与 375/768/1440 宽度；单行加载、防重复及接受后立即关闭。

回归覆盖原生数据中心五分区、草稿保护、选择品种、目标图格失效、真实 Yahoo 图表重试、唯一 ticker 搜索、自选表/比较/指标输入、四行情请求占满时管理读取可用、实际触屏只读、版本/资源降级、配置提交和 Chrome `tabs.setZoom` 真实 200% 缩放。

最终 **8 套件、46 组检查通过**，补充 **4 组检查通过**，所有报告的页面异常均为空。补充覆盖 OANDA 参数配置返回、Dukascopy 添加自建行情的来源代码预填与取消返回、ArrowDown/Enter 的唯一 ticker 和目标保护、版本兼容窗口的真实 Yahoo 检索与输入焦点。最后只删除本轮 integration 报告记录的测试工作区，其他工作区保持；原验收工作区入口、平台页面、关闭回焦检查通过。

运行证据见 [套件汇总](final-suites.json)、[平台专项](platform-report.json)、[补充检查](supplement-report.json)、[清理与最后检查](cleanup-smoke-report.json) 和 [实际运行服务](runtime.json)。

截图：[桌面](platform-yahoo.png)、[暗色](platform-dark-1440.png)、[375 px 亮色](platform-light-375.png)、[实际 200% 缩放](browser-zoom200-platform-1024.png)。静态构建、JavaScript 语法与 `git diff --check` 同时验证；后端接口和数据库结构无变化。

## 运行与复验

验收网址：<https://192.168.7.232:19943/advanced-charts>；图表 origin：<https://192.168.7.232:19944>。密码沿用原验收密码，凭据、env、TLS 私钥和浏览器登录状态未提交。

chart/web 镜像通过 `mw-docker build --purpose acceptance`，明确 task/project，builder `market-watch-ubuntu`；仅重建本项目 web/chart-origin 并重启 TLS。实例继续保留供用户验收，未退役任务、删除数据卷或进行全局回收。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml restart tls'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

专项复验需要本机许可资源、私有验收登录文件和 Chromium：

```sh
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
node web/tests/chart-data-center-platform-search.browser.cjs

LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
node web/tests/chart-data-center-platform-actions.browser.cjs
```


## 页标题补充（2026-10-09）

按用户反馈恢复平台分区顶部的可见“平台行情”标题，与其他分区沿用相同字体并对齐搜索输入左侧。标题固定在结果滚动区域上方，提供明确的当前位置。矮视口下缩小标题、类别标签与底部提示的上下留白，保证 200% 缩放时打开图表仍可见。更新后的 Ubuntu Docker 镜像重新通过平台专项 11 组检查（包含标题在搜索框上方、暗亮主题与 375/768/1440 px 可见性）及实际 200% 缩放的 3 组检查，无页面异常。截图与平台/缩放报告同步更新；本次只重建并更新 web 服务。
