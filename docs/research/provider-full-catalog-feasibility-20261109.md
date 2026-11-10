# 六源完整可访问目录：可行性与边界核验

> 范围修订（2026-11-09）：本文为研究时点记录。用户已接受 Yahoo 公开分区覆盖边界，并将 AKShare 行情及清单收敛到项目原来已实现的新浪、腾讯接口范围；本文 AKShare 全市场扩展建议不再执行。当前范围和验收以[修订方案](../provider-catalog-on-demand-scope-20261109.md)为准。

日期：2026-11-09。基线：`f111d3a6`（v2.0.0）。本次仅阅读本地代码及有限数量的一手文档/SDK 源码，未连接有凭据的供应商账户、未扫描全品种、未采集 K 线、未修改运行实例。

## 用户目标与实现含义

用户要的是**全品种目录自动维护、本地快速检索、中文描述、选中后按需获取/维护行情**；并非提前下载所有品种的行情，也不要求后台逐个品种探测全部周期。

目录完整性和行情能力必须分别记录：目录枚举成功说明本次获得某来源/账户/市场的全部枚举结果；不能因此保证每个品种存在任意周期、任意年份的数据。目录可以完整导入而能力只在用户选择后核验。不能用“能力未预先验证”排除目录项目。

## 结论

1. 本地持久目录、后台定时刷新、中文搜索和按需行情均可实现；现有 MarketCatalog 是直接可复用的起点，无需另建供应商框架。
2. 当前代码确实限制了目录和品种范围；不仅缺按钮。Yahoo 的 20 条搜索结果、Dukascopy SDK 常量、AKShare 三市场/连续合约不能直接宣称供应商全量。
3. OANDA 可以承诺**配置账户可交易目录的完整快照**；Binance 可以承诺**所接现货 API、明确权限及状态范围的完整目录**。这些都不是供应商集团所有业务/地区/产品。
4. Yahoo 可以扩大为按市场/资产分片的分页目录，但本次证据不足以保证其所有可查询资产的无遗漏枚举。必须暴露实际覆盖范围，并提供独立的“补录/在线发现缺失代码”动作，不能把普通输入框每次击键变成供应商搜索。
5. AKShare 不是一个单一目录服务。官方接口分别提供 A 股、港股、美股、B 股、指数、国内期货等不同宇宙；支持“全部 AKShare 可获取行情品种”需要逐市场目录与历史适配，不可能仅刷新当前 a/hk/futures 达成。

Yahoo 的实施边界已由用户确认：不纳入沪深京 A 股或港股（H 股）目录。其他 Yahoo 分区仍需以实际可验证的分页总数和覆盖记录为准。

## 一手证据：Yahoo

### 本地现状

- `backend/alerts/yahoo_catalog.py:29` 从固定 ALIASES 种子初始化。
- `backend/alerts/yahoo_catalog.py:179` 的 search 通过远端发现少量品种后存入本地，不是完整目录同步。
- `backend/alerts/provider_yahoo.py:296` 使用 `yf.Search(max_results=20)`；311 行再次切片到 20。
- `backend/alerts/provider_yahoo.py:194` 的 `allowed()` 仅允许 INDEX/ETF/EQUITY/CURRENCY/FUTURE；200-201 行进一步仅允许美国交易所的 EQUITY/ETF，拒绝 `.HK/.SS/.SZ/.BJ`。
- 因此即使远端能搜到全球股票、加密货币或共同基金，现有接入也会过滤；“全目录”必须同时解除首期人为范围，并增加相应资产与行情语义。不能只把清单扩大而仍让已显示品种无法使用。
- `backend/alerts/provider_capabilities.py:10` 的现有 Yahoo 周期是 M1/M5/M15/H1/D1/W1/MN；供应商周期和本项目已接周期不能混称。

### 上游证据

- yfinance **与本项目锁定版本相同的 1.7.0** `screen()` 实现：
  <https://raw.githubusercontent.com/ranaroussi/yfinance/1.7.0/yfinance/screener/screener.py>
  支持 `offset` 和 `size`；单页 `size/count` 最大 250；将 EquityQuery/FundQuery/ETFQuery 映射为 EQUITY/MUTUALFUND/ETF；默认参数是英文 `lang=en-US`。这证明**分页筛选存在**，并不证明其可无遗漏枚举所有 INDEX/CURRENCY/FUTURE/CRYPTOCURRENCY/BOND 或全部退市品种。
