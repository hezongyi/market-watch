# Ubuntu 网页逐屏视觉验收

结论：本轮桌面和窄屏 UI 达到验收预期，目视效果可以收口。共70张最终截图，逐屏查看并核对布局、文字、入口、主题一致性与底部可达性；发现的两项视觉缺陷已实际修复、重建、部署与重拍。

[截图索引](index.html) · [完整截图与逐屏记录](capture.json) · [当前实例](../runtime.json)

实际环境为 Ubuntu quant-server，本机 Docker 独立 project `mw-pro-charts-20261011`。真实网页、API、PostgreSQL、worker和许可图表引擎运行；供源I/O为本任务合成fixture。规律K线尖峰、重复AUDUSD进度数据集及“确认尾部恢复中”是验收数据/状态，不证明供应商行情可用性。

浏览器登录后采集：桌面1600×1000、桌面指针窄屏768/375×800；手机375×812及915×412为Chromium触摸模拟。Android/iOS实机尚未验收，由用户负责后续验收，不作为本轮开发硬性阻塞。目视审查覆盖全部最终截图的对照板，并放大查看告警、详情、弹窗、日历、三个下拉框、任务进度与窄屏内容；本报告不是全站WCAG认证。

## 实际发现与修复

| 项目 | 修复前 | 修复后与证据 |
| --- | --- | --- |
| VA1 告警元信息被截断 | 状态超出19–60px，日志时间超出22px；[旧状态](before-dark-03-alert-sidebar.png)、[旧日志](before-light-04-alert-log.png) | 长身份缩短并显示省略号，状态和时间保留完整；到期信息允许另起一行。两主题最大溢出0px；[最终状态](light-03-alert-sidebar.png)、[最终日志](light-04-alert-log.png)、[失败证据](../alert-subtitle-red.json)、[通过证据](../browser-alert-subtitle.json) |
| VA2 浅色状态文字偏淡 | 对比度2.34–2.44:1；[旧颜色](before-contrast-light-03-alert-sidebar.png) | 浅色使用深绿/赭色，实测最低5.003:1；深色最低6.819:1。[失败证据](../alert-subtitle-contrast-red.json)、[通过证据](../browser-alert-subtitle.json) |

改动仅在 `web/src/advanced/ChartAlertsPanel.tsx` 和 `chart-alerts.css`，随后通过 `sg docker`、带task/project/purpose的 `mw-docker build` 重建chart与web，使用 `market-watch-ubuntu` builder部署本任务实例。价格告警回归和展示回归通过；新增截断/对比度专项4组检查通过。当前20份浏览器报告共119组检查均通过、错误列表为空。

展示回归首次出现浏览器请求队列拥挤，日历页面未加载；[原记录](../presentation-visual-rerun-rate-limit.json)保留。单独重跑及追加诊断重跑均通过，未据此声称原有队列问题已被CSS修复。之前采集脚本的错误分区路径、按钮标签、窄屏分类控件与加载等待时机均已纠正；旧attempt报告仅作过程记录，不作为最终视觉通过证据。

## 逐屏结论

