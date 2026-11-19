# 自选美股固定日线报价修复

分类：F0，兼容的只读报价计算修复；不改 schema、行情数据、分组或通知配置。
源码基线：`28af65ba`，独立分支 `fix/watch-us-stock-quotes-20261117`。

## 问题与根因

开发实例的“美股”分组已保存 NVDA、QQQ、SPY 的 MWH 固定版本。
三个版本均已发布 D1/W1/MN 产物，但 `/api/market-data/quotes` 对三条全部返回
`s=error`。手机行显示 UUID、“名称待确认”、空价格和空涨跌幅。

真实原路径复现断言：三个报价均应具有有效代码和价格，修复前为 `0 !== 3`。
在实际 API 容器调用 `metadata → fixed_snapshot` 得到：
`ValueError: Source trading-date bars cannot be inferred from M1 sessions`。

`fixed_snapshot` 无条件调用 M1 日界推导，随后还要求收盘分钟来验证昨收。
这适用于 M1 聚合行情，不适用于来源已确认的交易日日线；上层将异常转换为
整行不可用，连有效名称与价格一起丢弃。问题不在已保存的版本或数据维护。

## 修复范围

- `source_date` 的 D1 使用本根来源日线起点查询上一交易日，包含周末跨越。
- 昨收直接取同一固定版本内已闭合、来源确认且完整的 D1 收盘；缺失或无效时
  保留当前价格与名称，不编造涨跌幅，不读取虚构的 M1。
- 仅有 W1/MN 时保留该周期末价，不把周/月变化冒充日涨跌。
- 原 M1 聚合行情继续要求有效收盘分钟，未放宽外汇证据要求。
- 未修改 UI、精度、采样、原生行情请求策略或固定版本选择。

这三条自建是仅日线维护，仍不具有日内 sparkline。此次不从另一来源偷偷拼入
分钟走势，也不将跨日曲线伪装为日内曲线。

## 验证

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest -q \
  backend/tests/test_fixed_native_quotes.py \
  backend/tests/test_quote_close_evidence.py \
  backend/tests/test_quote_session_contract.py \
  backend/tests/test_native_history_archive.py \
  backend/tests/test_watch_quote_identity.py

PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/pytest -q \
  backend/tests/test_fixed_native_quotes.py backend/tests/test_market_stream_quotes.py
```

新回归在修复前复现 `s=error` 与上述日界异常；修复后第一组 54 通过、第二组 18
通过（含重复的 8 项，共 64 项独立用例）。第二组增加了真正的
`Subscription → claim → Calculator → commit → events` 路径核验，避免只验 HTTP。
Ruff、`git diff --check` 通过，无临时日志。

2026-11-17 18:24 UTC 在 Ubuntu Docker 持久 `mw-dev` 完成 R1：

- 使用可信 HTTPS `https://quant.kookvv.com:8443/m/` 登录，读取用户原有美股分组。
- HTTP 与后台任务发布的 SSE 报价均恢复 NVDA/QQQ/SPY 名称、价格和涨跌幅。
- 以真实已有版本的最后两根日线核对昨收及变化；没有修改用户数据或发送通知。
- 412/375px、深浅主题、150% 字号截图核验；无浏览器异常。
- APK 更新清单仍为 versionCode 6，无需更换 APK。未声称完成 Android 真机验收。
- 原始页面复现脚本修复后通过，详见私有证据目录的 `repro.before.txt` / `repro.after.txt`。

截图与结构化证据见同目录 `before.png`、`after-*.png`、`deployed-proof.json`。

## 部署与保留

API 以其已部署源码为基线构建；逐文件比对证实修改前源码一致。
SSE 计算实际属于 **data profile 的 market_stream loop**，须同步更新 data-worker。
data-worker 通过 `data-worker.Dockerfile` 叠加原部署镜像，只替换报价模块的源码与
已安装副本；全目录 SHA 核对证实仅 `alerts/quote_presentation.py` 不同，
Dukascopy 连接池自动恢复实现保持原样，见 `preservation.json`。

验收曾误将推送服务定位为 market-runtime，随后撤回该服务补丁、恢复原镜像。
最终变更仅 API 与 data-worker 的镜像；market-runtime 有过重建但运行原镜像；
Web、通知 worker、ntfy、PostgreSQL、TLS 五个服务的容器 ID、镜像及启动时间均未变。
没有创建额外验收栈或改动 Unraid。定向失效过三条错误报价的计算指纹，
未改报价身份、历史数据、用户分组或业务配置。

持久配置：
`/home/quant/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json`。
候选和旧镜像见 `deployment.json`。启动/停止只针对本次服务：

```bash
docker compose -p mw-dev \
  -f /home/quant/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json \
  up -d --no-build --no-deps api data-worker

docker compose -p mw-dev \
  -f /home/quant/.local/share/market-watch-dev/updates/mw-mobile-resume-20261117/run.json \
  stop api data-worker
```

回退时只把持久配置的 API、data-worker 镜像改回 `deployment.json` 中的 old，
再执行上述定向 up；不恢复整份旧配置，不覆盖其他任务。私有部署前后快照及
配置备份在 `~/.local/share/market-watch-dev/updates/watch-us-stocks-20261117/`。
