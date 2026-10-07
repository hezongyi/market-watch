# v1.14.1 生产部署记录

2026-10-08（Asia/Singapore）。用户明确授权生产部署。unraid 的正式 Market Watch 已从 **v1.12.0** 升级为 **v1.14.1**，源码为已合并 PR #21 的 `6fd9273a5f78d8761f76a20e3ad66b17e441f9f5`；附注标签 `v1.14.1` 保持原指向。本记录是后续运维资料，不改变标签产品源码。

- 工作台：<https://trade.kookvv.com:8443>
- 图表 origin：<https://charts.kookvv.com:8443>
- 正式目录：`/mnt/user/appdata/market-watch`，Compose project：`market-watch`。
- 发布目录：`releases/v1.14.1-6fd9273`，由 `deploy/active-release` 指定。
- 数据库：共享 PostgreSQL 14 内的专用 `market_watch`；未重启共享数据库或其他服务。
- 内部 web/chart 端口：`192.168.7.33:18080` / `192.168.7.33:18083`。

后续已按用户授权开启 OANDA stream，当前为 **11 个常驻服务**，EUR_USD、XAU_USD 持续订阅；实际生产登录和四图 dataReady 已通过。初次切换证据与后续启用结果分别记录。

完整镜像 ID、迁移、HTTPS 哈希、心跳、数据推进、备份 SHA 和恢复结果见 [生产清单](../deploy/releases/v1.14.1-production.json)。实际部署的 [Compose](../deploy/releases/v1.14.1-production.compose.yaml)、[备份 Dockerfile](../deploy/releases/v1.14.1-backup.Dockerfile) 和 [应用回退脚本](../deploy/releases/v1.14.1-rollback-v1.12.0.sh) 均不含凭据。

## 构建与切换

四类固定镜像 `market-watch-{api,web,chart-origin,backup}:v1.14.1-6fd9273` 均在 Ubuntu quant-server 经 `mw-docker build` 和 `market-watch-ubuntu` BuildKit 构建。task/project 为 `mw-release-v1141-20261008`，用途为 `release`，dirty=false。web 显式使用正式 chart HTTPS origin；chart 构建前核对 2928 个许可输入文件。711 项复审源码输入 SHA256 全部一致。

镜像经 save/load 传到 unraid，所有有序文件层与运行配置一致。两主机 Docker 存储实现返回的 inspect ID 类型不同，清单分别记录实际 ID；仅将缺省空字段规范化比较。备份镜像固定新 API 基础和 PG14 客户端，未修改应用依赖。

维护停写始于 **2026-10-08 06:37:37 +08:00**，服务启动与正式目录切换完成于 **06:41:24 +08:00**，约 227 秒。停本项目 API 及全部既有写入 worker 后生成最终数据库/配置备份，在 Ubuntu 隔离库实际恢复 41 张旧业务表。失败回退保护位于备份阶段；备份恢复通过后才执行正式迁移。

生产从 `u22_chart_alert_actions` 升级至 `aq44_aggregation_service_order`。迁移后原有业务表行数、9 张用户数据表指纹、所有既有 preference 内容均保持；审计表额外一条 `backup_completed` 是冻结备份完成时写入的正常记录。随后按 BTCUSD、BTCUSDT、EURUSD、XAUUSD 逐身份进行有界覆盖回填和真实行政核验，全部 complete 后启动唯一 chart publisher。

初次切换的 10 个常驻服务为 API、web、chart-origin、realtime、chart-history、chart-aggregation、native-history、notify，以及新增 history、composite-aggregate worker。后两者分别运行 `alerts.history_versions --without-composite-aggregates` 和 `alerts.composite_aggregate_worker`，避免两个进程同时负责组合聚合。

初次切换保留原密码、图表布局、告警、设备、通知配置与开关：delivery=true，MCP=false，Yahoo=false，OANDA stream=false。`pricing-worker` 使用显式 `oanda-stream` profile，当前未启动。生产未创建测试告警、未发送测试通知、未改写旧行情来源身份；显式三层 dataset 为 0，新 history/composite worker 当前为空闲。

