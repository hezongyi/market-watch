# 系统消息可靠性修复验收

2026-10-22。按 `/tmp/mwa-three-issues-plan-20261022/analysis-and-plan.md` 实施；原方案归档在 `docs/notice-reliability-plan-20261022.md`。本次分类 F1：重要行情后台链路和可恢复浏览器草稿格式，新增兼容 JSON，无数据库 schema 迁移。

## 候选与现场

- Worktree：`/home/quant/repos/market-watch-notice-reliability-20261022`
- Branch：`fix/mwa-notice-reliability-20261022`，基线 `42a1b71`。
- 最终 API/10 个 worker、Web 从干净源码 `1ba2b33` 构建；Chart 从干净源码 `0bd610e` 构建，包含 `9055f2a` 的草稿RPC防饥饿修复。中间 `8cde2f1` 补充大小写通知 ID 查询兼容和一致验收影子状态。
- 实际主机 Ubuntu `quant-server`，长期验收 project `mw-issue75-v2-20261018`，主入口 https://192.168.7.232:18280 ，图表 origin https://192.168.7.232:18281 。确切镜像见 `images.json`。
- 15 服务运行，API/PG healthy；替换 13 个应用服务，PG/gateway 保留。环境、挂载、网络和端口逐项一致，见 `runtime-audit.json`。无 seed、迁移、reset 或数据卷替换。
- 启停/查询：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|stop|status`。
- 私有初始回退：`/home/quant/repos/.mwa-notice-reliability-20261022/operate.py rollback`，须同时恢复其 `previous-candidate-override.json` 到持久 manager 的 `candidate-override.json`。C3 仅回到本轮上一候选使用同目录 `c3/operate.py rollback` 及 `c3/previous-candidate-override.json`。C4仅回到C3的Chart使用 `c4/operate.py rollback` 及该目录 `previous-candidate-override.json`，其他组件保持；不使用历史 manager 默认整栈回退。

## 实现行为

1. OANDA 确认窗口增加默认 15 秒余量；采样与分钟确认健康分开，只允许相同操作、覆盖原故障区间的确认成功结束确认故障。错误证据仅包含安全枚举/状态/窗口，不保存供应商任意正文、URL 或凭据。
2. 设置冲突文案与工作区冲突分域。本地草稿入队前持久化，每个文档独立 writer；重开可发现各 writer 草稿。恢复使用明确选择、远端 CAS、本地版本校验和旧 widget 冻结。采用服务器仅结束对应观察，不假报原写入成功。工作区保存确认和放弃只处理确切自有草稿版本。
   设置成功广播revision提示，未触及key重读服务器；不改变旧widget已观察内容的基线。未开始执行的同key回调合并，最新草稿仍立即持久化。设置RPC复用现有两个管理槽，四个慢行情请求不会阻塞草稿落盘/恢复；第三个管理RPC仍排队，不增加行情并发。
3. 未建立组合订阅返回特定 `COMPOSITE_NOT_ESTABLISHED`，观察者等待真实建立后重新核对。取消/世代变化不复活旧观察者，不隐式创建组合。明确 `/market-data/composites/use` 成功后，独立数据中心及嵌入式RPC均广播建立事实提示，再核对真实readiness。
4. 新通知保存名称快照；历史通知批量只读解析，列表/详情/气泡使用相同名称。组合增加短 ID 辅助区分；名称、斜线/大小写及前缀 ID 搜索在分页前过滤。名称不参与身份、去重及恢复关联。

## 已完成验证

- 最终相关后端回归 **171 passed**（notice reliability、live pricing、market notices、notification center、advanced preferences、series access、OANDA REST/recovery、market stream API/quotes）。新增时间偏移/延迟、故障通道隔离、安全证据、名称分页/权限/快照、大小写 ID 和无副作用订阅用例。
- 真实模块 Node 回归：notice-reliability、advanced-preferences、advanced-preferences-conflict、advanced-provider-subscriptions、notifications-runtime、api-read-recovery、preference-request-queue；TypeScript 检查、生产 Web/Chart/API 构建和 diff 检查通过。
- 核心实现及最终增量均经独立 Standards/Spec 复审，无剩余阻断项；发现的草稿丢失、跨 writer 清理、订阅丢唤醒均已修复。最终补审固定范围 `152dab9...9055f2a`，两轴均为0项发现，三个相关 Node 模块独立复跑通过。见 `review.md`。
- 全新 Playwright context 真实登录 mwa。自建/组合 EURUSD 日线的 Swing、EMA、RSI 原生数值有效；深浅主题 1440/390/375px、刷新、历史详情正常；指标悬浮窗保持取消。见 `chart-browser.json`。
- 真实原生草稿对话框验证远端版本变化自动刷新差异、提交本地/采用远端、旧 widget 回调阻断、重开提示。实际 EURUSD/XAUUSD/USDCAD 历史名称和 EUR/USD/eurusd 搜索通过，无 pageerror。见 `notice-browser.json`。
- 验收 helper 在临时 context 拦截工作区/设置/通知写入，偏好模拟 GET/写入共用影子 Map；未连接受保护 profile。最终两项browser验收服务端工作区revision75前后一致、偏好一致。此前指标检查期间工作区68→69有外部写入，因此不宣称整个时段服务端始终无变化，不回写用户现场。
- 原基准198条组合消息全部在实际PostgreSQL只读事务中解析成功：EURUSD103、XAUUSD77、USDCAD18，按四类注册表批量读取4次；三类详情与批量名称一致，身份/消息body/处理状态及组合/需求计数不变，见 `all-198-readonly.json`。
- 实际 PostgreSQL 只读运行新名称 SQL；载入基线42a1b71旧snapshot模块读取新增JSON后的现场通过，见 `old-reader-compatibility.json`。这不是完整旧镜像写入兼容验证。
- 主机时钟原先快约6秒；经无后退跳时的渐进校准，timesyncd持久使用已验证的字面NTP地址。独立30次主机同步采样全部同步，见 `clock-boundaries.json`。这与下面的行情观察是不同检查。

## 明确的验证边界

- **用户在2026-10-22明确要求跳过30分钟观察。** 实际行情只进行了17个分钟边界采样：同步正常，采样/确认错误字段未出现故障，确认游标持续推进；保留原始 `live-boundaries.json`，不表述为完成30分钟验收。最终复验期间另有真实网络错误：一次有界日志抽样计2次504、7次读取超时、0次400；当时三个源采样及确认已恢复正常。这些网络故障不归为future-to边界问题，短时成功不能保证供应商今后不发生504/超时。
- 独立 PostgreSQL R1最初被负载门槛阻止；主机负载自然下降后经标准工具启动，现已完成 **29 项既有并发/故障注入回归 + 6 项新增持久契约回归，全部通过**。每项测试使用任务库内独立随机schema。临时实例已停止，数据卷及私有配置保留；没有绕过资源门槛、借用其他任务数据库或停止他人实例。见 `postgres-verification.json`。
- 采用远端只结束能匹配当前profile/workspace/上下文的原观察。跨workspace/刷新后不匹配的历史失败不会被批量结案；不声称所有历史设置事故自动恢复或处理。
- 历史无法解析的名称仍显示类型与短ID。通知历史、未读/处理状态保持既有语义；未批量标记已读/处理。
- 本次未提交PR、未推送、未合并main、未创建正式tag、未发布生产。保留当前专用分支，供用户控制后续集成频率。


最终逐项核对见 `completion-matrix.md`。本轮实现、适用验证和最终增量独立复审均已收口；30分钟观察按用户指令跳过。最终Chart追加修复后的Playwright再次通过。补审未修改产品代码或重新部署；当前候选保留，等待用户决定提交PR的时间。
