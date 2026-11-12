# 旧新浪港股平台日线异常隔离修复

状态：业务修复、本地/PG 检查、独立审查和真实开发实例 API/UI 验收通过。PR 尚未合并，未打 tag、未发布生产。基于 PR #135 的 `92fe075b`，原因与规格见[诊断方案](../../research/sina-hk-ohlc-diagnosis-20261112.md)。

分类 F1：已有平台来源增加版本化异常记录策略，复用现有可选审计快照格式，需验证持久兼容。没有数据库迁移、旧 blob 改写或新后台任务。

仅旧新浪港股平台前复权 D1 设置 `record_policy=sina-hk-platform-invalid-ohlcv-audit-v1`。保持 ticker、前复权口径和全部有效 OHLCV；坏记录保留原日期、OHLCV 与原因到 `source_warnings`，并通过共享缓存和图表 API 返回。平台详情使用已有 `quality_note` 说明。未选择新策略的来源及自建/组合采集保持原有严格校验；空快照或全坏快照失败可重试，不保存为成功空历史。

本次用户要求修复，延续“在开发实例上验收”的授权：使用 Ubuntu quant-server 既有 `mw-dev`（https://192.168.7.232:18443），无需再创建隔离 preview。启动前可用磁盘约 13 GiB，可用内存约 7.5 GiB。只构建替换 API/三个原有运行组的共享镜像；Web、PG、TLS、ntfy、私有配置与其他任务保持。PG 自动化使用独立数据库 `mw_sina_hk_quality_20261112`，逐测试 schema，不向应用 dev 数据库写测试数据。完成后保留开发实例运行，不合并、不打 tag、不发布生产、不追踪 CI。

## 已完成检查

- 先写回归并确认失败：真实 2006 年坏记录令最近两根平台读取抛出 `Invalid OHLC extremes`。
- 修复后相关本地回归 192 passed（含 9 个本次用例）。验证全量先校验的真实故障、正常值不变、原始异常值保留、缓存身份隔离、目录说明、API 缓存审计、全坏/空快照失败恢复、默认严格校验和不吞掉缺字段/非数字错误。
- [PostgreSQL 10 passed](postgres-tests.txt)：本补丁 4 项持久/恢复用例，加原生周期已有 6 项兼容/并发用例。数据库为本任务专用库，schema 按测试独立创建、销毁。
- Ruff 与 `git diff --check` 通过。无前端代码变化，不重复构建或运行前端单测。

复现：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_sina_hk_quality.py backend/tests/test_provider_akshare.py \
  backend/tests/test_akshare_native.py backend/tests/test_source_history_store.py \
  backend/tests/test_platform_catalog.py backend/tests/test_provider_directory.py \
  backend/tests/test_market_presentation.py backend/tests/test_provider_cache.py \
  backend/tests/test_market_contracts.py
