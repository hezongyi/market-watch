# Ubuntu 持久开发实例

## 目标与基线

用户已授权给最新 main 打 tag，并建立全功能 Ubuntu 开发实例；稳定前不发布生产。
Git tag `v2.0.0-rc.4` 已推送，指向 `ae38d7b2bec8227afd3f196bc09824ad058fc51f`。
包含 PR #120 与 #121，基线 CI 已通过。

本次配置位于分支 `feat/ubuntu-full-dev-20261109`，工作树为
`/home/quant/repos/market-watch-dev`。主工作树的 main 不作业务修改。
Ubuntu 主机为 `quant-server` / `192.168.7.232`，Compose project 为 `mw-dev`。
没有创建 Unraid 开发实例，没有启动或更新生产容器。

## 访问与凭据

- 工作台：`https://192.168.7.232:18443/`
- MCP：`https://192.168.7.232:18443/mcp`
- 开发通知服务：`https://192.168.7.232:18444/`
- 登录密码及通知订阅地址：`~/.local/share/market-watch-dev/credentials.json`
- MCP Bearer 凭据：`~/.local/share/market-watch-dev/mcp.token`，有效期 90 天。
- 开发 CA：`~/.local/share/market-watch-dev/tls/ca.pem`。

浏览器和手机需要信任开发 CA；服务端使用 CA 签发的独立 leaf 证书。
CA 私钥、凭据、账户配置与 FXCM 依赖只保存在本机私有目录。
通知使用随机开发 topic，订阅地址从私有凭据文件读取。
此服务的回执表示服务端已接收，不代表手机已安装证书并收到推送。
开发通知服务没有连接公共 ntfy 的移动平台唤醒服务。

## 运行组成

PostgreSQL 14.24 + migrate + API + market-runtime + data-worker + notification-worker
+ web + TLS + ntfy；启用前端快速开发时增加 frontend。
只有 TLS 对局域网发布端口，PG/API/供源后台不发布宿主机端口。
各服务设置内存、CPU 限额与 10 MiB × 3 日志轮转。
数据库独占 `mw-dev_postgres-data`；网络为 `mw-dev_default`。

Yahoo、AKShare、FXCM、OANDA stream、站内通知、网络投递与 MCP 均显式启用。
Binance、Dukascopy 使用既有按需供源路径。
仅通知运行组负责网络投递，避免多个后台重复发送。
自动大范围历史预热设为 0；用户历史导入和维护功能保持可用。
历史回收保留 dry-run；本次没有开启破坏性回收。

## 已导入的数据

- 5 个服务器保存布局、36 条偏好与已有自选信息。
- 3 个活动组合及其固定历史版本、各周期发布产物和来源依赖。
- 2 条历史组合告警原样保留；来源状态均已归档，不自动重新激活。
- 实时开关、组合准备状态及必要平台元数据。

未复制生产 session、agent 凭据、待发送队列和全库。
生产最大的两张表合计超过 22 GiB，本机不具备整库复制的合适余量。
选择活动版本时保留完整内容，未伪造历史连续性或补造 K 线。
新库启用实时流后，会按现有恢复机制处理停机期间的行情。
归档与导入证据位于私有目录 `imports/` 和 `evidence/`。

跨环境导入按目标字段名指定列序，避免相同 schema 不同物理列序导致错位。
每表通过二进制 COPY 传输，并逐行比较完整 JSON 内容。
首次恢复校验在应用停止写入时完成，104 张表行数和排序内容指纹一致。
校验备份为 `backups/verified-*.dump`，校验记录为 `evidence/restore-verified.json`。

## 日常开发

`mw-dev` 链接到本工作树的 `deploy/ubuntu/mw_dev.py`，无须记住私有 Compose 参数。

```bash
mw-dev status
mw-dev up
mw-dev stop
mw-dev logs api
mw-dev restart market-runtime data-worker
mw-dev backup
```

`stop` 只停服务并保留全部数据。`up` 可能运行当前代码的迁移。
schema 改动使用 `mw-dev migrate`：先备份、停止写入者、迁移后启动。
迁移失败时保留数据库并让写入者保持停止，不自动执行 schema 降级。

API 与后台当前使用 source 模式：工作树 backend、migrations 及 alembic.ini 只读挂载。
`PYTHONPATH=/app/backend` 保证挂载源码优先于镜像内 wheel。
API 自动重载；后台代码修改后定向重启对应运行组。
依赖变化需通过专用 BuildKit 重建 API 镜像，再重新创建相关服务。

```bash
mw-dev source-on
mw-dev source-off
mw-docker build --repo /home/quant/repos/market-watch-dev --context . --file Dockerfile \
  --component api --tag market-watch-api:dev-20261109 \
  --task mw-dev-20261109 --project mw-dev --purpose development --retain-days 90
```

前端当前启用 Docker 内 Vite：React/CSS 修改通过 HTTPS HMR 更新。
完整原生图表依赖来自已验证的完整 web 构建，Vite 直接服务这些资源。
原生图表代码或许可库补丁改变时运行 `mw-dev web`，完成后刷新浏览器。
`mw-dev frontend-off` 恢复普通静态镜像网页；`frontend-on` 再启用 HMR。
MCP 代理保留外部 Host，由后端允许列表验证。

主实例同一时刻归属本活动开发任务。并行任务须独立分支、实例和数据库。
切换任务前核对 schema 兼容性，不让多个分支同时写本数据库。
PR 合并与生产发布保持独立，不能从本次开发部署推断生产发布授权。

## 备份与容量

用户级 `mw-dev-backup.timer` 每天 03:30 UTC 导出开发数据库。
`systemctl --user list-timers mw-dev-backup.timer` 查看下一次执行。
备份位于 `~/.local/share/market-watch-dev/backups/`，失败的临时文件保留调查。
备份不自动删除；磁盘监控沿用本机已有 Market Watch timer。
ntfy 消息缓存设为 24 小时，单独保存在私有目录。
数据库和备份会增长；本机部署后约余 20 GiB，避免全市场历史预热。
清理备份、volume、工作树及正式镜像仍按明确资源范围执行。

## 验证

变更范围为开发部署配置与开发代理，未修改数据库 schema 或告警算法。
选择 F0 配置 smoke，并因迁入持久数据额外执行实际备份恢复校验。

已验证：六类供源真实 K 线读取、HTTPS 登录、数据中心、手机视图、无草稿恢复提示，
MCP 初始化/工具发现/行情与工作区读取、站内与 ntfy 服务端投递。
组合实时告警使用 EURUSD 当前真实价格作为穿越阈值，触发 1 次、产生 1 条事件后归档。
37 个后台角色均有正常进度记录。
Dukascopy 一次并行复验曾返回 503；之前实际读取成功，保留其外部可用性限制。

```bash
python3 deploy/ubuntu/development_smoke.py
```

此命令查询真实行情并发送开发通知测试，结果仅写私有 evidence 目录。
不以合成行情替代真实供源结果；失败返回非零退出码。
