# PostgreSQL JIT 内存故障与修复记录

## 结论

Unraid 上原 `postgresql14` 容器运行 PostgreSQL 14.10。故障发生在启动 Market Watch 构建后，持续聚合查询与宿主机资源耗尽、SSH/网络不可用同时出现。14.10 包含官方在 14.11 修复的 JIT 内联内存泄漏，因此关闭 JIT 和升级版本作为止血及修复措施。现有记录不包含足以证明唯一根因的完整进程采样，不把版本与症状吻合视为对全部因果链的证明。应用通过 `ALERTS_DATABASE_URL` 连接独立的 Unraid 数据库容器，应用升级不自动升级该数据库。

## 已完成的生产修复

- 在 `market_watch` 数据库默认配置和 `market_watch_app` 角色上持久设置 `jit=off`，并重启 Market Watch 生产服务。
- 停止写入服务后，为该 PostgreSQL 实例的全部非模板数据库和 globals 生成停写逻辑备份；`pg_restore --list` 与 SHA-256 校验通过。
- 创建 `/mnt/disk1/appdata/postgresql14-pre14.24-20261015T1348Z` 冷备目录作为物理回滚点。
- 将 `postgresql14` 从 PostgreSQL 14.10 替换为官方 `postgres:14.24`，复用原数据目录、端口和配置。
- 保留停止的 `postgresql14-14.10-rollback-20261015` 容器，未删除旧数据或无关 Docker 资源。

## 验证

生产 PostgreSQL 报告 `PostgreSQL 14.24 (Debian 14.24-1.pgdg12+2)`；5 个非模板数据库可连接，`market_watch` 数据库默认值和 `market_watch_app` 角色均为 `{jit=off}`。Market Watch 的 API、worker、web 和 chart-origin 均恢复运行，API healthcheck 与生产 HTTPS 首页返回成功，Yahoo 仍保持启用。

## 持久修复

应用连接支持 `ALERTS_DATABASE_JIT=inherit|on|off`，默认继承，兼容旧布尔值。连接级覆盖不替换 URL 中其他 PostgreSQL options，且在连接池事务回滚后仍然有效。生产模板默认仍为 off，通过 `MW_PRODUCTION_DATABASE_JIT` 或各服务变量控制，当前生产数据库和角色关闭设置不自动撤销。

维护中的 Ubuntu 开发／验收模板与备份客户端固定到已核验的 PostgreSQL 14.24 digest。验收同时校验实际服务端版本及 JIT provider，生产数据库仍独立维护。评估显示 JIT 收益因查询而异，短测不证明长期零内存增长，详见 [重新评估](pg-jit-reassessment-20261015.md) 和 [实施与验证](pg-jit-policy-implementation-20261015.md)。

## 回滚

若 14.24 需要回退，先停止 Market Watch 写入服务，停止当前 `postgresql14`，将其改名保留，再用 `postgresql14-14.10-rollback-20261015` 和原数据目录恢复；优先使用本次冷备目录，不对数据库执行降级迁移。回退后继续保留逻辑备份和新数据，避免覆盖切换后的写入。
