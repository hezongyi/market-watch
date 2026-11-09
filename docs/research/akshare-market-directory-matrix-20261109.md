# AKShare 1.19.3 行情目录与历史接口矩阵

> 范围修订（2026-11-09）：本文件保留为全市场背景研究。用户已将本次 AKShare 行情及清单限制到项目原来已实现的新浪、腾讯接口范围；后文其他市场、新上游、新目录和交割月遍历均不属于本次待办。执行与验收以[修订方案](../provider-catalog-on-demand-scope-20261109.md)为准。

日期 2026-11-09；研究对象锁定 `akshare==1.19.3`。依据：PyPI 官方包元数据与 wheel（<https://pypi.org/project/akshare/1.19.3/>），以及其随包 Python 源码；对应官方文档入口：<https://github.com/akfamily/akshare/tree/main/docs/data>。本报告只覆盖能返回 OHLC（开、高、低、收）或明确行情价格序列的接口；财务、公告、资金流、宏观指标、新闻和纯统计接口不纳入行情目录。

“全量”仅在表中写明的供应商目录接口/市场分区内成立。AKShare 是多个上游网站的 Python 封装，没有一个覆盖所有资产的统一目录。目录刷新不应先拉历史 K 线；选中品种后才按支持周期请求。

## 代码规则与统一周期

AKShare 接口大多接受上游原始代码，不能把一个市场代码格式套到另一个市场。当前九周期为 M1/M5/M15/M30/H1/H4/D1/W1/MN。

- 分钟接口通常以字符串 `1/5/15/30/60` 表示 1、5、15、30、60 分钟；项目 H1 可映射 `60`。
- 日线接口的 `period` 通常是 `daily/weekly/monthly`，分别映射 D1/W1/MN。
- AKShare 1.19.3 没有通用 H4 原生参数；H4 只能在项目内从更细基础周期派生，并明确派生时区/交易日规则。
- 复权 `adjust` 的允许值因接口不同：常见 `""`、`qfq`、`hfq`；不应跨接口复用。
- 行情返回通常含中文日期、开盘、最高、最低、收盘、成交量；成交量单位和复权语义必须随 source family 保存。

## 股票

| 市场 | 可枚举目录接口（关键字段） | 原始 symbol 规则 | OHLC 历史接口与签名 | 九周期可用性/限制 |
|---|---|---|---|---|
| 沪深京 A 股 | `stock_info_a_code_name()`：代码、简称；或 `stock_zh_a_spot_em()`：代码、名称、实时 OHLC/成交量 | 6 位代码；东财历史接口直接传 `000001`；新浪/腾讯前缀 `sh`/`sz`；沪 `6`、深多数 `0/3`、京 `4/8/9` 需目录字段确认 | `stock_zh_a_hist(symbol, period, start_date, end_date, adjust)`；分钟 `stock_zh_a_hist_min_em(symbol, start_date, end_date, period, adjust)` | D1/W1/MN；M1/M5/M15/M30/H1。分钟接口文档周期 `{1,5,15,30,60}`；H4 派生。 |
| B 股 | `stock_info_sz_name_code("B股列表")`、`stock_info_sh_name_code("主板B股")`、`stock_zh_b_spot()`/`stock_zh_b_spot_em()` | 新浪历史例 `sh900901`；深 B 需以目录返回前缀/交易所为准 | `stock_zh_b_daily(symbol, start_date, end_date, adjust)`；`stock_zh_b_minute(symbol, period, adjust)` | D1；分钟 M1/M5/M15/M30/H1（实际历史保留由新浪返回决定）；W1/MN 可由 D1 派生；H4 派生。 |
| 港股 | `stock_hk_spot()`（字段含 `代码`、`中文名称`）、`stock_hk_spot_em()` | 5 位零填充代码，如 `00700`；新浪常用 `00700`，东财历史 `116.00700` 是内部 secid，不是展示 symbol | `stock_hk_hist(symbol, period, start_date, end_date, adjust)`；`stock_hk_hist_min_em(symbol, period, adjust, start_date, end_date)` | D1/W1/MN；东财分钟 `1/5/15/30/60`，M1 只返回有限近期趋势；H4 派生。 |
| 美股（东财） | `stock_us_spot_em()`：代码、名称、交易所等；新浪 `stock_us_spot()` 为全美股延迟快照 | 东财历史代码由 spot 的“代码”字段直接传入，示例 `105.MSFT`；不要只传 `MSFT` | `stock_us_hist(symbol, period, start_date, end_date, adjust)`；`stock_us_hist_min_em(symbol, start_date, end_date)` | 日 `daily/weekly/monthly`；分钟接口无 period 参数、仅趋势快照（默认近5日），不应承诺完整 M1-M30/H1 历史；H4 不能原生承诺。 |
| CDR/特殊股票 | `stock_info_sz_name_code("CDR列表")` 等 | 以目录原始代码 | `stock_zh_a_cdr_daily(symbol,...)` 等专用日线 | 仅 D1；不得伪装为普通 A 股分钟全量。 |

