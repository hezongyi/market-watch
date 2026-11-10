# 六源目录维护、按需行情与九周期接入：修订执行方案

修订日期：2026-11-09。仓库：Market Watch。基线：`v2.0.0` / `f111d3a6949779e4a7887ba5e8ef57a75ac4f276`。

工作树：`/home/quant/repos/market-watch-provider-catalog`。分支：`feat/provider-catalog-maintenance-20261109`。

本方案的应用开发、针对性回归、独立 review 和 Ubuntu 隔离候选验收已经完成；全量回归与 PR CI 状态见验收记录。本文件覆盖此前的广义“六源全部品种”要求，后续 agent 以本次修订的来源边界为准。未合并或部署生产。

## 本次范围修订

用户先将 AKShare 收敛到 A 股、港股和国内期货，随后进一步明确：**行情接入源、清单源都限定于项目原来已实现的新浪、腾讯接口范围，不扩大。**

- 不接入 AKShare 美股、B 股、指数、ETF/LOF/其他基金、债券、期权、外盘期货或外汇。
- 不因同一 AKShare 库另有接口，就接入新上游、新行情端点或新目录端点。
- 撤回本轮新增的 `futures_symbol_mark` → `futures_zh_realtime` 交割月目录扫描及 `futures_contracts` 刷新入口。国内期货目录保留原来的新浪主力连续目录范围，不承诺全部交割月合约。
- 股票周期按既有新浪、腾讯接口能力验收，不以增加东财分钟线来补齐九周期。
- 其余五源、持久目录、本地搜索、中文描述、定期刷新、按需维护及九周期上限保持本次已确认目标。

## 目标与来源边界

六源均需支持从目录选择品种、读取行情、进入自建维护并定位已有维护。目录完整性按下表的账户、业务或接口范围判断。

| 来源 | 本次目录及行情边界 | 验收说明 |
|---|---|---|
| Dukascopy | 官方当前动态目录 `https://jetta.dukascopy.com/v1/instruments`；准确 `name` 作为供应商代码 | 核对本次响应数量；旧 SDK 名称和已有历史身份保留，不以 SDK 常量代替完整性证据。 |
| OANDA | 已配置环境及账户的 `/v3/accounts/{accountID}/instruments` | 按账户范围记录快照，不扩展其他账户或监管地区。 |
| FXCM | 已配置 Demo 会话返回的完整 Offers 表 | 不按订阅状态过滤；周期以当前会话 TimeframeCollection 为准。 |
| Binance | 当前公共 Spot `exchangeInfo` 目录 | 保留交易状态；不接入合约、期权或地区站业务。 |
| Yahoo | 已核实、能够检查分页完整性的公开市场/资产分区 | 排除沪深京 A 股和港股；展示实际分区、数量及失败状态，不承诺全球资产全集。 |
| AKShare | 基线已经接通的新浪、腾讯股票及新浪国内期货路径，以及与其匹配的既有目录路径 | 仅在这些路径范围维护目录；不得把研究中列出的其他接口加入本次任务。 |

“完整”指已声明范围的完整枚举，不指供应商集团的全部产品。Yahoo 尚无法证明完整的资产集合如实标记覆盖限制；显式代码补录可补救缺失，不能作为全量目录证明。供应商限制、暂时请求失败和本项目尚未实现分别记录。

### AKShare 固定接口范围与兼容性

基线代码核对入口：`backend/alerts/akshare_catalog.py`、`provider_akshare.py`、`akshare_worker.py`。实施以基线实际使用的路径为准，不以 worker 白名单中的未启用接口自动扩大范围。

| 路径 | 基线已经使用的接口 | 本次处理 |
|---|---|---|
| A 股目录 | `stock_info_a_code_name` | 复用已有路径，仅保留与已接通新浪/腾讯行情匹配的品种；不额外引入新目录接口。 |
| 港股目录 | `stock_hk_spot` | 保留既有目录口径，修正 `中文名称` 字段。港股目录不等同于狭义 H 股分类。 |
| 国内期货目录 | `futures_display_main_sina` | 同步该接口返回的主力连续品种，不扫描交割月目录。 |
| 新浪股票行情 | `stock_zh_a_daily`、`stock_hk_daily` | 沿用原有价格、复权、日期及身份规则。 |
| 腾讯股票行情 | `stock_zh_a_hist_tx` | 保留独立平台行情身份和既有入口，不静默与新浪历史混合。 |
| 新浪国内期货行情 | `futures_zh_daily_sina`、`futures_zh_minute_sina` | 在已有接口内开放实际支持的项目周期，不引入其他期货上游。 |

