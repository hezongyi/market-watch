# A/H 股与美股 qfq 行情接入和复权依据实施方案

日期：2026-10-25。状态：实现与本地验证完成；用户已明确批准 `mwa` 验收，候选已部署，正在汇总最终全量检查及保留审计。当前结果见 `docs/verification/equity-qfq-mwa-20261025/README.md`。本文承接行情模式实施任务，限定于股票来源选择、平台临时行情默认 qfq、自建行情保存 none 与同源复权依据，以及自建图表 qfq 展示。原行情模式任务负责通用 D1 / 原生周期、维护、版本和图表框架；本方案不重复实现这些能力。

## 1. 已确认的产品行为

| 场景 | 市场 / 来源 | 采集与展示 | 边界 |
| --- | --- | --- | --- |
| 平台临时行情 | A 股新浪、腾讯 | 默认直接请求来源 qfq OHLCV，并按来源、周期、qfq 分开缓存 | 腾讯仅用于 A 股平台行情；不把其 qfq 值当作显式复权因子 |
| 平台临时行情 | 港股新浪 | 默认直接请求新浪 qfq OHLCV，并缓存 | 仅开放已经验证的周期；本次不从日线派生周线或月线 |
| 平台临时行情 | 美股 Yahoo / yfinance | 沿用现有 `auto_adjust=True` 股票 / ETF 行为，缓存调整后行情 | 不改变现有平台默认值 |
| 自建行情 | A 股、港股新浪 | 采集 `none` OHLCV，另存新浪 qfq 因子；展示时用同一数据集、同一来源因子计算 qfq | A 股公式 `raw OHLC / qfq_factor`；港股公式 `raw OHLC * qfq_factor`，不得共用未经分市场验证的公式 |
| 自建行情 | 美股 Yahoo / yfinance | 采集 `auto_adjust=False` OHLCV，并持久化同响应的 `Adj Close` 或 `Adj Close / Close` 比率；展示时按比率计算 qfq | actions 字段用于审计；不宣称其可独立重建 Yahoo 因子，也不声称 Yahoo 原始 OHLC 未经拆股规范化 |
| 不支持 | 腾讯自建、期货复权、跨来源复权 | 不提供 | 不用腾讯近似价格比率充当复权因子；不使用新浪因子修正 Eastmoney / 腾讯原始 bars |

用户当前用于临时查看和收集数据，不要求研究级公司行动核对。本期按供应商 qfq 口径呈现，保留来源、口径、抓取时间和修订依据，便于之后审计和重算。

本期不实现 D1 → W1 / MN 派生，不新增周期，不改实时行情、告警、组合行情或生产部署。

## 2. 仓库基线与执行约束

- 仓库：`/home/quant/repos/market-watch-history-modes-integration-20261024`。
- 当前分支：`integration/history-modes-mwa-20261024`，HEAD `8b7ee3eea8467866da89c0f3fc53989da5cc94e1`。
- 原行情模式实施工作树：`/home/quant/repos/market-watch-history-modes-20261024`，基线 `7fc4fbb84e613e12e4540d7582ea78d137bfcdbd`。
- 当前集成工作树有大量暂存和未跟踪任务文件；执行者必须保留现场，不得 reset、清理或覆盖用户/其他任务修改。开工先核对 `git status --short --branch`、HEAD、集成分支与实施分支差异，并把实际实现基线写入 Issue / PR；不要假定当前未提交状态等同已合并 main。
- 阅读本仓库 `AGENTS.md`。按 F1 处理：本功能新增持久复权依据并影响数据身份、版本和图表结果，需要 schema / 旧快照兼容验证。开发与验收使用独立 Ubuntu Docker worktree、Compose project、网络、volume、PG、端口；不在 Unraid 建验收实例。
- 先完成此专项的现场接口核验，再建立 Issue 草案、实施、测试和 `mwa` 验收。本文件不授权合并、生产发布或永久资源删除。

## 3. 已核实事实与实现前置条件

核验依据：

- `docs/verification/history-modes-20261024/akshare-adjustment-factor-verification-20261025.md`
- `docs/verification/history-modes-20261024/yahoo-adjustment-basis-verification-20261025.md`
- `docs/verification/history-modes-20261024/provider-capabilities.json`
- `docs/managed-history-modes-akshare-yahoo-implementation-plan-20261024.md`

已核实：

