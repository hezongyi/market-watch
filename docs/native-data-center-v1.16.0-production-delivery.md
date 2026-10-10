# v1.16.0 原生数据中心生产交付

2026-10-10。PR #27 已合并，发布元数据 PR #28 已合并。正式源码和附注标签 `v1.16.0` 固定为 `0bd9df8df823f01a64dd6ee98533bff4b537f96f`；后续本交付记录不改变运行源码或移动标签。

## 实际生产环境

- unraid `192.168.7.33`，现有 Compose project `market-watch`；目录 `/mnt/user/appdata/market-watch`。
- 网站 https://trade.kookvv.com:8443/advanced-charts ，图表 origin https://charts.kookvv.com:8443 。
- 当前发布 `releases/v1.16.0-0bd9df8`，12 个应用服务持续运行、零重启，API healthy；一次性 migrate 退出 0。现有环境变量、命令、端口、挂载均逐服务核对保持一致。
- 停写 2026-10-10T09:54:03Z，完成切换 2026-10-10T09:57:06Z，停写窗口 183 秒。没有在 unraid 创建开发、测试或验收实例。

## 构建与镜像

Ubuntu 本机 `mw-docker` / `market-watch-ubuntu`，task `mw-data-center-v1160-release-20261010`，project `mw-v1160-release-build`，purpose release，源码标签 dirty=false。133 个已安装 Python 模块与发布源码一致，版本 1.16.0，第三方依赖与 v1.15.1 一致；正式 API 镜像 32 项数据中心/目录/创建/真实 PG 回归通过。任务控制、SSE 顺序/代际/原生报价契约通过。

| 镜像 | 生产镜像 ID |
|---|---|
| `market-watch-api:v1.16.0-0bd9df8` | `sha256:0ef242e15bcce309e3c94f5d372ec4a90da8610e76f382149ead5b2bf527edff` |
| `market-watch-web:v1.16.0-0bd9df8` | `sha256:175c6ee07c0f38e94799662079b04b5b0b4f3344f023c674f2868c22fa2e2391` |
| `market-watch-chart-origin:v1.16.0-0bd9df8` | `sha256:59623aa85fdbab288090d5230c6ff67eadb7775882a4946a538be623b4f1e68c` |
| `market-watch-backup:v1.16.0-0bd9df8` | `sha256:37fd3ac34715ed30784751b5126e44a3b40019f1118e441f8364a0ac720bf91e` |

四类导出镜像逐层 hash、配置、标签、跨主机传输 SHA256 和生产实际 ID 均核对通过。固定 Compose 和逐服务清单见 `deploy/releases/v1.16.0-production.yaml/json`。标签指向实际构建提交；不将验收镜像改标为正式版本。

## 备份、迁移与回退

停写前后流程生成最终一致性数据库备份及私有配置归档；上线后另生成数据库备份。两份数据库 dump 分别在 Ubuntu 独立 project `mw-v1160-restore-20261010` 的 PG14 中实际恢复，各 86 张业务表计数与备份清单一致，恢复库已删除。配置实际解包、生产 env 哈希/权限及 Compose 配置校验通过；上线后配置另作归档。

schema 始终为 `ar45_market_stream`，无新增迁移。切换时既有86表核对通过，audit_events 仅增加备份审计1条。保留 v1.15.1 镜像、发布目录、回退配置及 `/mnt/user/backup/market-watch` 的正式备份。应用回退脚本 `deploy/data-center-v1.16.0-switch-20261010/rollback.sh` 已语法检查，先停写及备份，再恢复旧镜像/配置；不降级 schema、不覆盖当前用户数据。本次成功切换未实际执行生产回退。

## 生产验证

浏览器在 Ubuntu 直接访问正式域名和部署资源，最终 11 项检查通过、页面错误0：HTTPS登录/Secure Cookie、现有四图工作区三次加载与 dataReady、认证 SSE、四个数据中心栏目、原生指标窗口、既有品种与指标实例保持、真实 Binance BTCUSDT SSE 原价与 native tick scale=100、周末来源状态及390px布局。验收会话已退出，未新增工作区、指标、任务或行情。

生产 Yahoo 未配置，AAPL 不存在于目录；Yahoo 显示精度验收沿用 PR #27 Ubuntu 真实 SSE 证据。Binance 保留供应商 tick 规则，生产只断言原价和最终原生 scale=100。OANDA 当前闭市/时段未知，不声称已经验证开市推进或新成交；界面不误报 quote/candle ready。生产任务控制故障与创建命令不操作用户数据，其闭环证据见 [PR #27 验收](verification/chart-data-center/pr-integration-20261010.md)。

初始浏览器执行依赖缺失、Yahoo未配置、Binance字段契约和旧页面selector问题的报告均保留于 ignored artifacts；最终脚本使用已配置供应商和当前原生iframe组件，无运行产品代码修改或断言放宽。

## 启停与清理

在 unraid 生产目录运行：

```bash
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
./tools/docker-compose -p market-watch -f compose.release.yaml stop
```

恢复验证实例已通过 `mw-docker retire` 预览后精确退役，临时数据库、容器、volume、网络和任务登记镜像均清除；私有归档 `/home/quant/.local/share/market-watch-docker/archives/mw-v1160-restore-20261010-20261010T100404-2053378c` 保留。正式镜像用途为 release，不参与自动回收。生产临时镜像传输 tar 已精确删除，保留正式源码、生产备份和上一版回退资源；其他项目未操作。

私有证据在当前 worktree `artifacts/release-v1.16.0/`，env、登录凭据、完整 inspect、dump、许可库和浏览器状态不入库。
