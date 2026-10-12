# v1.21.2 生产交付

2026-10-12，Market Watch 正式生产已从 v1.20.4 升级到 **v1.21.2**，包含 [PR #46](https://github.com/hezongyi/market-watch/pull/46) 和日历身份碰撞补丁 [PR #47](https://github.com/hezongyi/market-watch/pull/47)。不可移动标签 `v1.21.2` 指向 `65f49669f2e798d6285885d5e91087e734805277`，生产镜像、实际安装版本与该提交匹配。12 个常驻服务运行，API healthy，最终核对零重启；升级前备份和 v1.20.4 回滚资源保留。

## 环境、地址与操作

正式主机为 unraid `192.168.7.33`，Compose project 为 `market-watch`，根目录 `/mnt/user/appdata/market-watch`，active-release 为 `releases/v1.21.2-65f4966`。

- 网站：https://trade.kookvv.com:8443/
- 图表工作区：https://trade.kookvv.com:8443/advanced-charts
- 图表来源：https://charts.kookvv.com:8443/

启动／停止现有正式应用使用固定镜像，不重新构建或触发迁移：

```bash
ssh unraid
cd /mnt/user/appdata/market-watch
services=(api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin)
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps "${services[@]}"
# 正式维护时停止这 12 个应用服务：
./tools/docker-compose -p market-watch -f compose.release.yaml stop "${services[@]}"
```

发布构建和数据库恢复验证均在 Ubuntu `quant-server` 完成，没有在 unraid 创建开发或验收实例。四类镜像经 `mw-docker` 和专用 `market-watch-ubuntu` BuildKit 构建，task=`mw-v1212-release-20261012`、project=`mw-v1212-release-build`、purpose=`release`。unraid 导入后 RootFS 与有效镜像配置匹配，旧 Docker 增补的空配置字段已记录；部署使用完整固定镜像 ID。见 [生产清单](../deploy/releases/v1.21.2-production.json) 和 [实际 Compose](../deploy/releases/v1.21.2-production.yaml)。该 Compose 的相对 `.env` 由正式根目录提供，仓库不包含私有 env。

14 个有效 service 定义除镜像外与旧版本一致。11 个后端定义（含维护 migrate）全部保持 Yahoo 启用，10 个常驻后端的实际 Settings 已核对；生产代理、数据库、账号和通知配置保留。schema 仍为 `ar45_market_stream`，没有依赖或 schema 变化。

## 版本选择与备份恢复

v1.21.0 在安装前的真实备份恢复门槛被阻止：目录与已登记品种可能拥有相同 source、symbol、ID，默认 tuple 排序落到元数据字典比较并抛出 TypeError。维护脚本重启 v1.20.4，没有替换生产数据库。PR #47 给目录范围增加 `catalog:` 身份前缀，并只按标量字段排序；相关 HTTP／日历回归 96 项通过，Standards 和 Spec 复核均零阻断，见 [补丁记录](calendar-scope-collision-v1.21.2.md)。

发布脚本未在失败的合并前置断言后及时终止，曾误把 v1.21.1 推到旧 `56048c82`，该标签不包含补丁，禁止部署。v1.21.0 与 v1.21.1 均未安装到生产，原标签保持不可移动；最终核对并部署 v1.21.2。

成功切换的写入暂停从 **02:44:39 UTC 至 02:50:11 UTC**（新加坡时间 10:44:39 至 10:50:11），共 332 秒；这不包含此前 v1.21.0 被门槛阻止的维护窗口。

- 最终数据库备份：`/mnt/user/backup/market-watch/alerts-20261012T024441763287Z.dump`，952,026,294 字节，SHA256 `17373015a6bd788e1dd1c61c15a400189b022708cf525e36e986e2fa0ebd876b`。
- 配置归档：`/mnt/user/backup/market-watch/config-20261012T024637Z-NFUfNT.tar.gz`，SHA256 `5d53922c0a4e5a68727012db8682b39a4bd2c41917211a49286312997c3e2b5e`。
- 最终 dump 在 Ubuntu 独立 PG14 实际恢复，使用**正式 v1.21.2 镜像**核对 86 张表计数、账号／通知设置和工作区等指纹，读取 430 行日历成功。恢复库实际大小 4,365,823,323 字节，临时恢复库已删除。此前注入修复模块的 v1.21.0 预检不代替这次正式镜像验证。
- 配置归档在 Ubuntu 隔离目录全量实际解包，env 字节及私有权限、Compose、active-release 与旧源码抽检匹配，Compose 展开验证通过，解包目录已删除。

证据：[数据库恢复](verification/pro-charts-v1.21.2-production/database-restore.json)、[配置恢复](verification/pro-charts-v1.21.2-production/configuration-restore.json)、[备份摘要](verification/pro-charts-v1.21.2-production/backup-summary.json)。升级与验证均未恢复或覆盖正式生产数据库。

## 上线验证

Ubuntu Chromium 对正式生产做了八组登录态检查，未保存新告警、布局、偏好或日历审核，未发送真实通知测试或修改密码。偏好迁移请求以 `migrated=0` 本地响应，原生偏好自动保存被阻止；行情订阅及读取仍实际访问生产。

- 现有五图工作区正常加载，唯一告警业务根就绪，认证 SSE 收到 16 个 bars／quotes 事件。
- 原生告警侧栏和窗口、消息取消／通知 Escape 的焦点恢复、100／2000 字段限制通过；指标窗口共存正常。
- 数据中心六个入口保留，来源状态和交易日历 HTTP 200。生产有效配置下读取 299 行、row_id 唯一；与恢复实例的 430 行分别记录，不把不同来源范围的数量视为一致。
- 既有画线属性中的 M1、M5、M15、M30、H1、H4、D1、W1、MN 九个可见周期均显示，取消后未修改画线。
- 390px 主页无横向溢出；触摸模拟手机显示只读看盘说明，现有桌面工作区保留。页面异常、HTTP 错误、图表域凭据泄漏及意外业务写入均为零，退出登录已核验。
- Yahoo AAPL 元数据、D1 实际上游读取（26 根）和报价通过，既有代理保持配置。记录的最近报价属于既有交易时点，不宣称实时股票报价。
- OANDA EURUSD／XAUUSD 为 connected／healthy，报价、分钟线及恢复就绪，没有 authentication hold；BTC M1 新鲜。既有组合品种状态仍为 waiting，历史 `Unknown source: composite` 计数至最终核对未增加，不宣称所有供源或组合链路均已健康。

连续 worker 观察窗口为 259.77 秒：12 个服务零重启，行情／通知心跳推进且新鲜，candles 增加 28、published bars 增加 6。stream worker 没有实现 `market_stream_heartbeat` 审计事件，因此以真实认证 SSE 和运行／重启状态核验。03:06:42 UTC 再次核对版本、固定镜像、API health 与心跳通过。

工作区、偏好、账号／通知配置与告警定义／生命周期字段保留，另外九个稳定业务表原始指纹匹配。`chart_alerts` 的 `health_reason` 与 `runtime` 被 worker 正常更新，**不把整张告警表的原始哈希记为未变化**；该区分由最终备份的实际隔离表恢复与生产只读比对验证。

证据：[登录态浏览器](verification/pro-charts-v1.21.2-production/production-browser.json)、[实际运行配置](verification/pro-charts-v1.21.2-production/runtime.json)、[告警配置比对](verification/pro-charts-v1.21.2-production/alert-config-preservation.json)、[worker 观察](verification/pro-charts-v1.21.2-production/worker-stability.json)、[最终健康核对](verification/pro-charts-v1.21.2-production/final-health.json)。

Android／iOS 实机验收仍按 [用户决定](verification/pro-charts-20261011/acceptance-decision.md) 由用户后续执行；触摸模拟不等于实机通过。未执行 Safari、真实手机响铃、所有供源完整链路或长期稳定性验收。

## 回滚与资源收口

已保留 v1.20.4 镜像、原 Compose／active-release、私有 env 和正式备份。回滚入口在正式根目录：

```bash
bash deploy/pro-charts-v1.21.2-switch-20261012/rollback.sh
```

回滚脚本先备份当前数据库和配置，再切回旧应用，保留当前数据库；本轮没有执行回滚。脚本和回滚配置的哈希已核对。

Ubuntu 两次恢复 project `mw-v1210-restore-20261012`、`mw-v1212-restore-20261012` 均经 `mw-docker retire` 精确预览、备份和实际恢复后退役；最终无 container／volume／network 遗留。正式发布镜像与回滚镜像保留，临时恢复镜像删除；生产两份本轮预览 `.env` 已核实并删除，私有回滚 env 与正式备份保留，未使用全局 prune。

清理记录仅涉及本轮明确归属资源。共享 Ubuntu 主机的其他容器基线中有两个旧 ID 不再存在，同时另一 project 的 api／migrate 已重新创建；没有保留旧 ID 的归属／销毁证据，因此不把“所有其他容器 ID 均未变化”写成通过。没有针对其他 project 执行清理或停止。见 [资源核对](verification/pro-charts-v1.21.2-production/resource-final-check.json)。

本记录及固定镜像清单在独立文档分支发布，生产仍对应不可移动的 v1.21.2 产品提交。可提交证据经过裁剪，原始 env、登录凭据、dump、许可文件和完整浏览器状态均不进入仓库；JSON 内容校验见 [证据索引](verification/pro-charts-v1.21.2-production/index.json)。
