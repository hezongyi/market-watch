# 告警交互更新验收记录

自动验收通过，等待用户人工验收。F0：兼容 UI 交互，无 API/schema 变更。

用户随后补充要求“加号先弹菜单，选创建告警才创建”。该修正已在当前分支实现并完成源码原生图表检查，尚未更新实例；下文记录仍对应此前部署版本。补充验证见 [交互补丁记录](alert-interactions-20261024.md#加号菜单补充修正待更新实例)。

实际主机 Ubuntu `quant-server`，现有 Compose project `mw-issue75-v2-20261018`，入口 https://192.168.7.232:18280/advanced-charts/mw75-real ，Chart origin https://192.168.7.232:18281 。实例保持运行，刷新页面即可加载新资源。

Chart 产品源码 `17b276dc9b167b562f4387c52698b8635bb89885`，Web `19cc026afa8583238ba83917498d03783f6cf7a2`。Chart 镜像 `sha256:6946f86b25a3bd84f9849ca9fe8e5de1a8fa572fb455cf51edcd54a119facb31`，Web `sha256:5c5ad462b8427bdb31832db3b05cab4585e42b0036edf882c39be0db0d97fdaa`。只更新 Chart/Web；保留 API b4e1326a、workers 8b7ee3ee 以及先前 NR、D1 和偏好修复。实际服务返回的 `/host.d080292e95049b2a.js` SHA256 与镜像内制品逐字节一致。

## 结果

- 15 服务运行，API/PG healthy；所有有效环境、挂载、端口、网络、资源和重启策略保持，其他 13 服务与保护浏览器 ID/启动时间保持。
- 真实实例现有 16 条规则、7 条日志，tooltip、编辑取消、独立未读字段、明暗切换通过。四按钮各自 hover，国旗移除，圆点加粗通过；告警/自选背景深色同为 rgb(15,15,15)，浅色同为 rgb(255,255,255)。页面异常 0。
- 从最终固定镜像提取的原生资源，无源码覆盖：许可图表实际指针拖动只调用一次编辑并同步条目与价格线；Escape 恢复且不保存；实际价格轴加号点击直接创建上穿价格告警，无输入弹窗。测试接口和行情为合成数据，没有向真实数据库创建测试告警。
- 真实库原先暴露 iframe 焦点导致 Escape 丢失，已修正为拖动开始聚焦标签。iframe 回归修复前失败、修复后通过，最终镜像再次通过原生交互验证。
- 原生参考测试覆盖线性/对数/百分比/指数轴、倒置、缩放、多图、多窗格、删除失败恢复、主题、375px 编辑器及 200% 文字；窄屏原生侧栏隐藏的既有限制保留。19 个 Node 定向测试、面板/编辑/价格线回归和构建通过。
- 六张保护表的内容指纹、原 23986 条通知状态和手机确认保持；后台正常新增 32 条通知。不声明后台行情缓存完全静止。

真实浏览器使用一次性 context，拦截工作区、偏好、通知写入，现有规则配置/版本不变；用户浏览器现场未触碰。原生写入专项使用模拟接口；真实数据库写入及 SVG 最终视觉比例交由人工验收。ATR 动态阈值、关联画线继续通过编辑器调整。

## 运行与证据

- 统一启动/状态/停止：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`，持久应用 overlay 已同步最终固定镜像。
- 本任务 Chart/Web 启动/状态/停止：`python3 /home/quant/repos/.mwa-alert-interactions-20261024/operate.py start|status|stop`。
- 本任务只读审计：`python3 /home/quant/repos/.mwa-alert-interactions-20261024/operate.py audit`。
- 更新前精确配置和原始回退在私有目录 `/home/quant/repos/.mwa-alert-interactions-20261024`；`rollback-original.json` 保留更新前 Chart/Web 镜像，不执行自动回退。不得将普通 stop 扩大为删除实例/卷。
- 原始日志、镜像身份、快照、数据指纹及截图：`/home/quant/repos/.reports/market-watch/20261024-alert-panel-ui/interactions/acceptance`，结构化摘要 `summary.json`。
- 真实页面截图 `runtime/real-hover.png`；原生拖动 `native-interactions-final/native-drag-saved.png`；直接创建 `native-interactions-final/native-plus-created.png` 已目视检查。

未迁移/seed/reset/清库；未 push、创建 PR、合并 main 或发布生产。人工验收尚待用户确认。
