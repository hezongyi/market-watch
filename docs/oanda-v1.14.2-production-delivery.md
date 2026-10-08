# v1.14.2 OANDA 正式生产交付

2026-10-08，按用户已授权的正式切换、单次鉴权重试和600秒生产观察执行。
[PR #22](https://github.com/hezongyi/market-watch/pull/22) 对固定 head
`09d94d4c491a4e83047f17f2478309e573c10cb9` 完成 Standards／Spec 独立审查，
两项均0阻断；合并提交为 `ccc7e0a88b61d48ecf03a166327ae6ba12decdc6`。
附注标签 `v1.14.2` 已推送且解析到该合并提交。生产发生在标签之后，本文及
[实际生产清单](../deploy/releases/v1.14.2-production.json) 是后续证据，未包含在原PR内。

## 实际环境、版本与恢复点

构建及回归运行于 Ubuntu quant-server 本机 Docker，以 `mw-docker`、
`market-watch-ubuntu` BuildKit 和 `mw-oanda-v1.14.2-release-20261008`
task/project 构建，purpose 为 release。新镜像内45项真实 PostgreSQL／连接池
回归通过；126个安装运行模块与标签源码及先前已验收镜像逐字节一致，依赖只改变
项目版本元数据为1.14.2。45项是本次选择集，不与历史72／10项相加。

实际生产是 unraid 上既有 Compose project `market-watch`，根目录
`/mnt/user/appdata/market-watch`，网站 **https://trade.kookvv.com:8443**。
九个后端服务使用 `market-watch-api:v1.14.2-ccc7e0a`，unraid实际配置ID为
`sha256:bd77247d63f8ee05a81fd1d925a90cfb48b304f3dc872260cacf3bcd963dd580`。
Ubuntu报告OCI镜像ID
`sha256:38e07873717085bb025b4bfa9be8e2e36cce9a580e1c8311c31c95e8e183b026`；
导出归档哈希、配置摘要及全部15个rootfs diff_ids匹配，差异来自Docker表示方式，
unraid仅补充空／false旧格式默认字段。未把旧候选镜像改标作为标签构建。

切换前九个写入服务实际停止。生产dump为66,819,248字节，含82张表的同快照计数；
数据库与配置归档SHA256、配置压缩流完整性核对通过。该dump在Ubuntu独立PG14
随机新库实际恢复，82张表全部计数匹配，随后删除该随机恢复库。没有在unraid
建开发、验证或临时调试实例，也没有给生产建库权限。

09:00:52 UTC完成九服务切换及实际镜像核对，API就绪，schema仍为
`aq44_aggregation_service_order`，没有运行迁移。保留web、chart-origin、backup、
migrate旧镜像及所有环境、网络、端口、挂载和通知配置。通过raw YAML保留变量
引用与anchor，使用全部Compose profiles对照，只有九服务镜像及共享anchor改变。
web重启用于刷新API上游地址。正式源码归档登记到
`releases/v1.14.2-ccc7e0a`，`deploy/active-release` 指向该正式版本，供后续配置／
源码备份使用；独立旧镜像及回滚配置保留。

## 单次重试与真实生产观察

旧生产的持久化 `unauthorized` hold、失效lease在只读事务中核对。生产凭据配置
保留，通过真实Secure Cookie登录与CSRF，09:06:22 UTC向现有
`POST /api/market-data/live/retry` 发出**一次**请求，HTTP200清除一个过期配置
故障。请求前写入独占尝试标记，未直接改数据库，未循环重试。第一次操作员登录
误用了隔离验证密码，未通过且没有发出行情重试；改用用户提供的生产密码成功。
观察后退出本轮操作员会话。没有创建需求、预警、下单或发送通知测试。

09:06:22–09:16:23 UTC完整窗口持续601.381秒，固定5秒计划共121次采样，
0读取失败。连接epoch保持353，无重连、失租、再次鉴权失败或新增死锁；累计
deadlocks仍为699，不是本轮新增。两品种确认及M1发布推进，结束时均healthy。
EURUSD样本为117 healthy、3 recovering、1 unavailable；XAUUSD为116 healthy、
1 degraded、3 recovering、1 unavailable。恢复就绪后的EURUSD没有采样到stale。
窗口包含连接恢复初期样本，原始失败记录保留。一次XAUUSD degraded对应REST
`phase=tls route=proxy_tls type=ConnectTimeout`，约5013ms；后续确认自动恢复。
另一次REST请求在约9307ms后返回HTTP504；5秒采样未必捕获每次短暂错误状态，
该失败仍按日志保留。`proxy_tls` 指CONNECT隧道内的上游TLS，不能直接归责代理。
持续报价流与REST故障同时存在是可能的，不能用连续不重连证明新连接或REST
成功率。两次REST失败均自动恢复，不构成当前持续启动失败或确认积压的证据。

严格验收仍失败，不修改15秒报价新鲜度、5／15秒连接／读取超时、鉴权保护、租约
或来源身份。之前Ubuntu600.025秒EURUSD freshness失败仍有效，EURUSD根因
深挖按用户决定暂停。首响应头停滞及历史成熟流timeout未证明消除，转为既定触发
条件监测；本次正式镜像没有自动启用验证模块中的四层探针。

## 启停、回滚与收口边界

维护这次交付的后端服务使用现有生产实例：

```sh
cd /mnt/user/appdata/market-watch
./tools/docker-compose -p market-watch -f compose.release.yaml stop -t 30 api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker
./tools/docker-compose -p market-watch -f compose.release.yaml config --quiet
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker
./tools/docker-compose -p market-watch -f compose.release.yaml restart web
```

回滚材料位于生产
`deploy/oanda-v1.14.2-switch-20261008/compose.before.yaml` 和
`active-release.before`。停止同九服务后恢复原raw Compose与active-release，再按
相同命令启动、重启web；精确旧镜像ID
`sha256:eef235c1020d0de799dfa4115bfcef8c59be727cd8bc5d02065f7d135418b65a`
仍保留。应用回退不降schema、不覆盖数据库或新增数据、不清除鉴权保护，旧版
本地缺陷风险会重新出现。不得用外部TLS超时直接推断需要回滚本地恢复补丁。

只清理本次已核对哈希、正式导入／解包完成的两个unraid传输归档；保留备份、
旧镜像、正式源码、回滚材料及其他任务资源。Ubuntu进行中的账户调查project未
退役，不运行全局prune。此次可收口的是本地修复的review／合并／tag／正式交付
及受控恢复观察，不是全部外部故障的根治或严格端到端验收通过。
