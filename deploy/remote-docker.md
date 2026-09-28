# 192.168.7.33 Docker 部署

使用独立文件 `compose.external-db.yaml`，不是原 compose.yaml 的覆盖文件。此配置只启动网站/API/三个worker及一次性迁移，复用已迁入数据的项目PostgreSQL，不创建新数据库容器或卷。

## 登录后检查

核实Docker/Compose版本、CPU/内存/磁盘、现有容器和网络、选定端口是否空闲。只操作trading-alerts项目，不运行全局prune或重启Docker守护进程。SSH用户名、端口及登录授权尚待用户提供。

## 配置和切换

1. 将代码传至独立目录，排除.env、artifacts、backups、SQLite、.venv及node_modules；受限.env单独传输，权限0600。
2. 保留已创建项目专用账户的ALERTS_DATABASE_URL，验证容器可达192.168.7.33:5432。不要改为localhost（容器内localhost不是宿主机）。
3. 确认可用端口后设置ALERTS_WEB_PORT/ALERTS_BIND_ADDRESS和匹配的ALERTS_PUBLIC_URL；LAN HTTP阶段ALERTS_COOKIE_SECURE=false。保持原ntfy topic，OANDA代理也需从容器验证。
4. 执行 `docker compose -f compose.external-db.yaml config --quiet` 和 `build`。不要输出展开配置，以免泄露凭据。
5. 停止并禁用开发机API及三个worker，做远端PG最终备份。确认没有活动旧worker后再运行目标Compose；不能两边同时启动行情和通知。
6. `docker compose -f compose.external-db.yaml up -d`，检查迁移退出0、API健康、网页登录及行情/通知心跳；已确认通知不可重发。
7. 安排目标机持续备份。当前开发机已有有效PG备份service/timer，目标机备份未验收前保留该备份机制。应用容器当前不包含pg_dump，不能假设在API容器内备份可用。
8. 在新回调地址进行约定的手机确认测试。移机使用同一PG数据库，通常不需要再次复制行情数据。

回退：先停止目标项目worker，再恢复开发机服务，保留同一PG数据库；不得切回过期SQLite。远端实际部署、端口与容器网络尚未验证，本文件为操作步骤。

## 当前发布标识

首个Unraid运行版本为 `20260929-05eb433`，源代码归档提交 `05eb433bdb667d77f797744ac920b27f809afaf1`。精确镜像ID记录在deploy/releases对应JSON；当前开发分支的新提交不代表生产已升级。

目标目录compose.release.yaml固定本次各服务镜像，后续启动使用：

```bash
./tools/docker-compose -f compose.external-db.yaml -f compose.release.yaml up -d --no-build
```

每次发布先构建新的版本标签并记录镜像ID，再更换该文件。不要对已发布标签重新构建覆盖。回退使用之前的版本文件，先检查数据库迁移是否兼容；不能只换镜像就宣称任何结构变更都可回退。备份镜像仍单独维护，尚需统一版本化。
