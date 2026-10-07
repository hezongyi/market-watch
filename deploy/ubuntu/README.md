# Ubuntu Docker 构建与资源生命周期

本工具只连接 Ubuntu 本机 `/var/run/docker.sock`。Unraid仍为生产环境，不使用本工具创建开发/验收实例。所有构建明确指定专用 `market-watch-ubuntu` builder。

## 已安装组件

- 用户级 Buildx：`~/.docker/cli-plugins/docker-buildx`（Ubuntu官方 `docker-buildx`包）。
- 专用BuildKit：`market-watch-ubuntu`，Docker容器 `buildx_buildkit_market-watch-ubuntu0`，独立volume `buildx_buildkit_market-watch-ubuntu0_state`。
- GC设置：[buildkitd.toml](buildkitd.toml)：回收目标8 GiB、保留约1 GiB热缓存、尝试保持主机20 GiB空闲。属于回收阈值，不是磁盘硬配额；构建运行期间可临时超过目标。
- `mw-docker`构建、归档、清理和监控命令；`~/.local/bin/docker`只拦截Market Watch范围的无归属构建，其他Docker命令透传。Market Watch `compose up`自动加`--no-build`。

builder默认选中可以防止普通构建继续使用legacy builder，但不能自动补上任务标签，所以应通过`mw-docker`构建。绝对路径`/usr/bin/docker`可以绕过用户wrapper；本规则是协作入口而非权限隔离。旧worktree中的脚本若显式调用这个绝对路径，需要更新。

## 构建

在任意Market Watch worktree内：

```bash
mw-docker build --repo . --component api --tag market-watch-api:issue-42 \
  --task mw-issue42 --project mw-issue42 --purpose acceptance
mw-docker build --repo . --component chart --tag market-watch-chart-origin:issue-42 \
  --task mw-issue42 --project mw-issue42 --purpose acceptance
mw-docker build --repo . --component web --tag market-watch-web:issue-42 \
  --task mw-issue42 --project mw-issue42 --purpose acceptance \
  --build-arg VITE_ADVANCED_CHART_ORIGIN=https://localhost:17444
```

默认将本机已有基础镜像临时导出为OCI输入，按digest交给BuildKit；构建结束删除临时输入，不长期保留镜像tar。这样无需再次访问Docker Hub。基础镜像缺失时明确失败，先在Ubuntu导入/拉取；网络可用时可显式使用`--base-source registry`。ARG形式的FROM和inline Dockerfile需使用registry模式。

`--purpose`可选development、acceptance、release、rollback。开发/验收默认保留7天（`--retain-days`），正式/回滚版本永不由自动清理删除。任务记录有明确结束状态，没结束的任务即使过期也不会清理。标签包含task、project、commit、工作树dirty状态、built-at、expires-at；标签不含凭据。现有镜像标签若属于其他任务、正式/回滚用途或未登记归属，拒绝覆盖，需选择新的任务标签。构建参数不可传密码或token。

Compose构建会给所有buildable service注入同样的标签，继续使用原来的构建参数/配置：

```bash
mw-docker compose-build --repo . --task mw-issue42 --project mw-issue42 \
  --purpose acceptance --env-file /private/issue42.env \
  --file compose.yaml --file /private/issue42.override.yaml
# 端口/网络/volume必须与其他任务隔离；构建后禁止再次隐式构建。
docker compose --env-file /private/issue42.env -p mw-issue42 \
  -f compose.yaml -f /private/issue42.override.yaml up -d --no-build
```

更换项目请使用新的task；已结束任务不能复用。只有本机许可库已准备完整时才构建chart。已有Dockerfile保持依赖安装在源码COPY之前；本次不修改应用、数据库结构及图表资源产物。

## 验收结束

先查看精确清单，确认这是已结束的验收project，再执行：

```bash
mw-docker retire --task mw-issue42 --project mw-issue42
mw-docker retire --task mw-issue42 --project mw-issue42 --apply
```