# TEST_POSTGRES_URL 从私有配置注入，仅连接本任务测试库。
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_sina_hk_quality_postgres.py backend/tests/test_akshare_native_postgres.py
```

## 开发实例实际验收

运行主机 Ubuntu quant-server；Compose project `mw-dev`；地址 **https://192.168.7.232:18443/**。部署业务提交 `8cec2c6fa2c9b41da6a52e4f3b08a506bdcc96e0`，后续提交仅补脚本和证据。

- API/三个运行组固定镜像：`sha256:54959714fa8691256ccb93606615e96d85f1198cb7afb9379ab781a490763978`。
- Web 保持 `sha256:fbc2c2d223d7fcaac4bc78e3e33a5cb2dcf1008f2a728b5e45da85d97cb8d4b6`；没有重建 Web 或修改许可资源。
- 通过 `mw-docker build`、`market-watch-ubuntu` builder 构建，task=`mw-sina-hk-quality-20261112`、project=`mw-dev`、purpose=`development`。
- 运行中三个修改模块逐个 SHA256 与候选完全相同：[源码证据](running-source.json)。[部署清单](deployment.json)记录固定镜像和备份。
- 原配置、launcher 和 1,566,417,056 字节的 `pg_dump -Fc` 保留在本机私有 `~/.local/share/market-watch-dev/updates/sina-hk-ohlc-20261112/`；`pg_restore --list` 读取成功，未声称执行全库恢复。旧镜像和此前备份保留。

| 实际验收 | 结果与证据 |
|---|---|
| 原始复现 | 相同 00700 最近 30 根请求从 HTTP 422 / 0 bars 恢复到 HTTP 200 / 30 bars |
| 四只港股 | 00700/02318/00941/00005 各取最近 30、80 根及 2010-05-04 前 30 根，共 12 项通过；坏记录分别 2/4/27/3 条，原值和原因可读取；[API 证据](application.json) |
| 图表与说明 | 00700 真实 D1 K 线绘制、数据就绪与有效可见范围通过，实际传入图表 1,000 根行情，刷新恢复成功，浏览器错误为空；[浏览器报告](browser.json)、[图表](00700-chart.png)、[异常说明](00700-quality-notice.png) |
| 同源和新能力回归 | 旧新浪/腾讯 A 股前复权、国内期货六周期、新新浪 A 股 H1/腾讯 A 股 MN/腾讯港股 MN 共 11 项通过；见 API 证据 |
| 既有服务 | OANDA/Binance/Dukascopy/Yahoo/AKShare/FXCM 各返回 40 根；运行组、ready、MCP 42 tools、SSE、通知及 ntfy 健康均通过；[服务证据](services.json) |
| 独立审查 | [Standards 和 Spec](review.md)均无待修代码问题；审查未被当作运行验收替代 |

首轮浏览器等待因数据回调 ticker 与图表 symbol 的大小写不同而误判超时，截图已显示正常 K 线。仅将验收脚本记录和查找统一为大写后复验通过，业务源码未更改。失败证据保留本机，未将失败写成通过。验收复用本任务布局 `0712785e-116d-407f-afab-a1396021e68c`，没有删除旧布局或修改自选。

实际执行：

```bash
mw-docker build --repo /home/quant/repos/market-watch-sina-hk-ohlc-20261112 \
  --context /home/quant/repos/market-watch-sina-hk-ohlc-20261112 \
  --file /home/quant/repos/market-watch-sina-hk-ohlc-20261112/Dockerfile \
  --component api --tag market-watch-api:dev-sina-hk-quality-20261112 \
  --task mw-sina-hk-quality-20261112 --project mw-dev --purpose development --retain-days 90
docker compose -p mw-dev \
  -f ~/.local/share/market-watch-dev/updates/sina-hk-ohlc-20261112/run.json \
  up -d --no-build --no-deps --wait --wait-timeout 180 \
  api market-runtime data-worker notification-worker
```

已更新持久 `mw-dev` launcher 和开发镜像引用，后续命令使用新固定配置：

```bash
mw-dev status
mw-dev up
mw-dev restart api market-runtime data-worker notification-worker
mw-dev stop
```

`stop` 会停止开发实例但保留数据；**本轮验收后保留实例运行**。不停止、删除其他任务或旧 orphan，不执行全局 prune。若需要回退，可使用私有 `run.before.json` 的旧固定镜像恢复上述四个服务；本补丁无 schema 变化。

验收脚本：`accept_dev.py` 通过 `MW_ACCEPTANCE_CREDENTIALS_FILE` 读取私有 `{base_url, login_password, ca_file}`，`MW_OUTPUT` 指定脱敏报告。`web/tests/sina-hk-quality.browser.cjs` 使用 `MW_BASE_URL`、`MW_OUTPUT`、`MW_ACCEPTANCE_CREDENTIALS_FILE`（私有 `{login_password, ca_file, tls_cert_file?}`），可选 `MW_WORKSPACE_ID` 复用本任务布局；Chromium 由 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定。脚本仅观察真实行情回调，不拦截请求或注入 OHLC。

## 交付边界

隔离使正常记录恢复可读，未恢复坏记录当天的真实价格。坏日没有有效 K 线，不补造、不跨来源混价；不提高历史完整性结论。旧严格历史数据和已保存布局仍保留，其他供源策略、缓存规则和后台服务未扩展。此次没有新的纯净空闲 CPU 测试，也不沿用上轮带采样开销的数值声称本补丁改善了 CPU。

修复及证据更新到 PR #135；不追踪 CI，不合并，不打 tag、不发布生产。
