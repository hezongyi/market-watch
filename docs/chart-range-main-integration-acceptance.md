# 范围映射与柱宽同步：最新 main 集成验收

2026-10-06（Asia/Singapore）。新 worktree `/home/quant/repos/market-watch-range-main`、分支 `feat/range-sync-main-integration`；整合原 PR 提交 `80611cb` 与 `main` 的 `826d316`，合并提交 `96709e8`，当前源码提交 `fd4dcad`。v1.8.0 原 worktree 与验收实例保留，[原验收页](chart-range-v1.8.0-acceptance.md) 作为历史记录。

## 实现与兼容

布局菜单末尾“同步设置…”集中配置范围映射、颜色、透明度及高低价标签。深色默认白色透明，浅色默认灰色透明；高低价显示在图表时间轴下方的信息栏。窄屏且高低价在屏外时，完整价格数字独立保留，仅附加提示可省略，悬停 title 保留全文。

柱宽同步以实际接收可信用户横向缩放的图表为源：鼠标未激活图滚轮、原生按钮、快捷键等会带动其他就绪时间图；仅开启、切焦点或程序恢复不主动传播。柱宽与日期范围互斥。

构建保留最新 main 的指标选择器、MCP 绘图投影和图表告警，并加入范围/同步模块，共22个宿主模块。工作区保存同时保留 `_mwBarRangeMapping`、`_mwSync`、`_mwDrawingProjection` 和 `_mwAlertCharts`；异步捕获期间 epoch/editRevision 改变会拒绝写入。

## Ubuntu 隔离实例

实际运行于 Ubuntu 本机 `192.168.7.232` Docker，Compose project `mw-range-main-20261006`。应用：<https://192.168.7.232:16843/advanced-charts>；图表来源：<https://192.168.7.232:16844>；PG14仅绑定 `127.0.0.1:16832`。独立网络、volume与数据库 `range_main`。原 `16743/16744` 验收实例保留。

私有目录 `/home/quant/repos/.acceptance/range-main-20261006` 保存 Compose、env、TLS、登录信息与 MCP token，不提交。自签证书首次分别访问两个地址接受证书。通知worker只连接无宿主端口的内部验收sink，不转发真实通知。未在unraid创建开发或验收实例。

```bash
sg docker -c 'docker compose --env-file /home/quant/repos/.acceptance/range-main-20261006/compose.env -f /home/quant/repos/.acceptance/range-main-20261006/compose.yaml up -d'
sg docker -c 'docker compose --env-file /home/quant/repos/.acceptance/range-main-20261006/compose.env -f /home/quant/repos/.acceptance/range-main-20261006/compose.yaml stop'
```

## 自动验收

范围与同步最终候选2浏览器169项/14组通过，均绑定 `host.d0a96d61fcfcc340.js`，无页面异常。最终证据见 [汇总](verification/chart-bar-range-mapping/main-integration/summary.json)。此前 v1.8.0 的169项不计入本次；候选1历史记录不作为最终候选2结果。

真实HTTPS指标窗口首次20项通过；进一步跨实时新柱复验完成19项后，最终“无错误”断言失败，当前不计完整通过。该轮catch诊断的page作用域错误将failure消息覆盖为ReferenceError，原4条console错误完整保留；当前源码已将page提升到try外，修复诊断遮蔽，后续完整复验仍待卡点解决。6个Python实例共10条曲线的90个闭合bar十字线样本与后端逐点一致（误差≤1.1e-5）。指标ID并不代表secondary feed已经绘制，等待条件改为逐plot至少5个有效unique样本；每plot的5样本与数值误差断言保留。脚本固定自己创建的workspace，保存前等待历史/同步guard结束，避免并发测试的最新workspace选择和就绪竞态。

真实Binance告警8项通过：按住拖动0次写入、释放1次；线性trend、反向log ray、SMA/EMA/RSI/MACD达到ready；刷新保留范围映射、柱宽同步、4个Python study及绘图，删除暂停规则。独立API/worker任务事件5项与内部通知sink重试通过，不发送真实通知。

MCP HTTPS SDK 15个检查/13工具通过；组合事件一致、readonly写拒绝及ack幂等3项通过。真实chart→PG→MCP projection→刷新6项通过，范围overlay不作为绘图，未保存编辑不可见。MCP与API/worker任务事件使用synthetic fixture，指标/告警的行情为真实provider，分别标识，不混称。

运行候选2的 `host.d0a96d61fcfcc340.js` 与22个宿主模块逐字节一致；28个构建源文件与137个运行后端Python源文件SHA核验。23个模块脚本（18个断言模块与5个helper load）及5个集成脚本通过；30项JS语法检查通过，web/API/chart构建成功。

后端完整测试586通过、46环境依赖项跳过；专项13通过（含3个真实PG并发/锁测试），真实PG fresh/r19/alert-only/MCP-only迁移4条路径通过。全量Ruff仍有main既有的5个import排序问题，任务变更Python脚本通过Ruff。

## 当前卡点与下一步

