# 六源本地目录候选验收

日期：2026-11-09。基线 `v2.0.0` / `f111d3a6`，分支 `feat/provider-catalog-maintenance-20261109`。风险 **F1**：新增持久目录索引和后台目录刷新，采用相关回归、PostgreSQL 迁移兼容验证、独立 Standards/Spec review 及 Ubuntu 隔离验收。未合并、未发布生产。

## 用户可见结果

商品搜索、平台目录和自建选择共用本地 SQL 查询，不等待供应商，也不逐行请求元信息。六源目录按分区完整取得后发布；失败保留旧快照。人工中文在供应商刷新后保留。详情可进入预填自建表单并定位相同来源身份的已有维护。

原慢查询带完整 JSON 做窗口排序，文本条件又未命中表达式索引。首次同步前的离线备用目录还可能让名称匹配挤掉代码匹配，现统一按准确代码、代码前缀、其他匹配稳定排序。现在先对身份过滤、分页再批量取详情；搜索表达式与 GIN 索引一致。实际 EXPLAIN 观察到代码搜索使用 `ix_provider_directory_search`，对应 SQL 执行 1.332ms；接口耗时还包含计数、序列化和传输。

## 真实目录和行情

以下数量是本次响应快照，不是永久全集承诺。

| 来源 | 成功发布数量/范围 | 实际代表行情 |
|---|---|---|
| Dukascopy | 官方动态目录 1,504 | EUR/USD 九周期 |
| Binance | Spot exchangeInfo 3,742，保留交易状态 | BTCUSDT 九周期 |
| OANDA | 已配置账户 127 | EUR_USD 九周期 |
| FXCM | Demo Offers 517 | EUR/USD 九周期 |
| Yahoo | crypto 分区 8,093，按 ticker ASC 完成分页 | BTC-USD 八周期，包含 M30，无 H4 |
| AKShare | A 股 5,223、港股 2,800、主力连续 82 | 新浪 A/HK D1、腾讯 A D1、RB0 的 M1/M5/M15/M30/H1/D1 |

AKShare 不新增目录或行情端点；北交所、ETF 和交割月合约不能从新入口选择，已有历史身份保留。腾讯与新浪维持不同平台身份。

Yahoo 美股分区超过公开接口可证明完整性的分页边界，刷新明确失败，保留旧快照；不以显式补录或前 10,000 条冒充完整目录。公开网络曾有超时，验收脚本有限重试后成功；这不是新建的供应商通用重试框架。

Dukascopy 原始响应中 17 项无 groupId、46 项无 priceScale：保留未分组品种；无精度项创建时要求人工填写，不将占位值当供应商确认精度。带 `+` 的原始代码可以传入创建接口。

六源代表数据集均实际运行维护并发布版本，再由 `query_chart` 查询固定版本，各返回 5 根 K 线；不以 mock 代替真实行情。四个 M1 来源只取有限近期窗口，Yahoo/AKShare 使用近期 D1。创建、配置、启动维护使用实际 command 层；浏览器验证预填与已有维护入口，未声称六源均逐一通过浏览器完整提交表单。

## 性能和浏览器

47,232 行，其中 25,000 行为明确标记的合成负载；脚本只清理自身合成行。API 1 CPU/512MiB，PostgreSQL 2 CPU/512MiB，主机 load 约 11。每种接口测 20 次。

| 接口 | p95 | 中位数 |
|---|---:|---:|
| 平台列表 | 569.42ms | 495.24ms |
| 代码搜索 | 64.38ms | 42.89ms |
| 中文搜索 | 103.97ms | 51.66ms |
| 自建选择 | 77.70ms | 66.71ms |

上述最终性能复测未与建表回归、浏览器同时运行。此前三者并行、主机 load 约 14 时，列表 p95 为 1,520.28ms、页面一次测量 3,584ms，其他搜索 p95 仍小于 102ms。该争用结果也保留在 `perf-contention-evidence.json`；性能目标不是共享主机在任意负载下的保证。

浏览器实际验证平台列表、代码搜索、中文保存、Binance 手动刷新成功、刷新后人工中文保留、预填创建表单、按完整身份进入已有维护，无 pageerror。平台标签打开至首批详情按钮可见最终候选实测 1,902ms（此前两次 1,797ms、1,860ms）；这是单次页面测量，不是页面 p95。结构化证据见本目录 JSON。

