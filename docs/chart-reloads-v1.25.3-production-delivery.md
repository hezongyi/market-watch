# v1.25.3 图表展示与 Supertrend 生产交付

2026-10-14，PR [#59](https://github.com/hezongyi/market-watch/pull/59) 和版本整理 [#60](https://github.com/hezongyi/market-watch/pull/60) 已合并；附注标签 `v1.25.3` 已推送，指向 `6679a70d0d38f5b3d786d1d022f65065a4b8fc28`。Unraid 正式生产已从 v1.25.2 切换到 v1.25.3，12 个常驻服务运行、API healthy、重启计数为零。网站 https://trade.kookvv.com:8443/ ，图表 https://charts.kookvv.com:8443/ 。

价格与 Supertrend 使用同一个持久展示快照，跨分钟、报价老化及重连保留已展示的未确认 M1；后台确认更新观测并重算递归指标后缀。展示与固定 checkpoint／告警判定分离，不把临时柱升级为确认行情。恢复错误支持明确重试，并对切换、取消和并发回滚做身份隔离。绘图可见周期恢复原生分钟／小时／天／周／月范围；正式图表 bundle 已确认不存在旧自定义可见范围钩子。功能及回归证据见 [实施验收](chart-reload-implementation-20261013.md)。

四类镜像在 Ubuntu 从 clean tag 经 `mw-docker`、purpose=release 构建，导入 Unraid 后逐项核对 RootFS 和有效配置，生产引用完整固定 image ID。运行代码与受测 `e9a2537` 一致，生产全部后端 Python 模块 hash 匹配标签。备份镜像沿用上一正式镜像的 PG14 客户端及依赖库，应用仍来自本次 clean tag。standalone Compose 由 `compose.production.yaml` 生成；除了四类镜像，全部有效服务配置与旧生产相同，原 `.env` 字节未改变。11 个 backend service 定义 Yahoo=true，10 个常驻后端实际 Settings 开启且代理存在；native-history-worker 的 OANDA REST 确认开关保留。

停写窗口为 **00:40:19Z–00:54:56Z，877 秒**（新加坡时间 08:40:19–08:54:56）。最终备份 `alerts-20261014T004020976828Z.dump` 为 2,513,986,657 字节，SHA256 `0f6e8b22168f7906a1b78d6260a7eb16967f1a02da3961ec964f0b31b2b028a6`。Ubuntu 独立 PG14 实际完整恢复，86 张应用表计数匹配、87 张 public 表恢复成功，恢复数据库约 9.5 GB。账号／通知配置、规则和工作区指纹一致；配置归档 `config-20261014T004511Z-L2ThYE.tar.gz` 实际解包核对 8,285 项。

在恢复库先验证 `as46_provider_price_confirmation → at47_display_observations → au48_display_indicator_tasks`，旧表计数和业务指纹不变、三张新表为空后，才放行生产迁移。上线后的实际 schema 为 au48，工作区、偏好、规则配置、账号和通知指纹保持一致，无通知测试或改密码；行情、通知心跳已推进。Yahoo AAPL 元数据、58 根原生日线及报价成功。最初包含当前日期的历史读取返回无效 OHLC，被严格拒绝；成功检查使用七日前的截止窗口，未将无效响应写成覆盖证据。

正式 HTTPS 登录页可加载，零 pageerror；登录后页面检查尚未完成：本机保存的旧密码返回 401，已请求当前密码或用户自行验收，未修改密码或绕过认证。生产图表资源、源码和 host 内容 hash 检查通过；Ubuntu 隔离实例此前的真实图表／Supertrend／恢复重试验收通过，但不代替生产登录后验收。没有保存生产布局、新建规则或测试通知。

正式根目录 `/mnt/user/appdata/market-watch`，project `market-watch`，active-release 为 `releases/v1.25.3-6679a70`。旧 v1.25.2 四类镜像、Compose、私有 env、最终数据库／配置备份保留。需要回退时执行：

```bash
ssh unraid
cd /mnt/user/appdata/market-watch
bash deploy/chart-reloads-v1.25.3-switch-20261014/rollback.sh
```

脚本先停写并备份当前状态，再恢复旧应用；保留最新数据库，不降级 schema、不覆盖用户新增数据。非空新表的迁移降级受保护。生产正常启停：

```bash
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin
./tools/docker-compose -p market-watch -f compose.release.yaml stop api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin
```

Unraid 未创建测试实例，已精确删除本次四个导入 tar，正式／回滚镜像与备份保留。Ubuntu 恢复 project `mw-v1253-restore` 已停止，恢复卷暂保留：`mw-docker retire` 预览拒绝该正式发布任务（仅支持登记的 acceptance task/project），未绕过工具删除卷。原图表修复验收实例继续保留。release build task 已登记完成；没有全局 prune，也没有影响其他任务。私有资料保留于受限目录，不提交 env、密码、dump、许可库、完整浏览器状态或原始日志。生产证据独立提交，不移动标签。

[固定镜像清单](../deploy/releases/v1.25.3-production.json)、[正式 Compose](../deploy/releases/v1.25.3-production.yaml)、[恢复验证](verification/chart-reloads-v1.25.3-production/database-restore.json)、[生产状态](verification/chart-reloads-v1.25.3-production/production-state.json)、[运行检查](verification/chart-reloads-v1.25.3-production/production-runtime.json)、[浏览器边界](verification/chart-reloads-v1.25.3-production/production-browser.json)、[证据索引](verification/chart-reloads-v1.25.3-production/index.json)。
