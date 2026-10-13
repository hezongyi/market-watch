# v1.25.0 生产交付

2026-10-13，Market Watch 已从 v1.23.0 升级到 **v1.25.0**。[PR #55](https://github.com/hezongyi/market-watch/pull/55) 已合并，附注 tag `v1.25.0` 指向 `027aa7095a34972d8a644a89a16ad79d4b6297df`。四类正式镜像由该 clean 提交在 Ubuntu 经 `mw-docker`、purpose=release 构建；Unraid 导入后的 RootFS 和有效配置逐项匹配，生产引用完整固定 image ID。12 个常驻服务运行、零重启，API healthy。

## 生产与操作

网站：https://trade.kookvv.com:8443/；图表资源：https://charts.kookvv.com:8443/。主机 Unraid `192.168.7.33`，根目录 `/mnt/user/appdata/market-watch`，Compose project `market-watch`，active-release `releases/v1.25.0-027aa70`。

```bash
ssh unraid
cd /mnt/user/appdata/market-watch
services=(api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin)
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps "${services[@]}"
# 已授权维护时停止正式应用：
./tools/docker-compose -p market-watch -f compose.release.yaml stop "${services[@]}"
# 需要回退时，先备份当前状态，再恢复 v1.23.0 应用；保留当前数据库：
bash deploy/pending-v1.25.0-switch-20261013/rollback.sh
```

14 个 service 定义核对完成，除固定镜像外有效配置没有变化，11 个后端定义（含 migrate）Yahoo 均为 true；10 个常驻后端实际 Settings 再次核实启用、代理存在。私有 env 字节保持一致，数据库、代理及通知配置保留。真实 Yahoo AAPL 元数据、26 根 D1 与报价读取通过。旧 v1.23.0 镜像、Compose 和私有回滚配置保留；没有覆盖旧标签。

## 备份、恢复与迁移

生产写入暂停 **2026-10-13T00:58:03Z 至 2026-10-13T01:05:46Z**，463 秒（约 7 分 43 秒）。先停止本项目写入，再生成最终备份与配置归档；Ubuntu 实际恢复和迁移验证成功后才放行安装。

- dump：`/mnt/user/backup/market-watch/alerts-20261013T005805572832Z.dump`，1,261,099,745 字节，SHA256 `389ccc43332b5a0f599fcd8d4c38bbf8bf8f32493345ef09236434e0043e9fa0`。
- 配置归档：`/mnt/user/backup/market-watch/config-20261013T010034Z-JtIc7v.tar.gz`，SHA256 `7d215cbc6a8a31757b2dad6398d196878695d3e46714cb0801b03ae41ad5042d`；Ubuntu 全量解包 8,077 项，私有权限、env、旧 Compose 和 active-release 匹配，Compose 展开通过，解包目录已删除。
- Ubuntu 独立 PG14 实际完整恢复 86 张应用表及 alembic_version，共 87 张实际 public 表；恢复数据约 4.74 GB，manifest 计数、业务指纹、账号和通知设置均匹配。备份完成后新增一条 `backup_completed` 审计记录，恢复按 dump 审计计数核对，其余计数匹配停写后的生产快照。
- 恢复库先验证 `ar45_market_stream`，再运行 `alembic upgrade head` 至 `as46_provider_price_confirmation`，所有表计数与稳定业务指纹不变，旧 provider price confirmation 均为空，保持保守回退。生产随后执行同一迁移成功；没有对生产恢复、替换或降级数据。
- 恢复容器首次因私有目录权限未能读取脚本，改为仅在 Ubuntu 恢复容器使用 root 读取私有挂载后通过；没有放宽宿主私有文件权限。

回退脚本先停写并备份当前生产，再切回旧应用，保留新增可空列和最新数据；不自动降级 schema，也不使用旧 dump 覆盖上线后的用户数据。数据库与配置备份保留在 Unraid 和 Ubuntu，仍不代表异地灾备。

## 上线检查与边界

正式 HTTPS 管理员登录、Secure/HttpOnly session、退出通过。现有五图布局、唯一告警业务根、真实 bars/quotes SSE 及目录读取通过。临时切换主图到 OANDA EURUSD D1，通用 Python EMA 42 的原生十字光标数值有限、结果通道启用；重新加载恢复原五图布局，临时指标未保存。手机 390px 首页已等待加载完成并检查无横向溢出。最终浏览器检查零 pageerror、HTTP error、图表来源凭据泄漏或意外业务保存。三张截图人工查看；不据此宣称全部历史和所有指标组合可用。

已有组合主图的临时 EMA 创建曾等待完整历史输入，该次 probe 未完成、已停止；后续用具备数据的 OANDA 主图验证通用通道通过，限制见 [记录](verification/pending-v1.25.0-production/browser-check-limitations.json)。原组合缺分钟继续 unknown/stale，不填价格、不推断闭市，不宣称既有生产告警完整恢复。`Load failed` 未复现，按用户决定暂不处理。此前 fixed 两个冷参数 pending→complete、managed 同柱和前缀更正、Python 值一致等验收仍见 [PR #55 报告](issues/production-pending-pr55-review-fixes-20261013.md)，本次未向生产写入合成更正 fixture。

OANDA 流首次重连经历两次上游 ReadTimeout，随后自动恢复；最终 EURUSD/XAUUSD connected/healthy、报价／分钟线 ready、没有 authentication hold，心跳与确认分钟推进。账号、通知、工作区、偏好及稳定告警定义一致；排除 worker 正常变化的 `runtime`／`health_reason` 字段。没有密码变更或通知测试事件新增，没有发送测试手机消息。

没有执行真实手机／Safari、响铃、长期稳定性或新一轮 27 样本性能／135 页矩阵测试。功能和性能边界保留。

## 资源与证据

Ubuntu 恢复 project `mw-v1250-restore-20261013` 通过 `mw-docker retire` 精确预览、归档及再次实际恢复验证后退役；容器、卷和网络已移除。正式和旧回滚镜像、其他任务及验收实例保留。没有全局 prune，也没有在 Unraid 创建开发／验收实例。

[固定镜像清单](../deploy/releases/v1.25.0-production.json)、[正式 Compose](../deploy/releases/v1.25.0-production.yaml)、[实际恢复](verification/pending-v1.25.0-production/database-restore.json)、[配置恢复](verification/pending-v1.25.0-production/configuration-restore.json)、[运行检查](verification/pending-v1.25.0-production/runtime.json)、[浏览器](verification/pending-v1.25.0-production/production-browser.json)、[证据索引](verification/pending-v1.25.0-production/index.json)。证据独立提交，不移动源码 tag；env、密码、dump、浏览器完整状态和许可库不提交。