- SDK 参考页：<https://ranaroussi.github.io/yfinance/reference/api/yfinance.screen.html>
- yfinance `Search` 源码（上游 main，研究时读取，非本项目版本承诺）：
  <https://raw.githubusercontent.com/ranaroussi/yfinance/main/yfinance/search.py>
  使用 `/v1/finance/search`、查询文本及 `quotesCount`，该接口是搜索而非全目录分页。
- yfinance History 实现：
  <https://raw.githubusercontent.com/ranaroussi/yfinance/main/yfinance/scrapers/history.py>
  声明多种 interval 和 intraday 保留限制。代码可下载不是供应商对永久历史或全资产统一周期的保证；首次按需获取应保留实际请求结果/限制。

### 可以承诺的范围和不能承诺的内容

- 可承诺：将已定义市场/资产筛选的所有分页取完，记录每片 advertised total、实际去重数、完成时间和失败状态；补录精确代码也进入本地目录。
- 未核实：Yahoo 对全球所有资产提供一个统一、稳定、官方受支持的完整枚举 API。本次不能声称“没有这种 API”，也不能声称现有 screener 已证明覆盖所有。
- 需要后续 bounded integration：全球各股票市场/基金/ETF 的有效分片、分页上限或截断、稳定排序、无 price/volume 等隐含过滤导致的遗漏；其他资产目录的真实来源与总量。
- 如果尚未实现完整枚举，对用户显示“已收录数量 + 覆盖市场 + 最近成功同步 + 不完整来源”，并保留明确的在线发现缺失代码入口；不得标记为“全部”。

## 一手证据：AKShare

### 本地现状

- `backend/alerts/akshare_catalog.py:108` 仅刷新 A 股 `stock_info_a_code_name`、港股 `stock_hk_spot`、期货 `futures_display_main_sina`。
- `backend/alerts/akshare_catalog.py:115` 读取 `code/代码/symbol`，116 行标签只读 `name/名称`。官方 stock_hk_spot 字段是**中文名称**，因此现有港股目录可能只显示代码。这是可直接修复的字段映射问题。
- `backend/alerts/akshare_catalog.py:125` 期货 exchange 映射未包含 INE，尽管 `backend/alerts/provider_akshare.py:30` 接受 INE。需核验源返回 INE 还是 SHFE，不能无依据改写归属。
- `backend/alerts/provider_akshare.py:39` symbol_rules 只实现 SSE/SZSE/BSE 六位股票、HKEX 五位股票、国内期货格式；没有美股、B 股单独资产语义、指数、基金、债券或期权适配。
- `backend/alerts/provider_akshare.py:64` endpoint 按 source_family 选择行情接口；当前 A/H 默认新浪 D1、国内期货 D1/分钟等实际限制仍要保留。

### 官方目录/行情文档

股票文档：<https://github.com/akfamily/akshare/blob/main/docs/data/stock/stock_quote.md>

- `stock_zh_a_spot_em`：描述沪深京 A 股全量快照。
- `stock_hk_spot`：所有港股快照，字段包含 `代码` 和 `中文名称`。
- `stock_hk_spot_em`：最近交易日所有港股。
- `stock_us_spot_em` / `stock_us_spot`：文档称美股所有上市公司快照。
- B 股、粉单、退市板块也分别有接口；“官方文档称所有”是该接口范围的声称，不能替代运行时分页和完整性核验。
- 美股历史 `stock_us_hist` / `stock_us_daily` 有单独代码和复权语义，当前 adapter 没有接入。

期货文档：<https://github.com/akfamily/akshare/blob/main/docs/data/futures/futures.md>

- `futures_display_main_sina` 被明确称为**新浪主力连续合约品种一览表**。当前目录不是全部交割月合约。
- `futures_symbol_mark()` 提供所有期货品种命名表。
- `futures_zh_realtime(symbol=品种中文名)` 返回该品种的合约代码、交易所、合约中文名称。
- 官方给出“所有期货品种的所有合约”示例：遍历 futures_symbol_mark 后按品种调用 futures_zh_realtime，并提醒获取频率。适合低频目录同步，**无需请求 K 线**。
- futures_zh_minute_sina 对具体合约有分钟接口；日线的具体/连续合约支持仍应按接口真实行为核验，不从目录存在推断。