- AkShare 固定版本为 1.19.3。`stock_zh_a_daily(adjust="qfq-factor")` 提供新浪 A 股因子，源码公式为 raw OHLC 除以因子；`stock_hk_daily(adjust="qfq-factor")` 提供港股因子，源码公式为 raw OHLC 乘以因子。
- 新浪 A 股因子曾对 `sz000002` 做过 live probe。港股因子目前只有固定版本源码核验，尚无现场响应、字段和公式交叉验证。
- `stock_zh_a_hist_tx` 支持新浪/腾讯对照中使用的腾讯 qfq bars，但不提供显式因子字段。不能从 rounded bars 的价格比值推断可复用的公司行动因子。
- 当前 `provider_akshare.py` 的 A 股源族是 `eastmoney-a`，平台/自建接口路由按 `stock_zh_a_hist`；港股为 `sina-hk`。实现本方案时必须显式注册来源身份，不能将当前 A 股 Eastmoney 标识直接改名为新浪而造成旧数据身份碰撞。
- 当前 yfinance 股票 / ETF 平台路径用 `auto_adjust=True`。归档路径设 `auto_adjust=False, actions=True`，但共享 `_rows` 目前仅存 OHLCV，丢弃 `Adj Close`、股息、拆股和资本利得字段。
- yfinance 的 `auto_adjust` 通过 `Adj Close / Close` 调整 OHLC；若上游没有独立 `Adj Close`，不能把回退到 Close 的同名列宣称为可用因子。

**S0 阻断条件：**在实现港股复权前，以固定 AkShare 版本对至少一个有已知复权事件的港股标的现场调用 raw、qfq、qfq-factor；核对字段、日期覆盖、sentinel / 缺失行处理，并验证 `raw * factor` 与供应商 qfq bars 在精度容差内一致。记录样本、时间、脱敏结果和限制至 verification 报告。如因网络 / 限流无法完成，A 股、Yahoo、平台源可继续；港股自建 qfq 必须保持不可用，不得仅凭源码核验开放。

## 4. 数据与身份合同

### 4.1 来源身份、缓存与价格口径

- 来源身份至少区分 `sina-a`、`tencent-a`、`sina-hk`、`yahoo`；股票交易所、供应商代码、接口、周期、adjustment、时区及规则版本进入 source / acquisition identity 和缓存 key。
- A 股新浪自建身份是新增身份。既有 `eastmoney-a` 数据集 / 快照不迁移成新浪，也不重解释、不覆盖。
- 平台缓存键包含来源与调整口径（至少 `provider + symbol + timeframe + adjustment`）。qfq 与 none、腾讯与新浪的 bars 永不共享缓存项。缓存 TTL 沿用现行行情缓存策略；这不是自建归档保留策略。
- 平台 qfq 的供应商结果标为 qfq / supplier-adjusted；自建图表计算结果标为基于本数据集同源依据计算的 qfq，元数据能区分直接供应商 bars 与本地计算 bars。
- 自建数据集在创建时固定 provider 和 `adjustment=none` 输入口径。复权依据作为版本化输入内容保存，关联其来源身份、观察时间、窗口、规则版本和内容摘要。刷新后形成新证据 / 新快照；不能悄悄改写已发布版本。
- 因子或 Yahoo ratio 修订时，按其影响范围重算当前新版本的 qfq 图表 / 指标输入；旧固定版本必须仍能复现旧 bars、依据和输出。

### 4.2 新浪因子

- 因子是独立的、可版本化的源数据，不混进 `NativeBarRow` 的 OHLCV，也不写回 raw bars。
- A 股因子定义与公式固定为 `qfq_ohlc = none_ohlc / qfq_factor`；港股固定为 `qfq_ohlc = none_ohlc * qfq_factor`。OHLC 四项使用同一交易日因子。因子缺失不得填 0、跨事件前向填充或跨供应商借用；只有上游明确的可沿用语义并有测试依据时才可前向填充，并需保留原值和规则。
- 因子历史覆盖不足、重复交易日冲突、非正/非有限值、非法价格关系，或同供应商 qfq 对照超出经记录的舍入容差时，受影响范围标 unavailable / stale 并保留 raw；不可静默画成 qfq。
- 供应商 `1900-01-01` sentinel 不当作真实交易日，不得污染图表、历史范围或内容摘要。

### 4.3 Yahoo 复权依据

- 自建归档保留 raw OHLCV 和同一次响应返回的 `Adj Close` 或精确 `adj_close / close` 比率。推荐持久化比率（使用 decimal / 字符串避免不必要的浮点累计误差）并可附存 Adj Close 方便审计。
- 展示 qfq 时 `ratio = Adj Close / Close`，`O/H/L *= ratio`，`C = Adj Close`（等价于 `C *= ratio`）。不调整 volume。
- `Adj Close` 缺失、无效，或与 Close 完全相等且无法证明上游确有独立调整列时，明确报告该区间 qfq basis unavailable；不能静默用 1 伪装完成。
- Dividends、Stock Splits、Capital Gains 可存为审计事件，但本期计算口径以 Yahoo 提供的 Adj Close ratio 为准，不从事件自行拟合 Yahoo 算法。
- 明确标示 `auto_adjust=False` 仅表示 yfinance 未执行该步自动调整；Yahoo OHLC 仍可能已经拆股规范化。

