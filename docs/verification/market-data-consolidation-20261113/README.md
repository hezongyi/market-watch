# 行情入口整合与性能优化：实施及开发实例验收

日期：2026-11-13。代码基线 `eaacf47ef86b082f7a80b81841366dc1aa8908e4`（v2.0.9）；分支 `feat/market-data-consolidation-20261113`，工作树 `/home/quant/repos/market-watch-market-review-20261113`。Draft [PR #136](https://github.com/hezongyi/market-watch/pull/136)。

**已直接更新既有开发实例并完成本轮验收。** 用户随后明确要求“直接受用开发实例进行验收”，覆盖仓库默认每任务新建独立实例要求。接口、图表、来源和后台健康检查通过；发现的旧自建列表漏项已修复。三条旧接续的产品映射不能按当前规则成为新的默认配置，界面会提示异常/需要核对；原配置、旧图表身份及实时采集仍保留并正常运行。此限制不能表述为默认接续开启或普通打开已经通过。

整体按 **F1**：涉及接续生命周期、历史发布和聚合 worker；未变更 schema、持久格式或旧身份。开发实例验收阶段未追踪 CI；后续按用户要求进行的 CI 修复见末节。不合并、正式打 tag 或发布生产。

## 实现范围

- “平台行情”改为“原生行情”；保留“自建行情”，组合改为详情中的可选“实时接续”。
- 历史维护与接续独立；显式写入才创建/开启，GET 不创建采集需求；默认配置显式选择，保留旧映射、修订及 MWH/MWC 身份。
- 自建列表摘要批量读取，追加分页、批量刷新、隐藏暂停、搜索取消；旧地址按排名定位原行；原生目录返回恢复后校验目录修订。
- 原生历史来源页解码一次，按月合并，继承未变化块引用，保留乱序/重复覆盖和发布校验。
- 九周期在有界批次共享同修订/输入版本的准备，各周期租约、提交、水位和失败独立。
- 展示快照 SQL 清理、BIGINT 到期值、有效命中快速路径及独立容量锁，TTL/容量不变。
- 实例验收发现三条旧映射来源数据集没有维护计划，原摘要因此漏列。新增回归并修复为包含已有接续的来源数据集；不创建维护计划，不扩入纯供应商/目标目录数据集；旧完整 API 保持原合同。

## 部署及回退

实际运行主机 **quant-server（Ubuntu 本机 Docker）**，Compose project `mw-dev`，地址 **https://192.168.7.232:18443**。没有访问 Unraid。

| 服务 | 固定镜像 | 构建提交 |
|---|---|---|
| API、market-runtime、data-worker、notification-worker | `sha256:ebb2178e2faa36a8e08cbf263b55a96d3c60b455e8397ad130cb8509d52e576a` | `b264d63b` |
| 完整 web（含许可图表资源） | `sha256:dddf3fdd9c115d51c922b0fc9607a10d270ee362d4fce7f4b0a6c67ee40ed0a4` | `5f025b2d`，后续修复仅后端 |

通过 `mw-docker build` 构建并按镜像 ID 部署。原 PG14.24、TLS、ntfy 容器 ID 保持不变；所有后端有效 `ALERTS_*`、PG/ntfy 配置逐项比对一致。部署证据见 [dev-deployment.json](dev-deployment.json)。API/PG/ntfy Docker health 均 healthy，其余服务容器 running，worker 业务健康另见 API 报告。

私有状态目录 `/home/quant/.local/share/market-watch-dev/updates/market-consolidation-20261113/` 保留原配置、inspect、实际镜像回退清单及部署前 `pg_dump -Fc`（1,568,135,828 字节，`pg_restore --list` 校验通过，603 项目录）。本轮未做全库恢复演练，不将目录可读等同于恢复成功。无 schema 迁移，未删除原数据库或 volume。凭据、env、完整原业务文档及许可库未提交。

```bash
mw-dev status
mw-dev stop api market-runtime data-worker notification-worker web
mw-dev up api market-runtime data-worker notification-worker web
```

固定部署及原镜像回退入口分别为私有目录 `run.json` / `rollback.json`：

```bash
docker compose -p mw-dev \
  -f /home/quant/.local/share/market-watch-dev/updates/market-consolidation-20261113/run.json \
  up -d --no-build --no-deps --wait --wait-timeout 180 \
  api market-runtime data-worker notification-worker web
```

回退时将上述文件替换为 `rollback.json`；镜像回退不还原或覆盖业务数据库。JSON 中已对 Compose 环境变量的字面 `$` 转义，不重复转义。

## 检查结果

解释器 `/home/quant/repos/market-watch/.venv/bin/python`，使用本工作树 `PYTHONPATH=backend`；前端依赖为本工作树 `web/node_modules`。

- 后端定向回归 **355 passed，0 skip**：[backend.xml](backend.xml)。包括列表、映射/双开关、图表身份、历史发布与回收、多周期/唤醒、快照、报价及告警。
- PostgreSQL 六组合同 **78 passed，0 skip**：[postgres.xml](postgres.xml)。最终漏项修复后重新执行完整整合合同 **17 passed，0 skip**：[postgres-final-contracts.xml](postgres-final-contracts.xml)，包含新增无维护计划旧接续回归。这 17 项与前述 78 项有重叠，不能相加声称 95 项独立用例。
- PG 测试复用获授权的本机 PG 服务，但使用独立数据库 `mw_consolidation_acceptance_20261113` 和逐用例 schema；测试 URL 不指向业务 `dev`。覆盖独立锁、并发容量/快速命中、租约/冻结/新输入和旧格式兼容。
- `node web/tests/market-data-consolidation.browser.cjs`：真实 React 组件 + 确定性 HTTP fixture 通过，覆盖十页十请求、批量刷新、缓存/位置、可见性、旧地址、多默认配置、失败开启和固定/接续视图区别。
- `node web/tests/data-center-location.cjs`、`node web/tests/dataset-navigation.cjs` 通过；完整 Docker 后端及含许可图表资源的 web 构建通过。
- 本任务修改的 Python Ruff、`git diff --check` 通过。额外全 backend 扫描的 46 项未改动文件既存问题未计为通过。
- F1 Standards/Spec 独立审查均已复核，无剩余发现。已修复 PG int4 毫秒溢出、返回地址丢失、默认状态误报、跨数据集日界映射、旧路由跨页恢复和真实实例旧数据集漏列。

PG 检查入口：

```bash
# TEST_POSTGRES_URL / ALERTS_DATABASE_URL 由私有配置指向独立测试 DB。
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_realtime_switch_postgres.py \
  backend/tests/test_series_access_postgres.py \
  backend/tests/test_composite_aggregates_postgres.py \
  backend/tests/test_data_center_completion_postgres.py \
  backend/tests/test_market_data_consolidation_postgres.py \
  backend/tests/test_provider_display_snapshots_postgres.py
```

## 真实界面、API 与 MCP

```bash
node web/tests/market-data-development.browser.cjs
python3 scripts/verify_market_data_development.py \
  --output docs/verification/market-data-consolidation-20261113/dev-api.json
```

[dev-browser.json](dev-browser.json) 记录未拦截请求、未替换资源的真实 HTTPS 浏览器验收：两类入口、三条旧来源数据集、详情复核提示、原 MWC 打开、独立固定 MWH 打开、旧组合列表兼容、原生目录和返回列表均通过，无 pageerror。使用临时工作区，结束按最新 revision 删除；图表宿主自动注册的 alerts 侧栏仅在核实唯一差异后按 revision 恢复，未覆盖整份偏好。截图：[自建列表](dev-managed.png)、[接续与旧引用](dev-continuation.png)、[原生目录](dev-native.png)。

[dev-api.json](dev-api.json) 记录：

- `/readyz`、登录通过，原 **7 个工作区、38 项偏好内容、0 条活跃/保存告警**保持一致。图表宿主可对相同偏好内容重新保存，使 revision 前进；元数据变化单独记录，不宣称字节完全相同。
- 3 个旧组合 ID、active revision、固定 history version 保持一致。三条接续 × 九周期 + 三个固定 H1 共 **30 组**读取非空且 OHLC 合法。
- OANDA、Binance、Dukascopy、Yahoo、AKShare、FXCM 共 **6 个来源**实际图表读取各 40 根（OANDA/Binance/Dukascopy/FXCM H1，Yahoo/AKShare D1，以 JSON 为准）；不据此声称每个来源所有周期都逐一实测。
- MCP 通过真实 TLS 传输读取三条旧组合和对应固定历史，共 **6 次**，均各返回 40 根；临时只读凭据 finally 撤销。
- 三类 worker 角色均无 missing/stale/degraded/failed 或 error。running/idle 是有效运行状态；无活跃告警时不声称实时告警送达已验证。关闭/重开的不补发语义由定向/PG 合同验证，未切换用户现有接续或创建真实通知规则。

### 旧映射限制

开发实例现有三条接续：EURUSD、GBPUSD、XAUUSD。它们保存的映射均属于当前账户，但不满足**当前新建/默认配置选择**的产品合同：EURUSD 保存的 cfd 标签与当前 spot_fx 规则不符，XAUUSD 的历史/实时产品标签与当前 cfd→metal_quote 规则不符，GBPUSD 不在当前新配置允许品种中。

保留原配置和身份，不伪造新的产品依据，不扩大允许品种。三条旧运行端点均 receiving、实时输入持续推进，旧图表及 MCP 仍可读取。新自建列表/详情显示 attention 并保留“已有接续配置与旧引用”，从旧引用可打开原图；普通“打开图表”和关闭后重新开启需要有效默认配置，因此不能把它们计为新默认配置验收成功。这是本轮确认的既有配置兼容限制；后续若要修订依据/扩展 GBPUSD，必须保持旧映射不可变，以新配置表达，不能原位重写。

### 实例列表延迟口径

同一候选连续各 20 次请求：摘要 P50 **64.27ms** / P95 **88.40ms**，旧完整 API P50 **10.20ms** / P95 **15.65ms**。但摘要含上述三条旧来源数据集，旧完整接口按原合同不含这些无维护计划条目，工作量不等，**不能拿这组延迟证明摘要快或慢于原接口**。同输入 SQL 收益见下一节。

## 固定输入回放

[fixed-replay.json](fixed-replay.json) 来自基线/候选在同一独立内存 SQLite 的相同输入交替三次回放，中位数；开启 tracemalloc，CPU/内存包含其开销。

```bash
PYTHONPATH=backend:backend/tests /home/quant/repos/market-watch/.venv/bin/python \
  scripts/measure_market_data_consolidation.py
```

- 4018 来源日线跨 133 月，历史结果与边界相同；checkpoint 解码 **134→1**，CPU **12.76369→1.84139s**，SQL **2131→1734**。
- 2048 个、各 4096 字节快照背景下新增一次，峰值 Python 内存 **17.69507→0.02785MiB**，CPU **0.0825→0.0112s**；SQL 次数同为 4，容量不变。
- 固定三身份 × 九周期确认输入回放结果一致，聚合 SQL **354→132**；首次 CPU 中位数 **0.4703→0.4205s**，只代表该处理路径。
- 同输入 25 行完整列表 **177 SQL**，摘要 **8 SQL**；有接续的一条/三条摘要均 **12 SQL**。不把实例旧接口空集合时的耗时拿来比较。

## 开发实例空闲 CPU

部署前 90 秒和最终候选 180 秒，采样错开构建、测试与浏览器；同窗读取 workload。原始记录为 [dev-before.json](dev-before.json) / [dev-after.json](dev-after.json)，汇总比较为 [dev-cpu-comparison.json](dev-cpu-comparison.json)。指标均为整个容器的 CPU 秒，100% 代表占满一个核；四核整机占用为各服务合计再除以 4。

| 服务 | 部署前：单核 % | 候选：单核 % |
|---|---:|---:|
| market-runtime | 5.147 | 4.846 |
| postgres | 3.750 | 2.741 |
| data-worker | 2.521 | 2.657 |
| ntfy | 0.850 | 0.867 |
| notification-worker | 0.463 | 0.481 |
| api | 0.442 | 0.454 |
| web | 0.001 | 0.001 |
| tls | 0.001 | 0.002 |
| 合计 | **13.175** | **12.049** |
| 四核整机占用 | **3.294%** | **3.012%** |

候选 180 秒所有采样点均无有效浏览器客户端、无历史任务、无活跃告警。三条接续均 connected/ready、无错误；live state revision 分别增加 366/260/150，确认尾部各推进 3 分钟，三组 preparation 均 queried，27 个周期任务水位均前进且无错误。这些 revision 不是逐条网络报价数量，不能用它们计算逐报价吞吐或丢失率。无活跃告警，因此 price_alert_streams sequence 增量为 0，不表示行情未更新。

合计观测值由单核 13.175% 到 12.049%，约少 1.126 个单核百分点（相对 -8.55%）；主开销仍是 market-runtime 4.846%、PG 2.741%、data-worker 2.657%。两次是真实行情的顺序短窗，报价到达和 PG 缓存温度不同，不能将全部降幅归因于本次代码，也不能承诺持续相同降幅。当前仍未达到“总开销单核约 3%”的历史期望。

采样原始 live state 中另有 124 条非本次活跃接续的目录/旧注册占位状态；其 unavailable 不属于上述三条实际运行流的错误。不能用占位数量声称有 124 个运行服务失败。采样窗口后的 [日志级别摘要](dev-log-summary.json) 未发现 ERROR/FATAL/Traceback；该检查不代替上述数据水位和业务健康检查。

本轮真实运行没有活跃告警或历史维护任务；未进行有用户使用、多图并发及历史维护窗口的服务负载对比，不将固定输入收益泛化为这些场景的整体实测收益。不降低采集/可见刷新频率来获得 CPU 数字。


## 后续 CI 修复（按用户要求）

原提交 `0fd0b687` 的 [Web checks](https://github.com/hezongyi/market-watch/actions/runs/43361768389/job/131676784508) 在 `advanced-watchlist-metadata.cjs` 失败：运行时输出 `EURUSD · 原生`，断言仍期待 `EURUSD · 平台`。本地同一命令先复现失败，再将两个展示断言和两个报价 fixture 同步为已批准的新名称；保留价格、来源、身份、缓存重放和取消校验，未修改应用代码或放宽断言。

该补丁按 **P0**：仅测试和证据文档，无运行行为变化，不需要重新部署开发实例。原提交的 Backend checks / Compose checks 已通过。

本地按 `.github/workflows/ci.yml` 顺序执行五个 Web run 步骤中的构建与全部 **75 条测试命令**，均通过，包含原失败点后续的浏览器和 single-frontend 单元检查。复用已有锁定依赖与 Chromium，未重复安装 npm 依赖或浏览器。另行执行本 PR 的三个行情整合/导航检查，均通过；`git diff --check` 通过。详细步骤耗时见 [ci-web-fix.json](ci-web-fix.json)。本地通过不等于新提交远程 CI 已通过；推送后不持续轮询新运行。
