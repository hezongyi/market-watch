# 守望 · Market Watch

个人外汇、黄金和比特币监控网站。当前源码版本 **v1.7.0**，新增 Yahoo 原生七周期行情、延迟报价和平台品种中文搜索，保留独立 Advanced Charts、平台/自建双系列、自建历史修订、Volume、原生历史缓冲、专业图表菜单、账户及工作区操作。源码发布、启用方法及上游限制见[v1.6.0源码交付记录](docs/yahoo-v1.6.0-source-delivery.md)，操作及既有系列规则见[双系列使用说明](docs/chart-dual-dataset-user-guide.md)。原预警系统验收见[交付矩阵](docs/acceptance-matrix.md)。

v1.7.0 增加原生视窗历史储备，并修复缓存重置及 Yahoo PG-only 储备边界。功能要求见 [实施计划](docs/native-viewport-history-buffer-plan.md)，发布与部署记录见 [v1.7.0 交付](docs/chart-v1.7.0-delivery.md)。

版本变化见 [更新日志](CHANGELOG.md)，发布规则见 [版本维护](docs/versioning.md)。后续功能选项见[图表能力清单](docs/advanced-charts-v31-future-integration-capability-research.md)，MT4 接入路线见[Windows 桥接研究](docs/mt4-live-trading-bridge-research.md)。

v1.6.0 的 Yahoo 行情及审查修复通过 PR #5 合入 main，版本及发布记录整理后以附注标签固定并推送源码；源码清单见 [v1.6.0-source.json](deploy/releases/v1.6.0-source.json)。生产运行版本由独立部署清单管理，本次源码发布未升级运行镜像。

源码主目录：`/home/quant/repos/market-watch`；独立开发工作树继续保留。Python发行包名为`market-watch`，导入路径继续使用`alerts`。生产服务、数据库、部署和备份路径保留`trading-alerts`相关名称。图表UI隔离实例仍以[v1.3.2专用清单](deploy/releases/v1.3.2-ui.json)为准，Volume和原生历史镜像保留各自原清单，本次源码发布不包含运行环境升级。源码新增从 `p17_volume` 派生的 `q18_yahoo_catalog` 加法迁移，仅增加目录元数据；Yahoo 默认关闭，启用需应用迁移并配置后端代理。历史量partial限制及既有Volume迁移/回退见[v1.3.3本机交付](docs/chart-v1.3.3-delivery.md)，账户回退要求见[v1.5.0源码交付](docs/chart-v1.5.0-source-delivery.md)。

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

生产使用 `compose.external-db.yaml` 与固定镜像版本文件 `compose.release.yaml`，复用Unraid现有PG14；操作步骤见[部署手册](deploy/remote-docker.md)。不要将原`compose.yaml`与此配置混用。

API异常退出自动恢复、HTTPS浏览器登录及手机确认已验证；锁屏验收由用户确认通过，整机重启测试按用户要求取消，详见交付矩阵。使用ntfy原生应用，不开发配套APK。

## 复用项目

TA-Lib Python（BSD-2-Clause）、NumPy（BSD-3-Clause）、FastAPI（MIT）、React（MIT）、Lightweight Charts（Apache-2.0，图表保留官方 attribution）、dukascopy-node（MIT）、ntfy。图表由 [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) 提供。锁文件固定实际安装依赖。

## 专业图表工作区（v1.1.0）

从工作台导航进入独立图表页面，支持多工作区、多图同步、八种画线和Python指标。
[操作与维护](docs/chart-workspace-implementation.md) · [验收记录](docs/chart-workspace-acceptance.md)。
本地版本与生产部署分开管理；本次图表模块尚未部署Unraid。