1. Python study 的实时映射：后续真实BTCUSDT M5复验在新柱边界记录4次 `not enough depth`。M1定向浏览器探针持续144秒、72次观察，保留原console.error，捕获31次该错误，堆栈为 `IS.get → IS.adopt → pythonStudies.main`；另有3次独立错误保留原记录。库级实验复现 primary/secondary 异步一bar滞后且target时间buffer深度2越界。`indicators.js` 与最新main无差异，但组合验收不能因此算通过。需要修复时间映射的缓冲/延迟合同，验证实时边界、缺口与内存，不采用错误过滤。
2. 连续历史完整产品：失败恢复、取消、返回最新、持续拖动、真实PG历史更正（resetCount=1、回调close精确匹配）、原历史视区和保存重开已完成；SMA(201)新secondary首次64,129根需求在90秒内未回调，Python前缀修订尚未开始，整份full product记录为失败。需区分任务排队、计算延迟和回调生命周期后复验；真实更正fixture已恢复。真实容量边界四图专项在最终候选2通过。

这些卡点尚未解决，PR保持待验收，不合并。证据保存失败详情，未以旧版成功结果替换本轮失败。

## 2026-10-06 兼容修复检查点（尚未收口）

源码修复提交 `0aaec93`：Python 主时间缓冲由 precise adopt 初始两格改为原生默认有界10,001格，不增加 mandatory countBack；每条曲线晚于主图当前柱时留空，避免旧值短暂写入新柱。实际许可库 Context 回放验证6种延迟、32根历史逐值重算和3条曲线连续3次换柱，保持precise、零值、负值、缺口及追赶恢复。新增维护约束见 [指标维护文档](python-chart-indicator-maintenance.md)。

运行图表已更新为候选4 `host.73eb5768a881494f.js`，22模块字节一致。候选4/API候选2真实M1探针72次采样、0console异常、0depth异常。该探针不提供“最新未闭合柱数值与后端逐点一致”的oracle，不据此声称所有实时数值验收已完成。

后端实时指标计算移出数据库事务，同次更新按数据集/末柱复用前缀，只读必要列；不截短算法输入，全部计算成功才发布cursor，失败可重试。API候选2全量586通过/47跳过；最新API候选3相关46通过，真实PG20通过，包括计算时无连接占用、失败不推进cursor、相同源前缀只读一次与不同参数结果保留。Ubuntu实例已部署API候选3，两处实际导入源码SHA与工作树相同。

候选4/API候选2连续历史整链仍失败：真实PG修订resetCount=1、回调close精确1.16018、历史范围恢复及保存重开通过；新SMA201首次64,122根请求90秒无回调，前缀修订尚未开始，同期连接池超时仍有记录。API候选3的长前缀定向探针和整链复验待完成，不能以专项测试替代。新证据单独保存在 [兼容修复汇总](verification/chart-bar-range-mapping/main-integration/compatibility-fixes-20261006/summary.json)，前面候选2检查点保持原始结果。

最终候选还需数字对照、告警/MCP组合及范围/十字线逐帧复验，随后提交用户人工验收。PR继续WIP，未合并、未生产部署。

## 验收配置与边界

旧布局date/time迁移使用2万根容量，检查同widget与刷新后的逻辑选项。20万根的旧配置跨周期对齐曾超出60秒等待预算，不计为该配置下通过。范围投影导航在20万根配置下到2023年目标也曾超出60秒；低容量因无法覆盖2025年来源而复验失败，因此保留原20万根/原日期/原投影断言，将该组有界等待设为180秒后8项通过。默认等待仍为60秒，不降低就绪条件或定位断言。逐帧远历史专项另使用20万根，真实M5走廊超过2万根；大容量不可达目标由容量边界专项覆盖。

最终候选2逐帧稳定性9项通过。远历史W1/M5/H4/D1使用真实provider，M5保留89,178根连续走廊；历史静止鼠标采集122帧，检查K线像素、同model/chart身份以及来源/公开光标/日期标签。

时间关系按来源真实 `[start,end)` 验证。周线日期标签可以与实际纽约17点交易周开始时间不同，小周期公开十字线时间需落在同一真实区间；跨周期标签不要求文字完全相同。有限逐帧采样不等于所有设备/任意操作绝无闪烁。

## 人工验收

已准备四图工作区 **main 集成：范围映射与柱宽同步验收**：W1/M5/H4/D1、Dark，范围矩形/高低价标签、时间与柱宽同步开启，日期范围同步关闭，单源容量200,000。该准备和自动重开验证不等同于用户人工验收。

1. 保持焦点图不变，在另一图滚轮缩放，观察其他图柱宽跟随；再试原生按钮和快捷键。仅切焦点或开关不主动统一。
2. 布局末尾打开同步设置，验证柱宽/日期范围互斥、颜色/透明度、保存和刷新。
3. 点击历史周线并保持鼠标静止，观察十字线公开时间落在来源真实周区间，矩形和高低价保持；重点观察加载、缩放、拖动、周期切换有无闪烁。
4. 窄屏及高低价屏外时确认完整数字、信息栏不碰K线；容量不足时停在真实边界，提高容量后可重试。

组合卡点修复后再作为最终人工验收候选。人工结果尚待用户确认，PR未合并，生产未部署。
