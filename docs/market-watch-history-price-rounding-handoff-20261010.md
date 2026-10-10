# Market Watch 历史价格精度处理交接

日期：2026-10-10
交接目的：记录已完成的历史行情价格精度处理、回归测试和 Ubuntu 验收，供后续审阅及获得授权后的生产恢复使用。

## 1. 当前状态

- 当前 worktree：`/home/quant/repos/market-watch-history-price-rounding-plan-20261010`
- 当前分支：`docs/history-price-rounding-plan-20261010`
- 基线：`origin/main`，提交 `8c65edfdee15f0281750e888711cf8ecd20de1a0`
- 本分支交付实现、回归测试、方案/交接文档和只读存储测量文件；不包含凭据或许可资源。
- 已实现代码与回归测试；完整受影响模块回归、API 镜像和 chart-only Ubuntu smoke 验收均已完成。未执行生产恢复。
- 未修改、重试、暂停或部署生产任务；本交接不构成生产操作授权。

先阅读：

1. [AGENTS.md](../AGENTS.md) 的 Ubuntu Docker、unraid 和构建/退役约束。
2. [实施方案](market-watch-history-price-rounding-plan-20261010.md)。
3. [只读存储测量](verification/history-price-rounding-storage-20261010.json)。

## 2. 已确认的业务规则

精度按每个数据集对应的 `Instrument.precision` 处理，不能全局固定为 5 位。不同品种、来源或数据集可有不同精度。

对 M1 的 `open/high/low/close` 分别处理：

- 有效小数位不超过设定精度：保持原值和原字符串，不补零、不截断、不调用舍入。
- 超过设定精度：使用 `Decimal` 和 `ROUND_HALF_UP` 四舍五入到该数据集精度。
- 末尾零不算超精度，例如精度 5 时 `1.093880` 保持不变。
- 不处理成交量、时间、完成状态或覆盖证据。
- 舍入后必须再次校验正价格、OHLC 关系和 `Numeric(24, 10)` 范围；不能用 float 或隐式 Decimal 上下文。

示例：精度 5 时 `1.093887 -> 1.09389`，`1.093880 -> 1.093880`，`1.0938849 -> 1.09388`。

不新增第二套 M1 数据或独立处理后来源页。来源页仍按真实上游内容保存和校验；业务价格在统一处理边界按数据集/版本规则从来源内容生成。不同精度的数据集共享同一来源页时，不能把一种精度的结果写回共享来源缓存。

旧已发布版本、manifest、checksum、固定引用和已保存前缀必须保持不变。旧版本缺少新规则记录时沿用旧规则。新任务在首次接受舍入数据前冻结并持久化规则版本。

## 3. 生产诊断事实（只读）

两个 Dukascopy 任务因 `price_precision_overflow` 停止，注册精度均为 5：

| 品种 | 任务 ID | 已查询至（UTC） | 已保存 M1 | 失败页超精度行数 |
| --- | --- | ---: | ---: | ---: |
| GBPUSD | `e3cbf344-d1c4-4200-bffe-5f11d8a8a569` | `2024-10-04 11:48` | 1,400,295 | 21 / 5,000 |
| EURUSD | `aa4588c3-8952-4983-b1a6-a0c63d4616c3` | `2024-10-09 23:03` | 1,404,010 | 57 / 5,000 |

生产来源页已验证：按 5 位严格校验失败，按 6 位通过；上游确实返回过类似 `1.093887` 的价格。EURUSD 有既有发布版本，GBPUSD 当前完整任务尚未发布。

只读测量的数据库总量约 3.883 GB；`market_source_blobs` 有 1,135 个 blob、压缩内容约 83.2 MB；`market_history_chunks` 1,315 个且均引用原始 blob，没有 inline payload。测量文件中的压缩样本只用于判断趋势，不代表已实施或承诺总字节不增长。

## 4. 关键代码地图与风险

