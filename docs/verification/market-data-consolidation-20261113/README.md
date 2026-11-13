# 行情入口整合与性能优化：实施及验收记录

日期：2026-11-13。基线 `eaacf47ef86b082f7a80b81841366dc1aa8908e4`（v2.0.9）。实施分支 `feat/market-data-consolidation-20261113`，工作树 `/home/quant/repos/market-watch-market-review-20261113`。

**整体尚未验收完成。** 代码、定向 SQLite 合同、实际 React 组件浏览器功能检查、公开前端构建、固定输入回放已完成；独立 PG 并发和完整 Ubuntu 实例受磁盘限制，不能计为通过。

## 已实现范围

- 保留“自建行情”，将“平台行情”改为“原生行情”；组合从并列导航归入自建详情的“实时接续”。
- 显式写入才创建/开启接续，读取不创建需求；复用既有实时开关、映射、修订及 MWH/MWC 身份。历史维护与接续独立。
- 多映射显式默认选择；旧默认失效不悄悄改选。所有旧接续对象仍有访问入口；固定历史图不随开关改身份。
- 列表摘要批量读取当前默认配置的准备/健康状态；非默认错误隔离。跨日界修订使用实际生效映射和历史来源开关，即使其数据集不在当前页。
- 旧组合/候选列表行地址按当前筛选排名恢复所属自建行，支持跨页及完整缓存重入；复用摘要请求定位，不逐行读取详情。
- 自建列表追加新页；已加载 ID 分批刷新；成员/排序变化时重建；搜索取消旧请求；隐藏暂停、恢复立即读；缓存按工作区和筛选隔离。原生目录恢复缓存前缀后校验目录修订，必要时失效重取。
- 原生历史来源页仅解码一次，私有有界暂存，按月合并；保留乱序/重复的先后覆盖规则，未变化块引用继承，发布仍校验所有引用。
- 聚合 worker 在九次领取或两秒内共享同身份/修订/输入版本/权限的元数据与确认分钟。各周期领取/提交/水位/失败仍独立；新输入、冻结和过期租约继续受原协议限制。
- 展示快照 SQL 清理，使用 BIGINT 毫秒到期值，有效凭证快速命中，快照容量锁与观察分钟容量锁分开；TTL 和硬容量不变。

## 本地验证证据

解释器：`/home/quant/repos/market-watch/.venv/bin/python`，以本工作树 `PYTHONPATH=backend` 加载代码；前端依赖为本工作树 `web/node_modules`，未链接其他 worktree。

- 后端定向回归 **354 项通过**，实际结果见 [backend.xml](backend.xml)。覆盖列表/完整旧接口、映射/开关、图表身份、旧发布版本、原生历史/回收、多周期/唤醒、快照、报价与告警。
- `node web/tests/market-data-consolidation.browser.cjs`：通过。使用真实 React 组件和确定性 HTTP fixture，不联系行情供应商。覆盖十页十请求、按 ID 批量刷新、成员变化、缓存/滚动恢复、可见性、过时搜索取消、原生目录失效、多映射选择、失败开启、旧配置入口、固定/接续图表选择。
- `node web/tests/data-center-location.cjs`、`node web/tests/dataset-navigation.cjs`：通过；包括受白名单约束的详情返回地址和工作区位置隔离。
- `npm --prefix web run build:ui`：通过。仅证明公开业务前端构建；不替代私有图表资源的完整构建和实例交互。
- 本任务改动的全部 Python 文件 Ruff、`git diff --check`：通过。额外全 backend 扫描有 46 项既存问题，均在未改动文件中；不将全库扫描表述为通过。

后端命令按方案第 5 节的既有测试，加上 `test_managed_continuation.py`、`test_dataset_summaries.py`、`test_native_history_merge_cost.py`、`test_composite_aggregate_inputs.py`、`test_platform_catalog.py`、`test_provider_directory.py`、`test_composite_quotes.py`、`test_composite_alerts.py`、`test_composite_matching.py`、`test_live_session.py`，输出 `--junitxml=docs/verification/market-data-consolidation-20261113/backend.xml`。不把未运行的 PG 用例或 skip 算入成功数。

## 性能回放

[fixed-replay.json](fixed-replay.json) 来自：

```bash
PYTHONPATH=backend:backend/tests /home/quant/repos/market-watch/.venv/bin/python \
  scripts/measure_market_data_consolidation.py
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q -s \
  backend/tests/test_dataset_summaries.py \
  backend/tests/test_composite_aggregate_inputs.py
```

测量脚本从固定基线提交读取原始 `_merge`/`publish` 函数，在同一个独立内存 SQLite、相同输入下交替回放三次取中位数，记录 CPU 秒/墙钟/峰值 Python 内存/SQL。历史结果、边界和 changed_from 逐项相同；快照容量一致。CPU 与内存测量包含 tracemalloc 开销。

