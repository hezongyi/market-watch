# 第三候选：公平等待与告警截止时间调度

2026-10-07 16:49 SGT。依据两个专项交接分析实施；数值门槛保持 acceptance-thresholds.md。当前未完成 PostgreSQL/全量/性能/消费者/浏览器验收，不代表 Issue #13 收口。

## 发布调度与恢复

- `ap43_publication_service_order` 新增 `last_service_seq` 及 PostgreSQL 全局 sequence。新、旧目标首次序号均为0，首次服务后排到队尾；墙钟 `served_at` 仅用于观测。SQLite 使用其单写者事务中的全局最大序号。序号允许回滚空号，不持有全局服务锁。Instrument→state 锁序、generation 条件更新和原子发布保留。
- 成功/失败共用队列状态返回；每目标失败退避期间，健康就绪目标继续短间隔运行。持续新输入保留失败目标的退避及 pending generation。无法取得任何目标锁时返回100ms后再试，不零等待忙转；无目标时每2秒检查，最近到期可提前唤醒。
- 每 cycle 共用4096源行额度及75ms合作式截止时间，其中1500行预留给一个完整日桶的来源聚合。发布目标页先固定最多384源成员；尾部探测、修订及旧页共同扣减额度。历史页及随后聚合各保留一次完整小片机会，防止固定尾页/发布先行永远耗尽deadline而饿死历史/聚合；超过截止时间不再执行额外片。覆盖迁移每次64证据行，显式全量核对仍属维护操作。没有把 Python 截止时间表述为可抢占 SQL 的严格执行上界；完整原子片可能超过75ms，必须实测整轮等待。
- 聚合按完整目标桶拆成约120分钟片；H4/D1每片最多一个目标桶。源读取从所有完整目标桶界计算，不为小周期每次读取整日。剩余任务在同一事务保存并继承原等待年龄，与同范围已有任务合并并保持price>volume>observed优先级；新输入可重新创建已经处理的范围，不丢修订。

## 告警调度与计时

- `alert_monitor.run` 为生产和探针共同入口：chart alert step→composite watch step，单调时钟控制1秒目标截止时间。无重叠；错过轮次合并，超预算轮等到下一未来截止时间；异常至少等待一个周期。尚未根据未运行数据缩短周期。
- 每条evaluate单独取得业务时间；可选观测回调在该条事务提交后执行，记录读取开始、评价结束、提交窗口及确切sequence/health/count。探针不再把轮首业务时间或整轮完成时间当成每条判断时刻，也不在监控循环做十条额外状态查询。
- 原330秒同价/stale恢复和120秒TCP触发窗口保留。新增330秒持续正常M1输入：十身份×31批=310个确切marker，含同价、新分钟、价格/量修订；作为额外窗口，不替代原窗口。
- 可见时刻记录前一次未见查询开始与首次见到查询完成的区间；判断使用独立事务提交窗口。数字认证采用保守延迟上界，原观测差值包括负值仍保存，避免静默截零。

## 公平性计量

长测每轮记录所有就绪目标年龄、服务开始与完成等待；终态仍就绪目标单列右删失区间，不计0秒通过。专项90目标探针持续重新请求已服务目标，运行30秒并要求至少两完整轮，不仅看首次服务。混合回填探针也保留终态未服务目标；记录锁等待不删除其分母。

## 当前验证

- 相关SQLite回归87 passed（34.20s），Ubuntu独立只读源码容器，0.75CPU/768MiB。
- 新增恢复/排序/失败隔离/监控时钟相关25 passed（8.98s）；与上述有重叠，不能相加当作独立测试总数。首跑两个失败为测试fixture的数字格式和选择次序假设，保留私有日志；修正数字比较和明确老化次序后通过。
- 专项agent复核发现两条预算饥饿路径后已修正；28 passed（9.96s）覆盖过期预算下真实历史页进展、慢发布下持久聚合继续服务、采集回调失败不改已提交health。另33项聚合/生命周期/告警合同通过。b2cb5d2初次冻结保留，最终验证使用后续修复冻结，不能将初次快测归为最终PG/长测通过。
- backend与新增迁移ruff通过，Python编译及diff whitespace通过。
- 小型逻辑回归与旧r2测量有宿主竞争；其日志保留，不声明旧测量无其他负载。重型PG/全量/性能/消费者严格串行。
- r2全量1356 passed / 2 skipped / 65 warnings，778.23s；这是599b043，不验证本候选。r2首两回填最长等待22.794/28.924s超10s，实时1.403/1.917s；原始样本继续保留。
- 17:12 SGT更新：r3产品220b328真实PG首轮135 passed/5 failed，失败是迁移HEAD常量和失败返回truthiness旧断言；日志保留，PG已停止，未进入性能。测试修正冻结8e06535（产品backend与220b328相同），新独立project `mw-issue13-optimized-r3b`、port19663真实相关回归140 passed/26 warnings（105.03s），完整后端运行中。不得把正在运行的全量或性能标为通过。

## 隔离环境与下一步

r3使用Ubuntu Compose project `mw-issue13-optimized-r3`、端口127.0.0.1:19653、独立network/pgdata volume/database。配置 `optimized-r3.compose.yaml`，私有env `/tmp/market-watch-issue13-optimized-r3.env`；准备不等于启动。冻结源码后等待r2完成并停止，再执行真实PG/全量、新12样本及消费者/浏览器。浏览器地址仍为独立任务的 https://192.168.7.232:19635（chart origin :19636）；目前未启动。未推送、未部署生产，禁止在unraid创建开发/验收实例。

首轮r3停止后当前实际运行的是project `mw-issue13-optimized-r3b`、PG 127.0.0.1:19663，独立volume/network及私有env `/tmp/market-watch-issue13-optimized-r3b.env`，源码 `/home/quant/repos/market-watch-issue13-r3d-baseline`（8e06535）。启动/停止使用 `sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized-r3b.env -p mw-issue13-optimized-r3b -f docs/verification/issue-13/optimized-r3b.compose.yaml up -d --wait postgres'` / 同前缀 `stop postgres`，仅本任务资源。在测量中不要手动停止；串行驱动 `/tmp/mw-issue13-r3b-driver.py`负责生命周期与private logs，公开阶段 `results/optimized-r3b/validation-state.json`。失败候选19653卷保留，未删除其他资源。