只支持由本工具登记、镜像归属匹配的acceptance项目，以及单个本项目拥有的PG14数据volume。数据库支持 `postgres:14-bookworm` / `postgres:14` 引用及其 `docker.io/library/` 别名，但必须核对容器实际镜像 ID，以及已审查的官方 RepoDigest `postgres@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`；仅有 tag 或来自其他仓库的同名 digest 不足以通过。Compose service 可叫 `pg`，不依赖必须命名 `postgres`。TLS service 使用共享的 `nginx:1.28-alpine` 时，也必须核对固定官方 manifest digest 和容器实际镜像 ID。PG/TLS 共享基础镜像不得带 `io.market-watch.*` 任务或发布归属标签；仅移除本项目容器，共享基础镜像保留。基础镜像更新后，未知 digest 会拒绝退役，需审查并更新允许的 digest 后重试。应用镜像仍要求 managed、task、project、acceptance 用途全部匹配；所有镜像检查读取容器实际 ID，不信任可变 tag。归档私有inspect、配置和bind材料，停止应用写入，导出所有非template库及全局角色；在该Ubuntu PG上新建临时库实际恢复，核对所有public表行数和来源稳定性。成功后重新核对容器、卷、网络和其他引用，删除明确资源，再登记task完成和删除无引用任务镜像。

共享卷、外部卷、非PG卷、bind数据库和外部数据库需要单独审查，不自动删除。验证失败保留卷；删除容器前失败会尝试重启原先运行的容器。归档位于`~/.local/share/market-watch-docker/archives/`，权限0700；包含角色凭据及env，严禁提交仓库。

纯构建任务没有容器时：

```bash
mw-docker finish --task mw-issue42
mw-docker cleanup --task mw-issue42          # 默认预览
mw-docker cleanup --task mw-issue42 --apply  # 精确引用，无force
```

用户级Docker wrapper是对日常构建入口的约束，不能阻止使用`/usr/bin/docker`或API绕过。

每天自动清理仅删除：managed=true、开发/验收用途、任务结束、保留期已过、项目无容器、任何运行/停止容器都未引用的镜像。每个ref删除前重新检查；不清理不明归属镜像，不自动删除数据库。可预览：`mw-docker cleanup --automatic`。没有全局prune。

## 定时任务和本地告警

首次安装（Ubuntu amd64，已有`postgres:14-bookworm`基础镜像；从Ubuntu包及SHA256固定的官方Moby发布包准备组件）：

```bash
bash deploy/ubuntu/bootstrap-builder.sh
```

安装/重新安装（Buildx已准备，builder镜像已安装）：

```bash
bash deploy/ubuntu/install.sh
```

`MW_BUILDKIT_IMAGE`可为审核过的官方builder镜像；本机Docker Hub连接不可用，本次使用Moby GitHub v0.33.1官方linux-amd64发布包，校验其release SHA256后制作本地 `market-watch-buildkit:0.33.1-official` 镜像。首次安装其他主机时需先安装Buildx并准备该镜像。安装脚本复用已存在的builder；变更GC配置需对专用builder单独停建维护，不会悄悄重建现有builder。

- `market-watch-disk-check.timer`：每15分钟检查可用空间，低于20 GiB时service返回3并写本地journal/终端告警，通知间隔至少6小时。
- `market-watch-disk-daily.timer`：每日04:20（主机时区）记录磁盘、镜像引用、containerd文件层、数据库卷、日志、home/tmp目录大小。
- `market-watch-image-cleanup.timer`：每日04:40清理已结束且过期的任务镜像。
- user Linger开启，因此无登录会话时timer也可运行。没有发送外部邮件、Slack或手机通知。

```bash
systemctl --user list-timers 'market-watch-*'
systemctl --user status market-watch-disk-check.service
journalctl --user -u market-watch-disk-check.service -n 30
mw-docker monitor --detail
cat ~/.local/share/market-watch-docker/alert.json
```

记录：`latest-disk.json`、`disk.jsonl`、`daily.jsonl`、`alert.json`、`last-cleanup.json`。history超过16 MiB保留一个轮换文件，避免监控日志自己无限增长。目录审计用精确只读挂载的临时Ubuntu Docker helper，不暴露主机根目录或改写文件。

启动/停止builder（不删除缓存卷）：

```bash
docker buildx inspect market-watch-ubuntu --bootstrap
docker buildx stop market-watch-ubuntu
```

停用自动任务：

```bash
systemctl --user disable --now market-watch-disk-check.timer \
  market-watch-disk-daily.timer market-watch-image-cleanup.timer
```

保留镜像以及数据观察、性能基线等并行任务；大规模构建/清理会影响CPU/I/O，性能测量必须记录这个环境变化。
