# 生产部署验收步骤

本文件为待执行步骤，不是已通过的证据。当前部署目标为本机 Ubuntu，开发期允许 IP/HTTP，域名和 HTTPS 按用户决定后补。单机 systemd 路径见 `deploy/systemd/README.md`；以下 Docker/PostgreSQL 路径仍需独立验收。

1. 在独立目录复制应用，按 `.env.example` 配置数据库密码、管理员哈希、公开 HTTPS URL。生产 cookie 保持 Secure。先保持真实通知关闭。
2. 执行 `docker compose config --quiet` 和 `docker compose build`；执行 `docker compose up -d`。
3. 检查 `docker compose ps`：迁移成功退出，数据库/API 健康，后台服务运行。`curl --fail http://127.0.0.1:8080/readyz` 应返回 ready。
4. 在已有反向代理中将选定域名转发到 `127.0.0.1:8080`，验证 HTTPS 证书和登录。数据库不映射公网端口。
5. 在设置页检查后台心跳及行情来源。数据过期、源错误、缺口必须可见；三个品种逐一验证最近 K 线、纽约/UTC 日界线。
6. 导入指定历史区间，创建演练，检查模拟信号与预计 K 线一致；刷新可继续，导出不包含虚拟时间之后的数据。
7. 执行 `deploy/backup.sh`，再对生成的备份运行 `deploy/restore-check.sh`。只在临时数据库做恢复，不覆盖业务库。记录备份路径、校验结果与耗时。
8. 使用已安装的 ntfy 原生应用及沿用的 topic，依据 `docs/operating-guide.md` 验证铃声、确认、锁屏、网络切换及长期待机。配套 APK 已退出当前范围。主动测试通知往返已通过；真实策略链路及长期条件仍需记录证据。测试前与用户约定，避免意外响铃。
9. 进行进程重启与网络中断恢复演练，核对一次性信号、任务重试、手机重复提醒和用户确认状态。保存实际日志及验收结论。

`/readyz` 只证明 API 能查询数据库；不证明上游行情、通知服务或手机可用。最终交付依据 `docs/delivery-status.md` 的完整证据矩阵。
