# v1.23.0 生产交付

2026-10-12，Market Watch 已从 v1.21.2 升级到 **v1.23.0**。[PR #52](https://github.com/hezongyi/market-watch/pull/52) 已合并，annotated tag `v1.23.0` 指向主分支合并提交 `463b863482a908c3d7317f5e191e4f291f1a6d4a`。正式安装版本与该提交匹配，包含 Supertrend 原生指标、Swing 及已合并的界面修复。12 个常驻服务运行、API healthy，最终核对零重启；旧 v1.21.2 镜像和回滚配置保留。

## 生产地址与操作

- 正式主机：unraid-aio，`192.168.7.33`；根目录 `/mnt/user/appdata/market-watch`，Compose project `market-watch`。
- 网站：https://trade.kookvv.com:8443/
- 图表：https://trade.kookvv.com:8443/advanced-charts
- 图表资源：https://charts.kookvv.com:8443/
- `deploy/active-release`：`releases/v1.23.0-463b863`。

```bash
ssh unraid
cd /mnt/user/appdata/market-watch
services=(api pricing-worker chart-aggregation-worker chart-history-worker history-worker composite-aggregate-worker native-history-worker realtime-worker notify-worker market-stream-worker web chart-origin)
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build --no-deps "${services[@]}"
# 授权维护时停止正式应用：
./tools/docker-compose -p market-watch -f compose.release.yaml stop "${services[@]}"
# 如需回滚，脚本先备份当前状态，再切回 v1.21.2 应用，保留当前数据库：
bash deploy/supertrend-v1.23.0-switch-20261012/rollback.sh
```

构建与恢复验证均在 Ubuntu quant-server 本机 Docker 完成。正式构建使用 `mw-docker`、builder `market-watch-ubuntu`、task `mw-v1230-release-20261012`、project `mw-v1230-release-build`、purpose `release`。四类镜像标签确认 clean、源提交和发布用途；unraid 导入后的 RootFS 和有效镜像配置与 Ubuntu 匹配，部署引用完整固定 image ID，见 [镜像清单](../deploy/releases/v1.23.0-production.json) 与 [正式 Compose](../deploy/releases/v1.23.0-production.yaml)。

全部 14 个 service 定义核对完成，11 个后端定义（含 migrate）Yahoo 均为 true。除镜像外，已合并的 API history-health worker 列表是唯一有效运行配置变更；正式私有 env 字节保持一致，数据库、代理及通知配置保留。10 个常驻后端实际 Settings 再次核对 Yahoo 开启和代理存在，实际 Yahoo AAPL 元数据、26 根日线与报价读取通过。schema 仍为 `ar45_market_stream`，相对 v1.21.2 无依赖锁或 migration 变化。

## 最终备份与实际恢复

写入暂停：**12:29:45 UTC 至 12:46:06 UTC**（新加坡时间 20:29:45 至 20:46:06），981 秒。恢复检查脚本的两次断言调整延长了维护窗口；未绕过恢复门槛。

- 最终 dump：`/mnt/user/backup/market-watch/alerts-20261012T122947693583Z.dump`，1,032,356,057 字节，SHA256 `81226d36a4cd2eb0fb4c71ec0a2ac0e36d2960a21099d4e1d6beb6cebc3b150c`。
- 配置归档：`/mnt/user/backup/market-watch/config-20261012T123157Z-h6D5R6.tar.gz`，SHA256 `5f6ce3c7395c60d1b4a4fd289b28d441d1baa234734420760d3236255d02604e`。
- dump 在 Ubuntu 独立 PG14 **实际完整恢复**，正式 v1.23.0 镜像核对 86 张应用表与 manifest 完全一致；加上 alembic_version，共 87 张实际 public 表。恢复库约 4.47 GB，稳定业务表指纹、账号和通知设置均匹配，日历读取 299 行、已标识日历 row_id 唯一，两个 native profile 目录存在。
- dump 完成后备份程序新增一条 `backup_completed` 审计记录，导致随后生产快照 audit_events 多一行。已通过只读查询核实该记录 SHA256 对应最终 dump；恢复按 dump 的审计计数与其他表的生产快照核对，未忽略其他差异。
- 日历通用 Yahoo 来源说明允许没有 row_id，检查脚本因此改为核对已标识行的唯一性。日历实际读取成功；不将通用说明行强制当作已标识品种。
- 配置归档在 Ubuntu 全量解包 7,837 项，env 字节、私有权限、Compose 和旧 active-release 匹配，Compose 展开通过；解包目录已删除。

生产数据库没有恢复或覆盖。验证成功后才放行安装；失败门槛保留重启旧应用的 trap。最终备份、私有回滚 env、旧镜像及脚本保留，本次未执行应用回滚。

证据：[恢复报告](verification/supertrend-v1.23.0-production/database-restore.json)、[配置恢复](verification/supertrend-v1.23.0-production/configuration-restore.json)、[备份摘要](verification/supertrend-v1.23.0-production/backup-summary.json)。

## 上线检查与截图

Ubuntu Chromium 对正式 HTTPS 做管理员登录，Secure/HttpOnly session 与退出通过。行情、指标、历史分页及 SSE 请求实际访问生产；只在浏览器中响应偏好和工作区保存，未保存新的生产布局、告警、模板或偏好，未改密码或触发通知测试。完整最终检查 **零 pageerror、HTTP error、跨图表来源凭据泄漏和意外业务写入**。

- 原有五图布局加载，真实 bars/quotes SSE 到达；原有告警根唯一。
- 高级目录包含 Supertrend 和 Swing；旧工作区目录仍仅包含八个支持的指标。
- 内存单图使用真实 `MWP:EURUSD` D1：两个独立 Supertrend 与 Swing 同时绘制，十字光标有限数值、Boolean 参数、独立参数和样式、模板恢复均通过。
- 参数窗口、深浅主题、重新加载后的五图告警侧栏和 390px 首页，共五张截图逐一人工查看。
- 正常网页重新加载恢复服务器原有五图工作区，验证中的新指标未保存到生产。
- 原生告警消息取消与通知 Escape 焦点恢复、数据中心六个入口／来源状态、指标窗口共存通过。
- 运行核对保留工作区、偏好、账号／通知设置，以及告警定义／生命周期。告警 `health_reason` 和 `runtime` 是 worker 可变执行字段，未把整表哈希不变作为上线结论。
- OANDA EURUSD/XAUUSD connected/healthy、报价与分钟线 ready，没有 authentication hold。市场和通知心跳推进，分钟线及已发布图表数据增加；历史 `Unknown source: composite` 没有新增。provider_bars 可因正常后台维护减少，不把其净增加作为健康条件。

截图：[深色](verification/supertrend-v1.23.0-production/production-supertrend-dark.png)、[参数](verification/supertrend-v1.23.0-production/production-supertrend-settings.png)、[浅色](verification/supertrend-v1.23.0-production/production-supertrend-light.png)、[五图告警](verification/supertrend-v1.23.0-production/production-native-alert.png)、[移动视口首页](verification/supertrend-v1.23.0-production/production-mobile.png)。[最终浏览器报告](verification/supertrend-v1.23.0-production/production-browser.json)、[实际运行配置](verification/supertrend-v1.23.0-production/runtime.json)、[最终健康](verification/supertrend-v1.23.0-production/final-health.json)。

早期检查脚本沿用旧 read allowlist、未显式选择参数输入页、拦截保存返回不完整，均已修正。另一次用裸 `widget.load` 将内存单图直接恢复成五图，出现 vendor `Value is null`，该路径**没有验收通过**；最终使用网页重新加载恢复服务器布局，完整检查零错误。详细范围见 [检查限制](verification/supertrend-v1.23.0-production/browser-check-limitations.json)。这不证明任意布局重建、所有参数或所有供源链路均可用。

没有执行真实手机／Safari 验收、手机响铃或长期稳定性测试。既有组合行情部分状态仍可能 waiting，不宣称其完整链路健康。Python/Pine 尚无相同 OHLC 导出对照；其余指标差异与范围见 [功能验收记录](verification/supertrend-20261012/README.md)。

## 资源与证据

Ubuntu 临时恢复 project `mw-v1230-restore-20261012` 已使用 `mw-docker retire` 精确预览、归档并再次实际恢复验证后退役，container、volume、network 已移除；正式和回滚镜像保留。没有全局 prune，也没有在 unraid 创建开发或验收实例。

证据发布在独立文档提交，不移动 v1.23.0 标签。env、密码、dump、完整浏览器状态和许可库不进入仓库。[证据哈希索引](verification/supertrend-v1.23.0-production/index.json) 与固定镜像清单可用于复查。
