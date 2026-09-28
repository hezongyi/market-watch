# 本机后台进程守护

这些服务文件针对 `/home/quant/repos/trading-alerts`，使用当前 `.env`。API和构建后的网站统一监听8080。部署前在web目录执行npm ci与npm run build；局域网HTTP阶段使用非Secure cookie，公开URL必须对应实际访问地址。

## 安装步骤

当前环境只允许代理写入仓库和 `/tmp`，无法写入 `~/.config/systemd/user`。安装脚本已经准备好，需要在本机 quant 用户自己的终端执行：

```bash
bash /home/quant/repos/trading-alerts/deploy/systemd/install.sh --install-only
```

该步骤保存已有同名服务文件的备份、安装四个运行服务及每日备份定时器，并设置开机启用，**不会启动/停止现有进程**。完成后先核对安装结果，再安排将开发进程切换至 systemd，避免重复 worker。不要在切换完成前重启主机。当前查询 `Linger=yes`；启用与 lingering 并不能替代重启后实测。

切换前确认没有活动监控或正在进行的重要操作，停止经过核对的四个开发进程，再执行：

```bash
systemctl --user start trading-alerts-api trading-alerts-market trading-alerts-imports trading-alerts-notify trading-alerts-backup.timer
systemctl --user status trading-alerts-api trading-alerts-market trading-alerts-imports trading-alerts-notify trading-alerts-backup.timer
```

新地址为 http://192.168.7.232:8080/。API 与通知服务明确覆盖公开回调 URL 为该地址，避免仍使用开发期 5173。后续配置域名时须同步修改这两个 unit 的 `ALERTS_PUBLIC_URL`，并重新安装/加载；单改 `.env` 不会覆盖 systemd 的 Environment。

备份定时器按 Asia/Shanghai 每天 03:00 加 0–10 分钟随机延迟执行，错过时在下一次启动补执行。当前使用 SQLite；工具也支持 PostgreSQL，后者需要配置相同主版本的 pg_dump/pg_restore 路径。备份文件不会自动删除，需按保留策略转移到另一台主机或存储。

## 验证

- 检查网站三个worker心跳。
- `journalctl --user -u trading-alerts-market --since '10 minutes ago'` 查看错误。
- 在无活动监控的验收时段重启一个worker，验证PID更新、心跳恢复和数据库状态保留。
- 使用真正的进程异常退出验证 Restart=on-failure。手工 `systemctl stop` 不会触发自动恢复。
- API或worker升级前备份数据库；数据库迁移应在服务停止期间执行。

当前状态：服务文件已生成并进行语法检查，尚未安装或替换开发进程。通知服务沿用 `.env` 的自动投递设置，不应在测试时复制到其他未知主题。
