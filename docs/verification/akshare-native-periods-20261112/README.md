# 原生周期接入验收记录

状态：实施中，尚未完成隔离实例及 UI 验收，不作为完成或部署声明。

## Issue 草案与范围

在 `v2.0.8`（`e9b9a78722961c5f8b58895a187410349def6c94`）上新增新浪、腾讯沪深股票八周期，以及腾讯港股日周月的原生不复权平台入口。各周期直接读取供应商 OHLC，不聚合、不转换复权价格。旧前复权入口和托管任务保持原义。实施方案见[任务书](../../plans/akshare-native-periods-20261112.md)。

分类 F1：新增可保存平台身份及独立缓存规则；真实深历史发现无效 OHLC，因此原生快照在有异常时新增可选审计封装。无 schema 迁移，无全局正价校验放宽。旧快照继续按原数组写入和读取；新封装仅出现在新来源身份，不能被旧入口误用。最小验收含兼容回归、真实上游、独立 PostgreSQL 并发、真实浏览器及独立 Standards/Spec review。

## 当前证据

- 相关后端回归：373 passed（2026-11-12，本机 Python，`PYTHONPATH=backend`，工作树代码）；范围含原方案回归组、原生历史/迁移、provider cache/chart。随后补充旧裸数组持久格式兼容测试，原生模块和共享来源缓存组 28 passed（包含重叠测试，不能与 373 相加）。
- Web 公共单测入口通过；TypeScript、Vite、数据中心构建及含私有许可图表组件的 `npm --prefix web run build` 均通过。许可目录被 git 忽略，未提交。
- [真实适配器报告](live-adapter.json)：38 个目标组合全部直接取得原生 OHLC，使用实际默认快照数量。该报告为上游适配器证据，不代替应用 API 和 UI 验收。
- [条数与单位报告](live-semantics.json)：19 条来源/周期路由各测试 count=2、80、默认有限快照，共 57 次通过。新浪 A 股单位为股，腾讯 A 股为手（100 股），腾讯港股为股；三组日线收盘价/成交量均与独立报价接口相同。H1 原始标签样本随报告保存。
- [独立 Standards / Spec 审查](review.md)：两项代码问题均已修复，复核未发现新的实质实现问题；运行验收缺口继续保留。
- 新浪 `SZSE:000001` 早期周月记录存在 `open > high`，并非本地解析顺序错误。处理保留原始 OHLCV、标签和原因，正常图表保留缺口，不修补价格；说明在平台详情可见，具体异常通过 `source_warnings` 随快照保存、随行情 API 返回。首次严格探测失败后才增加此处理，未缩短历史窗口以绕过异常。
- 新接口使用静态操作在 AKShare 导入前分派；超时仍由既有子进程 deadline 和进程组回收控制。没有新增定时服务。

## 验收环境与资源

工作树：`/home/quant/repos/market-watch-native-implementation-20261112`；分支 `feat/akshare-native-periods-20261112`。

任务及 Compose project 均为 `mw-akshare-native-20261112`，端口候选 `19443`，尚未启动。需要独立 PG/API/Web/TLS，不需要 collector、通知或历史 worker；预期资源限额按 preview 默认配置。

本轮盘点磁盘可用约 13.8 GiB（14,827,806,720 bytes），小于实施方案第 6 节和 `deploy/ubuntu/README.md:103` 的 23 GiB 门槛，约需再释放 9.2 GiB；内存可用约 7.3 GiB。已通知用户协调资源。自动镜像清理的只读候选清单为空，未执行删除。未绕过门槛，未停止其他任务，未修改现有开发实例或生产环境。

尚未构建 Docker 镜像或启动本任务实例，因此没有可交付的运行地址、镜像 ID、实际 API/UI 或容器 CPU 证据。预计地址 `https://127.0.0.1:19443` 仅为计划值。

## 需求核对

| 计划验收项 | 已有证据 | 尚缺证据 |
|---|---|---|
| 1. 38 个真实组合 | live-adapter.json 全部通过 | 同范围实际应用 API |
| 2. OHLC、时间、单位 | 真实响应首末值、57 次 count、3 组报价对照；稳定键和未完成周月单测 | 应用链路对照 |
| 3. 价格与旧身份兼容 | raw/qfq 身份隔离、旧入口测试、旧裸数组不改写 | 实际 PG、旧保存布局/自选恢复 |
| 4. 目录行为 | 变体、分页计数、描述关联、托管排除单测 | 实际 PG/API/UI |
| 5. 图表行为 | 完整前端构建；真实浏览器脚本已准备并通过语法检查 | 19 次 UI 切换、保存恢复、无浏览器错误 |
| 6. 有限窗口与恢复 | 跨分钟游标、缓存有限边界、超时及空响应恢复测试 | 实际 PG/API |
| 7. 并发与空闲 | 共享租约单测；PG 并发测试已准备 | 真 PG 并发、至少 5 分钟调用/进程/CPU 观察 |
| 8. 既有入口回归 | provider/catalog/history/resource 回归 | 隔离服务回归 |

## 可复现本地检查

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
npm --prefix web run test:single-frontend -- --unit
npm --prefix web run build
node --check web/tests/akshare-native-periods.browser.cjs
git diff --check
```

相关修改的 backend 文件已通过 Ruff。PG 专用测试在无 `TEST_POSTGRES_URL` 的本轮环境收集成功，6 skipped；这不是 PG 验证通过。

## 资源就绪后的续验

重新只读核对磁盘、内存、现有 project 和 19443 端口，再执行方案第 6 节的带归属镜像构建和 preview 命令。为任务 API 配置 AKShare enable 及任务独立出网；不得共享现有实例网络或数据库。通过本任务私有数据库 URL 运行：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_akshare_native_postgres.py backend/tests/test_provider_postgres.py \
  backend/tests/test_native_history_loads_postgres.py
```

`TEST_POSTGRES_URL` 只指向本任务的独立 PG，通过私有环境注入，不粘贴凭据。每个测试使用独立 schema。

浏览器脚本 `web/tests/akshare-native-periods.browser.cjs` 使用 `MW_BASE_URL`、`MW_OUTPUT`、`MW_ACCEPTANCE_CREDENTIALS_FILE`。私有 JSON 文件格式为 `{login_password, ca_file}`，CA 必须对应本任务证书；脚本仅信任该证书的 SPKI。可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定本机浏览器。脚本登录真实 API，验证 38 组行情，从平台目录打开 3 类来源，切换 19 个周期，通过图表公开导出接口确认实际数据，并保存/刷新恢复；不拦截或模拟行情。

退出全部图表后至少观察 5 分钟，保留本任务上游调用计数、子进程和容器 CPU 增量，再执行方案中的 preview stop，保留 PG volume。记录准确主机、地址、镜像 ID、SHA 及实际启停命令。

## 待完成

- 隔离 PostgreSQL 兼容及并发验证。
- 实际应用 API 的 38 个组合和真实浏览器周期切换、入口选择及布局恢复。
- 退出页面后至少 5 分钟的调用与 CPU 增量观察。
- 独立 PR、镜像与 SHA、准确访问地址和启停命令。

本任务不合并、不打 tag、不修改当前开发实例、不发布生产，不持续轮询 CI。
