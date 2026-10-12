# v1.20.2 生产发布与收口

2026-10-11，PR [#40](https://github.com/hezongyi/market-watch/pull/40) 已合并，
annotated tag `v1.20.2` 已推送，指向 `d8d5f0b15469c8627bc2232320496bbf0a4ba673`。
正式实例于 05:28:13 UTC（13:28:13 新加坡时间）切换完成。
本记录提交晚于发布，产品 tag 不移动；历史 release 清单不改写。

## 正式环境与操作

- 主机：Unraid `192.168.7.33`，正式 Compose project `market-watch`。
- 目录：`/mnt/user/appdata/market-watch`；活动指针：
  `deploy/active-release` = `releases/v1.20.2-d8d5f0b`。
- 网站：<https://trade.kookvv.com:8443/>。
- 图表来源：<https://charts.kookvv.com:8443/>，由主站加载。
- 密码未改变，真实 HTTPS 登录、Secure/HttpOnly cookie 和退出已验证。
  凭据、账户绑定 profile、env、私钥、许可库和完整浏览器状态均不提交仓库。

以下命令操作正式生产，不用于验收；`stop` 会停止服务：

```bash
# 启动已固定镜像的正式实例
ssh unraid 'cd /mnt/user/appdata/market-watch && ./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build'
# 停止正式实例，保留数据库及配置
ssh unraid 'cd /mnt/user/appdata/market-watch && ./tools/docker-compose -p market-watch -f compose.release.yaml stop'
# 必要时执行已保留的应用/配置回滚，不降级 schema
ssh unraid 'bash /mnt/user/appdata/market-watch/deploy/provider-fix-v1.20.2-switch-20261011/rollback.sh'
```

## 构建、备份与切换

四只正式镜像均从 clean tag 源码在 Ubuntu 通过 `mw-docker` 构建，专用 builder
`market-watch-ubuntu`；task `mw-provider-fix-v1202-release-20261011`，
project `mw-v1202-release-build`，purpose `release`。构建 task 已正常结束，正式及
旧回滚镜像保留。镜像流式传输，没有留下大型本机镜像归档。
Unraid 旧 Docker 的 image ID 与 Ubuntu 不同，RootFS 和有效 Config 已逐项匹配；
固定正式 ID、各层和标签见 [发布清单](../../../../deploy/releases/v1.20.2-production.json)。
正式 API 与验收 API 的 136 个产品 Python 文件、76 个依赖版本完全一致。

最终备份前停止 10 个写入服务，05:20:26 UTC 至切换共暂停 467 秒。
数据库备份 `alerts-20261011T052028734823Z.dump`，490,672,986 字节，SHA256：
`aa8e52b025ce73ed9e5ab952972775750a2e5104939c3e6451c22024644be0fc`。
Ubuntu 独立 `mw-v1202-restore-20261011` 实际恢复 3,436,866,907 字节数据库，
schema `ar45_market_stream`，86 表计数、10 类用户/组合表 fingerprints、账户和通知
设置均匹配。临时恢复数据库已删除。配置归档 SHA256
`d53328d0a029fab792299163fd9d5b822ce9baca877934ef0b3500b51bad923e`，
在 Ubuntu 实际解包，env、compose 和活动指针匹配且 Compose 展开有效。
正式备份保留在 `/mnt/user/backup/market-watch`，v1.20.1 镜像与私有回滚配置保留。

恢复首次因默认 app user 无法读取 0700 私密目录而失败；保留失败记录，随后仅用
`compose run --user 0` 恢复成功，未放宽文件权限。验收曾误挂旧夹具，计划复市被误断言
为 `open`；正确仓库夹具要求 `scheduled_open`。移除旧挂载后 clean 镜像正式清单
110 个供源/图表/池/OANDA 流测试、30 个真实 PG 合同全部通过，无产品修改。
更早的完整源码结果 1466 通过、389 跳过；跳过不计为通过。

## 生产验证结果与限制

12 个常驻服务运行、0 重启，API healthy，两个 HTTPS 入口返回 200。
Compose 的 11 个后端服务（含一次性 migrate）Yahoo 均启用；10 个常驻后端实际
Settings 均启用。实际 Yahoo AAPL 元数据、27 根 D1 和 quote 读取通过，既有代理保留。
仅 Binance 改为 direct，OANDA/Yahoo/Dukascopy 的代理、账户、通知和数据库配置保留。

165,366 毫秒供源观察内，BTCUSDT M1 推进 120,000 毫秒，末尾年龄 72,452 毫秒；
`Unknown source: composite` 历史审计 1823 条不增长，精确修复审计增加 1。
组合身份、固定修订、目标映射与 EUR_USD/XAU_USD desired graph 不变。
OANDA 两品种已证实闭市，普通网络残留状态已清，quote/candle/recovery readiness
仍为 false。周末不能验证未来真实复市报价和 M1；隔离 PG 保护合同通过不能替代实盘证据。
有限账户绑定 SG profile 于 **2026-10-18T00:00:00Z（08:00 SG）到期**，届时回到
unknown；到期前须依据官方交易小时和假日资料复核。计划开市不会解除报价/M1 门槛。

生产浏览器第二、第三完整验收均通过：既有五图、真实 authenticated SSE bars/quotes、
原生告警入口及取消交互、数据中心六分区/来源状态、指标窗口、390px 页面与退出。
两轮 0 页面异常、意外 HTTP 错误、凭据泄漏或意外写入。偏好保存被抑制，未保存真实
告警或发送测试通知；用户配置 fingerprints 未变。runtime/heartbeat 仅是短观察，
不宣称长期稳定性。网络预算仍受同步 DNS、多地址 connect 的底层边界限制，
HTTPcore 私有 backend 集成点须在依赖升级时复验。

**首轮有一次 HTTP 500，未视为通过或掩盖。** `/api/charts/data` 同 key 并发首次登记
需求，触发 `market_data_demand_pkey` UniqueViolation，导致图表就绪超时。
错误链两处文字属于同一次事故。`market_data.py`、`series_access.py`、`chart_api.py`
在 `v1.20.1..v1.20.2` 无差异，共享 `renew_demand` 的先查再插存在既有竞态。
后两轮通过不意味着竞态已修，回滚旧版本也保留这段逻辑。
根因和原子 upsert／真实 PG 并发回归方案见
[单独问题记录](../../../investigations/market-demand-first-insert-race-20261011.md)。

## Ubuntu 资源收口

开发、验收、备份恢复均只在 Ubuntu 本机，未在 Unraid 创建调试或验收实例。
本轮验收地址原为 `https://192.168.7.232:19819/` 和
`https://192-168-7-232.sslip.io:19820/`；退役后停止开放。
原启动/停止命令见 [验收记录](../README.md)，只供追溯，已退役 task 不复用。

起初可用空间约 7.7 GiB，`mw-docker retire --apply` 在停止/删除前被至少 10 GiB
门槛阻止，两次失败记录保留。本轮按确切目录清理可再生成的 npm/pip/Go/Node 缓存、
Conda 确认未使用且无软链接引用的包缓存；v1.20.0 本机 transfer 副本在核对正式备份
哈希且已有实际恢复证据后删除。没有全局 prune、广泛删镜像、删除其他任务卷或改变磁盘。
随后达到门槛，按以下 task/project 各自预览并执行退役，归档配置、数据库且实际恢复
通过后才删除所属容器、网络、卷及无引用验收镜像：

```bash
sg docker -c 'mw-docker retire --task mw-v1202-restore-20261011 --project mw-v1202-restore-20261011'
sg docker -c 'mw-docker retire --task mw-v1202-restore-20261011 --project mw-v1202-restore-20261011 --apply'
sg docker -c 'mw-docker retire --task mw-provider-fix-20261011 --project mw-provider-fix-20261011'
sg docker -c 'mw-docker retire --task mw-provider-fix-20261011 --project mw-provider-fix-20261011 --apply'
```

精确归档、恢复校验、完成时间与最终空间见 `resource-closure.json`。
私密归档位于 `~/.local/share/market-watch-docker/archives/`，0700，不提交仓库。
