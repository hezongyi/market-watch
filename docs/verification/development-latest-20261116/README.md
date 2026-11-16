# 最新版部署与 18447 数据迁移；旧实例清理暂缓

2026-11-16，Ubuntu 本机 Docker。当前分支 `feat/managed-live-rollover-20261113` 的最新版已部署到持久开发 project `mw-dev`；本轮没有访问 Unraid，没有 PR、CI、合并或正式 tag。

## 当前入口

<https://192.168.7.232:18443/m/>。APK 在“换服务器”中使用 `https://192.168.7.232:18443`，无需重新安装。登录密码沿用迁移前 18447。启动 `mw-dev up`，状态 `mw-dev status`，停止 `mw-dev stop`。

API/Web 镜像通过 `mw-docker` 构建，固定完整 ID，归属 `mw-dev-mobile-latest-20261116 / mw-dev / development`，见 deployment.json。手机 shell `d737795427509fa5`、APK 0.1.4。18443 HTTPS 使用当前 APK 信任的 CA；18444 ntfy 保留原证书、缓存和订阅配置。下载目录已复制到开发实例独立路径。

## 数据迁移已完成

用户明确认可迁移后，停止两边 API 与后台写入者，保持两边磁盘 PG 卷挂载；确认卷 Options 不含 tmpfs、PGDATA 为 `/var/lib/postgresql/data`。18447 的 `rollover` 完整导出后，恢复到开发 PG 的新库 `dev_mobile_20261116`，原开发库 `dev` 未覆盖、未删除。

- 全库备份 929,095,701 字节；SHA256 `de7a72deb0acd7b57151eca60ab7907a541711fb1127c5d993919cd4cdac6d18`。
- 实际 `pg_restore --no-owner --no-privileges --exit-on-error` 成功；106 张表、8,864,473 行，逐表行数及内容指纹全部一致。内容指纹为每行 JSON 的 MD5 排序流再计算 SHA256，避免在助手进程中载入多 GB 行内容。源库、恢复库的证明见 migration-18447/。
- 原开发库此前约 1.5 GiB 全库备份也已实际恢复验证，SHA256 `a4d2c07b977ef752f900d85b6a08ae0e20f4a9829477d8a370e1d56e46b8a7ec`，原库仍保留在同一开发磁盘卷。
- schema 均为 `bd57_notice_source_poll_index`，本次没有 schema 变更。全部后端与 migrate 服务已一致切到新库。原自选、自建、偏好、历史数据、告警及其记录一起迁移。
- 迁移时源库实际有两条已完成告警，均已达到次数上限；ID、status、version、control_revision、run、count 保持一致，没有重建或再次启用。目前 active 规则为 0，不能将服务运行误报为这两条规则在监控。
- 登录与供应商配置沿用来源；实际运行容器的 OANDA 及代理环境配置与来源逐项相同。外部通知交付保持来源的关闭状态，没有意外启用旧开发 ntfy 推送。
- `mw-dev backup` 已改为根据当前固定配置解析数据库；通过截获命令验证备份目标为新库，不再备份旧 `dev`。

分类 F1：真实持久业务数据迁移，采用停写、完整备份、实际恢复、逐表内容核对及原库保留回退；没有 schema 或 PostgreSQL 主版本升级。

## 验证通过与尚未通过

严格 CA/TLS 登录、readyz、HTML 与全部 6 个手机资源同镜像逐字节一致、APK SHA256、原 ntfy TLS 检查通过。自选、数据、告警、更多真实页面通过；自选等待数据加载后截图，历史曲线和品种标识正常。告警在 375px 浅色及 412px 深色/150% 字号下，原生命周期、详情检查/判定首屏和排查默认收起检查通过。验证未修改真实规则；只读浏览器对自动通知观察上报进行拦截，不伪造业务查询数据。

告警 worker 心跳在两次检查间推进 11,854 ms，后台服务运行正常。但是 OANDA 实时接口在启动和自动认证重试后仍返回 HTTP 401，四个自建实时连接未恢复；`realtime_acceptance_passed=false`。这是实际上游错误，不能把部署/API 就绪等同实时链路正常。`verification.json` 的 passed 仅表示其静态资源、TLS 和服务存活检查；完整迁移结论及实时限制见 `migration-18447/migration-verification.json`。

已触发仓库异常检查点：**保留来源实例和恢复点，暂停来源永久删除，待上游认证问题解决后继续运行验收和退役**。18447 Web/API/后台写入者已停止，PG 仍在；不要与开发后台同时重启。

## 清理状态及此前 CPU 异常

此前已完成 `mw-health-pg-20261111` 的所有数据库逻辑备份、实际恢复、行数及内容核对，并删除其 2 个容器、1 个数据卷和空网络。基础与依赖镜像保留。

本轮另完成 25476 测试 PG 的全部数据库备份、实际恢复及内容核对；18447 附属 `postgres` 库也已备份并实际恢复。其余退役仅形成清单，未执行删除：保留 18447 PG、25476 测试 PG，以及开发 project 内旧停止 frontend/migrate 容器；BuildKit、所有工作树、镜像和备份保留。

此前处理 `mw-cpu-20261111` 时，操作者遗漏检查 `Options.type=tmpfs`，停止最后一个使用者后内存卷清空，冷归档为空且恢复失败。此为操作失误，不能描述为正常退役。随后用历史逻辑备份在独立磁盘卷救援：空 `cpu_acceptance` 与 `cpu_dev_deploy_check` 的 104 表行数匹配停库前记录；`cpu_rehearsal` 业务表行数匹配，但缺 1 条 preferences 测试记录、2 个空表结构，3 条外键因原有孤儿记录未能恢复。行数一致不能证明完整内容恢复。

CPU 原停止容器、空 tmpfs 卷、已停止的磁盘救援副本和完整救援 SQL 均保留，详见 cpu-rescue-report.json。开发及 18447 数据不受该事故影响。本轮没有扩大 CPU 删除范围。

当前磁盘约余 30 GiB；保留备份、新库和救援材料占用空间，不宣称清理带来了净释放。

## 私有恢复材料

`/home/quant/.local/share/market-watch-dev/updates/mobile-latest-20261116/migration-18447-20261116/` 为权限 0700 的私有目录，包含停写备份、source/target 表证明、来源配置归档、原配置/登录/launcher、实际恢复日志及 RECOVERY.md。原开发备份和 CPU 救援记录位于其父目录。敏感配置、token、私钥和完整浏览器状态不入仓库。

回退时先停止开发写入者，保存迁移后新增数据，再恢复该目录 `before-dev-run.json` 与 `before-dev-credentials.json`，只重建四个后端服务，即可重新使用保留的原开发库。恢复 dump 必须选择新库或独立磁盘卷，不覆盖活动库。来源写入者保持关闭，避免双重处理。