官方股票源码位置（锁定 wheel 内）：`akshare/stock/stock_info.py`、`stock/stock_zh_b_sina.py`、`stock/stock_hk_sina.py`、`stock_feature/stock_hist_em.py`。文档入口：<https://github.com/akfamily/akshare/blob/main/docs/data/stock/stock_quote.md>。

## 指数与板块

| 类别 | 目录/名称接口 | 历史 OHLC | 周期边界 |
|---|---|---|---|
| 沪深京指数 | `stock_zh_index_spot_sina()`（全指数快照）、`stock_zh_index_spot_em(symbol="上证系列指数")` | `stock_zh_index_daily(symbol)`、`stock_zh_index_daily_tx(symbol,start_date,end_date)`、`stock_zh_index_daily_em(symbol,...)`；分钟 `index_zh_a_hist_min_em(symbol,period,...)` | D1；东财分钟 1/5/15/30/60；W1/MN 派生；H4 派生。目录按“系列”调用后仍需去重。 |
| 中证/国证/申万指数 | `index_code_id_map_em()`、各系列名称接口 | `stock_zh_index_hist_csindex`、`index_hist_cni`、`index_hist_sw`、`index_zh_a_hist` | 主要 D1；部分源支持 period=day；不统一承诺分钟。 |
| 港股指数 | `stock_hk_index_spot_sina()`、`stock_hk_index_spot_em()` | `stock_hk_index_daily_sina(symbol)`、`stock_hk_index_daily_em(symbol)` | D1；W1/MN 派生。 |
| 全球指数 | `index_global_name_table()`（代码/名称）、`index_global_spot_em()` | `index_global_hist_sina(symbol)`、`index_global_hist_em(symbol)` | D1；无通用分钟接口证据。 |
| 行业/概念板块 | `stock_board_industry_name_em/ths()`、`stock_board_concept_name_em/ths()` | `stock_board_industry_hist_em(symbol,start_date,end_date,period="日k",adjust)`、对应 `hist_min_em`；概念同名接口 | D1 与 5 分钟等分时；这是板块合成序列，不能与个股目录混为股票。 |

指数目录常是多个“系列”接口，不存在一个已证明覆盖所有指数且字段/代码稳定的总表；同步时保存 `index_family` 和源接口。

## ETF、LOF 与基金

| 类别 | 目录接口 | OHLC 历史接口 | 周期边界与限制 |
|---|---|---|---|
| 场内 ETF | `fund_etf_spot_em()`、`fund_etf_spot_ths()`；代码、名称、市场 | `fund_etf_hist_em(symbol,period,start_date,end_date,adjust)`；分钟 `fund_etf_hist_min_em(symbol,start_date,end_date,period,adjust)`；新浪 `fund_etf_hist_sina(symbol)` | 日/周/月；分钟 5/15/30/60（以函数参数为准，源码默认 5）；H4 派生。 |
| LOF | `fund_lof_spot_em()` | `fund_lof_hist_em(...)`；`fund_lof_hist_min_em(...,period)` | 日/周/月；分钟 5 等；H4 派生。 |
| 开放式/货币/理财/分级基金 | `fund_name_em()`、`fund_open_fund_daily_em()`、`fund_money_fund_daily_em()`、`fund_financial_fund_daily_em()`、`fund_graded_fund_daily_em()` | 多数返回净值（净值/累计净值），不一定有 OHLC；只有明确返回开高低收的场内产品才进入行情目录 | 不应把净值序列伪装成 K 线；通常只能 D1，且无分钟。 |
| 香港基金 | `fund_hk_fund_hist_em` 等 | 主要净值历史，不是 OHLC | 不进入 OHLC 维护目录，除非实测返回四价。 |

因此“基金全量”不能简单等于 `fund_name_em()` 全部名称；目录应标记 `price_series_kind=ohlc` 或 `nav`，只将前者提供自建 K 线维护。

## 债券与可转债

