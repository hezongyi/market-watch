# Ubuntu Docker 构建与资源生命周期

本工具只连接 Ubuntu 本机 `/var/run/docker.sock`。Unraid仍为生产环境，不使用本工具创建开发/验收实例。所有构建明确指定专用 `market-watch-ubuntu` builder。

并行开发、数据基线、镜像复用及发布提效的盘点与分阶段方案，见 [2026-10-15 提效方案](../../docs/development-acceptance-release-efficiency-plan-20261015.md)。本分支已实现下文的轻量 `preview`；镜像提升和新生产发布通道仍待实施。

验收并发由用户手动控制，不实现槽位或自动排队命令。agent 启动前检查 project、端口及资源余量；需要错峰时报告用户，不自动停止其他任务。沿用的 `ops.lock` 串行执行工具的资源变更命令（包括 preview 启停）；命令结束即释放，两个已启动实例可同时验收，不占用任何长期槽位。

## PostgreSQL 验收基线

维护中的开发和验收 Compose 使用 PostgreSQL 14.24，固定引用 `postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`。数据库 healthcheck 实际查询 `server_version_num=140024` 和 JIT provider；不只依赖 `pg_isready` 或镜像标签。应用侧设置 `ALERTS_DATABASE_EXPECTED_VERSION=140024` 后，每个新连接也检查实际服务器版本与 JIT 能力；SQLite 或其他版本会拒绝连接。基线更新必须同步 Compose、检查值及工具镜像白名单，不能自动跟随可变标签。

`pg_jit_available()` 在当前连接 `jit=off` 时也返回 false。验收检查会临时允许 JIT 探测 provider，再恢复连接的继承或显式策略；这一探测会加载 LLVM，仅用于验收。生产和旧版本回滚不配置 `ALERTS_DATABASE_EXPECTED_VERSION`。

根 `compose.yaml` 的新默认数据库使用 **postgres14-data**，不复用此前 PG17 的 **postgres-data**。已有 PG17 容器和 volume 保留，不执行原地降级；PG17 兼容性测试使用明确的单独配置与新任务，不作为当前验收默认值。请按既有规则给每次验收指定新的 project。

JIT 应用默认 `inherit`，可选 `on` / `off`，兼容旧 `true` / `false`。继承会保留数据库、角色、URL 和 `PGOPTIONS` 的设置；显式模式仅改变该应用连接的 JIT，不覆盖已有 `search_path`、`statement_timeout` 等参数。配置及连接回归入口见 [JIT 策略交付](../../docs/pg-jit-policy-implementation-20261015.md)。

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

chart 默认使用仓库根目录 context 和 `advanced-host/Dockerfile`，以编译共享告警 UI；显式 `--context`/`--file` 仍可覆盖默认值。旧版独立图表工作树可指定 `--context advanced-host --file advanced-host/Dockerfile`。

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

## 轻量验收与任务 PG 复用

以下命令使用本分支代码。**目前没有覆盖主机安装版**，该版本含尚未合入 main 的 OCI 构建缓存优化；不要直接运行安装脚本覆盖它。构建继续使用现有 `mw-docker build`，preview 先显式运行工作树脚本。脚本解释器需要 `argon2-cffi`（见锁定依赖），UI 另需 `openssl`；不需要在主机安装应用数据库依赖。

```bash
# 从本任务 worktree 执行；先只读检查现有 project/端口、磁盘和内存。
mw-docker build --repo . --component api --tag market-watch-api:issue-42 \
  --task mw-issue42 --project mw-issue42 --purpose acceptance
python3 deploy/ubuntu/mw_docker.py preview prepare \
  --task mw-issue42 --project mw-issue42 --repo . \
  --api-image market-watch-api:issue-42 --port 18443
python3 deploy/ubuntu/mw_docker.py preview up --task mw-issue42 --project mw-issue42
python3 deploy/ubuntu/mw_docker.py preview status --task mw-issue42 --project mw-issue42
python3 deploy/ubuntu/mw_docker.py preview stop --task mw-issue42 --project mw-issue42
# 再次 up 复用同一 PG volume、凭据和用户写入，不重复覆盖种子。
```

首次使用前需已有本地固定 PG14.24 和 Nginx 镜像（digest 见脚本）；`up` 不自动 pull 或 build。默认 R1 是 PG + API + 64 MiB Nginx 网关：仅网关发布 `127.0.0.1:18443`，PG/API 仅连接 internal 网络，后端无默认出网路由。默认禁用通知、Yahoo 和 OANDA stream，连接 JIT 为 `inherit`。这个 API-only 地址是 **HTTP**；UI 才使用 HTTPS。

私有状态保存在 `~/.local/share/market-watch-docker/previews/<TASK>/`，包括 `preview.json`、`credentials.json`、`compose.json`、固定 seed、启动时固定实际 image ID 的 `run.json` 和脱敏的 `last-run.json`。目录 0700、凭据 0600；登录密码从私有文件本地读取，不提交或粘贴到 PR。相同参数再次 `prepare` 不改文件；参数变化拒绝覆盖，使用新 task，或在原 tag 下重构建同任务镜像后 `up`。种子文件变化应新建 task，不静默改已有 dataset。

需要 UI 时在 `prepare` 追加 `--web-image market-watch-web:issue-42 --chart-image market-watch-chart-origin:issue-42 --chart-port 17444`；先按上文构建两镜像，web 构建参数必须为 `VITE_ADVANCED_CHART_ORIGIN=https://localhost:17444` 且写入图表 origin 标签。UI 的两个独立端口都只绑定回环；证书自签名。当前主机旧工具不写该新标签，UI 入口须在工具版本对齐后使用，不能跳过标签检查。按需追加 `--worker chart-history` 等，最多三个必要 worker；本轮 UI/worker 仅通过 Compose 展开，尚无真实业务链验收证据。

