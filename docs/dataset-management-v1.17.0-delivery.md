# 自建行情管理 UI v1.17.0 正式交付

PR #31 已修复并通过 Standards／Spec 复审，合并提交 `6c3bdc172ae058c3fc053c74fae365fbacd1ad83`，附注标签 `v1.17.0` 已推送。Python／web 及锁文件根版本为 1.17.0。正式四类镜像从该干净提交经 Ubuntu `mw-docker` 和专用 BuildKit 构建，不复用验收镜像身份。

## 实际部署

- 环境：unraid 既有正式 project `market-watch`，目录 `/mnt/user/appdata/market-watch`。
- 页面：https://trade.kookvv.com:8443/advanced-charts
- 图表 origin：https://charts.kookvv.com:8443
- 生效目录：`releases/v1.17.0-6c3bdc1`。
- 12 个正式运行服务身份核对通过，API healthy、重启数 0；环境变量、命令、端口及挂载保持一致。
- schema 为 `ar45_market_stream`，切换前后 86 张业务表核对通过，无新增依赖、迁移或服务。

启动／停止（在生产目录执行）：

```bash
./tools/docker-compose -p market-watch -f compose.release.yaml up -d --no-build
./tools/docker-compose -p market-watch -f compose.release.yaml stop
```

## 验证

- 原 Ubuntu 独立 Docker 验收：27 个浏览器场景、28 项既有 SQLite fixture 后端回归通过；供源联网不属于原验收。
- 最终修复：3 项 Ubuntu Chromium 实际 React UI／只读 fixture 回归通过，覆盖概览、覆盖页参数重排和旧位置记录；原 27 项未全部重跑。
- 最终正式 API 镜像：32 项回归通过（SQLite 和实际 Ubuntu PG 用例）；133 个安装后端模块与标签源码一致，第三方依赖与 v1.16.0 一致。
- 正式生产：16 项浏览器检查通过，实际五分类、精确任务入口和返回、375px 滚动 150 → 150、固定版本详情焦点、既有图表与 SSE；没有维护／采集／控制写入。登录检查首次在服务启动中返回 502，健康后完整复跑通过。
- OANDA 状态仍为 unavailable／unknown 和 m1_late，页面没有宣称供源就绪；周末开市与 Yahoo 网络未重新验证。
- 补充核对：上述生产“source status”检查实际操作 `details.dc-live-provider-status` 旧顶部区，验证其读取和 390px 布局；未验证独立「来源状态」页。该功能提交 `3631909` 没有包含在 v1.17.0；本 session 的页面迁移交付存在遗漏。Yahoo 实现虽已入 main，生产开关仍为关闭。详见[漏合核对](verification/session-unmerged-audit-20261010/README.md)。

## 备份与回滚

本次写入暂停从 13:31:25 UTC 至 13:36:49 UTC，共 324 秒，包含实际恢复等待。升级前 PG14 备份 `alerts-20261010T133127203948Z.dump` 已在 Ubuntu 独立 PostgreSQL 14 实际恢复，86 张业务表记录数与清单一致，schema 正确，临时恢复库已删除。配置归档已实际解包、核对私有 env 与 Compose 并清理解包目录。

生产保留 v1.16.0 镜像、源码与升级前备份。回退命令：

```bash
./deploy/dataset-management-v1.17.0-switch-20261010/rollback.sh
```

回退先备份，恢复旧 Compose 和版本指针，保留当前数据库，无 schema downgrade；本次没有实际执行生产回退。

## 部署包与证据

私有部署包位于 Ubuntu 发布 worktree 的 `artifacts/release-v1.17.0/`：`source.release.tar.gz`、`images.release.tar.gz`、`package-manifest.json`、`DEPLOYMENT.md`。包含许可库的包、凭据及数据库不上传 GitHub。归档 SHA256 和逐服务镜像身份在[发布清单](../deploy/releases/v1.17.0-production.json)中；[Compose](../deploy/releases/v1.17.0-production.yaml)、[复审和生产证据](verification/dataset-management-v1.17.0-production/)已留存。

Ubuntu 恢复 project `mw-v1170-restore-20261010` 已通过 `mw-docker retire` 精确退役；自身卷先备份并实际恢复、核对所有非系统表行数与内容 SHA256，再删除其容器、卷、网络和无引用 task 镜像。生产临时镜像／源码传输归档已删除；本机私有部署包及正式镜像、旧版本、备份保留。