| 类别 | 目录/快照 | 历史 OHLC | 九周期边界 |
|---|---|---|---|
| 沪深可转债 | `bond_zh_hs_cov_spot()`：代码、名称、实时价格 | `bond_zh_hs_cov_daily(symbol)` | 仅 D1；W1/MN 可派生；无已证分钟历史。 |
| 沪深债券 | `bond_zh_hs_spot(start_page,end_page)` 分页；字段含代码/名称/价格 | `bond_zh_hs_daily(symbol)` | 仅 D1；目录页参数有边界，需按页完整刷新并记录页数。 |
| 质押式回购 | `bond_buy_back_hist_em(symbol)` | 日/回购数据，按利率/成交字段，不总是 OHLC | 仅纳入实际含四价的品种。 |
| 银行间债券 | `bond_spot_quote()`、`bond_spot_deal()` | 现券报价/成交，不是标准连续 OHLC 历史 | 不自动纳入 K 线维护；需专门聚合定义。 |
| 国债收益率/指数 | `bond_gb_zh_sina`、`bond_gb_us_sina`、`bond_zh_us_rate` | 利率序列非债券 OHLC | 标记为 rate_series，排除普通 K 线。 |

## 国内期货

### 目录来源

- `futures_symbol_mark()`：官方函数 docstring 称“期货的品种和代码映射”，返回品种中文名/代码。
- `futures_zh_realtime(symbol=品种中文名)`：返回该品种当前全部可交易合约，字段含合约代码、交易所、合约中文名称及 OHLC/成交/持仓。
- `zh_subscribe_exchange_symbol(symbol="cffex"/"shfe"/"dce"/"czce"/"gfex"/...)`：交易所可交易品种。
- `futures_hist_table_em()`：东方财富期货行情交易所品种对照表。

这两层必须分开：品种目录（RB、IF、TA）与当时可交易交割月合约（RB2601、IF2603 等）。官方文档给出遍历 `futures_symbol_mark` 后逐品种调用 `futures_zh_realtime` 获取“所有期货品种的所有合约”，但提示控制频率；这是可枚举的低频目录，不是每次键入搜索。

### 历史接口与周期

| 序列 | 接口 | symbol | 周期 |
|---|---|---|---|
| 连续/主力 | `futures_display_main_sina()`、`futures_zh_daily_sina(symbol="RB0")`、`futures_hist_em(symbol="热卷主连",period="daily",...)` | 交易所连续代码（新浪如 RB0）或东财中文主连名称 | D1；W1/MN 派生。 |
| 具体交割月 | `futures_zh_daily_sina(symbol="RB2601")`、`futures_zh_minute_sina(symbol,period)` | 真实合约代码，来自实时目录 | D1；分钟 1/5/15/30/60；H1；H4/W1/MN 派生。 |
| 交易所日量价 | `get_cffex_daily/get_gfex_daily/get_ine_daily/get_czce_daily/get_shfe_daily/get_dce_daily` | 交易日/交易所，不是单一 symbol 历史 | D1 汇总，不能当作逐合约完整目录。 |
| 东财期货 | `futures_global_spot_em`、`futures_hist_em` | 中文品种/主连名由对照表提供 | 日线为主；分钟能力需按返回字段核验。 |

期货目录包括主力连续与真实交割月；连续合约是供应商人工拼接序列，不得与具体合约混为一项，也不能从连续存在推断每个交割月历史完整。

## 外盘期货与外汇

- 外盘期货目录/快照：`futures_global_spot_em()`、`futures_foreign_commodity_subscribe_exchange_symbol()`、`futures_hq_subscribe_exchange_symbol()`。
- 历史：`futures_global_hist_em(symbol)`、`futures_foreign_hist(symbol)`，源码 docstring 均描述日频；`futures_foreign_commodity_realtime(symbol)` 是实时行情。
- 代码由对应快照/订阅表提供（如 `HG00Y`、`ZSD`）；不能将国内期货的交易所前缀规则套用。
- 周期通常仅 D1；W1/MN 可从 D1 派生，H4 和分钟没有统一已证接口。外盘品种目录是否“全量”取决于上游当天返回集合，应记录快照总数与失败状态。
- 外汇：`forex_spot_em()` 返回所有汇率实时行情，`forex_hist_em(symbol="USDCNH")` 返回历史行情；代码为货币对字符串。源码只给日历史，按 D1 维护，W1/MN 派生；不能承诺 M1-H1。

## 期权

期权必须按交易所/标的分区；没有一个总目录：

