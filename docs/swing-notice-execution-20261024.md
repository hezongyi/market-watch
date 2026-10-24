# Swing 价格展示与即时通知：执行记录

日期：2026-10-24。结论：实现、回归、自审、本地 CI 等效检查及 Ubuntu R1 业务验收通过；实例保留运行。

## 边界、隔离与版本

用户授权从 `v1.28.0` 创建隔离 branch/worktree 并执行任务书；最新指令覆盖新建空 preview 和 Draft PR：验收使用 `$mw-acceptance`，不提交 PR。

- 基线：`v1.28.0^{commit}` = `59ed3a3f3fc727da76d13149934d999ebee04218`。
- 分支：`fix/swing-format-notice-placement-20261024`。
- worktree：`/home/quant/repos/market-watch-swing-notice-20261024`。
- 产品提交：`01b9d93d` 实现；`2d86c4da96b361211f14ba1a22f7d5df37882b5b` 修正卡片层级，为实际运行候选。
- 后续收口提交仅增强两个浏览器测试和本文；相对运行候选没有产品差异，无需重建镜像。
- F0 / Ubuntu R1：兼容展示调整，未改计算、schema、持久格式、调度或确认协议。
- 今日集成 worktree 仍在上述基线且干净；未 push、创建 PR、合并、打正式 tag、操作 Unraid、发布生产或删除永久数据。

## 实现与原生能力

1. 仅 Swing 使用原生 `format: {type: 'inherit'}`，其他 Python study 格式保持。公开 `precision: 'default'` 清除旧保存精度，不重建 study，不舍入计算数据。自动 2/3/5 位、手动再自动、自定义 formatter 和切系列通过。
2. 每实例 high/low 各一组轴/图例标签；优先未偏移绘图，否则转交可见左移绘图，两条都隐藏则无标签。All=4294967295，移除轴/图例位后4294967283，保留其余位、样式、可见性、四绘图及桥接线。复用既有事件和250ms刷新；统计关闭或snapshot缺失也规范化。
3. 即时通知 Surface 与 React 同步 bottom/right：桌面距实际可用图表边界16px，<480px距视口边界12px，最大宽355px。高度受限、内部滚动；真实画布尺寸不变。边界选择器集中于固定库原生适配器。
4. 入场向上16px/220ms，退场向下16px/160ms，只动画位移/透明度，移除 clip-path。保留状态、队列、确认、计时和 reduced-motion；消息中心继续 top/right。
5. 窄屏发现旧 host 卡片盖住 iframe 内通知，卡片改挂原生图表文档并保持pane坐标。真实 `elementFromPoint` 证明通知覆盖卡片；原统计开关保持。
6. 更新两份展示合同并保留历史。旧原生测试固定8个catalog study的断言改为实际保存前数量及完整输入比较。

依赖使用独立锁定 `.venv` 和 `npm ci`，许可库私有副本未入 Git。旧兼容输入经未修改 v1.28.0 的真实 `widget.save/createStudyTemplate` 生成，含 precision=3、颜色#123456、线宽4、非默认强度、单独隐藏及统计关闭。新 fixture 是真实Python算法生成的确定性800根合成行情，不修改共享seed或真实库。

## 验证结果

完整逐项矩阵、截图和日志索引：[results.md](/home/quant/repos/.reports/market-watch/20261024-swing-notice-implementation/results.md)。

| 检查 | 结果 |
| --- | --- |
| `npm run build`、独立 alert-ui build | 通过 |
| 价格格式、通知runtime/persistence、Swing identity/adapter | 通过 |
| CI前端 | 53条Node命令、6条CI浏览器命令通过 |
| CI工具链、分类及Ruff | 97 tests、66 subtests；14项分类测试；Ruff通过 |
| CI Compose | 4份配置展开通过 |
| PostgreSQL14.24 observed policy | 8项通过、0失败，76.78s |
| 旧Swing原生矩阵 | 四绘图/桥接/统计/隐藏/参数/撤回确认/多实例/双图/375px浅色/catalog模板通过 |
| 新Swing矩阵 | 13组通过，含真实EURUSD/XAUUSD及双图独立精度的实际study文本 |
| 新通知矩阵 | 8组通过，含布局/动画/长内容操作/队列确认/暂停计时/reduced-motion/实际底栏开合/部署后真实消息中心 |
| 自审 | `git diff --check`通过，backend算法/协议无变更，秘密/许可库/浏览器状态未入Git |

CI分类 `docs_only=false / backend_changed=false`；按仓库条件跳过后端全量及mapping迁移全量，仍跑始终要求的policy和工具链。用户不提交PR，因此未触发远程GitHub CI，以上为本地CI等效检查。

