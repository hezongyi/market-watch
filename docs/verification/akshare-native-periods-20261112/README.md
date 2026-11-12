# 原生周期接入验收记录

状态：本期新增能力的业务实现、真实 API/UI、兼容性、独立审查和 5 分钟空闲观察已通过。旧新浪港股基线异常单独记录。未合并，未打 tag，未发布生产。

后续更新：本记录对应 `833d1ccf` 的原生周期验收时点。用户随后授权修复旧新浪港股异常阻断问题；该问题已在同一 PR 内修复并更新开发实例，见[后续修复及验收](../sina-hk-quality-20261112/README.md)。以下原始失败及基线对照保留为历史证据。

## 范围与基线

在 `v2.0.8`（`e9b9a78722961c5f8b58895a187410349def6c94`）上新增新浪、腾讯沪深股票八周期，以及腾讯港股日周月的原生不复权平台入口。各周期直接读取供应商 OHLC，不聚合、不转换复权价格。旧入口身份、缓存规则和托管能力保持原义。实施方案见[任务书](../../plans/akshare-native-periods-20261112.md)，交付为 [PR #135](https://github.com/hezongyi/market-watch/pull/135)。

分类 F1：新增可保存平台身份及独立缓存规则；有异常记录的新快照使用可选审计封装。无 schema 迁移、旧持久身份改写或全局价格约束放宽。旧裸数组仍可读取且不改写。最小检查包括相关回归、持久兼容、独立 Standards/Spec review、真实 PG 并发、真实 API/UI 和空闲观察。

## 实际运行环境与部署

用户后续明确要求“在开发实例上验收”，覆盖原方案另建隔离 preview 的要求。本轮实际使用 **Ubuntu quant-server** 上既有 Compose project **mw-dev**，地址 **https://192.168.7.232:18443/**。不是独立 preview，不是 SSH 转发或 Unraid 实例。

部署源码为 `833d1ccf9046128b72d7000b38ad536e8a2be89d`；后续仅补验收脚本和证据。使用 `mw-docker build`、`market-watch-ubuntu` builder，task=`mw-akshare-native-20261112`、project=`mw-dev`、purpose=`development`：

```bash
mw-docker build --repo . --context . --file Dockerfile --component api \
  --tag market-watch-api:dev-akshare-native-20261112 \
  --task mw-akshare-native-20261112 --project mw-dev --purpose development --retain-days 90
mw-docker build --repo . --context . --file web/Dockerfile --component web \
  --tag market-watch-web:dev-akshare-native-20261112 \
  --task mw-akshare-native-20261112 --project mw-dev --purpose development --retain-days 90
```

实际执行显式使用上述工作树的绝对 repo/context/file。第一次 Web 调用遗漏根 context 而失败，修正后构建成功；没有使用失败构建替换服务。

| 镜像 | 实际固定 ID |
|---|---|
| API 与三个运行组 | `sha256:92151cd5bbad2eb379df5edcd378ec037b18522641b893d0fe6689b6974f41c3` |
| Web | `sha256:fbc2c2d223d7fcaac4bc78e3e33a5cb2dcf1008f2a728b5e45da85d97cb8d4b6` |

只重建 API、market-runtime、data-worker、notification-worker、Web，PG/TLS/ntfy 保持现有配置。保留原有供源 enable、私有代理、FXCM 依赖和健康探针设置；没有新增服务或数据库迁移。运行中 12 个修改的后端模块逐文件 SHA256 与候选相同：[源码证据](running-source.json)。[部署清单](deployment.json)记录固定镜像和备份信息。

原镜像、配置、launcher 和约 1.56 GB 的 `pg_dump -Fc` 备份保留于本机私有 `~/.local/share/market-watch-dev/updates/akshare-native-20261112/`；备份目录可被 `pg_restore --list` 读取。本轮未声称执行全库恢复。开发库既有约 3.38 GB，未重置或清空；其他任务实例保持原状。

已更新持久 `mw-dev` launcher，使用该私有目录的固定 `run.json`：

```bash
mw-dev status
mw-dev up
mw-dev restart api market-runtime data-worker notification-worker
mw-dev stop
```

`stop` 会停止整个开发实例并保留数据，**本轮没有停止验收后的开发实例**。应用重建的实际命令：

```bash
docker compose -p mw-dev \
  -f ~/.local/share/market-watch-dev/updates/akshare-native-20261112/run.json \
  up -d --no-build --no-deps --wait --wait-timeout 180 \
  api market-runtime data-worker notification-worker web
```

## 验收矩阵

| 计划验收项 | 实际证据与结论 |
|---|---|
| 1. 38 个真实组合 | [适配器](live-adapter.json)和[真实应用及浏览器](application-browser.json)均 38/38；沪深两样本各来源八周期，港股两样本腾讯日周月 |
| 2. OHLC、时间、单位 | [57 次 count / 3 组价量对照](live-semantics.json)通过；分钟收盘标签转 UTC、稳定周月键、当前周月未确认均有回归；浏览器记录实际交给图表的 OHLCV 首末值 |
| 3. 价格及旧身份兼容 | raw/qfq 身份隔离；旧裸数组无改写；[PG 41 passed](postgres-tests.txt)；[5 个原布局内容不变](layout-compatibility.json)；[新入口自选刷新恢复](watchlist-browser.json)通过，测试新建列表已移除，原列表保留 |
| 4. 目录行为 | SQLite 和实际 PG 均覆盖变体、搜索分页计数、物理描述关联、托管排除；[真实 API 单行分页](catalog-paging-api.json)与整页结果一致，三个查询分别 4/4/6 个不同入口；真实 UI 明示不复权、准确周期且没有添加托管入口 |
| 5. 图表行为 | 3 类代表来源共 19 次周期切换、3 次保存刷新恢复通过，实际 K 线及范围存在，浏览器错误为空；六张截图见下 |
| 6. 有限窗口及恢复 | [实际 API](finite-window-api.json)：新浪 D1 1970 根、腾讯两市场各 800 根，左边界外 0 根、window_limit=true、history_boundary=false，响应约 14–24ms；超时、空数组恢复和跨一分钟边界均通过 PG/本地回归 |
| 7. 并发及空闲 | 实际 PG 同周期并发共享一次 D1 获取、短超时不取消其他调用、重复缓存命中通过；需求自然到期后连续观察 302.4 秒，[空闲证据](idle.json)：新增上游请求 0、38 个缓存更新 0、抓取子进程 0 |
| 8. 既有服务 | [六供源、运行组、MCP/SSE/ntfy 健康](services.json)通过；[空闲观测后的最终健康检查](final-health.json)仍通过；[国内期货原六周期和旧 A 股前复权](legacy-regression.json)通过；旧新浪港股个案仍有既有上游问题，详见限制 |

成交量保留实际供应商单位：新浪 A 股为股，腾讯 A 股为手（100 股），腾讯港股为股。未在服务端或浏览器聚合供应商周期。

新浪 `SZSE:000001` 的早期 W1/MN 各有一条 `open > high`，新 raw 入口保留原始 OHLCV、标签和原因至 `source_warnings`，不修补价格；平台详情有质量说明。真实 API 中可读取相同审计信息，没有缩短默认历史来绕过异常。

## 空闲观测

关闭验收浏览器并等待现有 10 分钟需求自然到期后，连续观察 302.4 秒。所有采样均无新原生行情需求、无 AKShare 抓取子进程；AKShare 请求时间未改变，38 个新来源的抓取时间也未改变。未手动清理或提前过期需求。复现命令：

```bash
/home/quant/repos/market-watch/.venv/bin/python \
  docs/verification/akshare-native-periods-20261112/observe_idle.py /private/path/idle.json 300
```

| 服务 | 单核 CPU 平均占用 |
|---|---:|
| API | 6.5240% |
| market-runtime | 2.6100% |
| data-worker | 2.5404% |
| PostgreSQL | 1.8036% |
| ntfy | 0.8506% |
| notification-worker | 0.4615% |
| Web | 0.0013% |
| TLS | 0.0015% |

合计约单核 14.79%，折合四核总算力 3.70%。**此测量包含观测脚本在 API 容器内反复启动 Python/SQL 查询的开销**，以及既有组合/通知等负载；不能据此认定纯净无人使用状态达到该数值，也不能把它归于新行情功能。可以确认的是本功能没有在需求过期后继续抓取或刷新快照；本轮没有测出可归因的 CPU 增量。

## 本地检查与独立审查

- 相关后端回归 373 passed；随后补旧持久格式测试，原生模块及共享缓存组 28 passed（两组有重叠，不能相加）。
- 实际 PostgreSQL 14.24 的本任务测试数据库 `mw_akshare_acceptance_20261112` 中运行 41 项全部通过，逐测试独立 schema；自动化测试没有连接开发应用 `dev` 数据库写测试数据。
- Web 公共单测入口、TypeScript/Vite、含许可图表组件的完整 Web 构建通过；许可目录被忽略，未提交。
- 修改的 backend 文件通过 Ruff，浏览器脚本通过 node 语法检查，diff 检查通过。
- [Standards / Spec 独立审查](review.md)：Standards 无必修问题；Spec 发现有限窗口证据过期和空快照缓存两项代码问题，均已修复并复核。

本地复现（在实现工作树）：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_akshare_native.py backend/tests/test_provider_akshare.py \
  backend/tests/test_platform_catalog.py backend/tests/test_provider_directory.py \
  backend/tests/test_market_presentation.py backend/tests/test_market_resources.py \
  backend/tests/test_market_contracts.py backend/tests/test_history_mode_creation.py \
  backend/tests/test_history_modes.py backend/tests/test_native_history_archive.py \
  backend/tests/test_native_history_loads.py backend/tests/test_history_modes_migration.py \
  backend/tests/test_provider_cache.py backend/tests/test_provider_chart.py
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_akshare_native.py backend/tests/test_source_history_store.py
# TEST_POSTGRES_URL 由私有环境注入，只指向本任务测试数据库。
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_akshare_native_postgres.py backend/tests/test_provider_postgres.py \
  backend/tests/test_native_history_loads_postgres.py
npm --prefix web run test:single-frontend -- --unit
npm --prefix web run build
node --check web/tests/akshare-native-periods.browser.cjs
node --check web/tests/akshare-native-watchlist.browser.cjs
git diff --check
```

## 浏览器契约与截图

两份真实浏览器脚本使用 `MW_BASE_URL`、`MW_OUTPUT`、`MW_ACCEPTANCE_CREDENTIALS_FILE`。私有 JSON 为 `{login_password, ca_file, tls_cert_file?}`；后者为可选 leaf 证书路径，用于浏览器固定 SPKI 信任。通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定本机浏览器。自选脚本还需 `MW_WORKSPACE_ID`，本轮指向本任务新建的验收布局。

周期脚本登录实际 API，从真实目录打开来源，读取元数据和价格说明；只观察传入图表的真实数据回调，不拦截 HTTP、不修改 OHLC，也不生成合成响应。切换后必须 dataReady 且可见范围有效，通过应用现有 save adapter 保存，再刷新验证 ticker 和周期。自选脚本等待业务初始化完成，验证三类新 ticker 保存并刷新恢复，然后移除自己创建的测试列表、恢复原活动列表；不删除既有用户列表。

- [新浪 A 股目录](SINA-NATIVE-SZSE-000001-directory.png) / [月线图表](SINA-NATIVE-SZSE-000001-chart.png)
- [腾讯 A 股目录](TENCENT-NATIVE-SZSE-000001-directory.png) / [月线图表](TENCENT-NATIVE-SZSE-000001-chart.png)
- [腾讯港股目录](TENCENT-NATIVE-HKEX-02318-directory.png) / [月线图表](TENCENT-NATIVE-HKEX-02318-chart.png)

截图裁去无关区域，未修改行情。完整截图和失败诊断留在本机私有证据目录。

## 已知限制与基线问题

- 有限快照：新浪默认 1970、腾讯默认 800 条，均已实际测试；不承诺无限分钟历史或未经验证的日期续取。新接口 stream=false，沿用现有按需刷新。
- 旧新浪港股 `HKEX:00700` 前复权 D1 在本轮返回无效 OHLC。使用 v2.0.8 原 `provider_akshare.py` 在同实例对照得到相同 `Invalid OHLC extremes`：[基线对照](sina-hk-baseline-comparison.json)。因此结论是未新增回归，不能声称该旧个案已经可用；本期按方案保留旧价格语义，未扩大修改。
- 初次六供源 smoke 中 Binance 一次 503，之后单独读取及整组六供源复验通过。保留供应商瞬时不可用的实际边界。
- 额外验收尝试调用图表 exportData 时，现有许可包缺少一个导出功能的懒加载 chunk；最终改为观察真实数据回调并验证实际绘图，全部周期操作未调用该额外功能。没有修改或补造私有库资源，不能声称该导出接口已验证。
- 本轮用户授权使用既有开发实例，CPU 包含原有后台负载及观测脚本每 15 秒启动 Python/SQL 查询的开销；这是带采样负载的实测，不能当作纯净空闲基准。本轮未做更新前同窗对照，不能据此推断本功能新增的 CPU 百分比；是否持续抓取以请求时间、38 个缓存快照及抓取进程记录判断。

边界：仅更新已授权开发实例及 PR；不合并 main、不打正式 tag、不发布或改动 Unraid，不持续轮询 CI。
