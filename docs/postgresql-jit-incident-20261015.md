# PostgreSQL JIT 内存故障与修复记录

## 结论

Unraid 上原 `postgresql14` 容器运行 PostgreSQL 14.10。故障发生在启动 Market Watch 构建后，持续聚合查询触发 PostgreSQL JIT 内联路径，后端进程内存持续增长，最终耗尽宿主机资源并导致 SSH/网络不可用。应用容器不会自动选择或升级 PostgreSQL；它通过 `ALERTS_DATABASE_URL` 连接独立的 Unraid 数据库容器。

## 已完成的生产修复

- 在 `market_watch` 数据库默认配置和 `market_watch_app` 角色上持久设置 `jit=off`，并重启 Market Watch 生产服务。
- 停止写入服务后，为该 PostgreSQL 实例的全部非模板数据库和 globals 生成停写逻辑备份；`pg_restore --list` 与 SHA-256 校验通过。
- 创建 `/mnt/disk1/appdata/postgresql14-pre14.24-20261015T1348Z` 冷备目录作为物理回滚点。
- 将 `postgresql14` 从 PostgreSQL 14.10 替换为官方 `postgres:14.24`，复用原数据目录、端口和配置。
- 保留停止的 `postgresql14-14.10-rollback-20261015` 容器，未删除旧数据或无关 Docker 资源。

## 验证

生产 PostgreSQL 报告 `PostgreSQL 14.24 (Debian 14.24-1.pgdg12+2)`；5 个非模板数据库可连接，`market_watch` 数据库默认值和 `market_watch_app` 角色均为 `{jit=off}`。Market Watch 的 API、worker、web 和 chart-origin 均恢复运行，API healthcheck 与生产 HTTPS 首页返回成功，Yahoo 仍保持启用。

## 持久修复

应用数据库连接新增 `ALERTS_DATABASE_JIT`，默认关闭，并在所有生产服务中显式设置为 `false`。备份客户端基线固定到已核验的 PostgreSQL 14.24 镜像，避免未来构建重新使用可变的 `postgres:14-bookworm` 标签。

## 回滚

若 14.24 需要回退，先停止 Market Watch 写入服务，停止当前 `postgresql14`，将其改名保留，再用 `postgresql14-14.10-rollback-20261015` 和原数据目录恢复；优先使用本次冷备目录，不对数据库执行降级迁移。回退后继续保留逻辑备份和新数据，避免覆盖切换后的写入。