| 截图 | 合同 | 目视结论 |
| --- | --- | --- |
| [深色 · 五图工作区](dark-01-five-charts.png) | F1/U6 | 五格均有K线、周期与价格轴，图格边界清楚。W1只有任务历史范围内的少量周线；规律尖峰来自合成数据。 |
| [浅色 · 五图工作区](light-01-five-charts.png) | F1/U6 | 五格均有K线、周期与价格轴，图格边界清楚。W1只有任务历史范围内的少量周线；规律尖峰来自合成数据。 |
| [深色 · 品种详情](dark-02-symbol-details.png) | U3/U4 | 观察清单与详情分区稳定，来源行情观察时间独立成行，未核实时段明确标注。 |
| [浅色 · 品种详情](light-02-symbol-details.png) | U3/U4 | 观察清单与详情分区稳定，来源行情观察时间独立成行，未核实时段明确标注。 |
| [深色 · 告警侧栏](dark-03-alert-sidebar.png) | F3/U2/U8 | 修复后状态完整可见，长来源说明有省略号；浅色状态文字对比度至少5.0:1，名称和来源可读。 |
| [浅色 · 告警侧栏](light-03-alert-sidebar.png) | F3/U2/U8 | 修复后状态完整可见，长来源说明有省略号；浅色状态文字对比度至少5.0:1，名称和来源可读。 |
| [深色 · 告警展开](dark-03-alert-expanded.png) | F3/U8 | 条件、18位人工阈值、来源、周期、次数及健康原因可展开读取，布局没有重叠。 |
| [浅色 · 告警展开](light-03-alert-expanded.png) | F3/U8 | 条件、18位人工阈值、来源、周期、次数及健康原因可展开读取，布局没有重叠。 |
| [深色 · 告警日志](dark-04-alert-log.png) | F3/U8 | 日期分组清楚，修复后时分秒完整可见，长来源说明使用省略号。 |
| [浅色 · 告警日志](light-04-alert-log.png) | F3/U8 | 日期分组清楚，修复后时分秒完整可见，长来源说明使用省略号。 |
| [深色 · 事件展开](dark-04-alert-log-expanded.png) | F3/U8 | 事件与检测时间、精确值和通知状态完整显示；长小数正常换行，操作按钮可见。 |
| [浅色 · 事件展开](light-04-alert-log-expanded.png) | F3/U8 | 事件与检测时间、精确值和通知状态完整显示；长小数正常换行，操作按钮可见。 |
| [深色 · 价格右键菜单](dark-05-price-menu.png) | F3/U8 | 创建告警与复制价格采用当前图格精度，菜单文字可读，原生菜单层级一致。 |
| [浅色 · 价格右键菜单](light-05-price-menu.png) | F3/U8 | 创建告警与复制价格采用当前图格精度，菜单文字可读，原生菜单层级一致。 |
| [深色 · 价格告警弹窗](dark-06-price-alert-dialog.png) | F3/U8 | 标题采用可读品种、来源、basis与周期，比较值焦点明显，取消和创建按钮完整显示。截图只保留草稿。 |
| [浅色 · 价格告警弹窗](light-06-price-alert-dialog.png) | F3/U8 | 标题采用可读品种、来源、basis与周期，比较值焦点明显，取消和创建按钮完整显示。截图只保留草稿。 |
| [深色 · 八个Python指标](dark-07-python-indicators.png) | F6/U5 | 八行指标、收藏星标、主副图标记与详情入口完整，Python分类选中状态清楚。 |
| [浅色 · 八个Python指标](light-07-python-indicators.png) | F6/U5 | 八行指标、收藏星标、主副图标记与详情入口完整，Python分类选中状态清楚。 |
| [深色 · MACD指标详情](dark-08-python-indicator-detail.png) | F6/U5 | 右侧用途、计算说明、默认输入与添加操作可读；列表选中状态和返回入口清楚。 |
| [浅色 · MACD指标详情](light-08-python-indicator-detail.png) | F6/U5 | 右侧用途、计算说明、默认输入与添加操作可读；列表选中状态和返回入口清楚。 |
| [深色 · 绘图九周期](dark-09-drawing-nine-periods.png) | U7 | M1/M5/M15/M30/H1/H4/D1/W1/MN九项均完整显示，选中状态及取消、确认可区分。 |
| [浅色 · 绘图九周期](light-09-drawing-nine-periods.png) | U7 | M1/M5/M15/M30/H1/H4/D1/W1/MN九项均完整显示，选中状态及取消、确认可区分。 |
| [深色 · 交易日历列表](dark-10-center-calendar.png) | F4/F5/U1/U5/DC1 | 搜索、来源筛选、核实状态、版本与核实日期排列清楚，同代码的适用身份另行展示。 |
| [浅色 · 交易日历列表](light-10-center-calendar.png) | F4/F5/U1/U5/DC1 | 搜索、来源筛选、核实状态、版本与核实日期排列清楚，同代码的适用身份另行展示。 |
| [深色 · 展开日历](dark-11-calendar-expanded.png) | F5/U1 | 适用范围、常规时段、官方时区、有效范围和核实依据可读，窗口底部提示独立固定。 |
| [浅色 · 展开日历](light-11-calendar-expanded.png) | F5/U1 | 适用范围、常规时段、官方时区、有效范围和核实依据可读，窗口底部提示独立固定。 |
| [深色 · 日历滚动到底部](dark-11-calendar-bottom.png) | U5 | 实际滚动后末行、身份说明与待核实数量可见，不被固定底部提示遮住。 |
| [浅色 · 日历滚动到底部](light-11-calendar-bottom.png) | U5 | 实际滚动后末行、身份说明与待核实数量可见，不被固定底部提示遮住。 |
| [深色 · 任务与记录](dark-10-center-tasks.png) | F4/F5/U1/U5/DC1 | 任务状态、周期发布进度、更新时间与操作列可读，分区提示对应任务列表。 |
| [浅色 · 任务与记录](light-10-center-tasks.png) | F4/F5/U1/U5/DC1 | 任务状态、周期发布进度、更新时间与操作列可读，分区提示对应任务列表。 |
| [深色 · 自建行情](dark-10-center-managed.png) | F4/F5/U1/U5/DC1 | 来源、日界、可用范围、维护状态与操作列对齐；多个AUDUSD为本任务独立进度fixture。 |
| [浅色 · 自建行情](light-10-center-managed.png) | F4/F5/U1/U5/DC1 | 来源、日界、可用范围、维护状态与操作列对齐；多个AUDUSD为本任务独立进度fixture。 |
| [深色 · 来源状态](dark-10-center-sources.png) | F4/F5/U1/U5/DC1 | 无采集记录及无匹配历史记录的实际状态明确显示，状态API可读不冒充供应商已连通。 |
| [浅色 · 来源状态](light-10-center-sources.png) | F4/F5/U1/U5/DC1 | 无采集记录及无匹配历史记录的实际状态明确显示，状态API可读不冒充供应商已连通。 |
| [深色 · 组合行情](dark-10-center-composite.png) | F4/F5/U1/U5/DC1 | 来源接续、日界、确认尾部恢复中及操作入口可读；这个fixture状态不记为真实实时供源成功。 |
| [浅色 · 组合行情](light-10-center-composite.png) | F4/F5/U1/U5/DC1 | 来源接续、日界、确认尾部恢复中及操作入口可读；这个fixture状态不记为真实实时供源成功。 |
| [深色 · 平台行情](dark-10-center-platform.png) | F4/F5/U1/U5/DC1 | 原生分类、搜索、来源筛选、打开图表与详情入口一致，打开前同步开关说明可见。 |
| [浅色 · 平台行情](light-10-center-platform.png) | F4/F5/U1/U5/DC1 | 原生分类、搜索、来源筛选、打开图表与详情入口一致，打开前同步开关说明可见。 |
| [深色 · 新历史基线下拉框](dark-12-baseline-dropdown.png) | DC1 | 展开列表有占位与真实固定M1版本，日界、历史范围及版本短ID可区分，焦点框明确。 |
| [浅色 · 新历史基线下拉框](light-12-baseline-dropdown.png) | DC1 | 展开列表有占位与真实固定M1版本，日界、历史范围及版本短ID可区分，焦点框明确。 |
| [深色 · 实时映射版本下拉框](dark-13-mapping-dropdown.png) | DC1 | OANDA Practice、目标品种和映射短ID可读，展开层显示在表单前方。 |
| [浅色 · 实时映射版本下拉框](light-13-mapping-dropdown.png) | DC1 | OANDA Practice、目标品种和映射短ID可读，展开层显示在表单前方。 |
| [深色 · 目标准确品种下拉框](dark-14-target-dropdown.png) | DC1 | 账户环境标签明确，真实API返回的目标代码、描述与类别可读，焦点及占位状态清楚。 |
| [浅色 · 目标准确品种下拉框](light-14-target-dropdown.png) | DC1 | 账户环境标签明确，真实API返回的目标代码、描述与类别可读，焦点及占位状态清楚。 |
| [深色 · 真实派生任务详情](dark-15-task-progress.png) | F4 | 24,002累计观测、两周期进度、近期速度ETA及等待状态可读，界面没有假装任务已经完成。 |
| [浅色 · 真实派生任务详情](light-15-task-progress.png) | F4 | 24,002累计观测、两周期进度、近期速度ETA及等待状态可读，界面没有假装任务已经完成。 |
| [深色 · 任务详情底部](dark-15-task-bottom.png) | F4/U5 | 详情实际滚动后时间记录、任务操作与身份完整可见，固定标题和底部提示没有遮住末尾。 |
| [浅色 · 任务详情底部](light-15-task-bottom.png) | F4/U5 | 详情实际滚动后时间记录、任务操作与身份完整可见，固定标题和底部提示没有遮住末尾。 |
| [深色 · 768px日历展开](dark-16-calendar-768.png) | F5/U1/U5 | 左侧分区保留，搜索和详情自然换行；官方链接在内容区滚动。 |
| [浅色 · 768px日历展开](light-16-calendar-768.png) | F5/U1/U5 | 左侧分区保留，搜索和详情自然换行；官方链接在内容区滚动。 |
| [深色 · 768px日历底部](dark-16-calendar-bottom-768.png) | U5 | 最后一条规则、待核实数量与时区说明可见，没有横向截断。 |
| [浅色 · 768px日历底部](light-16-calendar-bottom-768.png) | U5 | 最后一条规则、待核实数量与时区说明可见，没有横向截断。 |
| [深色 · 768px平台列表](dark-17-platform-768.png) | U5/DC1 | 分类、来源筛选及商品行收紧到窗口宽度，图表和详情按钮保留。 |
| [浅色 · 768px平台列表](light-17-platform-768.png) | U5/DC1 | 分类、来源筛选及商品行收紧到窗口宽度，图表和详情按钮保留。 |
| [深色 · 768px指标列表](dark-18-indicators-768.png) | F6/U5 | 分类和八行Python指标同时显示，来源、主副图及详情入口无重叠。 |
| [浅色 · 768px指标列表](light-18-indicators-768.png) | F6/U5 | 分类和八行Python指标同时显示，来源、主副图及详情入口无重叠。 |
| [深色 · 768px指标详情](dark-19-indicator-detail-768.png) | F6/U5 | 详情切为完整内容面板，说明、参数、返回列表和添加入口清楚。 |
| [浅色 · 768px指标详情](light-19-indicator-detail-768.png) | F6/U5 | 详情切为完整内容面板，说明、参数、返回列表和添加入口清楚。 |
| [深色 · 375px日历展开](dark-16-calendar-375.png) | F5/U1/U5 | 六分区导航换为两行，字段改为单列，文字自然换行，底部提示稳定。此为桌面指针窄屏。 |
| [浅色 · 375px日历展开](light-16-calendar-375.png) | F5/U1/U5 | 六分区导航换为两行，字段改为单列，文字自然换行，底部提示稳定。此为桌面指针窄屏。 |
| [深色 · 375px日历底部](dark-16-calendar-bottom-375.png) | U5 | 长适用身份和时区文字换行，最后规则和统计可滚动读取。此为桌面指针窄屏。 |
| [浅色 · 375px日历底部](light-16-calendar-bottom-375.png) | U5 | 长适用身份和时区文字换行，最后规则和统计可滚动读取。此为桌面指针窄屏。 |
| [深色 · 375px平台列表](dark-17-platform-375.png) | U5/DC1 | 分类换行，商品、来源与打开/详情入口仍可读，列表没有水平溢出。此为桌面指针窄屏。 |
| [浅色 · 375px平台列表](light-17-platform-375.png) | U5/DC1 | 分类换行，商品、来源与打开/详情入口仍可读，列表没有水平溢出。此为桌面指针窄屏。 |
| [深色 · 375px指标列表](dark-18-indicators-375.png) | F6/U5 | 分类切换为原生下拉框，八行Python名称、主副图标记与详情入口全部可见。此为桌面指针窄屏。 |
| [浅色 · 375px指标列表](light-18-indicators-375.png) | F6/U5 | 分类切换为原生下拉框，八行Python名称、主副图标记与详情入口全部可见。此为桌面指针窄屏。 |
| [深色 · 375px指标详情](dark-19-indicator-detail-375.png) | F6/U5 | 用途和计算说明换行，三个输入、版本、添加与返回入口完整。此为桌面指针窄屏。 |
| [浅色 · 375px指标详情](light-19-indicator-detail-375.png) | F6/U5 | 用途和计算说明换行，三个输入、版本、添加与返回入口完整。此为桌面指针窄屏。 |
| [触摸模拟 · 手机竖屏模拟](mobile-readonly-375.png) | F7 | 只读说明与单图可见，编辑入口隐藏，价格轴与底部控件可读。Chromium触摸模拟，未证明实机效果。 |
| [触摸模拟 · 手机横屏模拟](mobile-readonly-915.png) | F7 | 只读说明、单图、时间轴和底部控件完整，价格轴可读。Chromium触摸模拟，未证明实机效果。 |