## 5. 预计文件改动范围

以开工时实际代码为准；若原行情模式实施已经改变文件，应扩展现有模块，不机械复制或重建模块。

| 区域 | 预计改动 |
| --- | --- |
| `backend/alerts/akshare_catalog.py`、`provider_capabilities.py`、`source_registry.py`、`platform_catalog.py` | 注册新浪 A/H、腾讯 A、Yahoo 的明确来源能力、可用周期和平台 qfq 默认值；腾讯不暴露自建入口 |
| `backend/alerts/provider_akshare.py`、`akshare_worker.py` | 按市场 / 来源调用各自端点；平台请求 adjustment 与自建 none/factor 请求路径分开；保留 deadline / source slot |
| `backend/alerts/provider_cache.py`、`provider_chart.py`、`provider_service.py` | 选源、显式 qfq 请求、缓存身份和图表结果来源标记；保留 Yahoo 平台既有 auto-adjust 行为 |
| `backend/alerts/provider_yahoo.py`、`native_history_archive.py`、`source_history_store.py` | 解析和保存 Yahoo Adj Close / ratio 与事件；与 raw bars 及版本关联；按依据修订建立新结果 |
| `backend/alerts/market_contracts.py`、`storage.py`、迁移文件、历史产物 / 版本模块 | 如现有模型不能承载依据，新增 factor / adjustment-basis canonical schema 和持久记录；不变更旧 M1 key，不原地修改历史快照 |
| `backend/alerts/series_access.py`、`fixed_indicators.py`、相关图表接口 | 支持请求 raw / qfq 明确视图；当前 qfq 显示走对应 immutable snapshot 的同源依据，指标输入身份含 adjustment basis version |
| `web/src/market-data/`、`advanced-host/bridge.js` | 在平台行情显示供应商 / qfq 标签；自建行情保持产品确认的 qfq 默认展示，清楚区分原始采集口径与展示口径；无可用依据时显式状态 |
| `backend/tests/`、`web/tests/`、`docs/verification/history-modes-20261024/` | 覆盖公式、来源隔离、缓存隔离、缺失 / 修订处理、真实端点证据和浏览器验收 |

仅在审计事件有具体后续使用价值且版本模型允许时存储全部 Yahoo action 列；最低要求是保留 Adj Close 或 ratio。不要为本功能引入通用复权 DSL、跨源因子池或全市场因子同步服务。

## 6. 执行步骤

1. **S0：基线和接口核验。** 核对 integration / implementation 两分支与工作树文件归属；记录 issue 范围、F1 分类、最小验收矩阵。现场验证新浪港股 factor/raw/qfq；补充新浪 A 股多个公司行动样本、腾讯 A 股平台 qfq 响应和 yfinance Adj Close 行为证据。接口失败时标记具体源/市场不可用，不阻塞独立市场。
2. **S1：来源和身份。** 定义来源能力矩阵及新身份，明确新浪 A、腾讯 A、新浪 HK、Yahoo 的代码映射、端点、时区、周期和价格口径；加测试证明既有 Eastmoney 身份、旧数据 key 和历史版本不变。
3. **S2：平台临时行情。** 接通新浪 A qfq、腾讯 A qfq、新浪 HK qfq；沿用美股 Yahoo auto-adjust。验证请求参数、默认来源、平台选择行为及缓存键隔离；无须引入平台 none 选项，除非既有平台契约要求。
4. **S3：自建 A/H 因子。** 新浪 A/H 自建 raw `none` bars 与独立 factor acquisition / persistence；分别实现除法 / 乘法转换；图表按数据集版本取同源因子计算 qfq。遇缺因子只禁用受影响 qfq 范围，不丢失 raw 访问或伪造价格。
5. **S4：自建 Yahoo basis。** 扩展 archive parser，保存 Adj Close / ratio，补充有效性状态和快照版本关系；实现 qfq 视图与指标身份。覆盖上游缺字段、Close 为零/非法、因子修订及老版本复现。
6. **S5：F1 持久化兼容。** 若新增 schema，迁移在旧 M1、D1、原生数据及固定指标快照数据库上执行；验证旧读取不变、迁移重启可恢复、回退说明不要求删除新数据。保持数据库备份与恢复证据。
7. **S6：回归与 `mwa` 验收。** 执行 §8 的本地与隔离 Docker 检查；在已有授权的 `mwa` 上按需做本次浏览器验收，先确认实例归属和运行配置。验收只使用隔离实例，不触及生产。记录真实主机、URL、启动/停止命令和结果；停止于合并前。

