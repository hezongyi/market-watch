# 交付验收矩阵

更新：2026-09-29。此文件用于逐项判定，项目当前仍未完整交付。历史过程见 delivery-status.md；未标为“通过”的项目不能由其他测试结果替代。

## 已确认的当前范围

- 本机 Ubuntu、单人账户、EURUSD / XAUUSD / BTCUSDT；仅预警，不自动下单。
- OANDA Practice Bid M1 与 Binance last M1，自行按 NY17 / UTC0 聚合。
- 开发阶段 IP/HTTP，域名/HTTPS 后补；ntfy.sh、原生 Android ntfy，沿用既有 topic。
- 配套 APK、由 APK 控制的精确 15/30 秒节奏已退出当前范围。手机实际持续响铃行为以原生 app 的验证结果为准。

## 功能与证据

| 要求 | 当前结论 | 可检查证据 / 未覆盖范围 |
|---|---|---|
| H4 回落 2/3 根阴线、连续更低低点、收破前高；卖出镜像 | 自动验证通过 | test_domain.py：镜像、等号、十字星、低点中断、准备后等待；test_service.py / test_replay_capacity.py：长期准备状态与不可变证据 |
| M5 前日高低点双向首次突破 | 自动验证通过 | domain.advance、previous_session；缺失前日暂停，周末跳过，日历例外需明确证据 |
| 新建之后的事件、双向一次性、无下单 | 自动验证通过 | 严格 occurred_at > armed_at；事务信号/outbox唯一性与 PostgreSQL 并发测试；providers.py 仅读行情 |
| 自定义分桶与 DST | 已验证基础口径 | NY17/UTC0/DST测试；EURUSD、XAUUSD一个完整日与官方D1 OHLC实测匹配，见交付记录 |
| 节假日和维护 | 机制通过，真实日期未完成 | calendar_profile/admin、calendar-maintenance.md；全日跳过、部分交易日保留、缩短H4跳过、旧演练快照测试；还需账户适用官方公告 |
| 免费实时行情与延迟 | 有活跃时段证据，长期仍观察 | market-runtime-report.json：2小时、各120根M1；P95约24–27秒；欧元1次401已恢复，根因未确认；不代表全年稳定 |
| 断线、窗口内部缺口、重试恢复 | 自动验证通过 | test_recovery.py、test_market.py；缺口排队、租约接管、非空但不完整响应不得完成；完全无观测未知区间保守暂停 |
| 初始180天历史 | 正在执行 | ImportJob持久化游标/优先级；最新抽查87完成、458等待；全量完整性尚未验收 |
| Python可编辑指标 | 首个插件及接口通过 | TA-Lib SMA交叉、版本/参数快照、warmup/restart/回放一致性；递归/高低价指标扩展边界明确 |
| 网页登录、图表、策略、预警列表 | 浏览器通过 | web/tests/browser-smoke.mjs、indicator-browser.mjs；390px无横向溢出、无JS错误 |
| 演练日期/隐藏未来/步进/播放/定位/恢复/导出 | 核心流程通过 | replay-browser.mjs、test_replay_capacity.py；31233根真实M1预热性能已测；推进区间最多20000根，完整预热不截断 |
| 网页声音 | 浏览器音频流程通过，扬声器听感未实测 | sound-browser.mjs：真实AudioContext经点击后running，新信号启动音调，禁用/重复信号不响；浏览器内模拟信号，不证明实际设备音量 |
| ntfy主动测试接收、响铃、确认 | 手机实测通过 | 用户反馈和服务端确认回传；此前测试链路，不代表真实策略链路已实测 |
| 策略→outbox→重试→通知确认API | 自动串联验证通过 | test_strategy_retry_and_phone_action_round_trip：只有外部ntfy模拟，真实策略/DB/API；旧尝试凭证仍可确认、幂等、错误凭证拒绝、停止发送 |
| 真实策略→ntfy→手机→确认 | 未验收 | 需用户约定测试窗口，或用户主动开启的真实机会触发后检查；不创建未约定的响铃测试 |
| 原生手机长期锁屏、切换网络 | 未验收 | OPPO后台限制已记录；当前LAN回调离开局域网需VPN/公网路由，不能宣称公网可确认 |
| 夜间静音 | 服务端自动验证通过 | quiet_until/claim边界测试；原生app已开始的本地响铃无法由服务端保证远程停止 |
| 备份与恢复 | SQLite及独立PG实际通过 | alerts.backup、test_backup.py；0600、hash、事务快照、PG随机临时库恢复全部表计数、失败清理；同机备份不等于异机容灾 |
| 每日备份 | 工具/timer准备，实际定时未验收 | trading-alerts-backup.timer；网页最近状态/超时/失败显示已测；安装后需实际触发 |
| 部署、自动启动、进程异常恢复 | 未验收 | systemd units、install-only脚本、Linger=yes；当前服务未安装，进程仍由开发会话托管 |
| Docker/PostgreSQL正式运行路径 | 配置存在，未运行 | 本机无Docker；独立PG测试不能替代Compose整栈实际部署；当前在线业务库为SQLite |
| 版本及凭据管理 | 已检查 | 本地Git基线和增量提交；.env/db/artifacts/backups忽略；提交前扫描未发现当前秘密值 |

## 仍需要的外部协助

1. 在 quant 用户主机终端执行已提供的 systemd install-only 命令，返回结果。代理当前写入范围不包括 ~/.config/systemd/user。安装后由代理核对切换步骤，避免重复worker。
2. 提供 OANDA 所属公司或该账户适用的交易时段/假日公告。无需提供新的 token 或密码。
3. 约定真实策略手机验收窗口，观察通知、声音、确认及长锁屏/网络切换。未获得测试安排前不发送额外真实测试消息。

## 继续可做的工作

- 等待已确认运行的历史worker完成任务，检查失败/异常，核对全量覆盖。
- 完成系统服务切换、异常退出自动恢复与定时备份运行记录。
- 明确并落实最终数据库/部署路径；不把SQLite开发访问当作Compose部署通过。
- 每个手机/日历外部条件具备后进行对应验收，不以近似或模拟结果替代。
