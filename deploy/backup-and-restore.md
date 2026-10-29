# 备份与隔离恢复

## SQLite（旧实例或独立本地验证）

```bash
.venv/bin/python -m alerts.backup --directory backups
.venv/bin/python -m alerts.backup --restore-check backups/alerts-具体时间.db
```

每个备份有一个同名 `.json` 清单，保存 SHA-256、字节数和当前模型中全部业务表的记录数（随迁移新增表扩展）。数据和清单权限均为 0600，不覆盖已有文件。SQLite 使用在线备份 API，并检查完整性和外键；失败时删除本次不完整产物，保留以前的备份。

网页“提醒与设置”显示最近执行状态，超过 36 小时无成功记录会提示。它表示备份工具的执行结果，不等于已经启用定时器或完成异机容灾。手工旧脚本 `scripts/backup_sqlite.py` 没有此审计记录，仍可用于升级前快照。

## PostgreSQL（独立于 Docker）

设置 `ALERTS_DATABASE_URL` 指向要备份的数据库，并使同主版本的 `pg_dump` / `pg_restore` 位于 PATH，或通过 `ALERTS_POSTGRES_BIN_DIR` 指定目录。连接凭据只传入子进程环境，不进入命令行、备份清单或网页。

PostgreSQL 这条流程生成的是 **全量逻辑备份**（`pg_dump --format=custom`），不是文件系统快照，也不是增量/WAL 备份。`REPEATABLE READ` 与 `pg_export_snapshot()` 只用于让 dump 读取同一份 MVCC 数据视图；它仍需读取并导出全库内容。归档里的压缩大小不能改变其全量性质。

运行相同备份命令生成 `.dump` 和 `.dump.json`。`pg_dump` 使用导出的 REPEATABLE READ 快照，清单记录数与导出使用同一快照。普通备份检查归档可读性，**实际恢复**需执行：

```bash
.venv/bin/python -m alerts.backup --restore-check backups/alerts-具体时间.dump
```

恢复检查需要当前连接有 CREATE DATABASE 权限。当前生产账号没有该权限，v1.8.0 已在 Ubuntu 独立 Docker PG14 服务器／账号恢复升级前35表及升级后36表备份；不要给生产账号临时提权，也不要将上述 restore-check 命令直接用于当前生产连接。它新建随机名称 `alerts_restore_<uuid>` 的临时数据库，使用 pg_restore 恢复并核对所有业务表记录数，最后删除自己创建的临时库。不会覆盖源库、不会启动通知/行情进程，也不会发送手机消息。SHA-256 不匹配时拒绝恢复。命令返回非零表示未通过；程序对外只显示错误类别，避免输出连接凭据。

生产使用PG14服务端和PG14客户端。已验证的Ubuntu持久客户端包装路径为 `/home/quant/.local/libexec/trading-alerts-pg`；当前 Unraid 备份镜像为 `trading-alerts-backup:v1.8.0-b700911`，精确 ID 见 [生产清单](releases/v1.8.0-production.json)；旧镜像保留用于回退。早期PG17客户端生成的备份无法直接通过PG14恢复检查，不能当作已通过验收的恢复点。

恢复旧 schema 备份须匹配备份时的模型／实际表清单。q18备份只有35张业务表，直接使用包含 r19 新表的模型核对会查询不存在的 native_history_loads。v1.8.0升级前快照在 Ubuntu 按原schema和清单的35张实际表核对，不迁移恢复库；升级后r19备份用标准恢复检查核对36张表。两者临时库均已删除，结果与SHA见生产清单。

## 当前每日任务（Unraid）

`deploy/unraid-backup.sh`使用当前 standalone Compose 的固定 PG14 备份镜像，保存到 `/mnt/user/backup/trading-alerts`。原生cron文件 `/boot/config/plugins/dynamix/trading-alerts.cron` 每日主机时间03:00执行，日志为 `/mnt/user/backup/trading-alerts/latest-run.log`；已安装并核对crontab。v1.8.0 升级前后备份已在 Ubuntu 独立 PG14 随机临时库恢复，35／36张业务表计数匹配；两份配置归档已在 Ubuntu 独立解包验证。旧恢复和临时 cron 自动调度属于历史验证，尚未观察新镜像的下一次每日03:00任务。

Ubuntu旧生产备份timer已停止禁用，避免与开发.env混用。systemd目录中的timer供独立部署参考，并非当前生产执行方式。

备份含账户状态和登录会话信息，应限制访问。当前工具不自动删除备份；需要配置异机副本与保留策略时再实施，现阶段同机备份不能防范磁盘损坏。

## 旧Compose脚本

`deploy/backup.sh` / `deploy/restore-check.sh`依赖原Compose内的PostgreSQL服务，且不生成上述清单，不适用于当前复用外部PG14的生产部署。请使用Unraid备份流程，详见[部署手册](remote-docker.md)。