指数文档：<https://github.com/akfamily/akshare/blob/main/docs/data/index/index.md>。它直接说明 AKShare 的可查询资产范围超出当前 A/H/国内期货三类；若用户要求全 AKShare 行情，指数等不能无说明略去。

### 可实施方式

- 先建立显式的 AKShare 行情目录分区表（例如国内股票、港股、美股、指数、ETF/基金、债券、国内/国际期货、期权等，具体以官方实际行情接口为依据）；每区记录目录接口、行情接口、代码规则和中文字段。
- 按目录接口做低频、分页/按品种遍历。官方不提供中文名时保留原名及人工中文描述，不伪造官方中文。
- 所有发现项目入目录；只对用户选中的项目按支持周期拉行情，不能为目录刷新遍历历史。
- 本研究没有逐一验证每个 AKShare 数据接口、全球资产完整性和实时可达性，不能在此承诺一轮开发即全覆盖。

## 其他四源：已证实边界及待核验

| 源 | 可以定义的完整目录边界 | 证据与限制 |
|---|---|---|
| OANDA | 当前环境/账户可交易品种 | 官方 <https://developer.oanda.com/rest-live-v20/account-ep/> 的 GET /v3/accounts/{accountID}/instruments 明确目录依赖账户监管分区。不能将其他地区账户品种算为缺失。 |
| Binance | 所接现货 API 的权限/状态范围 | 官方 <https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#exchange-information> 描述 exchangeInfo。未传 permissions 默认暴露 SPOT/MARGIN/LEVERAGED 中的品种；明确 SPOT 或完整权限范围，保留 HALT 等状态，不用“未交易”直接删目录。合约、期权、地区站不属于同一个现货端点。 |
| Dukascopy | 需改为供应商真实可访问目录并验证覆盖 | 当前 `backend/alerts/provider_dukascopy.py:33` 从 dukascopy-python 常量构造列表，52 行已写 coverage_not_verified，且 LRU 缓存。SDK 常量完整只代表 SDK 发布清单。对 <https://freeserv.dukascopy.com/2.0/?path=common/instruments> 的单次公开探测返回 429，不能据此认定端点不存在，也没有获得动态完整目录证据。 |
| FXCM | 当前环境/登录权限的 Offers 目录；检查是否受订阅过滤 | `backend/alerts/fxcm_history.py:205` 已有 catalog helper，218 行有会话周期目录。需继续核验 helper 真正枚举全 Offers 还是仅订阅集合；本次未登录账户，未获得供应商完整性实证。不能宣称已证明全 FXCM 账户目录完整。 |

## 中文描述和快速读取的验收建议

- 主键仍是 source + source symbol（账户源保留 scope），中文字段不能改变身份或合约代码。
- 分开保存 supplier_name、name_zh、name_zh_origin；优先原始中文名，其次稳定词典/人工描述。外文公司名缺少可靠中文时保留外文名并提供中文市场/资产描述，不能生成假译名。
- 普通列表和搜索只读本地目录，禁止等待供应商或逐项获取元数据；按源、资产、代码、名称、中文关键词检索和分页。
- 当前 `backend/alerts/platform_catalog.py:26` 读取全部 MarketCatalog，86 行 Python 过滤排序，92 行才分页。小清单可用；全市场需要移到 SQL WHERE/ORDER/LIMIT，并为代码前缀/中文名称检索建立适合的索引，避免全部目录反复序列化。
- 目录同步先完成本批再发布新快照；失败保留上次可用目录并显示最近成功时间。局部失败不得把未返回项目批量删掉；只在完整分区刷新成功后更新下架状态。
- 可测目标：已同步完整样本上，本地列表/代码检索 p95 < 1 秒；测试提供至少与实际总量同数量级的数据，覆盖中文、精确代码和分页。目录同步期间仍能正常读取。
- 目录定期刷新不自动注册任何行情维护任务。选择品种后才拉真实元信息/周期能力并启动所需维护，保留供应商真实保留窗口。

## 本次核验局限

一手源码有明确行为证据，当前锁定 yfinance 1.7.0 screen 源码已读取；AKShare 官方文档及其他上游 main 是研究日可见内容，不能替代锁定 AKShare 1.19.3 的集成测试。公开 Yahoo screener 页面请求遇 TLS 失败、Dukascopy 目录请求遇 429、猜测的 FXCM 示例 URL 与 AKShare tag URL 返回 404，均未据此得出不存在的结论。未做无界网络扫描、未读取凭据、未修改数据库或运行服务。