注意：`stock_info_a_code_name` 本身拼接交易所代码表，不能将它描述成“新浪/腾讯提供的目录”。这里保留的是基线已有清单路径，目录对外范围必须与既有新浪/腾讯可读取范围一致；例如不能因代码表含北交所，就承诺已有仅支持沪深的新浪/腾讯路径覆盖北交所。也不能因为旧适配器留有东财相关代码，就自动开放新的东财目录、分钟行情或维护入口。

旧数据库已有身份和数据保留；收敛通过新同步、搜索、选择及创建边界实现，不删除历史数据，不改写既有采集身份。若发现既有数据依赖范围外路径，记录兼容性处理，不用扩大新入口来掩盖。

## 九周期及按需维护

唯一周期集合：**M1、M5、M15、M30、H1、H4、D1、W1、MN**。不新增其他周期，也不要求每个来源提供全部九周期。

| 来源/已接路径 | 九周期内的原生能力 | 实施要求 |
|---|---|---|
| OANDA、Binance、Dukascopy | 适配映射覆盖九周期，具体品种历史以实际响应为准 | 贯通请求、分页、解析、存储、图表及自建维护。 |
| FXCM | 以会话返回的项目周期交集为准 | 不把静态映射当作账户实际可用性。 |
| Yahoo | M1、M5、M15、M30、H1、D1、W1、MN | 补齐 M30，不伪造原生 H4；遵守各周期历史保留窗口。 |
| AKShare 新浪/腾讯股票 | 已接接口原生 D1 | 沿用既有 D1 基础派生 W1/MN，明确派生语义；不扩展股票分钟接口。 |
| AKShare 新浪国内期货 | M1、M5、M15、M30、H1、D1 | 不将种子仅验证 M5/D1 误当成接口只有两个周期；不伪造原生 H4/W1/MN。 |

对用户首次选中的品种及所选周期做有限验证，不后台遍历全目录的全部周期。目录存在不等于所有历史区间均可用，尚未验证不作为隐藏品种的理由。目录同步不请求历史 K 线、不注册维护任务。

source_family、价格侧、复权、时区、交易日期及账户纳入来源身份。原生与派生周期明确区分，切换来源不得静默复用旧历史。保留项目已有派生能力，不为凑齐九周期新增聚合模式或上游接口。

## 清单、本地读取、中文及刷新

复用 `MarketCatalog` 和 data-runtime，采用简单的低频目录同步，不建立新微服务或通用供应商框架。

- 每日后台刷新；首次启动无目录或目录过期时后台同步；保留各源手动更新入口，按接口限流调整频率。
- 分区所有分页读取成功后原子发布，保存来源、范围、原始代码、取得数量、供应商总数（如有）、最近成功时间及失败状态。
- 刷新失败保留旧快照；仅在完整分区成功后标记未再返回的品种，不删除历史数据。
- 普通商品代码搜索、平台目录和自建选择共用本地 SQL 过滤、排序和分页。搜索不等待供应商，不为每行获取元信息。
- 中文优先供应商原字段，其次稳定映射及人工描述。缺少可靠译名时保留原名并提供中文市场/资产描述；不得编造官方译名。人工修改在自动刷新后保留。
- 搜索覆盖代码、原名、中文描述、来源、交易所及类别。供应商原始代码不得截断，同名跨来源或交易所不得合并。
- 统一“刷新列表”“更新供应商目录”“读取行情”“添加自建行情”“管理维护”的操作含义；已有维护按完整来源身份定位。

候选性能标准：在与实际目录规模同数量级的数据下，列表及代码/中文搜索接口 p95 < 1 秒；页面首屏目标 < 2 秒。记录实际数据量和主机条件，完成实测后才能宣称达标。

## 当前进度与剩余工作

本地共享目录查询、分区原子发布、每日及手动刷新、中文维护、Binance 自建 M1 和六源选择入口已经实现。迁移验证保留旧历史身份及人工中文；AKShare 新入口限制在既有股票/主力连续范围。

47,232 行实测中列表、代码搜索、中文搜索、自建选择的接口 p95 均低于 1 秒。六源真实目录、代表周期、维护发布及发布版本图表读取均已有证据；两份独立 review 未发现阻断项。Yahoo 无法完整枚举的美股分区明确失败并保留旧快照，不宣称全球全量目录。

验收覆盖、候选镜像、测试状态及保留限制见 [候选验收记录](verification/provider-catalog-20261109/acceptance.md)。后续仅核对该记录所列全量回归与 CI，不扩展来源、市场或其他图表功能。

