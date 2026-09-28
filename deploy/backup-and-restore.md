# 备份与隔离恢复

## SQLite（旧实例或独立本地验证）

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

生产使用PG14服务端和PG14客户端。已验证的Ubuntu持久客户端包装路径为 `/home/quant/.local/libexec/trading-alerts-pg`；Unraid备份镜像为 `trading-alerts-backup:20260929-pg14`。早期PG17客户端生成的备份无法直接通过PG14恢复检查，不能当作已通过验收的恢复点。

## 当前每日任务（Unraid）

`deploy/unraid-backup.sh`使用固定PG14备份镜像，保存到 `/mnt/user/appdata/trading-alerts/backups`。原生cron文件 `/boot/config/plugins/dynamix/trading-alerts.cron` 每日主机时间03:00执行，日志为 `backups/latest-run.log`；已安装并核对crontab。脚本实际备份、随机临时PG数据库恢复和16表计数匹配均已验证；自然定时触发尚未观察。

Ubuntu旧生产备份timer已停止禁用，避免与开发.env混用。systemd目录中的timer供独立部署参考，并非当前生产执行方式。

备份含账户状态和登录会话信息，应限制访问。当前工具不自动删除备份；需要配置异机副本与保留策略时再实施，现阶段同机备份不能防范磁盘损坏。

## 旧Compose脚本

`deploy/backup.sh` / `deploy/restore-check.sh`依赖原Compose内的PostgreSQL服务，且不生成上述清单，不适用于当前复用外部PG14的生产部署。请使用Unraid备份流程，详见[部署手册](remote-docker.md)。
