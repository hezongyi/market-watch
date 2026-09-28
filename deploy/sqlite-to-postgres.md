# SQLite 到 PostgreSQL 迁移

工具：`alerts.database_transfer.transfer(backup_path, target_engine)`。目标必须是已执行同版本Alembic迁移、全部业务表为空的PostgreSQL库；不要先启动API或bootstrap，否则会写入种子数据。凭据只通过受限环境/内存传递，不放命令行或输出。

## 顺序

1. 停止API、行情、历史、通知worker及备份timer，确保切换期间没有业务写入。
2. 用alerts.backup生成最终SQLite备份和SHA256清单，保留原库供回退。
3. 为本项目建立独立PostgreSQL数据库/账号，执行alembic upgrade head。
4. 对备份调用transfer。工具先验证备份清单，按外键顺序分批复制16张业务表，以主键排序比较每表SHA256和条数，再设置自增序列。复制、逐表校验在同一事务中完成，失败回滚数据；目标非空时拒绝覆盖。目标必须保持离线。
5. 保存验证报告（不含连接凭据），更新受限.env数据库连接，启动API和worker，再恢复备份timer。核对网站、心跳、行情、演练及既有确认状态。
6. 对PostgreSQL执行实际备份恢复验收。切换后若已有新写入，不可直接回退到旧SQLite，否则会丢失新状态；需先停止服务并核对增量。

## 已有证据

隔离PG17 schema迁入真实SQLite备份：795393根K线、16张业务表，逐表SHA256和条数一致；含已确认通知/发送尝试及演练二进制数据。第二次迁入被拒绝。独立测试注入摘要不一致，所有业务表数据回滚，随后可成功迁入。尚未完成远端192.168.7.33迁移，也未切换线上连接。
