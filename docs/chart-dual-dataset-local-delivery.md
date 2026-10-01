# 双数据系列本机候选运行与回退

2026-10-02。当前源码尚未最终交付，不推送远端、不合并main、不操作Unraid生产。包版本1.3.0为未验收候选；建立本地候选源码快照并构建同提交镜像，不创建正式验收标签。权威需求见[方案](chart-dual-dataset-plan.md)，验证进度见[实施记录](chart-dual-dataset-implementation.md)，操作见[使用说明](chart-dual-dataset-user-guide.md)。

## 候选环境

源码为`/home/quant/repos/market-watch-advanced`的`feature/advanced-charts`。API和三个worker采用同一`market-watch-api:provider-publication-cadence-20261002`候选镜像；主站与图表分别使用`market-watch-web:provider-startup-metadata-20261001`、`market-watch-chart-origin:provider-startup-metadata-20261001`。运行完整ID见 `verification/dual-container/publication-cadence-runtime-images.txt`。标签会随候选重建改变，不能用标签名替代镜像ID或源码提交。

独立项目为`market-watch-dual-acceptance`，数据库为本机`market-watch-postgres-isolated`中的`market_watch_dual`。所有服务pool=1/overflow=0，通知强制关闭，服务连接通常4条；共享开发数据库的总预算仍为8，没有用其做故障注入。凭据/TLS位于受限`/tmp/mw-dual-acceptance/`，不提交Git。

```bash
sg docker -c 'docker compose --env-file /tmp/mw-dual-acceptance/compose.env -p market-watch-dual-acceptance -f compose.acceptance.yaml -f compose.dual-acceptance.yaml up -d --wait'
sg docker -c 'docker compose --env-file /tmp/mw-dual-acceptance/compose.env -p market-watch-dual-acceptance -f compose.acceptance.yaml -f compose.dual-acceptance.yaml restart web tls'
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

## 最终交付尚待补齐

源码先建立1.3.0本地候选提交并绑定三类镜像，候选清单必须明确accepted=false；全部门槛完成后才整理正式附注标签和交付清单。现有v1.2.0清单和文档只证明其历史版本，不证明本次双系列候选。最新303项后端、五分钟八图、内部预警演练、画线/手机只读均通过；日期同步保存重开及原生UI比较/价格轴由未变更的web/chart镜像复验覆盖。平台所有周期3秒稳定性门槛仍未收口，整体目标保持未完成。
