# SQLite恢复演练

1. 运行 `scripts/backup_sqlite.py` 创建权限0600的新文件，工具拒绝覆盖现有文件并检查完整性和外键。
2. 从备份复制出单独的演练副本；不要对唯一备份执行演练写入。
3. 从仓库根目录启动：

```bash
ALERTS_DATABASE_URL=sqlite:///./backups/restore-copy.db ALERTS_DELIVERY_ENABLED=false .venv/bin/uvicorn alerts.site:app --host 127.0.0.1 --port 8082
```

4. 登录演练实例，检查历史行情与监控记录，创建历史演练。不要启动该副本的行情/通知worker，不要点击真实手机测试按钮（主动测试独立于自动投递开关）。
5. 验证完成后停止临时服务。正式替换数据库前停止所有写入进程，保留当前数据库副本，确认目标文件和路径，再更新配置。

以上为当前SQLite开发部署流程，PostgreSQL部署使用独立的pg_dump/pg_restore流程。
