# PostgreSQL 空闲开销优化建议

状态：用户于 2026-11-12 认可执行，本轮实施、开发部署及验收已完成。详见 [验收记录](postgres-idle-optimization-20261112-evidence.md)。延续不跟踪 CI、保留逐报价展示状态更新的要求。风险分类 F1：修改逐报价核心事务及后台派生链路，不修改 schema，须做 PostgreSQL 兼容/并发验证及独立 Standards/Spec review。

## 基线与目标

- 工作树 `/home/quant/repos/market-watch-idle-v2-20261112`，工作分支 `fix/idle-cost-v2-20261112`，代码/文档基线 `a344279e`，PR #134 head `fix/composite-idle-20261112`。
- Ubuntu Docker `mw-dev`，部署应用 `f301eb69`。当前任务只涉及开发实例，不合并、不打正式 tag、不操作生产。
- 前次 120.097 秒观测：PostgreSQL 单核 3.399%；其中行情请求后端 1.357%、数据请求 0.883%、通知请求 0.633%、checkpointer/walwriter 合计 0.025%，其余为统计、监听、短命进程及未归属差额。这是按后端连接的 CPU 归属，不是逐 SQL CPU。
- 同窗 7,616 commits、3,256 行更新、237 行新增、591,669 次缓存块命中和 27 次读取。读取主要由缓存满足；没有依据优先调整 shared_buffers 或削弱持久化。
- 保留每条接受报价的提交、Instrument/LiveState/临时 OHLC，保留告警事件、来源确认、顺序、ownership/epoch fencing 和恢复语义。
- 目标是降低无需求时的 SQL、历史重扫和派生状态更新；每步独立比较 CPU，不能把减少 BEGIN/COMMIT 次数本身当作成功。

## 顺序 1：通知新事件与兼容补偿分开（先做 F0）

证据：通知数据库后端约 0.63% 单核；当前 once 每轮运行 project、backfill，空轮还运行 reconcile_channels。project 没有新事件时仍对 2,137 个历史来源做 receipt 探测。

文件：`notification_center_worker.py`、`notification_center.py`，以及写入 notice_source 的来源 hook。

1. 先核对每个现行可靠来源和 browser intake 的提交通知；缺少的 hook 在原写入事务中补齐。回滚不通知，通知不代替持久记录。
2. 新事件到达立即投影，批满继续快速排空。把兼容历史 backfill 和通道 reconcile 从每次空轮移到启动扫描及独立的约 60 秒维护节拍。
3. 健康 LISTEN 连接且确实无任务时，兜底扫描可先取 30 秒；断连时保留约 2 秒退化轮询。最大等待还须满足该角色既有健康期限，停止可中断。新事件正常路径不等待维护计时器。
4. 这是不改 schema 的第一步，先实测；旧写入者没有 hook 时由补偿节拍发现，需明确该兼容路径的发现延迟变化。

验收：正常事件投影延迟不退化；提交/回滚、事件恰好落在扫描与等待之间、断连重连、重复投影、重启、旧来源补偿、通道状态变化和停止均正常。现有测试入口 `backend/tests/test_notification_center.py`、`test_notification_runtime.py`、`test_notice_reliability.py`，并补适用的 PostgreSQL 并发用例。

## 顺序 2：无任务与未到期时减少查询（F0/F1 按路径判断）

文件：`oanda_worker.py`、`live_pricing.py`、`native_history_loads.py`、`history_versions.py`、`provider_service.py`、`chart_history_worker.py`。

1. 复用现有 LISTEN/NOTIFY；按提交事件、最早 next_at、健康期限决定下一次扫描。已有实现不是从零增加监听，重点是减少仍存在的固定频率扫描。
2. 数据 worker 的 5 秒无任务扫描可先评估延长至 30 秒；market 角色依照更短的既有健康期限决定上限，不能统一套用 30 秒。活动任务、在途结算、故障重试和到期确认维持各自时限。
3. 将同类“有无待办”的发现尽量做成一个轻量 EXISTS/批量查询；不在只需判断有无时加载整个 ORM 对象。真正领取/写入仍用短事务，网络请求不放入持锁事务。
4. 确认循环先一次读取各数据集 next_confirm_at，只有到期项进入现有有锁流程；真正提交重新检查所有权与 epoch。保留 5 秒 lease guardian 和连接故障处理，不能缓存 owner 取代逐报价 fencing。

验收：首次新任务及时唤醒、未来重试到期、确认分钟、丢失提示后的兜底发现、恢复/交接和健康过期判断。主要入口 `backend/tests/test_oanda_worker_lifecycle.py`、`test_oanda_schedule.py`、`test_provider_service.py`、`test_runtime_health.py` 和 PostgreSQL recovery 测试。

## 顺序 3：逐报价事务内去重复（F1）

文件：`live_pricing.py`、`price_alert_inputs.py`、`display_observations.py`。

