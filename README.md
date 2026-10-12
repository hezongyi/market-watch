# 守望 · Market Watch

个人外汇、黄金和比特币监控网站。当前源码版本 **v1.22.1**，修复手机弹窗、长行情身份、保存焦点、历史服务心跳、股票分类、日历审核展示及指标／告警参数，保留 v1.22.0 Swing 支撑阻力与原生模板能力。源码发布与验收边界见 [修复验收记录](docs/production-ux-fixes-20261012.md) 和 [源码清单](deploy/releases/v1.22.1-source.json)，既有操作见[双系列使用说明](docs/chart-dual-dataset-user-guide.md)。原预警系统验收见[交付矩阵](docs/acceptance-matrix.md)。

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

源码主目录：`/home/quant/repos/market-watch`；独立开发工作树继续保留。Python发行包名为`market-watch`，导入路径继续使用`alerts`。生产服务、数据库、部署和备份路径保留`trading-alerts`相关名称。既有隔离实例与历史镜像保留原清单；生产的后续升级以 v1.8.0 生产清单为准。生产已应用 `p17_volume`→`q18_yahoo_catalog` 加法迁移，仅增加目录元数据；Yahoo 默认及当前生产仍关闭，启用需配置后端代理。历史量partial限制及既有Volume迁移/回退见[v1.3.3本机交付](docs/chart-v1.3.3-delivery.md)，账户回退要求见[v1.5.0源码交付](docs/chart-v1.5.0-source-delivery.md)。

## 当前实例

生产网站：**https://trade.kookvv.com:8443**，运行于Unraid（192.168.7.33），使用独立PostgreSQL14生产库。外汇/黄金为OANDA Practice Bid M1，比特币为Binance BTCUSDT成交价M1，系统自行聚合其他周期。

Ubuntu为开发机，`.env`使用独立开发库，真实手机投递关闭。生产沿用已测试的ntfy.sh主题。凭据存放在受限文件中，不提交Git，也不通过网站提供。

使用方法见[操作指南](docs/operating-guide.md)，版本、升级与回退见[Unraid部署](deploy/remote-docker.md)。

## 指标预警

已支持 TA-Lib 双均线交叉，可修改快慢周期、方向与确认周期；实时和历史演练共用规则。Python 插件接口及扩展边界见 [策略维护](docs/strategy-maintenance.md)。

## 本地开发

需要 Python 3.11+、Node 22+。当前开发与生产使用分离的PostgreSQL库及账户，单元测试可使用SQLite。新安装才使用默认配置；不要覆盖当前开发机.env。

```bash
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/python -m alerts.cli init
cd adapters/dukascopy
npm ci
cd ../../web
npm ci
```

从仓库根目录启动 API：

```bash
.venv/bin/uvicorn alerts.api:app --host 127.0.0.1 --port 8000
```

另一个终端启动网站：

```bash
cd web
npm run dev
```

行情和通知 worker 各自独立运行，不依赖网页：

```bash
.venv/bin/python -m alerts.market
.venv/bin/python -m alerts.notify
.venv/bin/python -m alerts.market --imports-only
```

默认 `ALERTS_DELIVERY_ENABLED=false`，不会发送真实手机消息。行情请求失败会在界面展示，没有自动填充的模拟行情。历史导入示例（UTC，半开区间）：

```bash
.venv/bin/python -m alerts.market --instrument EURUSD --start 2026-09-21T00:00:00Z --end 2026-09-26T00:00:00Z
```

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

TA-Lib Python（BSD-2-Clause）、NumPy（BSD-3-Clause）、FastAPI（MIT）、React（MIT）、Lightweight Charts（Apache-2.0，图表保留官方 attribution）、dukascopy-node（MIT）、ntfy。图表由 [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) 提供。锁文件固定实际安装依赖。

## 专业图表工作区（v1.1.0）

从工作台导航进入独立图表页面，支持多工作区、多图同步、八种画线和Python指标。
[操作与维护](docs/chart-workspace-implementation.md) · [验收记录](docs/chart-workspace-acceptance.md)。
专业图表已在 Unraid 生产部署；当前版本与验收以 v1.8.0 生产清单为准。

## 原生 MCP（开发分支）

为 Codex 等受控 agent 提供同进程 Streamable HTTP `/mcp`，通过注册表开放行情、指标、告警及已保存画线。默认关闭；使用独立可撤销 Bearer 凭据。实现、Codex 配置和隔离验收步骤见 [原生 MCP 使用与开发](docs/native-mcp-usage.md)。真实 HTTPS SDK/Codex 与图表告警组合验收见 [MCP 验收](docs/verification/native-mcp/acceptance.md)及 [v1.11.0 交付](docs/chart-alerts-v1.11.0-source-delivery.md)。

## Ubuntu Docker 构建与资源回收

本机使用专用BuildKit、任务归属标签和验收结束退役流程，缓存回收目标8 GiB；每日记录容量，低于20 GiB本地告警。构建与维护命令见 [Ubuntu Docker 生命周期](deploy/ubuntu/README.md)。
