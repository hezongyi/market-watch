# Unraid 生产部署与升级

## 当前部署

- 网站：**https://trade.kookvv.com:8443**。反向代理后端为192.168.7.33:18080。
- 服务器：`ssh unraid`（root，22），目录 `/mnt/user/appdata/trading-alerts`。
- 独立 Compose 项目 `trading-alerts`，复用现有PG14中的专用生产库。
- API、web和三个worker已运行；一次性迁移退出0。Ubuntu生产服务已停止禁用。
- Ubuntu `.env` 指向独立开发库，关闭真实投递。开发/测试账号不能连接生产库。
- HTTPS启用 `ALERTS_COOKIE_SECURE=true`，`ALERTS_PUBLIC_URL=https://trade.kookvv.com:8443`。使用域名登录，HTTP IP入口无法正常携带Secure登录Cookie。

只操作本项目；不运行全局prune，不重启Docker守护进程或共享主机。不要输出展开后的Compose配置、完整环境变量或凭据。

## 当前发布标识

运行版本 `20260929-05eb433`，应用源代码归档提交 `05eb433bdb667d77f797744ac920b27f809afaf1`。各服务精确镜像ID记录在 `deploy/releases/20260929-05eb433.json`。当前开发分支的新提交不代表生产应用已升级。

运行时配置已在应用部署后更新：HTTPS入口、Secure Cookie、黄金日历 `oanda-sg-xau-maintenance-20270331-v1`。日历保存在数据库及对应deploy JSON，不能仅靠应用提交判断当前配置。

在服务器项目目录启动已发布版本：

```bash
./tools/docker-compose -f compose.external-db.yaml -f compose.release.yaml up -d --no-build
```

`compose.external-db.yaml` 是独立文件，不与原 `compose.yaml` 混用，不创建新PG容器。8080被其他服务使用，不占用。

## 升级流程

1. 在Ubuntu开发库/独立测试库验证更改，记录测试结果和迁移兼容性；不在生产库运行破坏性测试。
2. 生成新的源码归档和版本标签。排除.env、artifacts、backups、SQLite、.venv及node_modules。
3. 在独立发布目录构建镜像并记录每个镜像ID，不覆盖已发布标签。确认代理、数据库网络和PG版本兼容。
4. 安排短暂维护窗口，检查活动监控；停止本项目需要升级的写入worker并执行备份。数据库迁移涉及API写入时一并停API。
5. 更新compose.release.yaml，执行固定版本启动。迁移必须退出0，API必须健康。API重建更换内部IP后，重启本项目web以刷新Nginx上游解析。
6. 验证HTTPS登录、行情更新、worker心跳和错误审计。使用 `web/tests/deployed-readonly.mjs` 验证页面；不要对生产执行会新建预警的browser-smoke。
7. 记录实际镜像、配置和验证结果。真实手机测试需要用户在场的测试窗口，不重复发送响铃。

回退前核对数据库结构兼容性，再切回已保留的镜像版本。不能假设任意迁移都可仅换镜像回退；恢复数据前必须明确备份之后的数据处理。不再启用Ubuntu旧生产服务，也不能切回旧SQLite。

## 备份

- 备份镜像固定为 `trading-alerts-backup:20260929-pg14`，精确ID见发布清单；这是已实际恢复验证的原镜像，新增标签未重构建。
- `deploy/unraid-backup.sh` 使用flock防重复，挂载项目backups，凭据从受限.env读取，PG客户端主版本14。
- Unraid原生cron文件 `/boot/config/plugins/dynamix/trading-alerts.cron`，每日主机时间03:00执行；日志 `backups/latest-run.log`。
- 安装后运行 `/usr/local/sbin/update_cron`。Ubuntu旧备份timer已停止禁用。
- 已从Unraid生成的备份在随机临时PG库实际恢复，16表计数匹配。自然定时触发及整机重启后的执行尚未实测。
- 备份目前保存在同一服务器，不代表异机容灾。不要将旧PG17客户端生成且未通过PG14恢复的文件视作可用恢复点。

重构建备份镜像时可用 `--build-arg APP_IMAGE=新的固定应用镜像`，发布新的备份标签并重新验证恢复；不要覆盖当前标签。