- `backend/alerts/market_datasets.py`：`price_rule` 解析冻结规则，`version_price_rows` 统一生成版本业务价格；`validate_ingestion` 根据显式版本 manifest 保持 legacy 严格校验或使用冻结精度，仍拒绝非法值和无效 OHLC。
- `backend/alerts/history_versions.py`：历史导入和 `snapshot_rows` 均通过统一价格处理边界；旧任务错误字段和前端提示保留兼容读取。
- `backend/alerts/source_history_store.py:38`：`raw_chunk` 返回经过 checksum 校验的原始来源内容；不要在这里把共享原始内容改写成某个数据集的精度。
- `backend/alerts/history_artifacts.py`：周期产物通过统一接口处理原始块；父子版本价格规则不兼容时从原始块重建。
- `backend/alerts/history_derivation.py`：派生版本读取原始块，按目标数据集精度处理后写入 `Bar`，来源内容与 checksum 保持不变。
- `backend/alerts/history_maintenance.py:159`：父版本复用/增量维护直接读取原始块。
- `backend/alerts/data_center.py`：覆盖详情使用版本冻结规则处理原始块。
- `web/src/market-data/DatasetViews.tsx`：精度错误提示明确要求显式重试；版本详情区分新冻结规则与旧版本行为，创建页解释舍入条件。
- `backend/alerts/storage.py`：`HistoryVersion.manifest` 可记录精度与规则版本；`HistoryChunk` 保持引用 `SourceBlob` 的现有归属。

关键风险是只放宽 `validate_ingestion`：图表、聚合、回测、组合历史和派生仍可能读取未处理的超精度值，造成同一版本结果不一致。必须提供一个统一的版本价格读取/处理接口，并让所有下游使用它。

## 5. 推荐实现顺序

1. 新增纯函数：输入原始 OHLC 和指定精度，返回处理后的业务行；覆盖精度 2、3、5、6，输入 6/7/8 位、末尾零、半单位、进位、非法值和范围边界。
2. 定义规则版本和冻结位置；新任务 manifest 保存 `precision`、处理规则版本及必要审计信息。
3. 接入导入和 `Bar` 写入，再接入 `snapshot_rows`、周期产物、数据中心覆盖、历史派生、父版本复用和价格比较。
4. 保证同一来源页被不同精度数据集读取时互不污染；不同目标精度不能连续舍入已处理结果，必须从原始块重新处理。
5. 更新任务/版本详情和 `price_precision_overflow` 提示，说明超出设定精度会按数据集精度四舍五入。
6. 为两个既有失败任务设计安全重试：沿用原任务 ID、cursor、已保存块和读取证据；只允许匹配精度错误、未发布且无有效写入租约的任务启用冻结规则，并记录审计。

## 6. 必须通过的验证

### 单元与回归

- 精度 2/3/5/6 分别生效；同一来源页的不同数据集结果不互相覆盖。
- 未超精度和仅有末尾零的值完全不变。
- 超精度、半单位和进位使用 `ROUND_HALF_UP`；6/7/8 位输入均可处理。
- 成交量、时间、完成状态、日界和覆盖证据不被修改。
- 处理后仍拒绝非有限数、非法负值、超范围值及无效 OHLC。
- 导入、快照、周期产物、图表、回测导出、组合历史和派生对同一 M1 产生一致结果。
- 原始来源 checksum 不变；不产生第二份处理后 M1 内容块。
- 旧已发布版本和既有前缀 checksum 不变；任务重试、暂停、取消、重启和父版本继承行为正确。

### Ubuntu 隔离验收

按 `AGENTS.md` 使用独立 worktree、Compose project、网络、volume、数据库和端口；通过 `mw-docker build` 或 `mw-docker compose-build`，明确填写 task、project 和用途，使用 `market-watch-ubuntu` BuildKit。验收交付必须记录实际运行主机、访问地址、启动/停止命令和验证结果。完成后先用 `mw-docker retire --task TASK --project PROJECT` 查看精确清单，再按归属清理并验证数据库备份恢复。

### 生产恢复前置条件

只有实现、测试和 Ubuntu 验收通过后，才按后续明确授权恢复上述两个生产任务。恢复前确认新版本中 Yahoo 默认启用规则仍满足根目录生产 Compose 配置要求；生产操作只在 unraid 正式实例执行，不在 unraid 创建临时开发/验收实例。

## 7. 后续审阅入口

```bash
cd /home/quant/repos/market-watch-history-price-rounding-plan-20261010
git status --short --branch
git diff -- docs/market-watch-history-price-rounding-plan-20261010.md
rg -n "validate_ingestion|raw_chunk|snapshot_rows|price_precision_overflow" backend/alerts web/src/market-data
```

## 8. 本次实施记录（2026-10-10）

