# 图表工作区验收记录

2026-09-29；Ubuntu开发机，开发PostgreSQL，未执行生产发布、通知发送或生产重启。

| 范围 | 验证与结果 |
|---|---|
| 全屏独立页面 | 浏览器无旧侧栏；桌面/390px手机截图；手机无横向溢出 |
| 工作区持久化 | 新建、复制、新ID、刷新恢复；服务器revision冲突能另存/加载 |
| 布局 | 单图、左右/上下双图、两种三图、四图；键盘分隔线、单图最大化 |
| 绘图 | 八工具真实鼠标创建；逐类属性编辑、删除/撤销、刷新恢复；斐波那契级别、文字、多空盈亏比做空2:1 |
| 共享/隔离 | 同品种跨周期保留锚点；复制独立ID；不同工作区图表重新挂载 |
| 同步 | 四图鼠标平移后时间范围一致；按[start,end)映射十字线；不同品种只传时间 |
| 手机 | 切换查看后revision不变，无绘图/保存操作 |
| 保存可靠性 | 断网失败提示、本地草稿；恢复网络自动保存；并发修改409不覆盖 |
| 指标 | 八类添加、参数/模板；LWMA数值、STOCH输出、EMA预热/缺口、Python新插件；分页统一起点、修订失效 |
| 周期 | M30/W1/MN接口与浏览器；闰月、跨年周、DST、D1 OHLC、缺失/修订、黄金维护覆盖 |
| 日历绘图 | 对发布bundle的几何函数测试：周末、DST、黄金维护、自然月、历史前插及边界拒绝猜测 |
| 性能 | 4图＋100画线＋每图SMA/EMA/RSI/MACD，headless Chromium首次显示约1.4秒；编辑与保存通过；非FPS承诺 |
| 数据库 | 开发PG随机schema升级/回退/再升级通过；工作区含画线/指标SQLite备份恢复内容一致 |
| 原有模块 | 完整后端回归含PG隔离schema并发/演练/迁移；图表不改策略周期或worker |
| 构建 | TypeScript、Vite、Ruff、git diff --check；固定第三方源与离线重建bundle |

后端最终共124项通过、1项跳过；开发角色连接数上限为8，停止本轮开发API并释放连接后完整单进程回归通过（5.85秒）。

## 测试入口和证据

- `backend/tests/test_chart_workspace.py`
- `web/tests/chart-workspace-acceptance.mjs`
- `web/tests/chart-workspace-resilience.mjs`
- `web/tests/chart-geometry.mjs`
- 本地 `artifacts/chart-acceptance.json`、`chart-resilience.json`、`chart-backend-regression.txt`；截图 `chart-acceptance-desktop.png`、`chart-acceptance-mobile.png`、`chart-scale-100.png`（不提交用户开发数据）。

## 已知限制与发布门槛

- PostgreSQL整库dump/restore自动测试需要建库权限及匹配PG客户端，开发角色没有这些权限，该项跳过。新表迁移、序列化备份内容与PG事务路径已分别验证；生产发布前仍执行既有隔离恢复流程。
- 未来投影120个桶，超出范围不猜测时间。未加载历史的对象保留，待加载对应数据后渲染。
- 长期历史越来越多时，完整递推重算成本增长；已有缓存/请求合并，不声称无限数据规模性能。
- 分钟采集、上游数据缺口和日历公告维护限制继承现有系统；无虚构实时价格。
- 本地开发验收通过不等于生产已上线。生产发布按 chart-workspace-implementation.md 执行。
