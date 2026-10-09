# 统一行情订阅实施前置核对

2026-10-08；实施依据为 `market-data-unified-subscriptions-plan.md`。

## 已核实环境

- 独立分支 `feat/unified-market-sse-20261008`，worktree `market-watch-unified-sse-20261008`，起点 `6fd9273`。原工作区未跟踪方案已复制，原文件保留。
- SSH 只读核实：生产 API / worker 镜像 `market-watch-api:v1.14.2-ccc7e0a`，web / chart-origin `v1.14.1-6fd9273`。API 命令为单 uvicorn 进程；另有 realtime、pricing、native-history、history、composite-aggregate、chart-aggregation、chart-history、notify worker。
- `git diff 6fd9273 ccc7e0a` 显示业务差异集中在 OANDA 连接/报价落库/worker、历史保留及 managed 历史计划。统一订阅涉及的 chart_api/provider_service/composite_series/series_access 无该版本差异。实施不回退生产的 OANDA 修复；发布准备时必须再核对目标基线。
- Ubuntu Docker socket 当前拒绝 quant 访问（permission denied）。已请求用户配置本机权限；未部署任何本任务实例，未测量运行基线。不得将静态分析当作成本测量。

## 唯一计算归属与恢复

统一行情 worker 承担结果计算；API 仅认证、登记消费者、续租及读取已提交结果。使用现有 PostgreSQL 与租约模式，不增加消息中间件。每个稳定计算键对应一个持久任务，领取采用行锁/skip locked，提交检查租约 token；同键跨页面、连接与 API 进程共享。计算键包含解析后的系列身份、显式固定或跟随绑定、周期及指标规格/递归起点，不含客户端窗口。

持久结果带单调序号和有界恢复记录。worker 的当前 bucket 状态在内存中保存；接管时按权威固定输入重建一次，不把内存缓存宣称为唯一计算归属。报价更新替换临时分钟；确认/修订按 immutable input delta 更新，bucket 边界重建，失效及消费者释放回收。恢复记录不足、绑定改变、历史窗口修订要求 reset；不得用最近三根承担任意断线恢复。

## 触发源与消费者状态

| 路径 | 权威变化凭据 |
| --- | --- |
| 平台 | ProviderDataset revision、ProviderBar changed_at、覆盖/元数据失效、采集 error |
| managed | Bar revision/volume_revision/received_at、发布状态/历史计划、日历身份 |
| 固定 history | 固定 manifest/checksum、周期产物准备及指标 run cursor/status |
| composite | active_revision_id（跟随绑定）、CompositePreparation input_revision/status/cutoff、CompositeMinuteInput delta、LiveState revision/epoch/forming、PricingOwner token/epoch/expires、账户身份及时间新鲜度 |
| 指标 | 完整计算规格及递归起点、固定指标 run/cursor/status、确认输入修订与临时替换 |

Loaded range、游标、首读凭据、客户端世代和 reset 确认存于消费者行；复用现有 history_check 规则逐窗口判断，不进入共享实时计算键。SSE 心跳只续有效消费者租约，不能证明价格新鲜；会话需持续有效。取消使用世代 CAS，注册幂等，断线有界宽限。浏览器需求独立于预警/策略/维护需求。

## 仅报价采集迁移点

`market_data.router.quotes` 当前 provider 分支调用 `provider_chart.quote_page` / `quote_previous_close`；Yahoo 调用 `provider_service.yahoo_quote`，其缓存仅进程内、按请求过期。统一报价任务将这些调用移至独立后台按来源 poll_seconds 调度，快照由数据库共享，纯报价不创建全周期 ProviderInterest 或历史预热。组合报价复用 composite_quotes 的账户/owner/epoch/新鲜度/接缝校验并维持单独 MarketDemand；不隐式 first_use。managed 沿用 M1 需求，固定 history 保持固定版本。

## 待运行验证

权限恢复后使用专属 mw-docker task/project、网络、PG volume 和端口建立 Ubuntu 基线。记录 W1/MN 原路径 M1 扫描与日历检查次数、指标成本，随后同输入差分和跨进程验证。当前尚未有延迟、CPU、SQL 或容量结论。
