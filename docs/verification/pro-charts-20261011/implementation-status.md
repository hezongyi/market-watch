# 专业图表修复：实施与验收记录

实现树：`/home/quant/repos/market-watch-pro-charts-impl-20261011`。
分支：`fix/pro-charts-20261011`；基线：`7b5c614`（2026-10-11 获取的 origin/main）。
相对调查基线 `368a87a` 仅有文档变化。

完整需求和验收合同仍以[交接](/tmp/market-watch-pro-charts-implementation-handoff-20261011.md)
及[最终方案](/home/quant/repos/market-watch-pro-charts-heavy-use-20261011/docs/investigations/pro-charts-rootcause-solutions-20261011.md)为准。
调查树的未跟踪报告与证据保留原位；本实施不覆盖调查树。

| 项目 | 实施状态 | 完成所需证据 |
| --- | --- | --- |
| F1 多图生命周期 | 隐藏消费者与线程世代修复；完整五图→单图→BTCUSDT→XAUUSD→Yahoo AAPL→组合EURUSD→五图通过 | `browser-full-stack.json`；真实比较消费者隐藏往返、单格503与页面重试按钮保持peer身份/周期/范围，`browser-consumers.json`；保存工作区连续两次加载取消旧回调，`browser-lifecycle.json`；2v/3r/4共享消费者、同步开关和实际修订启用后的stream重载，`browser-revision-consumers.json` |
| F2 取锁和 worker 恢复 | Dataset→Instrument→PublicationState；完整事务三次重试仅40P01/40001；逐目标事务与世代核对 | PG分支39项、恢复32项；真实import_page屏障交错6项通过，`import-publication-green.txt` |
| 需求首次登记竞态 | 原子upsert、续租不倒退、引用回收保护 | 真实PG/真实data_sync提交55项，`demand-green.txt` |
| DC1 三个必填下拉框 | 真button、可见label/focus、required/invalid/disabled；首个可验证表单字段焦点 | 公共许可引擎8项；实际映射保存201、组合修订准备201/启用200、键盘与未保存guard通过，`browser-data-center.json` |
| F3/U8 告警身份和价格 | 捕获发起格formatter；创建/编辑/列表/日志/通知使用保存身份的可读名称；新事件证据保存精确Decimal | 38价格checks、bridge7项、真实fractional formatter3项；真实POST201、多格切换、Yahoo格式菜单、人工18位小数与刷新读取，`browser-alerts.json`；PG事件提交/重读/API及真实日志面板，`notification-runtime.json`、`browser-notifications.json`；外部投递未启用 |
| F4 派生性能与进度 | 公平轮转、compact tuple 64MiB LRU、日历/解码复用、持久进度/近期ETA；保留Decimal路径 | 原总计451.12秒；追加完整分段457.87秒/派生峰值411.83MiB，2,147,763观测的九周期2,841,385桶全字段与基线一致，`derive-contract-2147763.json`；近期ETA红→绿与PG恢复通过；真实页面累计观测/暂停/恢复/完成3项通过，`browser-derive-progress.json`；DST批量原型18项等价 |
| F5/U1 日历身份、审核和表格 | 摘要可辨环境/通道/匿名账户/口径/范围；独立真实审核audit与CLI | calendar/profile37项；两主题1600/768/375px搜索、筛选、键盘展开、无水平溢出通过，`browser-presentation.json` |
| F6 Python 指标分类 | 八Python稳定native ID优先；原生分类/收藏/添加/当前分类 | 真实工作区server保存/刷新恢复通过，`browser-indicators.json` |
| F7 手机说明 | 图表内和main入口均有可见手机只读说明 | 375×812及915×412触摸模拟、单图/无编辑入口/返回/无写入/桌面文档哈希保持，`browser-mobile.json`；Android/iOS实机由用户后续验收，不作为开发硬性阻塞，见`acceptance-decision.md` |
| U2 告警入口 | 44px盒内原28px图形；移除重复汉堡入口 | 两主题实际44×44按钮/图标盒、中心22/22；警报/日志页签；Chromium原生100/125/150%页面缩放、键盘开关/选中/原生焦点框6项通过，`browser-native-zoom.json`；等效视口/DPR模拟另保留 |
| U3/U4 品种信息 | 移除外层底栏；真实许可模块适配；canonical固定身份快照查找 | 两主题、8次侧栏切换高度1000px；真实来源观察时间/四时区；rare状态snapshot回放通过（回放与实际供源证据分开） |
| U5 原生操作提示 | 原生SymbolSearchDialogFooter复用；分区短提示；平台打开前可见同步说明 | 两主题/三宽度；375px六分区提示高度稳定；末行/键盘焦点、标明目录503后真实API重试；`browser-operation-hints.json`、`browser-presentation.json` |
| U6 固定系列储备 | 共用native cache；canonical ticker/缓存世代/修订/input revision防旧响应；大需求有界分页 | 三类×四周期冷暖/慢快/反向/起点及实际native24120根单次原子交付，`browser-reserve.json`；追加12项idle/缓存拖动帧耗时与900ms背景延迟，`browser-reserve-performance.json`；真实拼接/缩放及受控unknown，`browser-lifecycle.json`；实际运输与受控修订/输入世代/消费者取消，`browser-reserve-fencing.json`；Python SMA200预热/缓存拖动/900ms延迟增强储备，`browser-reserve-indicator.json`；VM21001/11页及预算耗尽通过 |
| U7 九周期绘图可见性 | 单对象与多选原生mwMask属性/九checkbox；每个图格按自身周期求值；旧范围仅显式编辑迁移 | 许可引擎九周期/同步/undo/redo/cancel/旧范围；产品两主题/独立位/复制/server保存刷新/跨品种，`browser-drawings.json`；多选/mixed/旧范围cancel与undo/手工hidden/组隐藏/真实绘图告警201/仅可见性编辑不改告警版本，`browser-drawing-association.json` |