- `backend/alerts/market_datasets.py` 增加 `process_price_row/process_rows` 与规则版本 `dataset-precision-half-up-v1`：使用局部 Decimal 上下文和 `ROUND_HALF_UP`，有效位未超精度时保留原字符串，处理后重新校验正价格、OHLC 和存储范围。
- `validate_ingestion` 返回处理后的业务批次；`market.ingest` 将处理后的行写入 Bar 和聚合，来源 blob 仍保存原始行。
- `HistoryVersion` 创建时冻结 precision/rule manifest；发布、快照读取、周期产物、数据中心覆盖和历史派生统一按冻结规则读取原始 chunk。旧 manifest 缺少规则时沿用旧原始行为。
- 修复历史派生分页进度写回时覆盖 manifest 的问题，派生版本会保留冻结的 precision/rule metadata。
- 发布旧的、尚未冻结价格规则的 legacy manifest 时不自动补写新规则，避免旧版本读取行为被改写。
- 更新前端 `price_precision_overflow` 文案，说明按数据集精度四舍五入。
- 增加精度 2/3/5/6、末尾零、半单位、进位及非法值测试，并把历史版本高精度回归改为验证成功舍入。
- 增加共享 raw page 的 5/6 位精度隔离测试，以及 legacy manifest 发布兼容测试。
- 复合行情尾部读取也按目标数据集精度处理；共享 `SourceMinuteRevision` 仍保存原始价格，并增加 source/raw 与 composite/view 分离测试。
- 对历史任务保留显式安全恢复：仅旧 `price_precision_overflow` 任务在无有效 lease 时执行 `retry` 才激活并审计新规则；普通失败不会被误分类或自动启用。
- `python -m compileall` 与 `git diff --check` 已通过。使用含完整供应商依赖的 `/home/quant/repos/market-watch-data-integration/.venv`：受影响模块回归最终为 `348 passed, 149 skipped`；精度/历史/派生/共享来源/复合输入聚焦回归为 `56 passed`。完整 backend 测试和 SQLite-only 全集在 5 分钟上限前分别停在 PostgreSQL 合约区段和约 63% 处，未产生失败断言。API 与 web 镜像通过 `mw-docker build` 使用 `market-watch-ubuntu` 构建；chart 镜像使用本机已有 licensed 资源临时构建，并在验收后删除资源副本。API-only Ubuntu Compose 在 `127.0.0.1:18011` 验收：`/readyz` 返回 `status=ready`，容器内精度/历史/派生/共享来源/复合回归 `69 passed, 1 deselected`，schema 检查、运行时精度检查和 SQLite `backup-restore-ok` 均通过。chart-only smoke Compose 在 `127.0.0.1:18012` 验收：首页 623 字节、`charting_library.js` 60,521 字节、`range-sync.js` 2,282 字节，CSP/Referrer-Policy/nosniff/no-store 响应头存在，未知资源返回 404。两个验收项目的容器、网络、volume 和登记镜像均已按精确归属清理；SQLite 项目因 `mw-docker retire` 不自动处理非 PG volume，先完成备份恢复检查后按明确 project 名手工 `compose down --volumes`，再清理镜像。未执行生产操作。
- 收尾复核从 `backend` 目录以完整依赖和 `PYTHONPATH=.` 重跑受影响测试，结果为 `92 passed in 18.97s`；两个 acceptance task 的清理预览无容器、网络、volume 或 task 镜像残留。

上述记录为初次实现证据；PR #36 复审发现的规则绕过、Decimal 上下文和正常页面说明问题，以以下修复与验收记录为准。PR 合并、打 tag 和生产恢复仍由用户授权；生产恢复前须重新确认目标任务状态、备份和发布窗口。

## 9. PR #36 修复复审与可复现验收（2026-10-11）

- legacy pending/retrying 任务、resume 和无关错误 retry 不能自动启用舍入；精度错误只通过无写入租约的显式 retry 冻结并审计规则。导入与派生将 manifest 明确传入工作表写入边界，避免 Bar、快照和产物价格不一致。
- 有效小数位从 Decimal tuple 计算；量化使用独立 Context，低全局精度和 Inexact/Rounded traps 不改变结果。处理前后都校验 OHLC。
- 统一解析规则；未知、不完整或非法规则拒绝消费。父子产物规则不兼容时重建，避免复用不同精度或旧规则价格。
- 宿主受影响模块回归：`206 passed in 59.48s`。Ubuntu API 容器内真实 PostgreSQL 回归：`34 passed in 79.80s`，覆盖精度规则、maintenance、artifacts 和 source store；唯一 warning 是非 root 容器无法写 pytest cache，与断言无关。测试使用独立 schema，未接触生产数据库。
- API/web 均经 `mw-docker` 与 `market-watch-ubuntu` 构建，web 的 TypeScript/Vite 构建通过。API 与 Web 代理的 `/readyz` 均返回 ready，编译后的 native JS 返回 HTTP 200。
- Chromium 实际加载 Ubuntu Web 容器编译产物，以受控 API fixture 检查创建页、冻结精度 5 版本与 legacy 版本的说明。1280px 和 390px 均通过，无页面级横向溢出或 pageerror；这不是供应商或完整图表端到端验收。