## 实际验证与边界

Ubuntu 使用独立 project `mw-v1141-restore-20261008`、网络、PG volume、数据库和 19724–19727 本机端口。正式新镜像在恢复数据上完成迁移、覆盖核验、新 worker 单次运行；实际旧 v1.12.0 镜像完成 additive schema 读取、API readiness、聚合/发布函数运行，以及新版本重新核验覆盖。没有在 unraid 创建验收或调试实例。历史启停使用私有 Compose 和 `docker compose --env-file PRIVATE_ENV -p mw-v1141-restore-20261008 -f PRIVATE_COMPOSE`；先启动 PG、恢复备份并迁移，再 `up -d --no-build --wait api web chart-origin`，停止用 `stop`。该任务现已完成并退役，地址不再提供服务；再次验收须登记新 task/project 并隔离资源，不能复用已完成任务。

Chromium 在 Ubuntu 恢复库使用单独随机验收密码完成登录、Secure/HttpOnly cookie、数据中心四分区、保存的四图布局、原生指标选择器、同步/范围映射设置及 390px 首页。浏览器 HTTPS origin 路由到本机 HTTP 服务，事件流未验证。隔离实例未注入生产供应商授权，缺失历史请求被取消，图表 dataReady=false，不能据此宣称原生历史补数通过。

生产 HTTPS 首页、JS/CSS 和 chart host 资源与正式镜像匹配；readiness/health 为 200，未认证 session 为 401。10 个常驻服务运行、API healthy、restart=0，行情/notify 心跳正常；BTCUSDT、EURUSD、XAUUSD M1 均继续推进。旧 bucket job 队列实际清空；source/gap 阻塞请求仍保留真实输入缺口状态，不强行确认 pending 世代。历史 import_heartbeat 仍过期，不能将其当作新的 worker 故障或本次通过项。

初次切换时生产管理员密码不可用；用户随后提供密码，已通过正式 HTTPS 的真实登录、Secure/HttpOnly session、四图 dataReady、数据中心、指标/告警面板/同步设置及移动首页检查，检查后注销会话。没有修改密码或绕过认证；密码不写入仓库或浏览器状态。首次检查在图表页面切换时出现一次 `Value is null`，第二次完整复查无 pageerror、失败 HTTP 或跨 origin 凭据泄漏，首次现象不抹去。短时运行观察不承诺长期性能、外部通知送达或供应商 SLA；没有重测定时备份触发和整机重启。

## 备份与启停

升级前在线预检备份、最终停写备份、升级后备份均已用 PostgreSQL 14 在 Ubuntu **实际恢复**，核对各自 manifest 的所有业务表行数和 schema。私有 dump、env、完整 inspect、恢复资料和配置归档保存在生产备份目录及 Ubuntu 私有目录，均不提交仓库。配置归档另经 SHA256、隔离解包、env 哈希/0600 权限核验，最终归档包含可执行的回退脚本和旧 Compose。

生产保留原有正确指向 `/mnt/user/appdata/market-watch` 与 `/mnt/user/backup/market-watch` 的定时备份脚本；不直接覆盖源码中历史 `trading-alerts` 路径的脚本。手动备份：

```sh
ssh unraid /mnt/user/appdata/market-watch/deploy/unraid-backup.sh
```

在 unraid 正式目录执行以下命令，仅操作明确的 Market Watch project。已迁移版本的常规启动不重复创建迁移服务：

```sh
cd /mnt/user/appdata/market-watch
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps --wait api chart-origin
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps web realtime-worker chart-history-worker chart-aggregation-worker native-history-worker notify-worker history-worker composite-aggregate-worker pricing-worker
./tools/docker-compose -p market-watch -f compose.release.yaml stop -t 30
```

上述 stop 停常驻项目服务，不停共享 PG14。涉及迁移、维护或回退时，先停全部写入者。

## 应用回退

回退点为实际上一生产 **v1.12.0**。四类旧固定镜像、旧发布目录、旧 Compose 和冻结备份均保留。正式回退脚本位于：

