# 第二轮最终网页验收证据

Ubuntu `quant-server` 独立task/project `mw-ux-acceptance-20261012-r2`，web19981／chart19982，仅loopback；真实登录、真实API／PostgreSQL持久化，本任务合成价格。不是生产供源或通知验收。第一轮文件保留，不作为最终未补齐入口的证据。

| 验收 | 最终结果 | 截图 |
| --- | --- | --- |
| UX-01/06/07、S-01 | [触摸保存](results.json)、[双入口身份与键盘矩阵](identity-results.json) | watch-375/390/844、home-identities-375/390/844/1440、composite-watch-explicit-identity |
| UX-02 | [全部四角色stop、原300秒阈值及逐个恢复](health-stop-recovery.json) | health-all-stopped、health-recovered-history_versions/chart_history/native_history/legacy_import |
| UX-03 | [真实native Python对象POST201、独立参数snapshot、手选保存、reload](native-results.json) | native-indicator-actual-values、python-object-alert-1366/snapshot、python-alert-saved-independent、manual-alert-parameter-snapshot、alerts-reloaded |
| UX-04 | [真实股票＋来源＋关键词筛选](native-results.json) | dukascopy-stock-filter/0700/7203 |
| UX-05 | [真实BTC与OANDA独立适用对象](native-results.json) | calendar-independent-targets、calendar-oanda-independent-overview/independent-targets/catalog-target |
| S-03 | [真实固定历史演练、play/step/reload恢复、完成收起](replay-results.json) | replay-empty-stable/playing-result/restored-controls、replay-controls-375/390/844/1440 |

[visual-review.json](visual-review.json)记录全部33张逐张打开的视觉复核、尺寸及SHA256；截图文件加`.png`。滚动窗口截图验证当前区域，保存／快照／焦点以对应JSON及脚本断言配合。手机为Chromium viewport/touch模拟。

[checks.json](checks.json)记录178后端＋56生命周期测试、15subtests、18真实PostgreSQL、构建以及focus竞态的归因／修复／连续四轮复验；[首页120fixture](home-fixture-results.json)、[三个组件场景](panel-fixture-results.json)仅作补充，不代替真实网页。

S-02已复验既有reset恢复autoscale，仅保留建议，没有新增轴行为修改。真实通知、告警worker端到端判定、实机／Safari与生产修复后验证不在本轮通过范围。价格合成但历史发布、组合映射、告警和演练持久化流程真实。

数据库实际恢复与精确退役证明在cleanup.json；私有env、password、cookie、许可库和数据库归档不提交。
