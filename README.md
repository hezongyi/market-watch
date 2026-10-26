# 守望 · Market Watch

当前分支候选（2026-10-26）：Advanced Charts 为唯一业务前端，网页与 MCP 共用 ChartAlert；旧 Watch、兼容图表和历史演练的活动入口已退役，历史记录保留。一个 Web 镜像提供同源静态资源、API、MCP 和 SSE。告警循环仍由 API 持有，API 停机期间判定暂停。实施及验证见 [完成审计](docs/verification/single-frontend-20261026/completion-audit.md)。以下版本段落属于历史交付，不代表本候选已发布生产。

个人外汇、黄金和比特币监控网站。当前源码版本 **v1.26.0**，改进 Python 指标结果复用、参数切换与布局恢复，统一 OANDA 平台历史和实时 candle 的账户价格口径。新增可回退迁移 `av49_indicator_demands`，无新增依赖；验收范围、已知边界与生产前检查见 [源码交付](docs/indicator-parity-v1.26.0-source-delivery.md)。

本次为源码发布。Ubuntu 真实行情及组合行情已复验，用户认可指标加载体验并决定收口；严格性能矩阵原始未达标记录保留。正式生产迁移、开盘新柱接续及休市重启后的报价恢复仍须按发布清单验证。历史生产交付见 [v1.25.7 记录](docs/oanda-rest-v1.25.7-production-delivery.md)，实际生产版本须在部署前只读核实。

v1.14.1 保留固定自建历史、实时接续组合及可审计修订；部署前需迁移至 `aq44_aggregation_service_order`，按发布身份执行覆盖 `--until-complete --verify`。应用回退及重新升级步骤见 [发布说明](docs/verification/issue-13/release-pr.md)；本次为源码发布。

v1.13.0 新增主图空白处双击最大化／恢复，并加强 Ubuntu 验收退役的 PG/TLS 镜像身份校验；发布范围见 [v1.13.0 交付](docs/chart-maximize-v1.13.0-source-delivery.md)。

v1.12.1 增加 Ubuntu 专用 BuildKit、任务归属构建、数据库恢复验证后的验收退役和磁盘监控；维护版本说明见 [v1.12.1 交付](docs/ubuntu-docker-v1.12.1-source-delivery.md)。

v1.12.0 新增多图范围映射、原生同步设置和按实际操作图跟随的柱宽同步；矩形高低价标签只左右避让。源码发布、Ubuntu验收及运行镜像边界见 [v1.12.0 交付](docs/chart-range-v1.12.0-source-delivery.md)。

v1.11.0 新增 Advanced Charts 后台持久价格、区间、画线及四指标告警，支持单次或有限 2/3 次触发；关闭网页仍继续监控。审阅修复、Ubuntu 实例及源码发布见 [v1.11.0 交付](docs/chart-alerts-v1.11.0-source-delivery.md)。

v1.10.0 新增原生 HTTP MCP，默认关闭，使用独立 agent 凭据并提供 13 项能力。接入见[原生 MCP 使用文档](docs/native-mcp-usage.md)，源码发布和真实验收来源见[v1.10.0 交付](docs/native-mcp-v1.10.0-source-delivery.md)。本次只发布源码；生产状态以[v1.8.0 生产记录](docs/chart-v1.8.0-delivery.md)为准。

v1.7.0 增加原生视窗历史储备，并修复缓存重置及 Yahoo PG-only 储备边界。功能要求见 [实施计划](docs/native-viewport-history-buffer-plan.md)，发布与部署记录见 [v1.7.0 交付](docs/chart-v1.7.0-delivery.md)。

版本变化见 [更新日志](CHANGELOG.md)，发布规则见 [版本维护](docs/versioning.md)。后续功能选项见[图表能力清单](docs/advanced-charts-v31-future-integration-capability-research.md)，MT4 接入路线见[Windows 桥接研究](docs/mt4-live-trading-bridge-research.md)。

Android APK 的个人使用、低维护选型与手机界面分析见 [讨论与研究归档](docs/research/android-apk-discussion-record-20261011.md)，包含当前建议及早期通知研究的范围说明。

历史 v1.7.0 发布：PR #6 已合入 main，附注标签 `v1.7.0` 指向 `e40eaac` 并已推送。Unraid 生产已从 v1.5.0 升级；四类镜像由该标签源码构建，实际镜像、备份恢复与验收见 [v1.7.0-production.json](deploy/releases/v1.7.0-production.json)。

源码主目录：`/home/quant/repos/market-watch`；独立开发工作树继续保留。Python发行包名为`market-watch`，导入路径继续使用`alerts`。生产服务、数据库、部署和备份路径保留`trading-alerts`相关名称。既有隔离实例与历史镜像保留原清单；生产的后续升级以 v1.8.0 生产清单为准。生产已应用 `p17_volume`→`q18_yahoo_catalog` 加法迁移，仅增加目录元数据；此处 Yahoo 关闭状态属于该次历史交付；当前生产状态须在发布前只读核实。现行生产模板按 AGENTS.md 保持 `ALERTS_YAHOO_ENABLED=true`，并保留私有代理配置。历史量partial限制及既有Volume迁移/回退见[v1.3.3本机交付](docs/chart-v1.3.3-delivery.md)，账户回退要求见[v1.5.0源码交付](docs/chart-v1.5.0-source-delivery.md)。