1. 复用同一事务已经读取的 dataset、instrument、日历结果和 state，减少重复取数、JSON/身份计算；优先使用事务内复用，不引入无失效控制的跨事务缓存。
2. handover 的持久完成标记在成功后可由当前 worker 记住；新 worker 启动重新读取，只缓存已完成的正结果。
3. 价格告警需求先精简查询。若仍是热点，再维护事务性消费者需求状态；必须覆盖首次注册、修改、启停、过期、重连，沿用 dataset 锁下注册与下一条观测的竞态保证。禁止仅凭短期“无告警”缓存跳过输入。
4. 每条报价保留现有提交边界和所有权检查，保留状态、临时 OHLC 和告警输入写入。暂不做跨报价小批量合并。

验收：每报价 SQL 数、CPU/quote、commit P95 降低；相同输入的接受/拒绝、OHLC、顺序和告警事件一致。覆盖瞬间穿越回落、同价新时间戳、跨分钟、乱序、重启、首次告警并发注册和 owner 交接。

## 顺序 4：组合接续目标按消费者维护通用派生数据（F1）

文件：`market.py`、`chart_aggregation.py`、`publication_schedule.py`、相关读取/需求入口。

- 先核对独立图表、告警、导出等全部使用者；对确实只有组合消费者的接续目标，保留来源确认 M1 和组合输入，停止无需求的通用高周期/发布派生。
- 独立需求出现后按需补齐，并正确报告 preparing/ready，不能展示过期结果为最新。
- 历史 gap correction job 保留，按输入内容或覆盖 generation 变化唤醒，避免无新证据仍被 discover 周期性重排。
- 验证组合全部周期和告警不退化、首次独立需求能恢复派生、历史纠正仍能重放。不是关闭实时来源或删除历史数据。

## 收益不足时再做：通知可索引待处理状态（F1）

第一步后若历史 anti-join 仍占明显 CPU，再在来源记录或独立待处理表维护可索引的 pending 状态。优先选择满足现有来源类型的最小实现，不同时增加两套状态。

- 来源写入和待处理登记同事务；投影、receipt 幂等记录及清除 pending 同事务。
- 兼容迁移有界补登记，已经有 receipt 的来源不重复通知；重启/崩溃可恢复。
- 不使用全局最大 Audit.id 作为消费游标：较小 ID 的事务可能更晚提交，简单游标会漏事件。
- 必测反序提交、重复提交、中途失败和重放。只有待处理查询的扫描量与 backlog 而非历史总量相关，才算完成。

## 执行与验证约定

执行前重新只读核对实例、分支和工作区，保留用户改动；所需数据库测试使用本任务独立 PostgreSQL，不向 mw-dev 写入测试事件。创建测试资源前检查端口、内存、磁盘和其他任务；新镜像仅使用 `mw-docker`。

先按本步改动选择最小测试组，例如：

```bash
cd /home/quant/repos/market-watch-idle-v2-20261112
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest -q \
  backend/tests/test_notification_center.py \
  backend/tests/test_notification_runtime.py \
  backend/tests/test_notice_reliability.py
```

持久化/并发修改再使用任务私有测试数据库跑对应 `_postgres` 测试；凭据不写入本文件或日志。Schema/核心路径按 F1 做相应迁移与独立 review。不能因未设置数据库而跳过 PostgreSQL 用例后声称全部通过。

每步完成后运行三段至少 5 分钟的同窗观测，记录 PG 容器/后端 CPU、SQL/扫描量、事务和行变化、报价数、确认数及功能时延；至少覆盖一个分钟边界。未开启 SQL 汇总扩展时明确该项缺失，使用限定范围的 EXPLAIN 和应用调用计数补证，不能冒充逐 SQL CPU。

空闲场景保持 3 条实时来源、0 浏览器/订阅/active 告警；另做有告警、打开图表、重启恢复场景。若报价漏失、OHLC/告警不一致、所有权失败、健康误判或发现延迟不可接受，停止推广该步并保留证据。CPU 改善且功能通过后再进入下一步。暂不承诺 PG 固定降到某个百分比；不跟踪 CI，不合并、不发布生产。

## 实施边界补充

- 无独立消费者的接续目标保留来源 M1 和组合输入，通用聚合 dirty range 按最多 1,440 分钟合并留存，不删除纠正依据。独立图表、有效告警、视口、历史维护或导入需求恢复时补齐。仅显式关闭 managed_realtime 且存在接续 mapping 的目标可暂停；源历史根和普通品种不受此条件影响。
- 首次读取提交短期派生需求后返回 DERIVATION_PENDING；同一数据快照内再次检查屏障，状态接口返回 preparing。逐报价提交、展示状态和 owner/epoch 检查保持逐条执行。
- 本轮先以回归测试逐项验证，再统一部署并做三段五分钟观测；未对各阶段分别部署测量，因此只能报告整组收益，不能将总体差值归因到单项。history_versions 和 market 角色短健康期限的循环本轮保留原节拍。未引入通知 pending 新表或迁移。