实际运行环境为 Ubuntu 本机 Docker，task/project 为 `mw-price-rounding-review-20261011`；API `http://127.0.0.1:18011`，Web `http://127.0.0.1:18013`。本轮使用独立 PostgreSQL 14 数据卷和网络，未启用供应商采集或通知。Compose 清单：[`deploy/ubuntu/history-price-rounding.acceptance.yaml`](../deploy/ubuntu/history-price-rounding.acceptance.yaml)。测试结束后退役，以上地址不再提供服务。

真实 PG 用例运行方式（先启动隔离实例；`TEST_POSTGRES_URL` 仅从容器现有配置读取，测试自动创建/删除各自 schema）：

```bash
sg docker -c '/usr/bin/docker exec -w /app/backend mw-price-rounding-review-20261011-api-1 python -c '\''import os,pytest; os.environ["TEST_POSTGRES_URL"]=os.environ["ALERTS_DATABASE_URL"]; raise SystemExit(pytest.main(["-q", "-p", "no:cacheprovider", "tests/test_history_price_rules_postgres.py", "tests/test_history_maintenance_postgres.py", "tests/test_history_artifacts_postgres.py", "tests/test_source_history_store_postgres.py"]))'\'''
```

初次构建后新增的 `test_history_price_rules_postgres.py` 已单独复制进本轮 API 容器执行；重建最终分支镜像会直接包含该文件。其余应用与测试代码均来自构建时工作区。上面的复现命令关闭 cache 插件，避免已记录的非 root cache warning。

复现时选取新的 task/project；创建仓库外权限 0600 的 env 文件，包含 `MW_ACCEPTANCE_DB_PASSWORD`（开发专用随机密码）、`MW_API_IMAGE`、`MW_WEB_IMAGE`，不要提交凭据。构建、启动、停止和退役方式：

```bash
cd /home/quant/repos/market-watch-history-price-rounding-plan-20261010
task=mw-price-rounding-review-20261011  # 重跑时必须换新 task
project=$task
mw-docker build --repo . --component api --tag market-watch-api:$task \
  --task "$task" --project "$project" --purpose acceptance
mw-docker build --repo . --component web --tag market-watch-web:$task \
  --task "$task" --project "$project" --purpose acceptance \
  --build-arg VITE_ADVANCED_CHART_ORIGIN=http://127.0.0.1:18012
env_file=/tmp/$task/acceptance.env
# 本会话用 sg docker 获得已授权的本机 docker 组权限。
sg docker -c "/usr/bin/docker compose --env-file '$env_file' -p '$project' \
  -f deploy/ubuntu/history-price-rounding.acceptance.yaml up -d --no-build"
curl -fsS http://127.0.0.1:18011/readyz
curl -fsS http://127.0.0.1:18013/readyz
# 停止应用写入，保留 PG 供归档与实际恢复校验。
sg docker -c "/usr/bin/docker compose --env-file '$env_file' -p '$project' \
  -f deploy/ubuntu/history-price-rounding.acceptance.yaml stop api web"
mw-docker retire --task "$task" --project "$project"
mw-docker retire --task "$task" --project "$project" --apply
```

本轮 chart 未改动；18012 仅是编译配置，不代表本轮运行 chart 服务。真实生产失败页断点续传与最终发布、完整 backend 全集仍未验证；生产恢复需后续明确授权。

复审还校正了方案中的输入边界表述：已有契约校验 Decimal 可解析性、有限正价格、OHLC 和数值存储范围，没有单独限制价格字符串长度、有效数字数量或指数绝对值。本次不声称实现了这些基线不存在的限制；额外边界须另行确定供应商与历史兼容范围。

本轮 `mw-docker retire` 已完成：`postgres` 和 `price_rounding` 均实际恢复成功，后者 87 张表的行数与内容指纹一致，并重新核对来源未变。按精确 project 删除 4 个容器、1 个独立数据卷、1 个网络和 2 个任务镜像引用，task 已登记完成。私有归档留在 `~/.local/share/market-watch-docker/archives/mw-price-rounding-review-20261011-20261010T205849-c2824dda`，不提交其凭据与配置。公开验证摘要见[本轮证据](verification/history-price-rounding-review-20261011.json)。规范/需求独立复审均无合并阻断；没有执行合并或生产操作。