```sh
ssh unraid /mnt/user/appdata/market-watch/releases/v1.14.1-6fd9273/rollback-v1.12.0.sh
```

脚本先停止新 API 和全部新写入 worker，以新镜像运行 `prepare-rollback --workers-stopped`，失效覆盖完成标记并重建旧 bucket jobs；随后恢复旧固定 Compose、启动单一旧 publisher、切回旧 active-release，并移除新版本专属的两个已停 worker 容器。保留 additive schema、原始证明及所有数据，不执行 schema downgrade。重新升级必须再次停旧写入者，逐身份 `coverage --until-complete --verify` 后才能启动新 publisher。

该旧应用路径在开启 stream 前用恢复库实际验证，本次未在生产触发。开启 stream 后实际注册了 127 个账户范围数据集，而 v1.12.0 的旧轮询写入者不能保证新版显式身份约束；因此脚本现有只读前置守卫，在发现显式数据集时拒绝切换并保持在线服务，不宣称可直接回退旧应用。需要旧应用回退须另行规划数据兼容；停 stream 的配置回退见下节。需要恢复冻结备份时应另行维护，明确停写并评估切换后的新增数据；不盲目覆盖在线库。

## 资源终态

确认生产稳定后，仅退役本次 Ubuntu 验收 project。先归档并停止/删除精确归属的三个应用验收容器，保留它们引用的正式镜像；PG 数据卷使用 `mw-docker retire` 清单预览和 `--apply`，在删除前对每个本机库真实 dump/restore 并比对行数与排序 JSON 内容指纹。已实际核验 4 个本机库，验收 project 容器、网络和卷全部移除；临时验收密码文件及配置解包目录已删除。正式 release task 已完成，正式镜像继续受保留规则保护。

生产所有一次性迁移、覆盖维护和备份容器均使用 `--rm`；旧正式回退镜像和备份保留。未执行全局 prune，其他项目实例、数据卷和生产服务保持原状。

## 后续开启 OANDA stream

用户明确授权开启，并提供当前管理员密码用于登录检查。正式 Compose 将 `pricing-worker` 改为默认常驻服务，`ALERTS_OANDA_STREAM_ENABLED=true`，resident 为 `EUR_USD,XAU_USD`；API 显式报告 stream=true。未改私有 `.env`、账户 token、密码或既有告警。该配置随普通启动保留，不需要额外 profile。

OANDA Practice 账户目录成功读入并注册 127 个明确身份数据集；实际仅 EUR_USD、XAU_USD 为当前常驻订阅，其他按真实需求订阅。保留旧四品种，未将旧历史冒充新账户范围数据。pricing worker 使用 delivery=false，但原 notify worker 仍按既有正式配置工作。原生平台图表订阅与新实时流身份各自保持原口径。

实际验证：11 个常驻服务运行，API healthy，pricing restart=0；单一账户租约存在，鉴权错误为空。两个品种均收到真实报价，REST M1 恢复完成，最终样本 connection=connected、recovery_ready/quote_ready/candle_ready=true，确认分钟继续推进。生产 `/api/market-data/live` 和 SSE snapshot/heartbeat 为 200；四图已真实 dataReady，无模拟行情。用户数据指纹保持一致。

观察期间发生上游断开和自动重连，曾短暂显示 recovering；EURUSD 没有新的源价格时真实显示 stale，即使连接心跳及确认 M1 正常。这些状态不被隐藏，短时最终 healthy 不证明长期稳定或报价时效 SLA。新配置备份经 SHA、实际隔离解包、env 内容/权限核对通过，包含更新的启停与回退资料。

只停 stream 并恢复之前配置，可在明确维护时执行下列正式脚本；它保持 v1.14.1、原有服务和全部已采集数据：

```sh
ssh unraid /mnt/user/appdata/market-watch/releases/v1.14.1-6fd9273/disable-oanda-stream.sh
```

该脚本已通过 shell 语法检查，本次没有执行停用。启用后的精确运行状态和限制见清单 `post_deployment_oanda_stream_activation`。