验收仅在 Ubuntu 本机独立 Compose project `mw-pro-charts-20261011`。
通过 `sg docker` 使用 Docker。此文件将随实际测试更新；未执行的项目不宣称通过。
未授权生产发布，未操作 unraid。Ubuntu合成历史/映射/组合准备已完成，工作区 pro-charts-fixture 已创建。
实际运行：Ubuntu本机Docker，PG 127.0.0.1:19995、公共控件探针19996、web19997、chart-origin19998。
浏览器验收使用任务合成供源I/O、真实API/PostgreSQL和许可引擎；它不能证明供应商可用性或供源吞吐。
最新chart/api/web均已实际运行；容器ID、镜像ID和构建归属见 `runtime.json`。
私密env及许可库仅在本机，不提交。截至最终验收核对时，变更尚未commit/push/PR；开发goal按用户确认的验收门槛已标记complete。后续提交与PR状态以Git记录为准。

2026-10-12追加逐项审计：近期吞吐ETA、分区操作提示已补实现；大数据集逐桶/分段计时、真实活动修订多消费者及真实任务页面控制流程已通过。
已有报告的检查数量不代替逐项合同；审计与补验结果见 `completion-audit.md`。
用户明确Android/iOS实机竖横屏、软键盘、触摸与返回由其后续验收，不作为开发收口的硬性阻塞，见`acceptance-decision.md`。
实机结果仍记录为未验收；Chromium触摸模拟证据保持其实际适用范围。
当前USB设备描述核对见`mobile-device-availability.json`；接入方式与逐项实机记录表见`mobile-physical-acceptance.md`。
本轮开发与Ubuntu隔离验收已收口，20份浏览器报告共119组检查通过；70张网页截图已逐屏目视审视，用户后续实机反馈可接续修复。
开发goal完成不结束Docker生命周期任务；该task/project保留进行中，供用户继续验收，不执行finish/retire。
验收实例保留供用户访问；进行中的任务不finish/retire，不删除任务数据卷。

日常启动与停止（在实现树）：

```bash
sg docker -c 'docker compose -p mw-pro-charts-20261011 -f docs/verification/pro-charts-20261011/compose.yaml up -d --no-build --wait'
sg docker -c 'docker compose -p mw-pro-charts-20261011 -f docs/verification/pro-charts-20261011/compose.yaml stop'
```

验收入口 <http://localhost:19997/advanced-charts>。许可图表源 <http://localhost:19998/> 由应用iframe使用。
数据库与env仅为本任务所有；不复用生产，不全局prune，不退役进行中的任务。

浏览器回归使用 `LD_LIBRARY_PATH=/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu` 和本机Chromium。
PG集成测试读取任务私有test.env，均用独立临时schema；端到端测量schema已经精确删除。
测试脚本和结果位于本目录及 `web/tests/pro-charts-*.browser.cjs`。

性能决策：pandas/Polars原型补至60,000分钟有界输入（实际59,390观测），NY17/UTC0×春秋DST×九周期共36场景，
对OHLC、Decimal量、完整性和日历字段全字段等价；分别验证该语料价格5位、量2位缩放与Int64范围，峰值458.55MiB。
但分组前仍需准确归一化和日历转换，不能以分组CPU时间代表端到端收益。
最终合同测量中，复用后的Decimal路径完成真实PG九周期派生、校验、coverage、编码和发布用时457.87秒，
派生峰值411.83MiB；九周期2,841,385桶全字段与固定基线一致。原451.12秒为此前总耗时测量，未做逐桶对照。
最终测量输入归一化49次、最长tick1.98秒、LRU高水位60,270,506字节；分段和测量边界见`completion-audit.md`。
本轮保留这个有界、可恢复的运行时，不增加pandas/Polars运行依赖；原型保留可复跑。
36场景的分组加最终化耗时合计pandas14.27秒、Polars10.72秒，转换另17.31秒；原逐行路径合计41.21秒。
这只是固定5位价格/2位量语料的CPU对照，复用基线桶键，不覆盖生产通用精度、SQL、排队或事务恢复，不能据此承诺端到端收益。
供源导入未包含在上述派生耗时内；没有生产加速承诺。

