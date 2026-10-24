# 即时通知全局右下角：用户验收后调整

用户最终确认：电脑宽窗口的即时弹窗从整个应用视口右下角弹出，允许覆盖侧栏、底栏或其他内容。此规则取代初版的可用图表区域避让；其他已满意的Swing展示和通知行为保持。

F0 / Ubuntu R1，继续使用原隔离分支 `fix/swing-format-notice-placement-20261024`，基线仍为v1.28.0。使用现有mwa，不创建PR、不push、不合并、不发布生产。

## 实现与验证

- 右/下边距桌面16px、窄屏12px，最大宽355px，高度按全局视口限制并内部滚动。
- 面板开合不改变锚点；继续使用原生Surface覆盖层与原有进退动画、计时和确认协议。
- 移除即时通知对侧栏/底栏布局MutationObserver的依赖，只在视口resize时更新几何。
- 新 `instant-notice-layout.browser.cjs` 使用唯一标识的持续通知，验证其没有后续状态更新时，桌面侧栏/底栏真实开合仍固定全局右下角，并以elementFromPoint证明能覆盖面板。
- 旧逻辑已在此新断言下实际失败：1440px视口中通知right=1074，而全局目标right=1424。红灯证据 `20261024-notice-layout-followup/red.log`。
- 保留完整原通知矩阵，改为全局边界断言，并补查375px、长内容及消息状态。

## 实例与证据

Ubuntu `quant-server`，实际Compose project `mw-issue75-v2-20261018`，仅更新Chart/Web，保留其余13容器、数据、完整私有配置与保护浏览器。

入口：<https://192.168.7.232:18280/advanced-charts/mw75-real>；Chart origin：<https://192.168.7.232:18281>。

证据目录：`/home/quant/repos/.reports/market-watch/20261024-notice-layout-followup/`。

本轮Chart/Web-only私有运维：`python3 /home/quant/repos/.mwa-notice-global-corner-20261024/operate.py start|status|stop|audit`；换版前精确快照及回退overlay在同目录，保留长期实例运行。长期统一manager仍为 `.mwa-v1264-chart-init-20261021/manage.py`，部署后同步固定镜像引用。

状态：已更新并验收通过，实例继续运行。实际产品提交 `777adf1153cd8ae677722062a776fb12389728d0`，Chart/Web镜像均dirty=false；后续收口只更新记录，不改变运行产品。

- Web构建、通知runtime/persistence通过；本地布局6场景、实际mwa布局6场景、完整通知8组通过。
- 实际1440×858原生视口中，侧栏/底栏开合前后通知right=1424、bottom=842；底栏展开后图表bottom=457，通知仍覆盖全局右下角。375×650时right=363、bottom=638，均为12px边距。所有布局样本topLayer=true。
- 最终运维审计：15容器运行，API/PG healthy、restart=0；其他13容器身份及全部配置保持；保护浏览器ID与启动时间保持。
- 6表核对中，chart_workspaces及数据集/历史版本/产物4表数量与完整行哈希不变。工作区9→10，偏好数量仍30但哈希变化；访问日志及行更新时间显示换版前、验收期间及测试结束后仍有并发保存活动。保留现有内容，不恢复覆盖，不声称6表全部不变。测试context拦截工作区/偏好保存；允许的legacy migrate读取既有完成标记后直接返回。
- 本轮只运行与通知调整相关的检查，未在新产品提交重跑历史53条Node CI、6条CI浏览器、PG专项或13组Swing；这些历史结果仍见原报告。

完整结果、固定镜像ID、截图、数据审计及精确回退说明：[results.md](/home/quant/repos/.reports/market-watch/20261024-notice-layout-followup/results.md)。
