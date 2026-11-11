# PostgreSQL 告警健康统计修复验证

风险 **F0**：修复兼容 API 中的只读查询；schema、响应格式和告警执行语义不变。基线 main / v2.0.5 为 `1bb935bd`，修复提交 `c0f76a24`。需求见 [Issue 草案](issue-draft.md)。

## 问题与改动

`chart_alert_health.summary()` 原来在 SELECT、WHERE 和 GROUP BY 分别构建 `runtime["execution_state"]`。SQLAlchemy 给不同表达式生成不同 JSON key 绑定参数，PostgreSQL 不认可 SELECT 与 GROUP BY 的表达式等价，报 `GroupingError: column "chart_alerts.runtime" must appear in the GROUP BY clause or be used in an aggregate function`。空库同样会在执行该查询时失败，影响认证后的 `GET /api/health`。

复用一个 `execution_state` 表达式，使 SELECT、WHERE、GROUP BY 使用同一绑定键。保留原有归档、过期、结算和故障筛选条件。

## 验证结果

- 同一真实 PostgreSQL 用例：主线连续两次 `1 failed`，均为上述 GroupingError（2.14s / 2.13s）；候选 `1 passed`（1.65s）。见 [基线结果](baseline-result.json) 和 [候选结果](candidate-result.json)。
- 健康统计、健康 API、运行组健康、告警 API、PostgreSQL 告警并发及迁移相关 6 个模块 **36 passed，0 skipped**。20 个警告均为已有 Alembic `path_separator` 配置弃用提示。见 [相关回归](related-tests-result.json)。
- 真实本机 HTTP：`/healthz`、`/readyz` 返回 200；未登录 `/api/health` 返回 401；真实密码登录后 `/api/health` 返回 200。8 条合成规则涵盖监控、过期、结算、故障恢复、归档和缺少执行状态，结果为 `monitoring=2, settling=1, recovering=1`。见 [HTTP smoke](http-smoke-result.json)。
- 改动源码、回归用例与两个验收脚本 Ruff 通过；`git diff --check` 通过。
- PR CI 以最终提交的 GitHub Checks 为准；本记录的本地测试不能代替 PR CI。

## Ubuntu 实例与复现

实际主机 **Ubuntu quant-server**；独立 project `mw-health-pg-20261111`；数据库 `health_acceptance`。独立持久 volume、内部数据库网络、API 入口网络和私有凭据。PostgreSQL 不发布宿主端口；API 仅在 <http://127.0.0.1:28472> 提供服务。

复用本机依赖镜像完整 ID `sha256:6dcd7c1b9e05c16552606cd33dcced0788f8786ac678f4ce03bd298d307183a4`，只读挂载本任务源码；这是源码 smoke，不是新构建或生产镜像。PostgreSQL 固定为 14.24 官方 digest。PG 512 MiB /0.5 CPU，API 或验证器 768 MiB /0.75 CPU；验证器退出后才启动 API。无 worker，行情采集、外部投递及可选供源关闭。保留 mw-dev、CPU 异常现场和 Android 工作。

以下从当前 worktree 根目录执行，私有文件已在本机准备；不要打印或提交其中内容：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-private/chart-alert-health-pg-20261111/compose.env \
  -p mw-health-pg-20261111 -f docs/verification/chart-alert-health-pg-20261111/compose.yaml \
  --profile smoke up -d --no-build --wait postgres api
```

停止 API 后可重跑回归，不重置或共享数据库：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-private/chart-alert-health-pg-20261111/compose.env \
  -p mw-health-pg-20261111 -f docs/verification/chart-alert-health-pg-20261111/compose.yaml stop api
docker compose --env-file /home/quant/.local/share/market-watch-private/chart-alert-health-pg-20261111/compose.env \
  -p mw-health-pg-20261111 -f docs/verification/chart-alert-health-pg-20261111/compose.yaml \
  run --rm -T verify
```

基线对照在上述 run 的 verify 之前追加只读文件挂载（本机已保存 origin/main 的目标文件）：

```text
-v /home/quant/.local/share/market-watch-private/chart-alert-health-pg-20261111/main-chart_alert_health.py:/app/backend/alerts/chart_alert_health.py:ro
```

公开 HTTP 脚本 [http_smoke.py](http_smoke.py) 接受 `--credentials` 私有文件和 `--output` 结果路径，不输出密码、Cookie 或 CSRF。seed_smoke.py 仅用于首次创建本任务合成数据，不重复运行。HTTP 复查前启动 API。

整体停止命令保留数据库和 volume：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-private/chart-alert-health-pg-20261111/compose.env \
  -p mw-health-pg-20261111 -f docs/verification/chart-alert-health-pg-20261111/compose.yaml \
  --profile smoke stop
```

验收结束后的数据库归档、实际恢复与资源退役另按 AGENTS.md 执行；本任务尚在合并检查点，不登记完成。安装版 mw-docker 存在已知固定 PG14.24 引用识别兼容问题，不能直接忽略退役校验。

## 自审

F0 本人自审完成，无阻塞项：

- 表达式复用消除分组绑定键差异，参数仍由 SQLAlchemy 绑定，没有拼接 SQL。
- 原筛选条件和统计返回结构保持一致；真实 PostgreSQL 覆盖空结果及混合状态，既有 SQLite/API 用例继续通过。
- 未改迁移、持久事实或后台执行链；验收数据和凭据与其他项目隔离。
- 最终合并需用户决定；本轮不创建正式标签或发布生产。
