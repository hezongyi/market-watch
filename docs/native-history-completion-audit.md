# 原生连续历史实施验收审计

2026-10-05。权威合同：[实施方案](native-history-implementation-plan.md)。当前产品 `2468143`，API/web `b3dd20c`，Ubuntu project `mw-native-history-ubuntu-20261004`。P1～P4 已交付隔离候选，P5 自动检查已完成，**原用户人工验收待反馈，因此不宣告整个方案最终完成**。未合并、推送或生产部署。

| 合同 | 证据与结论 |
| --- | --- |
| 原四周期大请求成功，静止光标、hover 不重建 | [当前完整四图](verification/native-history/supplemental-20261005/final-2468143-full.json)：真实 EURUSD W1/M5/H4/D1，超过 20,000 的实际走廊成功；正常 getBars 回调，无自动窗口身份；静止光标及 hover 断言通过。既有 [2/8 图](verification/native-history/final-415ae61-2-8.json) 保留实际候选版本。 |
| 新意图覆盖旧意图 | 同一完整四图证据：真实未完成 HTTP、旧公开 Promise 取消、回最新后迟到回调不反向改变视区。模型导航代次与引擎范围代次分别约束。 |
| 503、繁忙、超时、取消、预算拒绝后恢复 | 完整四图的 `faultRecovery` 与 cancel/latest 结果。408/容量响应是隔离 HTTP 故障注入，证明产品收尾及恢复，不声称浏览器实等 600 秒。任务 deadline/expiry、页数、预算与租约由既有后端回归证明，164 项相关回归通过。真实前端超额准入另见模板证据。 |
| 一致快照、分页持久化、小请求有界读取 | [冷任务](verification/native-history/cold-task-evidence.txt)、[hot profile](verification/native-history/hot-profile.txt)及 provider/task/真实 PG 回归。约 60,031 根冷任务 16 页/48.18 秒；热约 1 秒；200 根含储备约 0.046 秒。无每页全量 payload 解码；覆盖/revision/bars 保持同一观察。 |
| 完整冷 PG、新页面热 PG、同 widget 缓存分层计时 | [空 PG 完整产品](verification/native-history/supplemental-20261005/full-product-cold-415ae61.json)：开始 provider bars 为 0、独立项目/PG，点击至就绪 44.27 秒。当前 `2468143` 完整四图热 PG 5.15 秒；同 widget 已加载区间公开定位 3 毫秒、无历史 HTTP，含测试等待就绪约 0.53 秒。测试参考机与容量见验收文档；单次记录不是任意硬件 SLA。 |
| 真实价格修订、前缀更正、几何恢复 | 最终完整四图：真实隔离 PG 更正经 SSE/review；原生主图回调收到确切 close，视区/柱宽恢复。`prefixRevision` 将 SMA201 依赖 bar 更正，影响值先置于可见范围，再核对真实指标回调与 201 根预期均值；finally 恢复。范围外/未变化/核实失败及并发扩展另由模块回归证明，不冒充全供应商产品修订矩阵。 |
| 共享取消和销毁无残留 | [最终生命周期](verification/native-history/supplemental-20261005/lifecycle-a2f9004-final.json)：同一商品/周期两图共享真实等待，取消一图回最新，另一图完成；整体 remove 后 models/threads/pending/resident 为 0。 |
| 模板、输入修改、容量准入 | 最终生命周期：3 MA 模板恢复、length 改 100；10 MA 超额模板在原生修改前拒绝，指标/视区保持，下一指标操作恢复。曾失败的旁路修复于 `7179eb0`～`a2f9004`；原始失败记录保留在私有目录。 |
| 模板撤销/重做、宏组合和历史栈 | [最终模板撤销](verification/native-history/supplemental-20261005/template-undo-a2f9004-final.json)：小缓存重模板→轻模板→历史增长→超额 undo，拒绝前后 undo/redo 状态相等，轻模板保持，后续操作正常。模块回归覆盖嵌套宏、两图累计投影、checkpoint 截止；首次应用/命令执行/栈出栈各入口固定 SHA 和唯一锚点。 |
| 长时间拖动/旧侧追加/2、4、8 图释放 | 既有产品按住拖动、释放回归及最终生命周期：共享读取延伸到更旧侧、6 轮布局扩缩/导航/切周期/指标，GC 后整体 page live heap 与浏览器进程 RSS 有界，再静置 60 秒，最终 widget 释放为 0。隐藏布局模型可保留至 8 个，这是原生布局缓存，不能要求每次缩布局立即为 1。仅证明几分钟受控压力，不证明全天无泄漏。 |
| 日历、适用供应商周期、DST | [OANDA DST](verification/native-history/supplemental-20261005/calendar-oanda-dst-9545d1b.json)：真实 H4 UTC 开盘时刻跨 DST 从 14:00→13:00，D1 交易日标签正确及周末闭市；W1/M1 导航/UTC 标签通过。[Binance](verification/native-history/supplemental-20261005/calendar-binance.json)及 [H4](verification/native-history/supplemental-20261005/calendar-binance-h4.json)、[Yahoo AAPL](verification/native-history/supplemental-20261005/calendar-yahoo.json) 的 D/W/M 与历史导航通过；标签映射还复用 `advanced-time.cjs` 模块检查。没有声称所有商品/所有周期/原生日历组合均通过。 |
| 光标失效、同步开关和公开导航入口 | [真实交互](verification/native-history/supplemental-20261005/interactions-2468143.json)：原四图远跳/静止/hover 通过；Alt+G 原生日期定位；关闭同步后公开导航无外部光标重绘；真实鼠标在 D1 发出光标后关闭并卸载源图，保留 W1 无旧时间/可见光标；九个支持周期尾部就绪；双 M5 日期范围同步。源图关闭缺口修复于 `97864b5`/`2468143`；模块回归红→绿。原生关闭同步可能保留旧显示状态，合同核对不重放，不将可见标志全部为 false 当作原生合同。新增 [源身份/反向同步](verification/native-history/supplemental-20261005/interactions-source-identity-reverse-2468143.json)：真实 M5 点击向 W1/H4/D1 反向同步，静止/再次移动标签一致；源 D1→H4 与 EURUSD→XAUUSD 后对应新原生 bar；模块证明旧源身份的重放失效；双 M5 两方向日期范围完成且一致。非全部周期笛卡尔同步矩阵。 |
| 内容版本与旧浏览器缓存 | [最终 HTTP 缓存迁移](verification/native-history/supplemental-20261005/content-cache-a2f9004.json)：隔离同源代理，真实浏览器未用 route 禁用缓存；旧冷/旧热→新版本→新热，实际执行 bundle SHA 与目录内容版本相同，warm 确实命中缓存；旧/新上游只读。用合成 bars 验证脚本缓存合同，不替代行情产品正确性。安装器原件/旧版/幂等/篡改/disable 回归通过。 |
| Ubuntu 与交付边界 | [验收文档](native-history-acceptance.md)、[预算](verification/native-history/budget.json)、[Compose 模板](verification/native-history/compose.template.yaml)。实际健康 API、专用历史 worker、隔离网络/PG；业务通知关闭，凭据与许可不入库。冷产品额外项目已停止，旧比较候选保留。 |