## 访问、复跑与保留

Ubuntu本机入口 <http://localhost:19997/advanced-charts>；图表iframe使用 <http://localhost:19998/>。端口绑定Ubuntu的127.0.0.1；其他机器访问需转发19997及19998，这不是unraid实例。登录凭据在任务私有目录，不进入截图记录或仓库。

从实现树启动/停止：

```bash
sg docker -c 'docker compose -p mw-pro-charts-20261011 -f docs/verification/pro-charts-20261011/compose.yaml up -d --no-build --wait'
sg docker -c 'docker compose -p mw-pro-charts-20261011 -f docs/verification/pro-charts-20261011/compose.yaml stop'
```

复跑截图采集会新建本任务独立合成AUDUSD进度fixture，之后实际完成派生并保留数据与记录。尚未保存的临时浏览器图表变化不保存到server；截图不会创建告警或发送外部通知。采集脚本默认仍将目视结论记为pending，必须重新审视后更新。

```bash
LD_LIBRARY_PATH=/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  node web/tests/pro-charts-visual-capture.browser.cjs
LD_LIBRARY_PATH=/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  node web/tests/pro-charts-alert-subtitle.browser.cjs
```

七个服务与任务数据卷保留供用户继续验收；Docker生命周期任务保持active，不finish/retire。未操作unraid，未生产发布。截至本轮截图验收核对时未commit/push/PR；后续提交与PR状态以Git记录为准。
