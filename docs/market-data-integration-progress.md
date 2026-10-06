# 行情接入接续开发记录

日期：2026-10-06。工作区 `/home/quant/repos/market-watch-data-integration`，分支
`feat/market-data-integration`；`git fetch origin` 后基于 `origin/main` 的 `3c18f60` 创建。
主工作区与其他任务的未提交文件保持原样。正式方案由原文档 worktree 复制保留，原件仍在。

## 已恢复决策与当前边界

主历史采用 dukascopy-python；实时为 OANDA practice；首批 EURUSD/XAUUSD；外汇/黄金回测
只读单一 Dukascopy 数据集。MT4 在其活跃终端验收后才可参与互备。保留 Binance、yfinance 的既有能力。
当前完成 P0 首批代码及离线验证，尚未达到 P0 运行验收门槛；P1/P2/P3 尚未实施。

本会话范围更新：用户要求完全实现并真实验收；随后明确 **MT4 实时接入留到后续**。
当前目标为 P0–P2 全部实现与验收，P3 不列入本次完成门槛。下面初始 P0 记录保留作历史，
本节更新为最新状态。

## P1 与 P2 接续实现（2026-10-06）

- 新增 `dukascopy_history.DukascopyHistory`，锁定 SDK 4.0.1；复用其请求构造、JSONP 解码和
  行迭代，以独立 SDK 模块实例绑定传输。每次调用最多 5000 行、一个实际请求、明确 start/end；
  不调用无终点 fetch、不积累无界 DataFrame、不修改全局 requests/SDK。
- SDK 原始 `_stream` 的第二页空数组索引及隐式重试问题由有界传输停止处理；HTTP 失败直接返回
  结构化结果，不由 SDK 重试或转成空成功。Decimal 精确解码，UTC 半开裁剪，页检查点递增。
- `history_versions` 建立月窗口固定截止任务、持久检查点、带 token/到期验证的任务租约、退避及
  共享冷却。每个已提交页面与 managed M1 同事务写入 gzip 不可变分块；失败不推进 cursor。
  成功空页允许记录查询进度，但未知分钟写入分块，不认证观测覆盖或休市。
- 发布时验证分块连续查询分区与 SHA-256 内容清单；ORM 禁止删除/修改分块及已发布版本。
  新导入修订产生新版本，旧版本内容不变。`t21_history_snapshots` 迁移已有数据时拒绝破坏性降级。
- `/api/market-data/datasets|inventory|versions` 增加经过现有认证的查询/任务入口。
  `/api/replays` 支持来源限定品种，显式数据集必须指定已发布 `dataset_version`；历史聚合、
  warmup、前日数据均从所选版本读取，seek 保留版本及 manifest；`u22_replay_dataset_version`
  增加来源信息，已有 pinned replay 时拒绝丢弃 manifest 的降级。仍需前端提供版本选择界面。
- `OandaPractice` 使用独立 REST/stream 客户端。账户范围 BID/smooth=false/complete M1，
  五秒收盘保护，严格数据窗口与账户指纹校验；NDJSON 增量 UTF-8 解码支持跨 chunk、多行、
  单侧无流动性、心跳及大小上限，不使用 stream 消息数当 volume。
- 修复 `market_resources.acquire` 对非 Yahoo 来源没有执行已写入 cooldown 的问题；
  所有来源/通道现均在冷却期拒绝新请求，历史任务与实时请求仍共享既有预算。
- 最近全量后端回归 573 passed、39 skipped；随后新增 SDK 预算超时和 replay 迁移保护，
  对应定向回归 20 passed。两个新增迁移均为单头；Ruff、diff 空白检查及 Compose 静态解析通过。

## 本轮真实只读探测证据

这些是 Ubuntu 本机有限只读 SDK/API 探测，没有启动开发服务、Docker 实例、通知或交易。
脚本复用后端配置，仅输出公共行情与品种规格，不复制/提交 `.env`、账号标识、token 或代理地址。

- [Dukascopy 两品种采样](verification/data-integration/dukascopy-samples.json)：EURUSD/XAUUSD
  分别查询近月、2016 年、跨年、DST 周四个 15 分钟窗口。六个窗口各 15 根；两个跨年窗口
  成功空页，保持 unknown。实际非零价格位数为 EURUSD 5、XAUUSD 3；原始 JSON 有六位尾零。
  这证明选定 SDK 与这几段真实数据可用，不证明十年完整性、来源全部日历或全量吞吐。
- [OANDA practice 探测](verification/data-integration/oanda-stream-probe.json)：实际账户目录有
  EUR_USD/XAU_USD，displayPrecision 分别 5/3；账户范围 candles 各返回 5 根完整 M1。
  一条共享 stream 75.045 秒返回 EURUSD 32、XAUUSD 169 个价格、14 次心跳，两品种 tradeable。
  来源到接收价龄 p50/p95/p99 为 EURUSD 269/538/581ms、XAUUSD 231/393/436ms。
  尚未校准独立时钟误差，不将该短样本称为 SLA、两交易日或 M1 收盘延迟验收。

## 最新未完成项

- Docker socket 仍无权限，未启动 PostgreSQL 验收库，也未完成升级/备份恢复的真实验证。
- 尚无后台 OANDA 采集拥有者租约与世代 fencing、常驻/需求订阅并集、REST 收盘确认重试调度、
  断线恢复、同源指标预热、恢复期间不补发过期通知、共享防重及故障降级运行链路。
- 尚未完成浏览器来源/环境/确认/降级状态、SSE 快照与断连恢复、历史版本选择及原生图表接入。
- 尚未全量下载约十年历史、验证源日历/精度元数据、清点实际存量；两交易日并发/时效测量与
  401/429、断线、进程重启等故障注入尚未执行。目标保持 active，不能按短时探测标记完成。
