# 守望 · Market Watch

个人外汇、黄金和比特币监控网站。当前处于实现与验收中，**尚未达到完整交付状态**。状态见 [交付记录](docs/delivery-status.md)，规格见 [实施方案](docs/implementation-plan.md)。

## 当前开发实例

网站：http://192.168.7.232:5173/（同一局域网访问）。外汇/黄金使用 OANDA Practice Bid M1，比特币使用 Binance BTCUSDT 成交价 M1；定时拉取并自行合成其他周期。当前数据库 `oanda-live.db`，旧 `alerts.db` 保留。开发登录凭据保存在本机忽略版本控制的 `artifacts/local-credentials.json`；该目录不通过网站提供。

新安装默认关闭真实手机通知；当前实例经手机验证后已启用，沿用测试 topic。当前进程尚未安装开机自启，开发地址可访问不代表最终验收完成。

## 指标预警

已支持 TA-Lib 双均线交叉，可修改快慢周期、方向与确认周期；实时和历史演练共用规则。Python 插件接口及扩展边界见 [策略维护](docs/strategy-maintenance.md)。

## 本地开发

需要 Python 3.11+、Node 22+。默认 SQLite 供本地验证，部署使用 PostgreSQL。

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

## 部署草案

设置 `.env` 中 HTTPS 的公开域名、密码 hash、随机 URL-safe `POSTGRES_PASSWORD`。反向代理 HTTPS 到 `127.0.0.1:8080`，并支持 SSE 长连接。

```bash
docker compose up -d --build
```

Compose 尚待实际 Docker 环境验收；不得将配置存在当作已部署。当前按用户确认使用 ntfy.sh 原生应用，配套 APK 开发已停止，自建 ntfy 暂不要求。手机持续响铃、后台与确认效果以原生应用实测为准。

## 复用项目

TA-Lib Python（BSD-2-Clause）、NumPy（BSD-3-Clause）、FastAPI（MIT）、React（MIT）、Lightweight Charts（Apache-2.0，图表保留官方 attribution）、dukascopy-node（MIT）、ntfy。图表由 [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) 提供。锁文件固定实际安装依赖。