- 历史：4018 个来源日线、跨 133 个月；来源页解码从随月份重复变为一次，CPU 秒、内存、SQL 的实际值以 JSON 为准。
- 快照：已有 2048 个、各 4096 字节内容，新增一次。SQL 次数不变，但消除了将全体 JSON 取回 Python 的成本。SQLite 不提供 PG 锁等待证据。
- 三条已核实身份（EUR/USD、USD/CAD、XAU/USD）× 九周期、确认输入版本 1：结果完全一致；聚合构建 SQL **354 → 132**。首次独立运行 CPU 中位数 **0.4703 → 0.4205 秒**，只代表该固定输入处理路径。
- 无接续配置的 25 行列表：完整旧接口 **177 SQL**，摘要 **8 SQL**；有接续配置的一条/三条摘要均 **12 SQL**。完整旧接口保留。

上述是固定输入的局部收益。尚无本候选真实实例、无人浏览三条接续运行或多图状态下的 CPU/P95/吞吐数据，不能据此报告整体空闲 CPU 降幅。

## 独立审查

按 `AGENTS.md` 的 F1 要求使用 `code-review` 技能，分别进行了 Standards / Spec 独立审查。

已修复并复核：PG 毫秒时间戳 int4 溢出、详情返回地址被丢弃、列表仅显示开启意图而缺少当前配置运行状态、跨数据集日界修订的映射不在当前分页导致假异常。补充审查发现的旧地址跨页定位和完整缓存较大旧页码不刷新已修复，并增加真实组件回归。Standards / Spec 最后复核均无新增发现。独立审查不替代待运行的 PG/实例验收。

## Ubuntu 实例与资源状态

实际宿主机：`quant-server`，Ubuntu。本任务 **尚未启动 Docker 实例，没有候选验收 URL**。未替换共享 `mw-dev`，未合并或打正式 tag，未接触 Unraid。

只读盘点：根盘约 142 GiB、剩余约 13 GiB；可用内存约 9.8 GiB。当前项目为 `mw-dev`、`mw-android-personal-v205`、`mw-cpu-20261111`、`mw-health-pg-20261111`。按照 `deploy/ubuntu/README.md`，轻量启动需 ≥23 GiB，带 worker 需 ≥26 GiB。缓存可回收量不足以补齐差额；未清理归属不明或其他任务资源，也未绕过门槛启动另一套配置。

共享开发实例只读库存：130 个数据集、3 条映射、3 个组合、3 个修订。API 镜像 `sha256:54959714fa8691256ccb93606615e96d85f1198cb7afb9379ab781a490763978`，web 镜像 `sha256:fbc2c2d223d7fcaac4bc78e3e33a5cb2dcf1008f2a728b5e45da85d97cb8d4b6`，容器 running；未找到可证明源码提交的 OCI 标签，不能将代码基线当作该运行版本。库存查询在显式 READ ONLY 事务内执行，未修改业务库。

## 资源满足后的继续入口

task/project 均使用 `mw-market-consolidation-20261113`；预选端口 18543，启动前重新检查，独立网络/volume/数据库/凭据。按构建入口使用 `mw-docker build`，包含完整 web/许可图表库；不借用共享实例或其他任务 PG。

运行带行情/聚合 worker 的独立实例，真实数据验收须显式启用本任务来源；默认禁流的 API-only preview 不能证明接续与告警运行正常。具体私有配置、镜像摘要、实际 URL、启动/停止命令待建立实例后补充，不能提前写为已执行。

新 PG 合同：

```bash
# TEST_POSTGRES_URL 只由任务私有配置注入，禁止使用 mw-dev 或生产业务库。
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_realtime_switch_postgres.py \
  backend/tests/test_series_access_postgres.py \
  backend/tests/test_composite_aggregates_postgres.py \
  backend/tests/test_data_center_completion_postgres.py \
  backend/tests/test_market_data_consolidation_postgres.py \
  backend/tests/test_provider_display_snapshots_postgres.py
```

需要完成：PG 并发容量/独立锁/快速命中、暖缓存下租约和冻结、同批新输入、迁移与旧格式兼容；完整界面、旧工作区和 API/MCP；关闭/重开不补发关闭期间告警；无人浏览三条接续/活跃告警/单图/多图/历史维护分别采样。性能采样与构建/测试错峰，同窗记录服务 CPU 秒、报价/确认/产物数、单核和四核归一化占用、就绪延迟及内存。

这组剩余检查通过前，任务保持未完成。磁盘需要扩容/释放至门槛，或由用户明确可清理的已结束任务资源；不会据此自行停止其他项目或删除永久数据。