## 最终证据与运行限制

- `alert-final-regression.txt`：77项告警领域/服务/worker/API/组合规则、通知和本地MockTransport回归通过（含真实PG精度项）。
  `notification-precision-pg-green.txt`：真实PG事务提交、重新读取与HTTP事件API保留人工18位小数。
  `notification-title-final.txt`：最终兼容性调整后14项通过；PG项单独已有通过证据。
- `bridge-final-regression.txt`：11个Node测试项通过，含38价格checks、八Python稳定身份、
  固定分页/世代和储备backoff测试。`drawing-visibility-final.txt`再次验证当前适配后的许可引擎原生合同。
- 真实API/PostgreSQL保存、启用修订及浏览器工作区持久化均已执行；供源I/O使用此project专属合成fixture。
  unknown空页、单次503、900ms延迟和输入/绑定修订变化使用明确标注的受控seam；
  它们验证原生消费者/桥接的行为，不宣称真实供应商发生过这些状态。
- 新告警事件把精确价格与阈值保存在不可变JSON证据中，避免旧共享Numeric(24,10)列造成显示截断。
  旧事件没有这些证据字段时沿用旧字段；不回写旧事件，不改人工阈值/用户自定义名称/计算规则。
- Yahoo股票的真实菜单/格式/弹窗身份已验证。现有告警合同只接受已确认ny17/utc0日历，
  Yahoo AAPL使用独立交易所日历，因此本轮不扩展股票告警计算能力；未将其POST成功列为证据。
  MWH不可变固定历史也不新增实时告警系列；可创建的固定修订告警通过组合身份验证。
- 外部通知投递在实例始终关闭；PG通知为web_only且无Outbox。已有notify重试合同仅用本地MockTransport验证。
- 最终20份浏览器报告全部passed=true、errors为空，合计119组cases/checks；42个运行时源文件哈希均与 `source-manifest.json` 一致。最终运行和证据核对见 `final-verification.json`。
- 两条前期合成进度调试任务已精确处理：v1错误任务取消，旧v2完成2/2；记录及数据保留，见 `debug-progress-tasks.json`。验收Compose的7个服务继续运行。
- 所有Docker操作通过 `sg docker -c`，构建通过带task/project/purpose的 `mw-docker`，
  使用 `market-watch-ubuntu` builder。未执行生产发布、unraid操作、全局清理或提交许可资源。

可重跑浏览器验收（从实现树，逐项执行，写业务数据的验收不并行重复同一个脚本）：

```bash
LD_LIBRARY_PATH=/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  node web/tests/pro-charts-consumers.browser.cjs
LD_LIBRARY_PATH=/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  node web/tests/pro-charts-drawing-association.browser.cjs
LD_LIBRARY_PATH=/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  node web/tests/pro-charts-mobile.browser.cjs
```

其他完整浏览器脚本使用相同前缀。通知运行脚本先在本任务api容器内以浏览器创建的告警ID运行，
再运行 `pro-charts-notifications.browser.cjs`；仅接收本任务PG/应用名/关闭投递的环境，执行前置断言。
PG集成回归须从0600私有 `test.env` 设置 `TEST_POSTGRES_URL`；不把env内容带入证据或仓库。

## 2026-10-12 网页逐屏截图与目视审视

已登录Ubuntu真实Docker网页，采集并逐屏审视70张交付截图，覆盖深浅主题、五图、品种详情、告警与日志展开、
价格菜单/弹窗、八Python指标/详情、九周期绘图设置、数据中心六分区、三个必填下拉框、真实任务进度/底部、
768/375px桌面窄屏及手机竖横屏触摸模拟。[截图索引](visual-acceptance/index.html)与
[逐屏结论](visual-acceptance/review.md)给出每张图的目视判断和适用范围。

此次目视验收发现并修复两项缺陷：长来源说明挤掉告警状态和日志时间，及浅色状态文字对比度不足。
修复后状态/时间溢出0px，浅色状态对比度最低5.003:1；失败与通过证据分别保留。
chart/web通过带task/project/purpose的mw-docker实际重建与部署；价格告警、展示回归及新增4组专项检查通过。
当前20份浏览器报告共119组检查通过，42份运行时源哈希核对一致，七个服务继续运行。
展示回归首次遇到请求队列拥挤，原失败记录保留；独立重跑及诊断重跑均通过，未将其归功于CSS修复。

目视结论是本轮桌面及窄屏UI达到验收预期，发现的视觉缺陷均已修复并重拍。
供源I/O仍为任务合成fixture，真实供应商链路尚未验收；手机实机由用户后续验收，不成为硬性阻塞。
截图不包含登录凭据、cookie或许可源码。实例保留，Docker生命周期任务仍active，不finish/retire。
