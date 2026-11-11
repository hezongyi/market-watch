# 开发实例 CPU 修复验收

基线 v2.0.6 / d2a3e092；实现提交 52f69226；分支 fix/dev-cpu-loops-20261111。
风险 F1：持久后台准备和发布链路，无 schema 或持久格式迁移。

## 修复与兼容

- 最新历史版本、映射和接缝已属于当前生效修订时，将本周 shadow 记为 unchanged，
  保留绑定及历史尝试次数，不再创建同一候选。该报告不允许激活，不解锁 retention。
- 失败/未就绪的准备使用原有 60 秒轮询，保留同窗口恢复，不再每 0.5 秒重试。
- 在 Instrument 锁内，对除 observed_at 外完全一致的原生发布快照直接刷新真实时间。
  不一致的价格、成交量、完整性、确认时间或修订号仍排入普通发布，不绕过屏障。
- 纯观测更新不增加内容 revision；M30/W1/MN 仍经过有界派生发布。指标数值缓存继续
  复用；可见 K 线重读当前快照，实时流额外读取一根尾柱观测信号。

## 验证

先运行三个新增用例，均复现基线失败；实现后首轮 45 passed。
最终 [核心回归](tests-core.log) 212 passed，另有一个真实 v1.14.0 writer 用例因未指定
源码而跳过；[补充回归](tests-extra.log) 配置真实旧源码后 162 passed，包括该补跑。
再补验 [发布数据集契约](tests-managed.log) 31 passed，合计 405 项通过。包含独立
PostgreSQL 14.24、并发锁/代际、发布故障回滚、历史交错、
死锁、成交量、告警、指标缓存和实时流。未宣称运行完整仓库测试套件。

隔离验收 project/network：mw-cpu-fix-20261111 / mw-cpu-fix-20261111_acceptance；
PG 127.0.0.1:25473，独立库及 volume，无开发库写入。PG 上限 1 CPU / 1 GiB，
测试完成后已停止并保留 volume。私有 env 位于
/home/quant/.local/share/market-watch-private/cpu-fix-20261111/compose.env。

独立 [Standards / Spec 审查](reviews.md) 通过；定向 Ruff 与 diff check 通过。

## 部署

- 实际主机：Ubuntu quant-server；project mw-dev。
- 开发入口：<https://192.168.7.232:18443>；ntfy HTTPS 18444。
- API/三个 worker：market-watch-api:dev-cpu-fix-20261111；运行镜像 ID
  sha256:3c564df910ab50e971926d747d732e42fef0864b73c6bf2091cc66b821813b95。
- 使用 mw-docker、market-watch-ubuntu BuildKit 构建，task mw-dev-cpu-fix-20261111，
  purpose development。镜像 commit 标签与四个服务实际挂载源码/模块 SHA 均已核实。
- 持久 launcher mw-dev 已指向本工作树；保留已验证的 v2.0.6 图表许可资产实体目录及
  Web 镜像。没有覆盖其他 dirty worktree、其他项目或 Unraid。
- schema 仍为 bd57_notice_source_poll_index，无迁移。
- 私有部署证据、截图、旧配置、旧 launcher、镜像清单位于
  /home/quant/.local/share/market-watch-dev/updates/cpu-fix-20261111/。
- 新全库备份 1,557,046,947 字节；SHA-256
  c395ceeb82ab03d4bc023292fc26f9ded8a692d8404b946106a07aeb7e1b9052。
  pg_restore --list 成功读取 603 行目录；本任务没有执行全库恢复，不把目录检查称为恢复演练。

启动：`mw-dev up`；停止：`mw-dev stop`；状态：`mw-dev status`。
重启后端：`mw-dev restart api market-runtime data-worker notification-worker`。
配置回退使用私有目录中的 compose.env.before 与 mw-dev.before，并按原服务列表重建；
旧镜像和原 v2.0.6 工作树均已保留，不需要数据库降级。

## 实测

[comparison.json](comparison.json) 为同一采样器、每 10 秒一次、各 19 点约 3 分钟的对比。
两段均保持 0 网页客户端、0 订阅、0 stream task；自动行情及后台维护仍启用。
测试、镜像构建、全库备份均在采样外；其余 Ubuntu 项目保留运行。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 整个 mw-dev 占四核主机 CPU | 21.51% | 13.50% |
| data-worker，占单核 | 42.05% | 18.04% |
| PostgreSQL，占单核 | 20.16% | 11.49% |
| shadow 尝试增量 | 660 | 0 |
| 发布行修订总增量 | 5,787 | 48 |
| 新发布行 | 9 | 18 |
| 聚合队列为空的采样 | 16/19 | 17/19 |

总 CPU 降低约 37.2%。额外 16 秒逐行对比：修复前 484 根纯观测变化产生 484 次内容
修订；修复后 475 根仍刷新真实观测时间，内容修订增量为 0。
最后 8 个瞬时 dirty publication job 仍按正常链路处理，不宣称所有队列每刻为空。
这是两段实际运行样本，输入并非逐条重放，不能外推高负载或长期 CPU，也没有达到
“全实例 1–5% CPU”的结论。

## 在线检查

浏览器实际多图布局、可见 OHLC、40 根真实行情、数据中心及许可资产均通过，无 JS
错误和图表资源错误。原部署脚本只等待初始 HTTP 数据；当前保存布局可直接通过 SSE
获得柱，验收改为实际 OHLC + 同供源数据查询，不修改用户布局。

38 个运行角色无 missing/stale/degraded/failed；MCP 42 工具、行情/通知 SSE、ntfy
健康通过。通知 SSE 使用历史分页返回的 after 游标。检查脚本不会发送测试通知或刷新目录。

行情源最终复核结果单独记录在 services-summary.json。

## 交付边界

### CI 跟进修复

首次完整 CI（run 43040422283）后端为 3816 passed、3 skipped、1 failed：
回退测试仍假定纯观测时间刷新要等待发布 worker，与本次原子刷新行为不符。
改用真实成交量修订触发待发布内容，继续验证分页回退准备不改变可见快照、
旧 worker 协议能恢复快照以及修订后的成交量和观测时间。

Web 与 Compose 则在安装系统依赖时遇到 azure.archive.ubuntu.com DNS 失败，
没有执行到对应浏览器/BusyBox 测试。工作流复用 Ubuntu hosted runner 自带的
Chromium 运行库和 BusyBox，保留浏览器下载、全部 DOM 回归与两种 shell 的备份测试；
缺少 BusyBox 时仍安装。此次跟进仅调整测试和 CI，按 P0 验证，不改变运行代码或 schema。

本地验证：关联后端/CI 分类测试 32 passed、18 subtests passed；备份测试原生 shell
及 BusyBox 各 112 passed、0 failed；watchlist DOM 回归通过；Ruff 和 diff check 通过。
远端最终结果以 PR 最新提交的完整检查为准。

开发实例已更新；[Draft PR #132](https://github.com/hezongyi/market-watch/pull/132)
承载代码与证据，GitHub CI 已触发，最终结果以 PR 检查为准。
未合并 main、未创建正式 Git/Docker tag、未部署生产。