```bash
# reset 默认只展示计划；显式 apply 在同一 PG 中新建任务数据库。
python3 deploy/ubuntu/mw_docker.py preview reset --task mw-issue42 --project mw-issue42
python3 deploy/ubuntu/mw_docker.py preview reset --task mw-issue42 --project mw-issue42 --apply
```

重置先停本任务写入者，保留旧库和 volume，记录 `reset_history`，对新库 migrate/seed 后才启服务；失败时保留新旧库且不启动写入者，修正后重试 `up`，不要手工删卷。旧库仍可通过任务 PG 导出，**目前不提供一键切回旧库**。普通 `up` 可能执行新镜像的迁移，并非数据库回滚；包含 schema 的改动必须另做迁移兼容验证。重复 reset 会占用额外空间；退役归档覆盖所有非模板数据库，不能只备份当前库。

当前 D1 是固定时点、四个合成品种、M1/H1 各 720 条的生成器，共 5760 candles 和 5760 published bars。首次生成、后续按 dataset marker 复用；未知 candles 或不同 marker 拒绝覆盖。它只支持功能 smoke，不能代表完整交易日历、实时供源、D2/R2 或生产规模。

资源上限：API-only R1 常驻合计 1088 MiB / 0.65 CPU，UI 另加 128 MiB / 0.1 CPU；PG/API/worker/网关均有内存、CPU 和 10 MiB × 3 日志轮转。启动保守门槛为可用磁盘 ≥23 GiB、内存 ≥3.25 GiB；worker 配置为 ≥26 GiB / ≥5 GiB；5 分钟负载 >4 拒绝新启动。检查不预留资源、不代替用户协调并发；root/Docker 状态目录在不同分区时还需人工检查 Docker 分区。`stop` 保留所有数据；任务退役仍走下文归档和实际恢复入口。

## 验收结束

先查看精确清单，确认这是已结束的验收project，再执行：

```bash
mw-docker retire --task mw-issue42 --project mw-issue42
mw-docker retire --task mw-issue42 --project mw-issue42 --apply
```

只支持由本工具登记、镜像归属匹配的acceptance项目，以及单个本项目拥有的PG14数据volume。数据库支持固定的 `postgres:14.24-bookworm@sha256:…`，也兼容旧 `postgres:14-bookworm` / `postgres:14` 引用及其 `docker.io/library/` 别名，但必须核对容器实际镜像 ID，以及已审查的官方 RepoDigest `postgres@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`；仅有 tag 或来自其他仓库的同名 digest 不足以通过。Compose service 可叫 `pg`，不依赖必须命名 `postgres`。TLS service 使用共享的 `nginx:1.28-alpine` 时，也必须核对固定官方 manifest digest 和容器实际镜像 ID。PG/TLS 共享基础镜像不得带 `io.market-watch.*` 任务或发布归属标签；仅移除本项目容器，共享基础镜像保留。基础镜像更新后，未知 digest 会拒绝退役，需审查并更新允许的 digest 后重试。应用镜像仍要求 managed、task、project、acceptance 用途全部匹配；所有镜像检查读取容器实际 ID，不信任可变 tag。归档私有inspect、配置和bind材料，停止应用写入，导出所有非template库及全局角色；在该Ubuntu PG上新建临时库实际恢复，核对所有public表行数和来源稳定性。恢复检查覆盖所有非系统schema的表行数及排序后JSON内容SHA256，来源库也再次核对，避免同数异内容或独立故障schema漏验。成功后重新核对容器、卷、网络和其他引用，删除明确资源，再登记task完成和删除无引用任务镜像。

共享卷、外部卷、非PG卷、bind数据库和外部数据库需要单独审查，不自动删除。验证失败保留卷；删除容器前失败会尝试重启原先运行的容器。归档位于`~/.local/share/market-watch-docker/archives/`，权限0700；包含角色凭据及env，严禁提交仓库。

项目名含 `production` 时默认拒绝退役，防止误选正式项目。若确认只是命名含该词的隔离验收任务，预览及 apply 都需追加 `--confirm-acceptance-project EXACT_NAME`，其值必须与 task、project 完全一致；登记用途仍须为 acceptance，镜像归属、共享资源和数据库恢复校验全部照常执行。此参数不允许正式／回滚镜像或跨任务生产依赖。

纯构建任务没有容器时：

```bash
mw-docker finish --task mw-issue42
mw-docker cleanup --task mw-issue42          # 默认预览
mw-docker cleanup --task mw-issue42 --apply  # 精确引用，无force
```

用户级Docker wrapper是对日常构建入口的约束，不能阻止使用`/usr/bin/docker`或API绕过。

每天自动清理仅删除：managed=true、开发/验收用途、任务结束、保留期已过、项目无容器、任何运行/停止容器都未引用的镜像。每个ref删除前重新检查；不清理不明归属镜像，不自动删除数据库。可预览：`mw-docker cleanup --automatic`。没有全局prune。

## 定时任务和本地告警

首次安装（Ubuntu amd64，已有上述固定 PG14.24 基础镜像；从Ubuntu包及SHA256固定的官方Moby发布包准备组件）：

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

固定镜像ID验收：PG服务支持完整`sha256:…`引用，仍必须通过实际镜像ID、官方PG14 RepoDigest及无任务/发布标签检查。跨任务依赖可显式重复提供`--retain-image sha256:完整ID`，仅删除当前project所属容器，保留所列镜像并在完成台账中永久记录自动回收保护；实际引用必须是完整ID，release/rollback/production或不完整归属标签拒绝使用此例外。未列出的应用镜像仍要求本task/project验收归属。先预览再apply，apply前必须仅启动本project PG以便实际恢复验证。