最终 Standards / Spec 两轴复核至 `2468143`：均无新增阻断项。审查发现的模板应用旁路、undo 栈丢失及多图组合预算问题均已修复并增加针对回归；复核结论不代替人工体验验收。

人工仍需在 `https://192.168.7.232:16343/advanced-charts` 按验收文档核对原 EURUSD 四周期布局、等待/hover 是否闪烁、加载中改日期/回最新、原有指标画线与保存重开。尚未收到本次候选的人工结果，不能用自动浏览器通过替代用户确认。

`2468143` 最后完整回归通过四图远跳、静止光标、hover、busy/503/注入超时/容量恢复、取消/回最新、指标/画线/拖动、真实价格修订、SMA201 前缀更正及保存重开。价格修订触发一次有原因的重载，不是 hover 重建；所有 PG 修订 fixture 已恢复。关闭源及同步开关另外使用独立真实交互用例，未与改写 PG 的完整回归并行。

范围同步补测曾在第二图异步操作开始前读取范围，后续失败快照两图已就绪；测试改为等待双方实际目标范围，再核对几何，未修改产品。第一次静止切周期断言全部 cursor 为空也被真实原生新广播反例否定，现核对源图当前 bar；旧重放清除由模块独立断言。失败记录留在私有验收目录，不以测试断言调整宣称修复产品缺陷。
