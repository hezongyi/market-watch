# v1.25.2 稀疏日线价格告警生产交付

2026-10-13，[PR #57](https://github.com/hezongyi/market-watch/pull/57) 已合并，附注标签 `v1.25.2` 指向 `be636948a4bb67db1012104ae89fae2ad0500a97` 并已推送。四类正式镜像从该 clean tag 在 Ubuntu 经 `mw-docker`、purpose=release 构建，运行源码与受测 `6b02eea` 逐字节一致。Unraid 导入后的 RootFS／有效配置匹配，生产引用完整固定 image ID；12 个常驻服务运行、零重启，API healthy。

`v1.25.1` 因本机旧版 gh 不支持合并参数，发布命令未合并却继续推标签，错误指向旧 main `845dcff`。该标签保留、不改写，未构建或部署；实际修复使用 v1.25.2。

## 实际问题与结果

活动 EURUSD 组合 D1 告警已从 stale 恢复 **ready**，runtime 当前报价也为 **ready**。同账户 OANDA 原生完整日线的四项 OHLC 为 1.11850／1.12167／1.11521／1.11549，与组合聚合完全一致；后台任务 result=data，不可变 blob 校验通过。实际判断证据包含 `native_ohlc_match` 和 `native_confirmed_close`。

原 2026-10-11 21:00 至 2026-10-12 21:00 UTC 的日线仍为 1425 分钟观测、15 分钟未知，`coverage_complete=false`；未补造 M1，未推断闭市或确认指标／成交量完整。判定仅为 recovery_baseline，告警触发次数保持 0；signals、notifications、delivery_attempts 均与停写备份相同，没有补发历史通知。上线初期正常 input revision 推进产生了 3 条同一事件时间的恢复基准证据，均无 signal。

实际 HTTPS 登录后的原生告警详情显示“数据就绪”和“当前报价：正常”；来源状态中 EURUSD／XAUUSD 显示“已核实交易时段”，实际源 connected／healthy、quote/candle ready、无 authentication hold。五图工作区、真实 bars/quotes SSE、主要页面和六个数据中心标签通过；390px 首页无横向溢出。两次完整浏览器检查均零 pageerror／HTTP error／意外业务写入，登录 Secure/HttpOnly 与退出通过。只读取用户规则和工作区，没有保存布局或修改设置。

## 配置与发布

网站 https://trade.kookvv.com:8443/ ，图表 https://charts.kookvv.com:8443/ 。正式主机 Unraid `192.168.7.33`，根目录 `/mnt/user/appdata/market-watch`，project `market-watch`；`deploy/active-release` 为 `releases/v1.25.2-be63694`。

standalone Compose 依据根 `compose.production.yaml` 生成。全部 11 个后端 service 定义（含 migrate）Yahoo=true，10 个常驻后端实际 Settings 均启用、代理存在；真实 Yahoo AAPL 元数据、26 根 D1 与报价读取通过。原 `.env` 字节未改变，外部数据库、代理、通知配置保留。除四类固定镜像外，唯一配置变化是显式启用 `native-history-worker` 的 `ALERTS_OANDA_STREAM_ENABLED=true`，以放行后台同账户 REST 确认；此 worker 不运行实时 pricing 流。后续部署需保留这个有效开关及 Yahoo 默认开启要求。

备份镜像的软件源访问未完成，取消该构建后改为从上一正式备份镜像复制已验证 PG14 客户端及缺少的运行库，应用仍使用新 clean tag；完整恢复实际验证成功。发布 Dockerfile 保留在该次私有 switch 目录中。最终 API 镜像内 35 项告警回归通过；缓存目录权限产生一条 pytest warning，不影响测试。原 190 项相关回归和真实 PostgreSQL 证据见 [修复验收](verification/sparse-alerts-20261013/README.md)。

## 备份与回退

停写窗口 **03:19:54Z 至 03:26:42Z**，408 秒。最终 PG14 dump `alerts-20261013T031955847620Z.dump` 共 1,349,931,537 字节，SHA256 `37a8c568b1868254dba3455d5ef73a5b91e0ed34b50ec39ad86182f69f553ef4`。Ubuntu 独立 Docker 实际完整恢复 86 张应用表及 alembic_version（87 张 public 表），计数、业务指纹、账号／通知设置匹配。新增一条 backup_completed 审计的差异符合备份快照顺序。配置归档实际解包 8,223 项、env／旧 Compose／active-release 一致，Compose 展开通过。数据库结构仍为 `as46_provider_price_confirmation`，无新迁移。

旧 v1.25.0 正式镜像、Compose、私有 env 和本次数据库／配置备份保留。需要已授权回退时执行：

```bash
ssh unraid
cd /mnt/user/appdata/market-watch
bash deploy/pending-v1.25.2-switch-20261013/rollback.sh
```

脚本先停写并备份当前生产，再恢复 v1.25.0 应用；保留最新数据库，不自动降级 schema 或用旧 dump 覆盖用户数据。启动／停止沿用：

```bash
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin
./tools/docker-compose -p market-watch -f compose.release.yaml stop api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin
```

## 边界与资源

原生历史 worker 未报告 turn failure，其他 worker 无 traceback。API 日志记录一次浏览器导航取消图表请求的 `asyncio.exceptions.CancelledError`；登录前 /api/session 的 401 和客户端取消产生的 nginx 499 已区分，真实浏览器验收无 HTTP 错误。没有真实手机响铃、未来交易日突破或长期性能观察；Load failed 未复现，按用户要求暂不处理。

Ubuntu 原修复验收与本次恢复 project 均经 `mw-docker retire` 预览、归档及实际恢复校验精确退役，其他任务不变。正式 release build task 已登记完成；正式和旧回滚镜像保留。Unraid 未创建测试实例，没有全局 prune。备份同时留在 Unraid 和 Ubuntu，不代表异地灾备。私有 env、密码、dump、许可库、完整浏览器状态与原始日志不提交。

[固定镜像清单](../deploy/releases/v1.25.2-production.json)、[正式 Compose](../deploy/releases/v1.25.2-production.yaml)、[告警证明](verification/sparse-alerts-v1.25.2-production/alert-ready.json)、[运行检查](verification/sparse-alerts-v1.25.2-production/runtime.json)、[浏览器](verification/sparse-alerts-v1.25.2-production/production-browser.json)、[证据索引](verification/sparse-alerts-v1.25.2-production/index.json)。生产证据单独提交，不移动源码标签。
