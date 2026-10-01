# 双数据系列本机交付与回退

2026-10-02。v1.3.0已按用户修订的“大多数冷首屏低于3秒”标准完成本地验收及交付，不推送远端、不合并main、不操作Unraid生产。源码构建提交、镜像ID及回退见[本地发布清单](../deploy/releases/v1.3.0-local.json)，附注标签v1.3.0包含最终验收和文档记录。权威需求见[方案](chart-dual-dataset-plan.md)，验证见[43项审计](chart-dual-dataset-acceptance-audit.md)，操作见[使用说明](chart-dual-dataset-user-guide.md)。

## 本地运行环境

源码为`/home/quant/repos/market-watch-advanced`的`feature/advanced-charts`。三类镜像统一由源码提交`a71439b34964fea9cf825d7a6e2d412bac071fc5`构建，最终本地别名为`market-watch-api:1.3.0-local`、`market-watch-web:1.3.0-local`、`market-watch-chart-origin:1.3.0-local`。运行容器仍使用相同镜像ID的`1.3.0-candidate.1`构建名，未为验收文档变更重启服务或重建。`verification/dual-container/candidate.1-runtime-images.json`已匹配发布清单；API代码/迁移及web/chart静态文件与此前验收版逐字节一致，内容关联证据在同目录`candidate-{api,static}-content-equivalence.json`。镜像构建时accepted=false标签保留，最终验收结论以发布清单为准。

独立项目为`market-watch-dual-acceptance`，数据库为本机`market-watch-postgres-isolated`中的`market_watch_dual`。所有服务pool=1/overflow=0，通知强制关闭，服务连接通常4条；共享开发数据库的总预算仍为8，没有用其做故障注入。凭据/TLS位于受限`/tmp/mw-dual-acceptance/`，不提交Git。

```bash
sg docker -c 'docker compose --env-file /tmp/mw-dual-acceptance/compose.env --env-file deploy/releases/v1.3.0-local.env -p market-watch-dual-acceptance -f compose.acceptance.yaml -f compose.dual-acceptance.yaml -f deploy/releases/v1.3.0-local.yaml up -d --wait'
sg docker -c 'docker compose --env-file /tmp/mw-dual-acceptance/compose.env --env-file deploy/releases/v1.3.0-local.env -p market-watch-dual-acceptance -f compose.acceptance.yaml -f compose.dual-acceptance.yaml -f deploy/releases/v1.3.0-local.yaml restart web tls'
```

API更换后先等健康，再重启web/TLS，刷新nginx保存的上游地址。主站15453、图表15454、静态服务15197只监听回环。候选使用既有授权代理访问OANDA/Binance；该配置只改本机隔离候选环境，不改生产。

## 数据与资源

平台K线直接从提供商对应周期读取；HTTP连接池在API进程内，bar/覆盖与有限会话目标持久化在独立provider_datasets/provider_bars/provider_interests。不写managed Bar/覆盖/任务。后端统一分页、预热和尾部更新，主站SSE桥接普通行情与Python指标；所有反向代理跳点应关闭SSE缓冲并允许长连接，参考deploy/acceptance-tls.conf。每源实时2并发/2次每秒，交互图表2并发/2次每秒，历史及报价1并发/1次每秒；历史在实时修复积压时让位。图表不能占用实时预留，数据库连接预算不随上游额度增加。

自建原始M1写入`candles`，派生后复制为`chart_published_bars`快照，通过`chart_publications`范围/修订开放。迁移`l13_managed_publication`增加发布表和计划的倒序/实时状态；基线为`k12_chart_aggregation`。平台缓存迁移m14_provider_cache新增独立三表，n15_provider_revisions区分bar修订时间与重复观测时间。当前schema应为n15。迁移回退会删除平台缓存或发布快照及计划字段，不能把“迁移可逆”理解为无需备份。

## 回退原则

旧`market-watch-acceptance`项目和旧运行环境未被改动。停止新候选后，可继续查看既有旧环境；不能让旧worker直接写新候选数据库。

```bash
sg docker -c 'docker compose --env-file /tmp/mw-dual-acceptance/compose.env -p market-watch-dual-acceptance -f compose.acceptance.yaml -f compose.dual-acceptance.yaml stop'
```

若需要回退新候选数据库，必须先停止本项目所有写入服务、生成私密备份并验证目标确为本机隔离库，再依据对应源码/镜像版本执行迁移或恢复。回到旧产品规则应恢复其升级前数据库备份，不仅回退镜像；不能在共享库或生产库试验回退。重新启动候选需使用与schema对应的API及worker镜像。

若只回到上一个同schema候选，使用 `deploy/releases/v1.3.0-local.rollback.env` 替代上述镜像选择env，Compose覆盖文件只规定本机镜像不可拉取，不改变schema。先核对目标库再替换API及所有worker，等健康后restart web/tls。清单记录精确旧镜像ID。回到v1.2.0旧产品规则仍须恢复相应旧数据库备份，不能直接用旧镜像写n15库。

## 已验收范围与限制

303项后端、35项VM、五分钟八图、内部预警演练、画线/手机、日期同步、真实故障及重启恢复已通过并关联同提交镜像。最新九周期18项及部署后6项冷PG首屏分别1385–2597ms、1280–1829ms；完整PG缓存请求到显示分别199–490ms、204–321ms。运行HTTP连接池条件与全冷TLS区分，原始长尾/失败不删除。

用户明确接受大多数冷首屏低于3秒，代理/TLS或上游响应长尾仍可能更慢；不承诺每次或任意网络环境耗时。自建首次准备不作时间承诺。通知关闭，原生导出/样式缺件及其他实际边界见使用说明。