## 验证状态

- 最新相关后端回归：199 passed；包含目录、平台、自建选择、AKShare/Yahoo/Dukascopy、市场搜索和 runtime profile。
- PostgreSQL 14.24：基线升级、重复升级、降级后升级通过；旧 BSE 历史身份和人工中文逐字保留；两项普通索引和两项 GIN 索引存在。独立 schema 中 `public.gin_trgm_ops` 可用性原失败项复跑通过。
- Standards 和 Spec 独立复审均无阻断项，分别补充 29 和 65 项相关回归。
- 修改的 Python 文件 Ruff、`git diff --check`、前端构建、`test:single-frontend -- --unit` 通过。
- 全量后端运行 68 分钟，结果为 3474 passed、8 failed、21 skipped。进程在最终改动前已启动，期间导入旧模块；8 项失败均在最新代码复跑通过（5 项 SQLite 包含于 199 项相关回归，3 项 PostgreSQL 独立复跑通过）。不把这次旧进程结果称为最终代码全量通过；首轮 PR CI 跑完全量，3489 passed、16 failed、3 skipped；16 项失败均属于 Yahoo 缓存兼容：恢复已知 adjustment 缓存对未知时区/时段的既有读取行为，过期测试改用独立元信息时间。包含全部失败项的相关回归 86 passed；后续最终提交结果见 PR CI。
- 全站 `single-frontend.browser.cjs` 在测试工作区保存断言失败。已确认测试请求 `D1_BTCUSDT`，实际登录回跳到 `D1_EURUSD`：基线 `safeNext` 不允许带下划线的工作区 ID，且测试只断言通用 URL。该规则在本次没有修改；清单专用浏览器流程独立通过。此限制保留，不为本次任务扩大修改图表导航。

## 候选现场及复核

实际主机：Ubuntu 本机 Docker。project/task：`mw-catalog-20261109`。地址：<https://localhost:19653>。独立数据库、volume、网络、凭据及端口，保留 `mw-dev`。私有配置不入库。

API/data-worker 镜像：`sha256:e13515044d542497dcc7d5756e217364fd0ba7fc57e31f004ecf980b2b6d1eff`。

Web 镜像：`sha256:6d6ab7a5d2fe97a2a03e85f0ff91b9b54c58674f160ce97ed5f71ab6d37238c0`。

镜像由 `mw-docker build` 构建并带任务/用途标签。API、data-worker 实际引用固定镜像 ID。data-worker 的 Compose healthcheck 仅检查数据库连通，不能代替业务 loop 健康证据；六源维护实际完成是本次业务验证依据。

```bash
cd /home/quant/repos/market-watch-provider-catalog
docker compose -p mw-catalog-20261109 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-catalog-20261109/acceptance-compose.json \
  up -d --no-build --pull never api data-worker web tls

# 停止时保留数据库与 volume
docker compose -p mw-catalog-20261109 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-catalog-20261109/acceptance-compose.json stop

PYTHONPATH=backend .venv/bin/python -m pytest \
  backend/tests/test_provider_directory.py backend/tests/test_platform_catalog.py \
  backend/tests/test_history_catalog.py backend/tests/test_provider_akshare.py \
  backend/tests/test_provider_yahoo.py backend/tests/test_provider_dukascopy.py \
  backend/tests/test_history_creation_check.py backend/tests/test_market_data.py \
  backend/tests/test_runtime_profiles.py backend/tests/test_series_access.py \
  backend/tests/test_series_search_mcp.py backend/tests/test_series_search_pagination.py -q --tb=short

npm --prefix web run build
npm --prefix web run test:single-frontend -- --unit
git diff --check
```

PostgreSQL 兼容回归使用 `TEST_POSTGRES_URL` 指向本任务独立数据库，凭据由私有文件注入，勿在命令输出或仓库中展开。主要用例为 `test_market_datasets_postgres.py`、`test_history_creation_check_postgres.py` 和 `test_history_modes_postgres.py`。浏览器测试依赖已安装 Chromium；私有 CA/登录信息通过 `MW_ACCEPTANCE_CREDENTIALS_FILE` 注入。

性能、迁移、真实行情和浏览器原始日志保留在 Ubuntu `/tmp/mw-catalog-*.log`；结构化脱敏证据随本目录保存。候选数据库、迁移兼容数据库及镜像继续保留，未执行永久删除。
