# v1.15.0 正式生产交付（2026-10-10）

PR [#25](https://github.com/hezongyi/market-watch/pull/25) 已合并，annotated `v1.15.0` 已推送，固定源码为 `9f182c28ac8f161ed292a53f743b9cb5041d4ccb`。
正式生产为 unraid `/mnt/user/appdata/market-watch`，Compose project `market-watch`；网站为 https://trade.kookvv.com:8443，许可图表来源为 https://charts.kookvv.com:8443。
当前正式版本是 v1.15.0；**生产浏览器端到端与真实 OANDA 行情验收尚未通过**。本次部署与可验证的运行检查已完成，下述阻塞必须保留。

## 构建、切换和数据核验

四个正式镜像均从 tag 源码在 Ubuntu 通过 `mw-docker`、`market-watch-ubuntu` BuildKit 构建，task/project 为 `mw-unified-sse-v1.15.0-release-20261010`，purpose 为 `release`。API、web、chart-origin、backup 镜像标签均为源码 commit、dirty=false；没有把验收镜像改标签作为发布镜像。
已安装的 130 个后端 Python 模块与 tag 字节一致，第三方包版本与已验收镜像一致。实际标签 API 镜像连接 Ubuntu 隔离 PG14，109 项流协议、生命周期、历史读取、固定指标、行情发布死锁及实时回归全部通过。
Ubuntu 与 unraid Docker 使用不同形式的镜像 ID；导入后核对配置 digest 和每个 rootfs diff_id，四个镜像一致。实际运行的 12 个正式服务均使用这些镜像。

生产停写 UTC `2026-10-09T20:22:48Z`，新版服务启动并完成 Compose 健康依赖 UTC `2026-10-09T20:26:28Z`；停写窗口约 3 分 40 秒。数据库仍为原外部 PG14，没有新建或替换生产数据库实例。
迁移从 `aq44_aggregation_service_order` 到 `ar45_market_stream`，新增四张 `market_stream_*` 表。最终停写快照在 Ubuntu 实际恢复，82 张原业务表计数逐表匹配；隔离迁移及正式迁移均再次核对原表计数，正式库仅有备份完成审计新增 1 条。
升级后 backup 镜像包含全部 86 张业务表；升级后的 dump 已在 Ubuntu 实际恢复并核对全部计数。两份生产配置归档在 Ubuntu 私密目录实际解包，核对 `.env` 哈希及权限、active-release 源码目录与 Compose 配置；解包目录已移除。dump、配置归档和正式恢复结果见 [生产清单](../deploy/releases/v1.15.0-production.json)。所有恢复实例均在 Ubuntu，没有在 unraid 创建开发或验收实例。

切换中首次迁移已成功，但额外的只读计数检查因挂载目录权限失败；原应用回退启动又被旧迁移镜像无法识别 ar45 阻断。随后通过标准输入传入只读校验脚本，确认 82 张原表及四张新表状态后启动新版。此事件造成的延迟计入上述停写窗口，不隐去首次失败。回退脚本已修正：保留 ar45 schema 及数据，维护用 migrate/backup 镜像保留 v1.15.0；业务应用恢复旧镜像并用 `--no-deps` 启动，避开旧迁移器。

## 运行验证与未完成验收

网站、图表域名及 `/readyz` HTTPS 均返回 200，API healthy。启动时核对 12 个正式服务运行状态、镜像、零重启；原 Compose 各服务除镜像以外的配置字段保持一致，新增一个 `market-stream-worker`，数据库池 2、overflow 0。
连接池、数据库死锁增量、长事务、重启次数和 stream 任务状态在生产只读采样：21 次、684.3 秒；死锁增量 0，未见超过 30 秒的长事务，12 个服务均零重启。数据库后端连接数 13–13。这是运行检查，不代替实际浏览器行情回调验收。

- 最初保存的密码登录返回 401。用户补充当前凭据后，正式 HTTPS 登录和退出均返回 200，Secure/HttpOnly 会话 Cookie 核验通过。凭据仅存于 Ubuntu 0700 目录中的 0600 私密文件，没有重置认证或伪造会话。
- 生产 `market_pricing_owners` 为 `error=unauthorized`、epoch=360。停写前 dump 中已有相同状态，确认不是 v1.15.0 引入。此授权隔离状态被保留，未擅自重试、改 token 或切换账号；当前没有活跃的真实 OANDA 行情数据。因此不能声称正式生产真实 OANDA 端到端已经通过。
- 当前四图工作区已在正式 HTTPS 页面加载。约 180 秒观察内，统一 SSE 打开一次、无连接错误，接收 81 个 bars/quotes 事件，真实许可图表收到 2 次首屏快照回调；稳定窗口没有 charts/data、market-data/quotes 或 provider/latest 行情 HTTP 请求。这不证明实时 OANDA 新价格推进。
- 浏览器首屏有一次未捕获的 `Value is null`，堆栈指向许可图表库 restricted-toolset 的 `componentWillUnmount -> model()`。约 8 秒的只读首屏探针在 SSE 和轮询模式均复现该异常，不能把它归因于 SSE；工作区恢复/库生命周期的完整根因尚未定位，也未修复。没有为此修改生产程序或保存用户图表配置。完整浏览器验收保持未通过，证据见 [补验记录](verification/unified-sse/v1.15.0-production-browser-followup.json)。
- 本地真实 Practice 的功能验收记录仍见 [PR 最终验收](verification/unified-sse/pr25-review-fixes-20261009.md)，其结果不替代生产账号验证。待生产 OANDA 授权恢复及图表首屏异常修复后，应补验新价格回调、确认水位推进和自动恢复。

## 启停、回退和保留资源

在 unraid 项目目录运行：

```sh
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
./tools/docker-compose -p market-watch -f compose.release.yaml stop
```

外部数据库不受上述命令管理。应用回退入口：

```sh
bash deploy/unified-sse-v1.15.0-switch-20261010/rollback.sh
```

回退保留 ar45 和新数据，旧业务镜像及原始 Compose/active-release 已保留。不得直接用旧迁移器运行 `alembic upgrade head`，不得自动降级 schema 或覆盖生产数据库。生产备份仍由原 `deploy/unraid-backup.sh` 和定时任务调用，实际目录为 `/mnt/user/backup/market-watch`；未用仓库早期 trading-alerts 路径覆盖生产脚本。
正式源码目录 `releases/v1.15.0-9f182c2`、旧版本源码、正式/回退镜像和数据库/配置备份保留。已移除本次切换的镜像及源码传输 tar、已成功退出的 migrate 容器；Ubuntu 仅用于恢复的 PG project 已归档角色及所有非 template 库，实际恢复核对后按已验证的 Compose 标签移除其单个容器、network 和 volume。该 project 没有验收镜像登记，mw-docker retire 预览拒绝非登记项目；未绕过构建入口或删除正式镜像。原 Practice 验收 project 仍保留，不执行 prune 或删除其他任务资源。

## 开销口径

相对原方案 `6fd9273` 的 Ubuntu 对照实测：单周期约增加 0.110 CPU 核、101.8 MiB；八周期约增加 0.264 CPU 核、128.5 MiB，八周期 WAL 为原版 2.37 倍。见 [同口径成本报告](verification/unified-sse/old-release-cost-report.md)。这些是先前隔离窗口结果，不是本次无有效 OANDA 消费者的生产负载增量。
本次增加一个正式 worker；无活跃 SSE 消费者的生产样本平均工作集 117.4 MiB、平均 0.016 CPU 核，仅代表该空闲时段。没有新增服务器或付费订阅，不能将短窗口 WAL 直接外推成月费用或长期磁盘增长。
