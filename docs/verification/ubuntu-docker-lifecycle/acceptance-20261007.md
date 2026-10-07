# Ubuntu Docker 生命周期落地验证（2026-10-07）

主机：Ubuntu 22.04 `quant-server`。专用builder仅连接 `unix:///var/run/docker.sock`；未部署应用实例到Unraid，未重启Docker服务。本轮独立worktree及分支：`market-watch-docker-lifecycle` / `chore/ubuntu-docker-lifecycle`。

## 已实际安装并启用

- Buildx `0.30.1-0ubuntu1~22.04.1`，来自Ubuntu官方软件包，安装到用户cli-plugins目录。
- BuildKit `v0.33.1`，官方Moby GitHub release tar SHA256 `4e044bcd62a0c0bbe6a8c94d73989de2bfe4c04dbc0f9d6021cf96b72cd1d965` 校验成功；使用本机PG14基础镜像制作独立builder镜像。Docker Hub和mirror.gcr.io连接失败，因此未依赖它们。
- `market-watch-ubuntu` docker-container builder正在运行；`buildx inspect`和 `buildctl debug workers -v` 实际确认GC：1 GiB保留、8 GiB最大使用回收目标、20 GiB空闲空间目标，构建并发2。GC阈值是回收策略，不是硬配额。容器名 `buildx_buildkit_market-watch-ubuntu0`；state volume独立。
- `~/.local/bin/mw-docker`与用户docker构建wrapper已安装；默认builder已选中。日常Market Watch直接 `docker build`被拦截，Compose启动使用已有镜像；通过工具构建自动记录task、project、用途、commit、dirty与保留期。
- 3个user timer均enabled/active：每15分钟磁盘检查、每日详细占用记录、每日已结束过期镜像清理。服务均实际运行成功，ExecMainStatus 0；user Linger=yes。

## 验证证据

1. Python标准库测试25项通过；覆盖运行/停止容器引用、manifest/config/短ID引用、正式镜像保留、未完成/未到期任务保留、外部/shared/bind数据库拒绝、构建入口拦截、多阶段基础镜像解析、20 GiB低空间判断及重复告警节流。Ruff与shell语法检查通过。
2. 在Ubuntu专用builder实际构建scratch应用并执行RUN；Compose Build实际命中同一builder缓存。无应用端口对外开放。
3. 独立project `mw-lifecycle-smoke`使用独立网络和PG14 volume。写入123行fixture，归档`fixture`及`postgres`数据库，实际新建临时数据库恢复，比较所有public表行数；`cleanup_probe=123`。核对源库稳定后精确删除2个容器、1个网络、1个volume，task完成后删除2个构建镜像（包括覆盖标签产生的旧无标签版本）。归档保持私密，未提交。
4. 独立本机PG14基础镜像构建、Compose构建均通过OCI输入成功完成，无需访问Docker Hub；临时OCI输入在成功后已移除。基础镜像获取方式可以显式选择registry。
5. 使用独立过期标签fixture模拟时间已过，调用已安装的真实 `market-watch-image-cleanup.service`，成功删除 `mw-lifecycle-expiry-check:check`。自动服务未删除其他在进行中的任务镜像。fixtures均退役；仅留下受GC管理的builder缓存。
6. 安装/bootstrap入口重复运行成功，复用已存在builder，不重建/重启业务容器。bootstrap临时包、基础镜像tar、解包目录已精确清除。
7. 最后保留项目的API及PG健康检查正常；issue13有自己的测量/浏览器流程，期间自行启动/停止实例。没有由本工具停止或重启它们。构建会产生CPU/I/O，性能基线需区分环境变化。

## 运行和维护

本次安装的是本机命令与后台timer，没有新增网页入口。应用访问地址保持其自身项目配置。

- builder启动：`docker buildx inspect market-watch-ubuntu --bootstrap`；停止：`docker buildx stop market-watch-ubuntu`。
- timer查看：`systemctl --user list-timers 'market-watch-*'`。
- timer停止：`systemctl --user disable --now market-watch-disk-check.timer market-watch-disk-daily.timer market-watch-image-cleanup.timer`。
- 监控记录：`~/.local/share/market-watch-docker/latest-disk.json`、`disk.jsonl`、`daily.jsonl`、`alert.json`、`cleanup.jsonl`。低于20 GiB时在本机journal/已登录终端告警；没有外部消息通道。
- 私有数据库归档：`/home/quant/.local/share/market-watch-docker/archives/mw-lifecycle-smoke-20261007T001429-488890ba`，目录0700；包含env及全局角色，禁止上传。
- 旧无标签/无归属镜像不在自动清理范围，需另行确认任务归属。仅通过绝对路径或API绕过用户wrapper仍有可能；根AGENTS已写入必须使用该入口的规则。

详细操作：[`deploy/ubuntu/README.md`](../../../deploy/ubuntu/README.md)。私有安装日志和release metadata在 `/home/quant/repos/.audits/ubuntu-docker-lifecycle-20261007/`，未进入仓库。
