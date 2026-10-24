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

状态：本地检查与mwa更新验收进行中。最终提交、镜像、结果及数据保留审计写入证据目录results.md。
