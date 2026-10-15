# PG14.24 / JIT 策略实施与 PR #65 验证

## 验收要求

用户确认按 [重新评估](pg-jit-reassessment-20261015.md) 实施、更新 #65，再对修改后的 PR review。本次要求：

1. 应用默认继承 JIT，支持显式 on/off，兼容此前 true/false。
2. 保留 URL / PGOPTIONS 的其他连接设置；显式策略在事务回滚和连接池复用后持续生效。
3. 生产默认继续关闭，但能只覆盖指定服务；不执行生产灰度、服务重启、数据库配置修改或发布。
4. 维护中的开发／验收入口固定 PG14.24 镜像，实际检查版本和 JIT 能力；不复用旧 PG17 数据目录，不修改历史生产 release 清单。
5. 保留固定备份客户端及事故证据，补充实际连接测试、部署配置检查及独立双轴 review，更新远端现有 #65，不自动合并。

## 最终行为

`ALERTS_DATABASE_JIT` 为 `inherit`（默认）/ `on` / `off`，旧布尔值与常见布尔字符串继续接受。继承不附加 JIT 设置，让 PostgreSQL 的数据库、角色和连接参数决定策略。

显式模式通过连接建立事件单独执行会话 SET，不替换 libpq 的 `options`。SET 使用独立 autocommit 语境，恢复原 autocommit 状态，避免连接池 rollback 撤销配置。实际回归覆盖 URL 的 search_path、statement_timeout、jit 和 PGOPTIONS。

生产模板使用 `MW_PRODUCTION_DATABASE_JIT`（默认 off），每个后端服务也支持 `MW_<服务名大写、连字符改下划线>_DATABASE_JIT`。例如 `MW_CHART_AGGREGATION_WORKER_DATABASE_JIT=on` 只影响聚合 worker，其他服务保持 off。通用 `.env.example` 的 `ALERTS_DATABASE_JIT=inherit` 不会意外改变生产默认值；Yahoo 在全部后端服务保持显式启用。

这些只是未来生成生产配置时的能力，本轮没有部署。生产现有 `market_watch/*` 与 `market_watch/market_watch_app` 的 `jit=off` 继续保留。后续灰度可以先使用单个 worker 的连接级 on；若以后恢复完全继承，需要明确核对／重置数据库及 `ALTER ROLE ... IN DATABASE ...` 两个层次，不能只删应用开关。旧 PG 回滚仍需显式 off。

## PG 验收基线

维护中的根目录开发／验收 Compose、`deploy/ubuntu` 和 `deploy/native-update` 中的 PG 服务固定为：

```text
postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872
```

数据库 healthcheck 除 readiness 外，实际检查 `server_version_num=140024`、`pg_jit_available()`。应用验收入口显式设置 `ALERTS_DATABASE_EXPECTED_VERSION=140024`，实际新连接版本不符时失败，配置该门禁却指向 SQLite 也失败。该选项不用于生产或旧版回滚。

PG14 的 `pg_jit_available()` 会在当前 jit=off 时返回 false，因此验收探测会临时 on，检查 provider 后恢复继承值，再应用显式模式。这会加载 LLVM，仅是验收门禁；不将 false 误报为当前镜像不支持 JIT。

根 Compose 从旧 PG17 默认改用 PG14.24，数据库卷改名 `postgres14-data`，避免对原 `postgres-data` 执行原地降级。已有容器／volume 未操作。PG17 兼容验证必须明确使用其他任务、配置和数据卷。历史 `deploy/releases` 和 `docs/verification` 的旧交付清单不改写。

生命周期工具认可固定 PG14.24 引用，并继续以容器实际镜像 ID 与已审查 RepoDigest 核验归属；可变旧别名只作为已有任务退役兼容。备份 Dockerfile 固定客户端不代表生产数据库自动升级。

## 实际验证

实际主机为 Ubuntu `quant-server`（Docker server: Ubuntu 22.04.5 LTS），项目 `mw-pr65-revision-20261015`。独立内部网络、volume、数据库；不公开端口，没有浏览器入口。容器内数据库地址为 `postgres:5432/jit_policy`。应用镜像由专用 `market-watch-ubuntu` builder 通过本工具构建，复制本次后端代码和依赖基线；测试不把旧应用代码当作新版本验证。

- 新配置／连接测试：**27 passed**。真实连接验证三态、布尔兼容、URL 与环境参数保留、pool rollback、错误版本拒绝、能力探测后恢复 off；未使用虚假的 SQLAlchemy SQLite 连接来代替 PG 行为。
- 加上既有 PG 并发通知、覆盖／聚合与组合聚合契约：**42 passed**，无跳过。真实通知投递关闭。
- 部署配置及生命周期：**62 passed，35 subtests passed**。实际 Docker Compose 展开检查 PG 固定镜像／门禁、生产默认 off、指定服务覆盖、Yahoo 保持启用、新 PG14 卷与旧 PG17 卷隔离。展开时仅移除私有 env_file 输入，不读取真实凭据。
- Ruff、shell 语法与 diff whitespace 检查通过。

原始输出、源文件摘要和测试镜像 ID 见 [验证证据](verification/pg-jit-policy-20261015/summary.json)。旧 JIT 性能及内存数据保留在评估报告中，本轮不将 1000 次短测视为长期内存稳定性证明。

## 启动／停止与退役

供后续新任务复用；必须选择未登记过的新 task/project 和镜像标签：

```bash
export MW_JIT_TEST_IMAGE=market-watch-api:pr65-jit-rerun
mw-docker build --repo . --component api --context . \
  --file deploy/ubuntu/Dockerfile.jit-acceptance --tag "$MW_JIT_TEST_IMAGE" \
  --task mw-pr65-jit-rerun --project mw-pr65-jit-rerun --purpose acceptance
docker compose -p mw-pr65-jit-rerun -f deploy/ubuntu/jit-policy.acceptance.yaml up -d --no-build
docker wait mw-pr65-jit-rerun-tests-1
docker compose -p mw-pr65-jit-rerun -f deploy/ubuntu/jit-policy.acceptance.yaml stop
mw-docker retire --task mw-pr65-jit-rerun --project mw-pr65-jit-rerun
mw-docker retire --task mw-pr65-jit-rerun --project mw-pr65-jit-rerun --apply
```

本轮执行器的用户目录只读，临时启动器将原工具的台账与 Docker CLI 元数据放在 `/tmp/mw-pr65-revision-20261015/`；使用现有本机 socket 权限和仓库同一构建／归属／归档／恢复校验逻辑，没有修改已安装工具。实际命令入口为 `python /tmp/mw-pr65-revision-20261015/mw-docker-task.py build|retire ...`。

PR 审阅期间保留本任务隔离 PG，供必要的复核；最终退役与审查结果在本文件后续记录。无生产操作。