- CFFEX：`option_cffex_sz50_list_sina()`、`option_cffex_hs300_list_sina()`、`option_cffex_zz1000_list_sina()` 列出合约；历史 `option_cffex_*_daily_sina(symbol)`。
- SSE：`option_sse_list_sina(symbol="50ETF")` 返回到期月；`option_sse_codes_sina(symbol,trade_date,underlying)` 返回全部认购/认沽代码；`option_sse_spot_price_sina(symbol)` 实时；`option_sse_daily_sina(symbol)` 日线；`option_sse_minute_sina(symbol)` 只能当前交易日分钟，源码 docstring 明确不能获取历史分钟。
- SZSE/商品：`option_current_day_szse()`、`option_margin_symbol()`/`option_comm_symbol()`、`option_commodity_contract_sina(symbol)` 返回品种/合约；`option_hist_dce/czce/shfe/gfex(symbol,trade_date)` 是指定交易日的日行情；`option_commodity_hist_sina(symbol)` 为指定合约日频。
- 代码规则是交易所专属：CFFEX 示例 `ho2303P2350`，SSE 示例数字合约 `10003720`，商品示例 `au2012C392`；不能用股票或期货规则转换。
- 可用周期：D1（指定合约/交易日）；部分 SSE/金融期权当日分钟。W1/MN 可在项目内从 D1 派生，H4 不原生；跨历史日期批量抓取受交易日/接口限流约束。
- “所有合约”只能在每个交易所、每个标的、每个到期月份分别枚举，并保存查询日期；不能宣称一次调用覆盖全部期权。

## 哪些结果可直接进入主干实现

优先实现以下不需要新资产模型的目录/按需历史映射：

1. A/B/H/US 股票、沪深/港股指数：目录快照导入；D1/W1/MN 与 1/5/15/30/60 分钟映射；H4 派生。
2. ETF/LOF：目录快照；D1/W1/MN 和已返回的分钟周期；开放式基金先标记 NAV，不接入 K 线。
3. 国内期货：`futures_symbol_mark` → `futures_zh_realtime` 两级目录；具体合约和主力连续分开；分钟/日线按接口映射。
4. 可转债与沪深债券：目录分页；仅 D1；避免将报价/利率序列伪装 OHLC。
5. 指数、外盘期货、外汇：分别保存 source family 和真实接口；主要先接 D1。
6. 期权：先目录分区与 D1 维护；分钟仅明确当日可用时显示，不承诺历史分钟。

全部目录必须本地读，目录刷新任务不能在用户键入时调用供应商。每个快照保存 `source_endpoint`、`observed_at`、`row_count`、`coverage_status`、`name_origin`；成功整区替换，失败保留上一快照。目录存在不等于九周期可用，选中后才实际请求并记录 `verified_frames`。

## 边界结论

AKShare 1.19.3 可以按上述多个官方目录接口覆盖大量可交易资产，但无法承诺“AKShare 全部 OHLC 品种”由一个清单一次枚举：基金净值、收益率、报价和板块指数混在同一 SDK；部分市场只有分页/按标的/按交易日目录；外盘、期权、债券上游接口的实时集合和历史保留窗口会变动。实现时应显示分区覆盖、时间和失败状态，不把未实现的资产悄悄标为不支持，也不把目录发现等同于全九周期维护能力。

精确本地源码证据（版本锁定）包括：

- `/tmp/mw-akshare-1.19.3/akshare/stock_feature/stock_hist_em.py:952` A 股 D/W/M、`:1042` A 股 1/5/15/30/60 分钟；`:1395` 港股 D/W/M、`:1467` 分钟；`:1688` 美股 D/W/M、`:1758` 近端分时。
- `/tmp/mw-akshare-1.19.3/akshare/stock/stock_info.py:20,122,185,440` 深/沪/北交所与 A 股目录；`stock_zh_b_sina.py:22,124,281` B 股目录、日线、分钟。
- `/tmp/mw-akshare-1.19.3/akshare/futures/futures_zh_sina.py:28,91,139,615,651` 期货品种、全部合约、交易所订阅、分钟、日线。
- `/tmp/mw-akshare-1.19.3/akshare/option/option_finance_sina.py:28-816` 金融期权目录/日/分钟；`option_commodity.py:32-504` 商品期权日行情。
- `/tmp/mw-akshare-1.19.3/akshare/fund/fund_etf_em.py:44,237,320` ETF 目录、日、分钟；`fund_lof_em.py:45,120,190` LOF 同类接口。
- `/tmp/mw-akshare-1.19.3/akshare/bond/bond_zh_cov.py:46,65` 可转债目录/日线；`bond_zh_sina.py:45,118` 沪深债券目录/日线。