- MT4 按用户指令留待后续；本次故障行为应是 OANDA 降级，不接入备用。

## 基线审计与实现

- 原方案引用 v1.7.0；新基线增加了平台原生历史缓存、后台任务、指标契约，managed M1 的来源字段
  及入库结构仍适用。平台缓存已有独立 `ProviderDataset`，本次不重算其键或迁移其缓存。
- 旧 `Instrument.id` 同时关联 K 线、覆盖、维护任务、预警、回放和图表引用；不能把旧 EURUSD
  改成 Python/OANDA 的新含义。新增 `market_datasets` 一对一绑定新 Instrument，旧数据没有自动映射。
- 新身份包含 source/channel/environment/account_scope/provider_symbol/basis/calendar_version。
  账户范围仅允许 public 或 SHA-256 指纹；`MD:<身份摘要>:<逻辑品种>` 保留现有图表 ID 长度约束。
- 注册默认 disabled；同名不同来源分别存储。完整身份、精度和 volume 语义入库前校验；绑定后禁止
  ORM 修改或删除身份及关键品种元数据。此保护不替代数据库管理员对直接 SQL 的控制。
- `CandleBatch` 为 UTC 毫秒半开有界窗口，价格/量用十进制字符串，拒绝重复、逆序、范围外、
  非有限值、无效包络和精度溢出。空返回不生成覆盖；临时柱不生成已确认分钟覆盖。
- 请求结果区分 data/empty_success/rate_limited/unauthorized/timeout/unavailable/invalid_payload；
  陈旧价格仍可属于成功请求。错误分类保留 Retry-After，安全错误不输出 URL/响应正文。
  这些契约供下一阶段 Adapter 使用，尚未替换所有旧采集入口的错误行为。
- 增加 Quote/Health/SourceSelection 契约；当前没有流拥有者、健康调度或自动切源运行逻辑。
- 黄金日历判断使用逻辑显示品种，覆盖来源限定的 ID、聚合、图表及回放。沿用现有日历规则不等于
  已证明 Dukascopy/OANDA 官方会话；正式导入前仍须验证具体来源日历。
- 显式 managed 数据集不能通过 MWP 变成平台原生别名。P1/P2 接入前不将新数据集开放为自动维护目录。

## 迁移与回滚

`s20_market_datasets` 是单头的增量迁移，前置为 `r19_native_history_loads`；不修改旧 Instrument/Bar。
旧数据清点使用 `market_datasets.legacy_inventory(db)`，只输出来源元数据、数量与映射状态，
不读取价格、账户标识或凭据。当前仅清点测试数据库；实际部署存量尚未审计，不能推断其来源。

验收库须先验证迁移前备份可恢复，再应用迁移。空映射可以 `alembic downgrade r19_native_history_loads`；
已有显式映射时降级主动拒绝删除身份，必须停写并恢复本实例的迁移前备份。
不得以删除绑定、修改旧 source 或继续启动旧 Adapter 来绕过保护；新版本日历也应注册为新身份。

## 实际验证与环境

- 实际主机：Ubuntu 22.04.5 LTS。本 worktree 新建 `.venv`，按 `requirements.lock` 安装依赖；
  测试使用 `PYTHONPATH=backend`，不从其他工作区导入业务代码。旧主工作区 venv 缺 yfinance 的初次
  回归失败已通过独立依赖环境解决。
- 最终全量后端回归：544 passed，39 skipped，1 个现有 Starlette 弃用提示；跳过项目包括 PostgreSQL/
  需额外环境的验证。契约及身份定向回归：67 passed，新增 PostgreSQL 验收用例 1 skipped。
  无凭据证据见 [全量回归](verification/data-integration/backend-tests.txt) 和
  [契约回归](verification/data-integration/contracts-tests.txt)。
- 所有变更 Python 文件 Ruff 通过，`git diff --check` 通过，`alembic heads` 为 `s20_market_datasets`。
- SQLite 验证两次迁移升降、保留旧历史、已有映射拒绝降级；不等于 PostgreSQL 运行验收。
- Ubuntu Docker socket 实际返回 `permission denied`；当前策略不允许申请提权，已请求用户配置本机
  权限。没有启动容器、运行迁移到服务数据库或连接 OANDA 账户；没有服务访问地址。

## 已准备的隔离验收命令（尚未运行）

[Compose](verification/data-integration/compose.yaml) 使用项目 `market-watch-data-integration`，
独立默认网络、`integration-postgres` volume、PostgreSQL 数据库；不发布端口、不加载生产 env，
不启动采集/通知 worker。`verify` 包含实际 PostgreSQL 新数据集注册/入库/回滚保护测试。
权限可用后，在此 worktree 执行以下命令；密码仅在当前终端环境生成，不提交仓库。

```bash
export MW_DATA_TEST_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
docker compose -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml up --build --abort-on-container-exit --exit-code-from verify verify
docker compose -p market-watch-data-integration -f docs/verification/data-integration/compose.yaml down
```

停止命令保留该项目 volume；重复启动须使用相同测试密码。仅在确认归属且已不再需要验收数据时，
可对这个明确的项目执行 `down --volumes`。不得全局 prune，不能转到 unraid 运行这些实例。

## 下一阶段

先完成上述本机 PostgreSQL 验收与实际存量映射审计；再接入 P1 的真实 Python SDK 分页 Adapter、
持久检查点和不可变回测版本，并在 P2 复用契约接入共享 practice stream 和 REST 完成柱。
P2 需另核对已有后端配置是否齐备、账户目录和长连接网络；本轮没有读取或复制凭据。
十年完整历史、两交易日实时测量及 MT4 活跃互备仍是后续验收工作，不能以本轮合成测试替代。
