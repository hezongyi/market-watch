# NR4 / NR7 加载闪动修复

状态：已修复并更新既有 mwa，2026-10-24T14:14:41.785541+00:00。本记录补充此前 b1 的最终静态画面验收，专门验证加载过程的连续性。

## 根因与最小修复

用户报告 H1 加载多次闪动，并提醒其他周期可能受影响。实际 H1 历史补载复现：34 行 snapshot → clear → 141 行 snapshot → clear → 401 行 snapshot → clear → 661 行 snapshot。首次出现后累计 **346 帧图形数为零**，三轮消失与 coordinator.detach 的清空时间吻合。

原生历史重启会短暂返回空 scope。协调器把“暂未就绪”当作“指标已移除”，清除绘图后再重建。b1 的完整 snapshot 机制避免最终丢图，但没有保证加载期间画面连续。问题在各周期共用的生命周期逻辑，不在 H1 金融计算。

现在依据真实 study 成员和可见性判断生命周期；同数据身份、参数和修订的 scope 空档保留 consumer 及已接受图形，恢复后合并增量。实际隐藏、删除、品种／周期／参数／修订变化仍立即清理。原有“本地绘图缓存确实缺失时强制 snapshot”的恢复机制保留。无延时防抖或源码诊断日志进入产品。

## 连续画面验收

使用独立临时浏览器、真实行情 API 和许可图表库。最终四轮均使用部署原始 bundle `host.ddb9d1cd0b96e97e.js`，无源码注入、强制 coordinator.sync 或强制重绘。通过正常 setVisibleRange 触发三轮历史需求，requestAnimationFrame 记录原生对象与世代，另保存每轮 95 张画面并检查专用测试色块像素。

| 图表周期 | 帧数 | scope 空档仍保留图形帧数 | 图形消失帧 | 初始对象 ID 丢失帧 | 首次画出后最少填色像素 |
|---|---:|---:|---:|---:|---:|
| 15 | 1824 | 219 | 0 | 0 | 13301 |
| 60 | 1564 | 151 | 0 | 0 | 13316 |
| 240 | 1290 | 0 | 0 | 0 | 23358 |
| 1D | 1531 | 0 | 0 | 0 | 15756 |

合计 6209 帧；首次出现后图形清空、初始对象丢失、实际色块像素归零、页面未捕获异常均为零。H4/D1 的本轮采样没有正好落在 scope 空档，不把它们宣称为该瞬态的独立复现。

联合 coordinator + NR renderer 回归覆盖 1/5/15/30/60/240/D/W/M 九种周期，每周期三次短暂重启，另测隐藏、删除、品种／周期／参数／修订切换、真实缓存丢失补全。相同新测试在旧 b1 源码失败，在当前源码通过。NR 几何／样式、通用 runtime、native identity/labels/hook 检查通过；许可库真实测试的双 study、保存布局、D/W、字号颜色、隐藏删除亦通过。没有修改 Python 数值逻辑或重跑全量后端。

## 实际运行与保护

- Ubuntu `quant-server` / `mw-issue75-v2-20261018`，仅替换 Chart。
- Chart 源码 `c68fd817e192b880d28790cb51f2fab5c7a134f5`，镜像 `sha256:74e9683e487e53c9a44e1ce7639936767e75852c981572b072e5e72731933b8d`；API/10 workers 仍为 8b7ee3ee，Web 仍为 3ac6f743，各组件不是同一提交。
- 15 服务运行、API/PG healthy、重启为零。六张保护持久表完整哈希不变，原 23888 条通知状态与 7 条手机确认不变，新增通知 0。
- 配置／挂载／网络／端口、DB/gateway/Web 容器及保护浏览器身份保持；未迁移、seed、清库或操作保护 profile。
- 新 Chart 启动以来 API 有 8 处 CancelledError、4 个 traceback 标记；不声称全栈零异常。该窗口 HTTP500、连接池超时和容器重启计数为零。
- 回退配置 `rollback-override.json` 当前对应更新前 b1 图表；原 NR 更新前回退仍单独保留。未执行回退。
- 运维保持 `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`；任务审计 `python3 /home/quant/repos/.mwa-nr4-nr7-20261024/operate.py audit`。
- 原始逐帧、截图、红绿回归及私有操作证据目录：`/home/quant/repos/.reports/market-watch/20261024-nr4-nr7/flicker`。结构化摘要见 [loading-continuity.json](loading-continuity.json)。

没有 push、PR、main 合并、生产／Unraid 操作或永久删除。
