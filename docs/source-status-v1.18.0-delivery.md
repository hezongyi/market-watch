# 来源状态与供源默认配置 v1.18.0 正式交付

PR [#33](https://github.com/hezongyi/market-watch/pull/33) 和 [#34](https://github.com/hezongyi/market-watch/pull/34) 已合并，附注标签 `v1.18.0` 指向 `e75694c79e62ff8a464916278f35c9148cce6241`。部署证据单独提交，不移动发布标签。四类正式镜像由该干净提交通过 Ubuntu `mw-docker` 和 `market-watch-ubuntu` BuildKit 构建。

## 实际部署

- 环境：unraid 既有正式 Compose project `market-watch`，目录 `/mnt/user/appdata/market-watch`。
- 访问：https://trade.kookvv.com:8443/advanced-charts
- 图表 origin：https://charts.kookvv.com:8443
- 生效目录：`releases/v1.18.0-e75694c`。
- 12 个服务运行，API healthy，重启数均为 0。镜像身份、命令、端口和挂载核对通过；环境配置只改变 Yahoo 启用值。
- 数据中心顶部供源提示迁入独立「来源状态」分类；原四分类没有顶部状态区。
- `compose.production.yaml` 固定所有应用后端 Yahoo=true；以后正式部署使用此模板，无需可选 overlay。10 个常驻后端实际 Settings 均启用 OANDA、Binance、Yahoo、Dukascopy；API 和 pricing-worker 的 OANDA 实时流为 true。

生产目录中的启动／停止命令：

```bash
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
./tools/docker-compose -p market-watch -f compose.release.yaml stop
```

## 验证结果及边界

- Standards／Spec 对 PR #34 最终提交 `d2bc0b1` 的复审均无发现；来源状态页面沿用 PR #33 的复审记录。
- 正式 API 镜像：91 项供源／live／OANDA recovery 回归与 32 项发布回归通过。133 个安装后 Python 模块与标签源码一致，第三方依赖与 v1.17.0 一致。
- Ubuntu 隔离 PostgreSQL 实例中完成 Yahoo 实际读取；生产既有 API 容器也实际返回 AAPL 元数据、10 根 D1 K 线和报价 336.64（quote_time `1791576000000`）。代理配置保留且不公开。
- 生产浏览器完成 18 项只读检查，包括三次既有工作区加载、登录／退出、真实 SSE、数据中心与管理五分类、任务入口和返回、375px 滚动恢复、版本详情焦点、指标窗口、Binance 原生价格精度、独立来源状态页刷新与折叠诊断、390px 布局、Yahoo 商品搜索与目录。没有维护、采集或控制写入；pageerror 为 0。
- 启用状态不代表上游可用。OANDA 仍为 `unavailable`、会话 `unknown`，行情未就绪；周末开市与实时恢复没有在本次验证。Dukascopy 上游读取没有重验，既有 `precision_overflow` 问题不在本次修复范围。
- 原来源状态验收和最终滚动修复回归保留各自记录的提交与执行范围；本次没有将旧验收数量描述为全部重跑。

## 备份与回退

写入暂停从 2026-10-10 14:49:16 UTC 至 14:56:21 UTC，共 425 秒。切换前 PG14 备份 `alerts-20261010T144918678554Z.dump` 在 Ubuntu 独立数据库实际恢复，86 张业务表记录数与清单一致，schema 为 `ar45_market_stream`。配置归档实际解包、核对 env 哈希／权限和 Compose。迁移检查通过，无 schema 变更，只有备份审计记录增加 1 条。

生产保留 v1.17.0 镜像、源码和切换前备份。回退命令：

```bash
./deploy/source-status-v1.18.0-switch-20261010/rollback.sh
```

该脚本先备份，再恢复旧 Compose 与版本指针，保留当前数据库，不执行 schema downgrade；本次没有实际执行生产回退。回退使用已核对的 v1.17.0 配置，保留 Yahoo=true；其余配置与旧生产完全一致。历史原 Compose 另行保留。

## 部署包与资源归档

Ubuntu 发布 worktree `/home/quant/repos/market-watch-release-v1.18.0-20261010` 的 `artifacts/release-v1.18.0/` 保留私有源码包、镜像包、`package-manifest.json` 和 `DEPLOYMENT.md`。包含许可库的包、凭据和数据库不提交仓库。SHA256、镜像身份及生产状态见[正式发布清单](../deploy/releases/v1.18.0-production.json)、[固定镜像 Compose](../deploy/releases/v1.18.0-production.yaml)和[验证证据](verification/source-status-v1.18.0-production/)。

Ubuntu 恢复 project `mw-v1180-restore-20261010` 已通过 `mw-docker retire` 精确退役：自身卷内三个数据库先备份并实际恢复，核对表记录数后删除其容器、卷、网络及无引用验收镜像。正式镜像保留，发布构建任务已登记完成。unraid 未创建测试实例，本次传输归档与已完成的迁移容器已删除；回退材料、旧版本和备份保留。