PG测试使用独立project `mw-swing-notice-ci-20261024`，回环18789、tmpfs、384MiB/0.25CPU，与长期业务库隔离，测试后已停止。没有对长期实例seed/reset/migrate。

## 真实实例、制品与保留

Ubuntu主机 `quant-server`；Compose project `mw-issue75-v2-20261018`；逻辑实例 `mw-acceptance`。

- UI：<https://192.168.7.232:18280/advanced-charts/mw75-real>
- 通知：<https://192.168.7.232:18280/advanced-charts/mw75-real?panel=notifications>
- Chart origin：<https://192.168.7.232:18281>

仅替换Chart/Web，经worktree内 `deploy/ubuntu/mw_docker.py build` 构建，task=`mw-swing-notice-20261024`，带project/purpose标签，commit均为干净 `2d86c4da96b361211f14ba1a22f7d5df37882b5b`。

| 服务 | tag | 实际镜像ID |
| --- | --- | --- |
| Chart | `market-watch-chart-origin:mw-swing-notice-20261024` | `sha256:18f1b7620cc10aef4f91eeedf5cd526e3de2d2d195fca9626019d6739c0c3e36` |
| Web | `market-watch-web:mw-swing-notice-20261024` | `sha256:ca01c730089fec0faea6e15cfb0f561b055e704340c7e7601a5d0d8303d4aa19` |

15容器运行，API/PG healthy，restart=0；其余13容器及镜像身份未变。完整环境、挂载、端口、网络、命令、资源和restart policy保持。长期manager固定Chart/Web引用已同步。候选静态资源逐文件比对及原生业务检查通过，非仅HTTP200。

6张表部署前后数量及完整行哈希一致：chart_workspaces=0、advanced_chart_workspaces=9、advanced_chart_preferences=30、market_datasets=130、market_history_versions=15、market_history_artifacts=135。不声称持续变化的demand/heartbeat等后台表不变。保护浏览器 `mw-issue75-v2-browser` 的ID和启动时间保持；另一历史浏览器操作前不存在，未重建。真实数据、认证、供源、Yahoo/MCP、TLS、数据库卷和浏览器现场保留。

真实应用使用新建临时Playwright context，拦截workspace/preferences写请求，不接管保护浏览器。EURUSD五位及 `MWP:XAUUSD` 三位Swing已实际渲染；XAUUSD high/low=`4,033.625 / 3,975.475`，与主图formatter一致。

## 运维与限制

本轮入口仅操作Chart/Web；已核对audit/status，验收完成不自动停止：

```bash
python3 /home/quant/repos/.mwa-swing-notice-20261024/operate.py status
python3 /home/quant/repos/.mwa-swing-notice-20261024/operate.py audit
python3 /home/quant/repos/.mwa-swing-notice-20261024/operate.py start
python3 /home/quant/repos/.mwa-swing-notice-20261024/operate.py stop
```

长期统一管理仍为 `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。精确换版前快照、原持久overlay及Chart/Web-only rollback位于 `.mwa-swing-notice-20261024/` 私有目录。回退未执行，不使用历史整栈rollback。部署仅指定两个服务 `up -d --no-deps --no-build --pull never`。

- 初次XAUUSD补验将平台系列误切到裸符号的自建系列，后者当时未dataReady而超时。独立诊断后改为 `MWP:XAUUSD`，实际平台行情验收通过；失败记录保留在 `swing-xau-initial-timeout.*`，不将自建行情等待归因于本补丁。
- 双图保存可复用study ID，测试按chart container限定实际DOM。长内容分别验证交易告警的查看/确定和系统消息的关闭；这些测试调整未改产品。
- 侧栏实际开合通过；fixture禁用 `trading_account_manager`，先验证center区域受控收缩，再在实际应用点击账户管理器底栏开合。展开后图表底边457px、浮窗底边441px，保持16px；关闭后边界恢复且浮窗重新定位。未连接broker或下单。
- 通知使用合成内存事件驱动生产React/native Surface，另验部署后真实消息中心；未创建真实告警、外部投递或事故。
- 临时context拦截保存可产生本地“设置未保存”提示，部分部署截图展示该实际通知；真实持久表哈希不变，保护浏览器不受影响。
- 动画证据含自然rAF采样与通过WAAPI定位到20%/50%/80%的真实渲染帧，不冒充自然帧率/性能测量。未做长期稳定性或生产发布验证。

任务范围内无剩余阻塞，源码及验收现场保留供检查。
