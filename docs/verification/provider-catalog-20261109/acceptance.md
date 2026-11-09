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
- 应用提交 `6867d6e574d1eb3a6b2a717848984907b865b02c` 的最终后端 CI 实际全量 **3505 passed、3 skipped**，耗时 1563.89 秒；结构/运维检查 110 passed、88 subtests，附加 PostgreSQL 检查 1 passed、8 passed。Web、Compose 和分类 job 全部 success。该 [run 42667285132](https://github.com/hezongyi/market-watch/actions/runs/42667285132) 在生成 required 汇总矩阵时遇到 GitHub `Internal server error`；轻量重跑再次出现内部错误，后续整轮重试的分类状态为 `abandoned`。因此实际测试通过与工作流总状态分别记录，不宣称这条 run 全绿。本次只补充验收记录，重新触发独立 CI，结果以 PR 最终检查为准。
- 全站 `single-frontend.browser.cjs` 在测试工作区保存断言失败。已确认测试请求 `D1_BTCUSDT`，实际登录回跳到 `D1_EURUSD`：基线 `safeNext` 不允许带下划线的工作区 ID，且测试只断言通用 URL。该规则在本次没有修改；清单专用浏览器流程独立通过。此限制保留，不为本次任务扩大修改图表导航。

## 候选现场及复核

实际主机：Ubuntu 本机 Docker。project/task：`mw-catalog-20261109`。地址：<https://localhost:19653>。独立数据库、volume、网络、凭据及端口，保留 `mw-dev`。私有配置不入库。

API/data-worker 镜像：`sha256:82cad17f395cc62ed230e11b74e0363b6b8bbc3ce0058d1ab5b5bd7d679421d9`。

Web 镜像：`sha256:fcd3eb79273aaa2560ba5279bc649326eadf7cec421d373e4410592ca7ab62cd`。

镜像由 `mw-docker build` 构建并带任务/用途标签。API、data-worker 实际引用固定镜像 ID。data-worker 的 Compose healthcheck 仅检查数据库连通，不能代替业务 loop 健康证据；六源维护实际完成是本次业务验证依据。 最终实查 `catalog_runtime` 为 idle，心跳间隔 60 秒、实际期限 90 秒，观测年龄 25.5 秒；六源样本固定版本仍全部为 published。末次 AKShare 港股及主力连续手动刷新成功，分别为 2,800 和 82 条。候选镜像中 205 个后端 Python 文件逐一哈希与应用提交 `6867d6e5` 一致。

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

## 用户确认的分页提速补充

商品代码搜索与自选表添加商品原本已每页请求50条；本次进一步使用 `include_total=false`，平台目录底层多查1条身份判断下一页，只为本页组装详情，省掉精确总数查询。全部类型搜索内部也省去平台分支计数。默认API及平台行情管理列表仍保留准确total，兼容既有客户端；本项不改变全目录搜索范围、去重规则及准确代码排序，不将旧4.7万行平台列表569ms视为本次搜索弹窗测量。

本次为F0兼容API/前端调用优化，无schema变更。相关回归88 passed（含101条按50/50/1翻页无重复丢失、无COUNT查询、SDK备用目录混合排序），Ruff、前端完整构建及single-frontend unit通过。Ubuntu沿用同一隔离候选，API/data-worker与Web均更新固定镜像；205个后端Python文件与当前应用工作树逐一哈希一致。

在当前22,232条真实目录下，交替测量同一 `/series/page?kind=provider&page_size=50` 的准确计数和免计数两种模式，各20次。空关键词HTTP p95从522.00ms降到316.78ms，中位数321.96→261.15ms；BTCUSDT p95为38.47→29.22ms，中位数28.84→22.46ms。返回品种及顺序逐次相同，翻页标记相同。宿主进程直接查询对照空关键词中位数270.13→187.98ms；该项不是容器HTTP指标，准确代码的直接查询未观察到稳定收益。共享主机上的这组短测不作为任意负载的保证。结构化数据见 `search-page-evidence.json`。

后续可优化空查询去重排序、混合分支少取无用候选和返回字段；本次未同时改动这些规则。最新代码全量结果以PR最终CI为准，不把此前应用提交的3505 passed直接计为本次分页补丁全量通过。

浏览器实际检查商品代码搜索和自选表添加商品：两者均发送 `include_total=false`、`page_size=50`，真实Binance连续两页共100个身份无重复，浏览器无pageerror。先选择有效BTCUSDT以消除候选初始无效工作区的图表提示遮挡；本次未修改基线登录回跳规则。

## 商品目录兼容入口收敛补充

用户授权迁移旧调用后，已删除旧 OANDA 独立刷新、旧搜索全量合并/重排和图表历史 worker 的目录刷新调度；兼容接口仅适配统一查询/刷新核心，前端剩余旧目录调用已迁移。F0 补丁无 schema 变更，286 项后端回归、前端 build/unit、Ruff、真实 OANDA 双入口刷新和浏览器 R1 均通过。最新固定镜像、调用边界与证据见 [unified-core-acceptance.md](unified-core-acceptance.md)。全量 CI 以本补丁提交为准。