## 当前实例

生产网站：**https://trade.kookvv.com:8443**，运行于Unraid（192.168.7.33），使用独立PostgreSQL14生产库。外汇/黄金为OANDA Practice Bid M1，比特币为Binance BTCUSDT成交价M1，系统自行聚合其他周期。

Ubuntu为开发机，`.env`使用独立开发库，真实手机投递关闭。生产沿用已测试的ntfy.sh主题。凭据存放在受限文件中，不提交Git，也不通过网站提供。

生产 PostgreSQL 已只读核实为 14.24；Market Watch 数据库和角色保留临时 `jit=off`。源码的应用默认策略为继承，可按服务显式开启或关闭。Ubuntu 开发／验收统一固定 PG14.24，根 Compose 使用新的 `postgres14-data`，不复用旧 PG17 数据目录。实现、验证和生产后续灰度范围见 [JIT 策略交付](docs/pg-jit-policy-implementation-20261015.md)。

使用方法见[操作指南](docs/operating-guide.md)，版本、升级与回退见[Unraid部署](deploy/remote-docker.md)。

## 指标预警

ChartAlert 支持当前图表告警条件、来源绑定、有限触发次数与独立事件确认；具体能力由原生告警表单和服务端校验确定。网页与 MCP 使用相同的配置、版本及幂等事务。代码入口与维护边界见 [告警与指标维护](docs/strategy-maintenance.md)。

## 本地开发

需要 Python 3.11+、Node 22+，每项任务使用独立 worktree、依赖目录与 Ubuntu Docker project。按 [AGENTS.md](AGENTS.md) 和 [Ubuntu Docker 生命周期](deploy/ubuntu/README.md) 使用受管构建、独立 PostgreSQL 14.24、端口及私有配置；不在 Unraid 启动开发实例。完整 Web 构建需要本机固定版本许可图表库，库文件不提交 Git。

本候选实际运行地址、镜像 ID 和保留数据库的启动/停止命令见 [验收进度](docs/verification/single-frontend-20261026/progress.md)。新任务应另建 project 和私有配置，不复用本任务的可写数据库。

## 验证

```bash
.venv/bin/pytest -q
.venv/bin/ruff check backend
cd web
npm run build
```

## 备份

当前实例可运行 `.venv/bin/python -m alerts.backup`，生成私密备份与校验清单。SQLite / PostgreSQL 恢复验证及每日任务见 [备份与恢复](deploy/backup-and-restore.md)。

## 生产部署

生产使用独立 `compose.release.yaml`，复用 Unraid 现有 PG14；固定配置见 [v1.7.0-production.yaml](deploy/releases/v1.7.0-production.yaml)，操作步骤见 [部署手册](deploy/remote-docker.md)。该发布文件单独使用，不与旧 Compose 文件叠加。

API异常退出自动恢复、HTTPS浏览器登录及手机确认已验证；锁屏验收由用户确认通过，整机重启测试按用户要求取消，详见交付矩阵。使用ntfy原生应用，不开发配套APK。

## 复用项目

TA-Lib Python（BSD-2-Clause）、NumPy（BSD-3-Clause）、FastAPI（MIT）、React（MIT）、dukascopy-node（MIT）、ntfy。业务入口统一为 Advanced Charts；许可图表库需在本机单独安装，不随源码分发。旧 Watch、兼容图表和历史演练已退役，历史记录保留。锁文件固定实际安装依赖。

## 专业图表工作区（v1.1.0）

当前直接进入 `/advanced-charts/:workspaceId?`，支持多工作区、多图同步、画线和 Python 指标；登录、账户与设置属于同一应用。下列 v1.1.0 链接仅作历史记录。
[操作与维护](docs/chart-workspace-implementation.md) · [验收记录](docs/chart-workspace-acceptance.md)。
专业图表已在 Unraid 生产部署；当前版本与验收以 v1.8.0 生产清单为准。

## 原生 MCP（开发分支）

为 Codex 等受控 agent 提供同进程 Streamable HTTP `/mcp`，通过注册表开放行情、指标、告警及已保存画线。默认关闭；使用独立可撤销 Bearer 凭据。实现、Codex 配置和隔离验收步骤见 [原生 MCP 使用与开发](docs/native-mcp-usage.md)。真实 HTTPS SDK/Codex 与图表告警组合验收见 [MCP 验收](docs/verification/native-mcp/acceptance.md)及 [v1.11.0 交付](docs/chart-alerts-v1.11.0-source-delivery.md)。

## Ubuntu Docker 构建与资源回收

本机使用专用BuildKit、任务归属标签和验收结束退役流程，缓存回收目标8 GiB；每日记录容量，低于20 GiB本地告警。构建与维护命令见 [Ubuntu Docker 生命周期](deploy/ubuntu/README.md)。

当前前端构建和 Ubuntu 隔离验收见 [单前端验收记录](docs/verification/single-frontend-20261026/progress.md)，实现边界见 [收敛方案](docs/single-frontend-chartalert-consolidation-plan-20261026.md)。