## 项目配置与源码归档（2026-09-29新增）

每日脚本在数据库导出成功后调用 `deploy/unraid-config-backup.sh`，另存 `config-时间-随机串.tar.gz` 和 `.sha256`。包含本项目 `.env`、实际Compose版本、后端、前端源码、迁移、依赖锁文件与deploy配置；排除node_modules、构建缓存等可重建文件。不包含数据库服务目录、其他appdata、反向代理服务配置或Docker镜像。

目录与归档受限，归档及校验文件权限0600。归档包含API/数据库/ntfy私密配置，不能提交Git或通过网站分发。该归档不能使用数据库的restore-check命令。

恢复时先核对SHA256，在 Ubuntu 解包到权限0700的隔离目录，核对 `.env` 权限0600，使用Compose `config --quiet`检查，禁止输出展开配置。v1.8.0升级前后两份归档的校验和、隔离解包、`.env`与生产SHA一致和Compose校验均通过，临时解包目录已清理。不要直接解包覆盖运行中的项目，也不要在测试恢复时启动生产worker。

数据库和配置分别有恢复证据，不代表已经演练全新机器上的整站重建。反向代理域名/证书由现有服务维护，需使用其自身备份。配置归档保存在同一Unraid服务器，尚不提供异机容灾。网页备份状态目前来自数据库备份审计；配置归档失败会令脚本失败并进入cron日志，需要同时检查该日志。

备份目录按用户要求独立放在 `/mnt/user/backup/trading-alerts`，与appdata分离。新部署先创建该目录，目录所有者设为容器应用UID/GID 10001:10001、权限0700；不要创建指向旧appdata备份目录的软链接。现有文件已按字节比较迁移，配置归档SHA256清单中的文件路径也已更新。

## 备份耗时上限、压缩级别与分阶段计时（2026-10-28新增）

PostgreSQL 子进程不再硬编码 900 秒：`ALERTS_BACKUP_TIMEOUT_SECONDS`（默认 3600，范围 60–21600）同时约束 `pg_dump`、`pg_restore --list` 和 `--restore-check` 的全量恢复；超时只报阶段名与秒数，不带连接或路径信息。归档压缩级别由 `ALERTS_BACKUP_COMPRESS_LEVEL`（默认 1，`0` 为不压缩）显式传入 `pg_dump --compress`，不再依赖 custom format 的隐式默认。

每次成功备份在 `.dump.json` 清单与 `backup_completed` 审计中记录 `counts_ms` / `dump_ms` / `list_ms` / `sha256_ms` 与 `compress`；失败审计记录 `error_type` 与 `stage`（`prepare` / `sqlite_copy` / `counts` / `pg_dump` / `pg_restore_list` / `sha256` / `manifest`，SQLite 备份没有 list 阶段）。前置校验失败只有 `error_type`，没有 `stage`。

`deploy/unraid-backup.sh` 的数据库导出与配置归档现在分段执行：任一失败整体返回非零，但不再互相静默跳过；锁被占用时打印 `skipped: backup lock held` 后退出。故障时间线与实测依据见 [自动备份超时排查](../docs/issues/automatic-backup-timeout-20261028.md)。

## 备份保留与轮转（2026-10-28新增）

`deploy/unraid-backup.sh` 在每晚数据库备份与配置归档之后按**份数**轮转：`market-watch-*.dump`（发布/回滚证据）与 `config-v*`（版本命名归档）永不由脚本删除。数据库备份失败的那晚同样执行轮转，避免连续失败时旧文件无限堆积。对同一份备份的成对文件一起删除（`.dump` 配 `.dump.json`，`config-*.tar.gz` 配 `.sha256`）。

- `MW_BACKUP_KEEP_DAILY`（默认 `14`）：保留最新 N 份每日 dump，`0` 表示该项不轮转；
- `MW_BACKUP_KEEP_CONFIG`（默认 `14`）：保留最新 N 份配置归档；
- `MW_BACKUP_ROTATE_DRY_RUN=1`：只打印 `would remove` 清单，不删除。

摘要行 `rotation: removed N files (X bytes)` 的 N 含成对删除的清单/校验文件。排序依据是文件名里的 UTC 时间戳（字母序即时间序），脚本不解析 `ls -t`，只处理备份目录的直接子项，不递归，不碰锁与日志；轮转失败只打印 `rotation failed`，不改变备份结果码。

删除不可恢复（该 share 未启用回收站）。首次上线更新后的脚本前，用 `MW_BACKUP_ROTATE_DRY_RUN=1` 在只读影子目录预览真实待删清单；轮转只在 `deploy/unraid-backup.sh` 落到 `/mnt/user/appdata/market-watch/deploy/` 之后才生效，落盘前生产不会删除任何文件。回归脚本：`sh deploy/tests/test_unraid_backup_rotation.sh`。


