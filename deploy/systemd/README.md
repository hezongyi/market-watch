# 本机后台进程守护

这些服务文件针对 `/home/quant/repos/trading-alerts`，使用当前 `.env`。API和构建后的网站统一监听8080。部署前在web目录执行npm ci与npm run build；局域网HTTP阶段使用非Secure cookie，公开URL必须对应实际访问地址。

## 安装步骤

先停止当前同名开发进程，避免重复worker或8080端口冲突。不要仅依靠进程名称批量杀进程，应核对PID与启动命令。

```bash
mkdir -p ~/.config/systemd/user
cp /home/quant/repos/trading-alerts/deploy/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now trading-alerts-api trading-alerts-market trading-alerts-imports trading-alerts-notify
systemctl --user status trading-alerts-api trading-alerts-market trading-alerts-imports trading-alerts-notify
```

退出登录后继续运行/重启后自动启动需要用户 lingering。先检查 `loginctl show-user quant -p Linger`；若未启用，由有权限的管理员执行 `loginctl enable-linger quant`。服务文件的 enable 本身不证明开机运行已验收。

## 验证

- 检查网站三个worker心跳。
- `journalctl --user -u trading-alerts-market --since '10 minutes ago'` 查看错误。
- 在无活动监控的验收时段重启一个worker，验证PID更新、心跳恢复和数据库状态保留。
- 使用真正的进程异常退出验证 Restart=on-failure。手工 `systemctl stop` 不会触发自动恢复。
- API或worker升级前备份数据库；数据库迁移应在服务停止期间执行。

当前状态：服务文件已生成并进行语法检查，尚未安装或替换开发进程。通知服务沿用 `.env` 的自动投递设置，不应在测试时复制到其他未知主题。
