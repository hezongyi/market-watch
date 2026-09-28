# 备份与隔离恢复

## 当前主机（SQLite）

```bash
.venv/bin/python -m alerts.backup --directory backups
.venv/bin/python -m alerts.backup --restore-check backups/alerts-具体时间.db
```

每个备份有一个同名 `.json` 清单，保存 SHA-256、字节数和 16 张业务表的记录数。数据和清单权限均为 0600，不覆盖已有文件。SQLite 使用在线备份 API，并检查完整性和外键；失败时删除本次不完整产物，保留以前的备份。

网页“提醒与设置”显示最近执行状态，超过 36 小时无成功记录会提示。它表示备份工具的执行结果，不等于已经启用定时器或完成异机容灾。手工旧脚本 `scripts/backup_sqlite.py` 没有此审计记录，仍可用于升级前快照。

## PostgreSQL（独立于 Docker）

设置 `ALERTS_DATABASE_URL` 指向要备份的数据库，并使同主版本的 `pg_dump` / `pg_restore` 位于 PATH，或通过 `ALERTS_POSTGRES_BIN_DIR` 指定目录。连接凭据只传入子进程环境，不进入命令行、备份清单或网页。

运行相同备份命令生成 `.dump` 和 `.dump.json`。`pg_dump` 使用导出的 REPEATABLE READ 快照，清单记录数与导出使用同一快照。普通备份检查归档可读性，**实际恢复**需执行：

```bash
.venv/bin/python -m alerts.backup --restore-check backups/alerts-具体时间.dump
```

恢复检查需要当前连接有 CREATE DATABASE 权限。它新建随机名称 `alerts_restore_<uuid>` 的临时数据库，使用 pg_restore 恢复并核对所有业务表记录数，最后删除自己创建的临时库。不会覆盖源库、不会启动通知/行情进程，也不会发送手机消息。SHA-256 不匹配时拒绝恢复。命令返回非零表示未通过；程序对外只显示错误类别，避免输出连接凭据。

本轮验证工具来自官方 apt.postgresql.org 的 Ubuntu 22.04 软件包，按官方包索引 SHA-256 校验：postgresql-client-17 17.11、libpq5 18.6；仅解压在 `/tmp/trading-pg-client`，没有安装到系统。`/tmp` 目录不可作为正式部署的永久客户端位置。

## 每日任务

`deploy/systemd/trading-alerts-backup.timer` 在北京时间每天 03:00 后随机 0–10 分钟运行，Persistent=true 会补执行关机期间错过的计划。安装过程见同目录 README。定时器尚需实际启用及执行验收。

备份含账户状态和登录会话信息，应限制访问。当前工具不自动删除备份；需要配置异机副本与保留策略时再实施，现阶段同机备份不能防范磁盘损坏。

## 已有 Docker 脚本

`deploy/backup.sh` / `deploy/restore-check.sh` 依赖 Compose 内的 PostgreSQL 客户端，可以在将来的 Docker 部署中使用。它们没有上述 `.json` 清单，不能混用验证命令；当前主机没有 Docker，尚未执行该路径。
