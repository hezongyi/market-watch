# 守望 · Market Watch

个人外汇、黄金和比特币监控网站。当前源码版本 **v1.2.0**，新增独立 Advanced Charts 工作台。本轮在Ubuntu本机Docker验收；不代表Unraid已升级。图表验收见[交付核对](docs/advanced-charts-current-acceptance.md)，操作及限制见[图表使用说明](docs/advanced-charts-user-guide.md)。原预警系统验收见[交付矩阵](docs/acceptance-matrix.md)。

版本变化见 [更新日志](CHANGELOG.md)，发布规则见 [版本维护](docs/versioning.md)。

本轮源码目录：`/home/quant/repos/market-watch-advanced`；原目录`/home/quant/repos/market-watch`保留。Python发行包名为`market-watch`，导入路径继续使用`alerts`。生产服务、数据库、部署和备份路径保留`trading-alerts`相关名称。本轮v1.2.0仅本地交付，生产仍按既有发布清单运行；[本地交付及回退说明](docs/advanced-charts-v1.2.0-delivery.md)。

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