## 执行顺序、文件与验证

先修订范围及清理 AKShare 越界改动，再收尾共享目录、Yahoo 同步、入口与周期，最后统一验收。不要重做已完成的研究或覆盖当前未提交改动。

主要文件：

- `backend/alerts/akshare_catalog.py`、`provider_akshare.py`、`akshare_worker.py`：既有范围、目录映射及能力计算。
- `backend/alerts/catalog_sync.py`、`catalog_runtime.py`、`data_runtime.py`：分区快照、同步状态和后台刷新。
- `backend/alerts/instrument_directory.py`、`platform_catalog.py`、`history_catalog.py`、`history_creation_check.py`、`market_data.py`：统一本地搜索及入口范围。
- `backend/alerts/yahoo_catalog.py`、`provider_yahoo.py`、`provider_capabilities.py`：Yahoo 分区、边界及 M30。
- `backend/alerts/binance_history.py`、`history_sources.py`、`aggregation_policy.py`、`source_registry.py`：Binance 自建及来源身份。
- `backend/alerts/history_api.py`、`web/src/market-data/CreationCatalog.tsx`、`DatasetCreate.tsx`、`PlatformMarket.tsx`：刷新、描述、选择和维护入口。
- `migrations/versions/bb55_provider_catalog_indexes.py`、相关 `backend/tests/`：索引迁移与实际行为验证。

本地检查示例（在当前工作树执行，使用已安装依赖的 Python 环境，显式设置 `PYTHONPATH=backend`）：

```bash
git diff --check
PYTHONPATH=backend python -m pytest backend/tests/test_provider_directory.py backend/tests/test_platform_catalog.py backend/tests/test_history_catalog.py backend/tests/test_provider_akshare.py backend/tests/test_history_mode_creation.py backend/tests/test_history_sources.py
python -m ruff check backend/alerts/catalog_sync.py backend/alerts/catalog_runtime.py backend/alerts/instrument_directory.py backend/alerts/akshare_catalog.py backend/alerts/provider_akshare.py backend/alerts/history_api.py backend/tests/test_provider_directory.py
npm --prefix web ci
npm --prefix web run build
```

补充所修改适配器和运行链路的相关测试；迁移在独立 PostgreSQL 14.24 验证基线升级、旧数据兼容和重复执行行为。不得仅修改断言掩盖实际缺陷。

重点验收：分区跨页不漏项；失败保留旧快照；人工中文名不被覆盖；前台搜索不触网；长代码可创建；同名跨源不串用；AKShare 不引入范围外目录或端点；Yahoo 排除 A 股与港股；原生/派生不混淆；超时和限流不变成“不支持”；选定品种的支持周期可读取和维护。

## Ubuntu 验收与交付边界

风险分类维持 **F1**：涉及持久目录、schema 索引及重要后台链路，保留迁移/兼容验证、适用独立 review 和 Ubuntu 隔离验收。

用户已经授权完成后直接验收，并忽略此前的环境资源限制；不因先前的磁盘保守门槛再次等待确认。启动前仍核对实际 project、端口及资源，使用本任务独立 Compose project、网络、volume、数据库、凭据和端口，保留现有 `mw-dev`。镜像通过 `mw-docker build` 或 `mw-docker compose-build` 构建并标注任务归属。

交付记录实际主机、镜像/代码状态、可访问地址、启动/停止命令、目录覆盖及数量、行情验证、搜索性能和未完成项。外部接口不可达时如实记录，不将 mock 成功写成真实行情验收成功。

本次不包含生产部署、正式 tag、合并、删除永久数据、全局 prune 或停止其他任务实例。准备合并时按 `AGENTS.md` 报告证据并等待用户决定。只有新的范围冲突、无法保持隔离、实际失败或需要生产/永久删除操作时才报告具体阻碍，不重复申请已授权的正常开发与验收步骤。

## 研究资料的适用性

- [六源目录可行性研究](research/provider-full-catalog-feasibility-20261109.md)：保留研究时的发现与局限；其中 AKShare 全市场建议已被本次修订覆盖。
- [AKShare 全市场接口研究](research/akshare-market-directory-matrix-20261109.md)：仅作背景资料，列出的额外市场、接口及交割月遍历不属于本次待办。
- [目录与九周期补充核验](research/provider-directory-period-matrix-20261109.md)：作为 Dukascopy、Yahoo、FXCM 及已有路径周期的证据；不得据此扩展 AKShare 新接口。