## 7. 验收矩阵

| ID | 验收场景 | 通过条件 |
| --- | --- | --- |
| Q01 | 新浪 A 股自建 raw 与 factor | 两个独立数据依据可追溯；跨公司行动日期 `raw / factor` 与新浪 qfq OHLC 在记录容差内一致 |
| Q02 | 新浪港股自建 raw 与 factor | 先有 live probe；`raw * factor` 对照新浪 qfq 一致；sentinel 不进入真实范围 |
| Q03 | 因子缺失、重复、修订 | raw 保留；qfq 对缺口明确 unavailable/stale；修订进入新版本；旧固定版本可复现 |
| Q04 | 腾讯 A 股平台 qfq | 返回腾讯 qfq bars；不读取/不生成腾讯因子；平台缓存与新浪、none 完全隔离 |
| Q05 | 新浪 A / HK 平台行情 | 默认用对应新浪 qfq 端点，使用平台短期缓存；不得误路由 Eastmoney 或其他来源 |
| Q06 | Yahoo 美股平台行情 | 股票 / ETF 继续 `auto_adjust=True`；缓存返回 qfq 风格 OHLC；原有其他资产行为不回归 |
| Q07 | Yahoo 自建 raw / basis | `auto_adjust=False` raw OHLCV 与 basis 同次响应入库；`Adj Close / Close` 转换与 yfinance 自动调整 fixture 一致 |
| Q08 | Yahoo basis 不可用 | 无独立 Adj Close 时不伪称 qfq；说明受影响日期范围，raw 仍能读取 |
| Q09 | 版本和固定指标 | 调整依据版本进入计算身份；修订产生新结果，不改已发布版本；对应固定指标读取 qfq 输入 |
| Q10 | 来源边界 | 腾讯不可创建自建数据集；新浪因子不得调整 Yahoo / 腾讯 / Eastmoney bars；期货 none 行为不回归 |
| Q11 | UI / `mwa` 现场 | 平台临时行情与自建图表标签准确；切换品种/来源不串缓存；无复权依据时没有错误 qfq 图表 |
| Q12 | 部署与旧数据 | F1 schema 升级、应用重启、旧 M1 / 历史快照回归通过；Ubuntu Docker 实例与任务资源隔离 |

确定性 fixture 测试和 live 网络 smoke 分开记录。单只股票现场响应只证明当时接口可达，不代表全市场完整性、供应商 SLA 或公司行动正确性。

## 8. 验证命令与完成条件

以开工时目标实现工作树为准，创建专用 venv，不复用或改写其他任务环境：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install -e . --no-deps
.venv/bin/python -m pytest -q \
  backend/tests/test_provider_akshare.py \
  backend/tests/test_provider_yahoo.py \
  backend/tests/test_native_history_archive.py \
  backend/tests/test_source_history_store.py \
  backend/tests/test_series_access.py \
  backend/tests/test_fixed_indicators.py
.venv/bin/python -m pytest -q
.venv/bin/ruff check <本次修改的Python文件>
cd web && npm ci && npm run build
```

按现有项目脚本和 `AGENTS.md` 完成迁移、CI、浏览器与 Docker 检查。实际路径 / 测试名称以实现落点更新；占位命令不得原样作为“已通过”的证据。新增真实 smoke 仅访问选定代表标的和有限日期范围，不能触发全历史下载。

完成交付包括：实现分支 / commit / Issue 草案或 Draft PR；Q01–Q12 逐项证据；现场接口响应与限制；迁移和旧版本复现记录；本地测试、CI、browser、Ubuntu Docker 结果分开陈述；`mwa` 可访问地址和停止命令；未通过项及影响范围。所有必须项通过后停止在合并前，等待用户决定合并；不创建正式 tag、不发布生产。

## 9. 停止条件

- 港股因子现场核验未通过：停止开放港股自建 qfq；继续其他已核实范围并交付明确限制。
- 新浪 factor 与同源供应商 qfq 在公司行动日期无法按文档公式对齐：保留 raw 与调查证据，该市场 qfq 不可用；不能换用其他供应商因子伪装成新浪 qfq。
- Yahoo 上游缺少独立 Adj Close：该区间自建 qfq 不可用；不能用 actions 自行拟合替代而仍标为 Yahoo qfq。
- 来源身份或迁移可能重解释既有数据、固定快照不可复现、隔离或恢复验证失败：保留数据库现场并报告，不删除或覆盖数据。
- 网络临时失败、资源竞争等单项阻碍：记录证据并完成不依赖它的市场和通用能力，不把未验证标成通过。
- 只有准备合并、生产发布或永久删除资源时按 `AGENTS.md` 停下请求相应授权；方案和隔离验收不构成该授权。
