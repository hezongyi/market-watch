# 系统消息可靠性修复验收

2026-10-22。按 `/tmp/mwa-three-issues-plan-20261022/analysis-and-plan.md` 实施；原方案归档在 `docs/notice-reliability-plan-20261022.md`。本次分类 F1：重要行情后台链路和可恢复浏览器草稿格式，新增兼容 JSON，无数据库 schema 迁移。

## 候选与现场

- Worktree：`/home/quant/repos/market-watch-notice-reliability-20261022`
- Branch：`fix/mwa-notice-reliability-20261022`，基线 `42a1b71`。
- Web/Chart 干净构建源码 `e0b2ecd`；最终 API/10 个 worker 干净构建源码 `1320035`。中间 `8cde2f1` 补充大小写通知 ID 查询兼容和一致验收影子状态。
- 实际主机 Ubuntu `quant-server`，长期验收 project `mw-issue75-v2-20261018`，主入口 https://192.168.7.232:18280 ，图表 origin https://192.168.7.232:18281 。确切镜像见 `images.json`。
- 15 服务运行，API/PG healthy；替换 13 个应用服务，PG/gateway 保留。环境、挂载、网络和端口逐项一致，见 `runtime-audit.json`。无 seed、迁移、reset 或数据卷替换。
- 启停/查询：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|stop|status`。
- 私有初始回退：`/home/quant/repos/.mwa-notice-reliability-20261022/operate.py rollback`，须同时恢复其 `previous-candidate-override.json` 到持久 manager 的 `candidate-override.json`。C2 仅回到本轮首候选使用同目录 `c2/operate.py rollback` 及 `c2/previous-candidate-override.json`。不使用历史 manager 默认整栈回退。

## 实现行为

1. OANDA 确认窗口增加默认 15 秒余量；采样与分钟确认健康分开，只允许相同操作、覆盖原故障区间的确认成功结束确认故障。错误证据仅包含安全枚举/状态/窗口，不保存供应商任意正文、URL 或凭据。
2. 设置冲突文案与工作区冲突分域。本地草稿入队前持久化，每个文档独立 writer；重开可发现各 writer 草稿。恢复使用明确选择、远端 CAS、本地版本校验和旧 widget 冻结。采用服务器仅结束对应观察，不假报原写入成功。工作区保存确认和放弃只处理确切自有草稿版本。
3. 未建立组合订阅返回特定 `COMPOSITE_NOT_ESTABLISHED`，观察者等待真实建立后重新核对。取消/世代变化不复活旧观察者，不隐式创建组合。
4. 新通知保存名称快照；历史通知批量只读解析，列表/详情/气泡使用相同名称。组合增加短 ID 辅助区分；名称、斜线/大小写及前缀 ID 搜索在分页前过滤。名称不参与身份、去重及恢复关联。

## 已完成验证

- 最终相关后端回归 **167 passed**（notice reliability、live pricing、market notices、notification center、advanced preferences、series access、OANDA REST/recovery、market stream API/quotes）。新增时间偏移/延迟、故障通道隔离、安全证据、名称分页/权限/快照、大小写 ID 和无副作用订阅用例。
- 真实模块 Node 回归：notice-reliability、advanced-preferences、advanced-preferences-conflict、advanced-provider-subscriptions、notifications-runtime；TypeScript 检查、生产 Web/Chart/API 构建和 diff 检查通过。
- 独立 Standards/Spec 复审无剩余 P1 或合并阻断；发现的草稿丢失、跨 writer 清理、订阅丢唤醒均已修复。见 `review.md`。
- 全新 Playwright context 真实登录 mwa。自建/组合 EURUSD 日线的 Swing、EMA、RSI 原生数值有效；深浅主题 1440/390/375px、刷新、历史详情正常；指标悬浮窗保持取消。见 `chart-browser.json`。
- 真实原生草稿对话框验证远端版本变化自动刷新差异、提交本地/采用远端、旧 widget 回调阻断、重开提示。实际 EURUSD/XAUUSD/USDCAD 历史名称和 EUR/USD/eurusd 搜索通过，无 pageerror。见 `notice-browser.json`。
- 验收 helper 在临时 context 拦截工作区/设置/通知写入，偏好模拟 GET/写入共用影子 Map；未连接受保护 profile。最终草稿验收服务端工作区 revision73 前后一致、偏好一致。此前指标检查期间工作区68→69有外部写入，因此不宣称整个时段服务端始终无变化，不回写用户现场。
- 实际 PostgreSQL 只读运行新名称 SQL；载入基线42a1b71旧snapshot模块读取新增JSON后的现场通过，见 `old-reader-compatibility.json`。这不是完整旧镜像写入兼容验证。
- 主机时钟原先快约6秒；经无后退跳时的渐进校准，timesyncd持久使用已验证的字面NTP地址。独立30次主机同步采样全部同步，见 `clock-boundaries.json`。这与下面的行情观察是不同检查。

## 明确的验证边界

- **用户在2026-10-22明确要求跳过30分钟观察。** 实际行情只进行了17个分钟边界采样：同步正常，采样/确认错误字段未出现故障，确认游标持续推进；保留原始 `live-boundaries.json`，不表述为完成30分钟验收。短时成功不能保证供应商今后不发生504/超时。
- 独立 PostgreSQL R1已prepare，但工具因主机5分钟负载超过4拒绝up；**没有创建该任务容器/网络/数据卷，也没有运行独立PG并发/故障注入回归**。没有绕过资源门槛、借用其他任务数据库或停止他人实例。任务配置保留于私有previews目录。
- 采用远端只结束能匹配当前profile/workspace/上下文的原观察。跨workspace/刷新后不匹配的历史失败不会被批量结案；不声称所有历史设置事故自动恢复或处理。
- 历史无法解析的名称仍显示类型与短ID。通知历史、未读/处理状态保持既有语义；未批量标记已读/处理。
- 本次未提交PR、未推送、未合并main、未创建正式tag、未发布生产。保留当前专用分支，供用户控制后续集成频率。
