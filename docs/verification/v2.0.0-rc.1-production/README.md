# v2.0.0-rc.1 生产证据

- `containers.json`：五个实际生产容器的源码、固定镜像、运行状态、重启与 OOM 状态。
- `runtime.json`：生产 schema、28 个角色心跳、EURUSD/XAUUSD 开关和采集状态、限定 Settings、最近三条备份审计。
- `browser.json`：已登录 Playwriter 页面读取 `/api/health` 的脱敏结果；无页面错误，登录前一次 session 401 保留。
- `backup-restore.json`：本次完整发布备份的大小、hash 和 Ubuntu 恢复结论。
- `pre-migration-check.json`、`post-migration-check.json`：Ubuntu 恢复副本迁移前后 102 张表行数与通知列结构。
- `configuration-restore.json`：新配置归档 hash 及 Ubuntu 所选配置恢复／在线逐字节比对。
- `maintenance-final.json`：实际 cron 文件、新 active-release、全部后端 Yahoo／REST 模式、最终 readiness 与最近 15 分钟日志检查。
- `index.json`：本目录 JSON 证据的 SHA256 索引。

这些是部署时的快照，不是持续监控。自动备份仍失败，生产没有 active chart alert，因此不能从角色心跳推导出真实新信号或手机响铃验收。
