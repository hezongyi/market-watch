# 目录完整性与九周期实施核验补充

> 范围修订（2026-11-09）：AKShare 行情及清单仅限项目原来已实现的新浪、腾讯接口范围；其他市场新适配不属于本次任务。执行与验收以[修订方案](../provider-catalog-on-demand-scope-20261109.md)为准。

2026-11-09，基线 f111d3a6。补充前次研究；本次只请求有限公开目录/文档/源码，未读取账户凭据、未连接项目实例或数据库、未扫描 K 线、未修改应用代码。范围固定为 M1/M5/M15/M30/H1/H4/D1/W1/MN；用户要先维护已确认范围内的完整目录、选中后按需获取行情。

## 立即可用：Dukascopy 官方动态目录

官方入口与代码调用链：

1. <https://www.dukascopy.com/swiss/english/marketwatch/historical/> 内嵌 `https://widgets.dukascopy.com/en/historical-data-export`。
2. <https://widgets.dukascopy.com/en/historical-data-export> 引用主程序 <https://widgets.dukascopy.com/en/main-I75YU6CR.js>。
3. 主程序的 `historical-data-export` 路由加载 <https://widgets.dukascopy.com/en/chunk-C1Ud2bUn.js>；其目录服务 `instrumentList(){return this.#t.get("/instruments")}`。
4. HTTP 服务 <https://widgets.dukascopy.com/en/chunk-HM45NA9V.js> 从配置读取 `JETTA_SERVER_URL`，路径构造为 `server + '/v1/' + path`。
5. 公开配置 <https://widgets.dukascopy.com/config.json> 返回 `JETTA_SERVER_URL=https://jetta.dukascopy.com`。
6. 真实目录：**<https://jetta.dukascopy.com/v1/instruments>**。

### 实测协议与结构

需要常规浏览器 UA、公开 Origin/Referer 和 Accept；这些不是凭据。无 token/cookie 登录。

```python
req = urllib.request.Request(
    'https://jetta.dukascopy.com/v1/instruments',
    headers={
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://widgets.dukascopy.com',
        'Referer': 'https://widgets.dukascopy.com/',
    },
)
```

同地址无 Origin/Accept 的初次请求返回 200 空响应；不能把空响应当作成功空目录。加以上 headers 后两次均成功，**200、377,438 字节、Cache-Control public,max-age=86400**。

本次响应 SHA256：`018e8d9acfd0bdbbbe377926390f127b24a1f9535a4e12e9c9f4de24ad960517`。

顶层：`instruments, groups, platformGroups, sectors, webGroups, platforms`。

- `instruments`：**1,504 条，1,504 个唯一 name**；无需分页参数。
- `groups`：45 条；字段 `id, code, description, sortOrder, parentId, countryCode, countryName`。
- instrument 字段：`id, name, code, description, pipValue, priceScale, countryCode, groupId, platformGroupId, webGroupId, sectorIds, rating`。

示例（来自供应商真实目录）：

```json
{"name":"EUR/USD","code":"EUR-USD","description":"Euro vs US Dollar","pipValue":0.0001,"priceScale":5,"groupId":18,"platformGroupId":"FX_MAJOR","countryCode":"DE"}
{"name":"AAPL.US/USD","code":"AAPL.US-USD","description":"APPLE INC","pipValue":0.01,"priceScale":3,"groupId":47,"platformGroupId":"STK_CASH","countryCode":"US"}
{"name":"SAR/HKD","code":"SAR-HKD","description":"Saudi Riyal vs Hong Kong Dollar","pipValue":0.0001,"priceScale":5,"groupId":17,"platformGroupId":"FX_CROSS","countryCode":"SA"}
{"name":"DEU.IDX/EUR","code":"DEU.IDX-EUR","description":"Germany 40 Index","pipValue":0.01,"priceScale":3,"groupId":23,"platformGroupId":"IDX_CASH","countryCode":"DE"}
```

`priceScale` 是小的整数精度字段，例如外汇5、股票3，**不是 100000 等价格分母**。可以保留为来源价格精度/显示信息，不能将其当作价格舍入指令或用它改写已获取数值。本次没有取得独立 Jetta 字段规范，价格解析仍保持现有 SDK 原值路径。

根组（下级通过 parentId 递归关联）：

| id | code | description |
|---|---|---|
| 3 | FX | Forex |
| 4 | CMD | Commodities CFD |
| 5 | IDX | Indices CFD |
| 6 | BND_CFD | Bonds CFD |
| 7 | STCK_CFD | Stocks CFD |
| 8 | ETF_CFD | ETF CFD |
| 9 | VCCY | Crypto CFD |

资产分类应由根组得出，不从 name 后缀猜产品类型；尤其债券 CFD、指数 CFD、ETF CFD 不应误标成实物/现货。中文描述可采用人工稳定词典翻译通用组/外汇货币，供应商英文公司名原样保留；不能编造官方中文名。

### 与 SDK 身份直接兼容

项目锁定 dukascopy-python 4.0.1（requirements.lock:57）。本次从 PyPI 该版本 sdist 读取源码：

- 版本来源：<https://pypi.org/pypi/dukascopy-python/4.0.1/json>
- SDK `dukascopy_python/instruments.py` 内 AAPL 是 **`AAPL.US/USD`**，EURUSD 是 **`EUR/USD`**。
- SDK `dukascopy_python/__init__.py:134-170` 的 `_fetch(instrument, interval, ...)` 将任意传入 instrument 原样放入 `chart/json3` query；没有要求必须命中 instruments 常量的成员检查。
- 本地 `backend/alerts/dukascopy_history.py:107` 将 `identity.provider_symbol` 传入 SDK；`backend/alerts/provider_dukascopy.py:119` 继续使用同一 SDK 请求构造。

因此**直接采用 Jetta 的 `name` 作为 provider_symbol**，可保留 stable_id(name) 规则并进入现有 SDK 请求构造。不要用 Jetta `code`（横线格式）作为旧 JSON3 instrument，不要用删除标点后的数据 feed 名称强行猜回来源身份。

本次比较：Jetta 1,504 个 name 中 **329 个不在旧 SDK 常量**；SDK 中 **205 个常量不在当前 Jetta 目录**。不在当前目录的旧名字不能自动删除，可能是旧产品或历史引用；保留已存身份/数据并标记最近目录状态。对新 name 的真实可取周期在首次用户请求时处理，本次未执行新标的 K 线探测。

### 可选历史覆盖元数据（不能替代当前目录）

官方 <https://www.dukascopy.com/datafeed/metadata/HistoryStart.bi5> 单次请求返回 123,823 字节。按以下大端结构完整消费文件得到 **1,512 条**：

```
uint16 symbol_utf8_length
bytes[symbol_utf8_length] symbol
uint64 periods_count
repeat periods_count:
    uint64 period_ms
    uint64 earliest_epoch_ms
```

示例 SARHKD 的 period 包含 0（tick）、60000、3600000、86400000，并给各自最早时间。注意该二进制格式是本次依据真实文件解析出的观察，不是正式稳定 API 规范。

将 name/code 去标点转大写后关联：Jetta 与 metadata 有 1,503 条交集；metadata 有9条未在当前目录，Jetta有1条未在metadata。历史 metadata 是历史可用范围，当前 Jetta 是当前官方导出工具列出的目录；不能要求两者完全一致才能同步，也不能把二进制名单直接替代当前可访问目录。

## Yahoo：真实分页、截断和无法承诺的边界

### 已找到的加密货币目录

官方 <https://finance.yahoo.com/markets/crypto/all/> 的服务端内嵌 `data-sveltekit-fetched` JSON 给出真实调用：

<https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=ALL_CRYPTOCURRENCIES_US&count=1&start=0&useRecordsResponse=true>

该公开地址本次直接 200。官方页面默认 count=25，总数 **8,092**；<https://finance.yahoo.com/markets/crypto/all/?start=25&count=25> 返回 start=25、同 total。列表字段在 `finance.result[0].records`，品种代码为 `ticker`、名称为 `companyName`，不要假定字段只能是 quotes/symbol。

该 screener 的 rawCriteria 是：

```json
{"quoteType":"CRYPTOCURRENCY","query":{"operator":"and","operands":[{"operator":"eq","operands":["currency","USD"]},{"operator":"eq","operands":["exchange","CCC"]}]}}
```

所以它是 CCC 交易源的 **USD 报价品种**目录；不代表 EUR、GBP、BTC 等所有计价方式。不能标成 Yahoo 全加密目录。猜测小写 `all_cryptocurrencies` 的 scrIds 会404，不能据此否定实际存在的全 USD screener。

### 已证实 10,000 条结果截断

官方股票筛选页：<https://finance.yahoo.com/research-hub/screener/equity/?start=10000&count=25>。

它内嵌的服务端响应给出 total=**19,773**，rawCriteria region=us，requested offset=10000，但 returned start=**9,975**，count=25。

进一步两次有限公开请求：

- <https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=equity&count=25&start=15000&useRecordsResponse=true>
- <https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=equity&count=25&start=9975&useRecordsResponse=true>

均返回 start=9,975、count=25、total=19,773，前两个 ticker 均是 ECXJ/JMDMF。**超过 10,000 并非返回下一页，而是返回最后可访问页**。只循环 offset 会造成重复/假完成甚至无限循环。

可实施策略：按 quoteType + region + exchange 构造明确分区；超过上限时需要再分片，验证分片规则覆盖全集且互斥/可去重，按每片 reported total 与实际唯一数量验收。不得用价格/市值/成交量都必须存在等过滤不加说明地排除未知值品种。SDK 已有 EquityQuery/FundQuery/ETFQuery 不能证明所有其他类型也支持同等筛选。

### 指数、外汇、商品页并非完整目录证据

本次读取官方页面，其服务端请求是预设 symbols 列表：

- <https://finance.yahoo.com/markets/currencies/>：公开页 quote 列表25个。
- <https://finance.yahoo.com/markets/world-indices/>：46个。
- <https://finance.yahoo.com/markets/commodities/>：37个。

这些页面可作为额外发现来源，**没有枚举供应商全部外汇交叉盘、全部指数、全部期限商品/期货合约的证据**。当前 SDK 搜索又是 bounded text search，不能通过有限几个关键词证明全集。

### 可执行结论

在**目前已验证的公开免费接口**范围内，不能对用户承诺“已覆盖 Yahoo 供应商全部可查询品种”。具体未证明的边界包括：非 USD 的全部加密计价、全部外汇交叉盘、全部指数、全部交割月期货/商品合约、固定收益与其他报价类型、退市但仍可查询的历史品种，以及全球股票/ETF/基金分片是否确实完成而无遗漏。

这不是“这些接口永远不存在”或“这些品种不支持”的结论；它是本次不能给出全集可枚举证明。可以实施本地目录与明确来源/分区同步，标记覆盖范围和未完整状态，并保留显式在线精确代码发现/补录。**显式补录只补救缺失，不是全量目录达标证据**。主搜索每次击键不能等待 Yahoo 请求。

## FXCM：现有 helper 已遍历完整会话 Offers 响应

`adapters/fxcm/history.cpp:178-197`：

1. 若 `loginRules.isTableLoadedByDefault(Offers)`，读 `getTableRefreshResponse(Offers)`。
2. 否则 `createRefreshTableRequest(Offers)` 后等待完整 response。
3. `createOffersTableReader(reply)`，遍历 `i=0..offers->size()-1`。
4. 只跳过空行、Instrument/Digits 无效行；没有 subscriptionStatus、资产类型或固定符号过滤。

该流程与 FXCM 官方固定提交文档完全一致：

- <https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GOffersTableResponseReader.html>
- <https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GRequestFactory.createRefreshTableRequest.html>
- <https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/TTOffers.html>

官方 `getSubscriptionStatus` 的 T/D/V 是“价格更新可用 / 不可用 / 仅供交叉计算，不供交易”：
<https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/docs/help/CPlusPlus/IO2GOfferRow.getSubscriptionStatus.html>。

因此不能因为实时更新未订阅 D 而排除历史目录。当前 helper 本身没有此过滤；`NoPrice` 与无 table manager 也未被用于过滤目录条目。

可承诺**当前配置 Demo 会话返回的完整 Offers 表**，不外推其他监管地区或账户。Python `backend/alerts/fxcm_history.py:205` 单次读取上限10,000，达到上限应保留不完整状态而非默默当成全部；当前真实账户数量本次未请求。

当前 helper 只输出 symbol/digits/instrument_type，中文和产品描述需在本地另维护。若要保留 subscription/tradable 状态可增加元字段，但不得改变会话不订阅推送的边界。

## 九周期边界

| 来源/现有通道 | 九周期内的来源原生周期 | 实施含义 |
|---|---|---|
| OANDA v20 candles | M1 M5 M15 M30 H1 H4 D1 W1 MN | 官方粒度枚举含 M、对应系统 MN；按既有账户、对齐与 Bid 口径处理。 |
| Binance 现货 klines | M1 M5 M15 M30 H1 H4 D1 W1 MN | 官方 interval 1m/5m/15m/30m/1h/4h/1d/1w/1M。目录完整与自建适配接入分开。 |
| Dukascopy JSON3 | 当前 adapter 映射九周期全部 | 本地 provider_dukascopy.py:24 明确 1MIN..1MONTH；Jetta 当前目录不是每个符号九周期历史全存在的保证。 |
| FXCM ForexConnect | 会话 TimeframeCollection 决定，可映射九周期 | helper history.cpp:199-208 列举全部会话周期、bars 215-220 只接受项目九周期；timeframe query_depth>0 才可用。 |
| Yahoo | M1 M5 M15 M30 H1 D1 W1 MN；**无已证原生 H4** | 官方 yfinance history 源码声明 30m，当前项目 YAHOO_INTERVALS 尚未加 M30；H4 若需要应明确作为可选自建派生，不能伪称原生4h。分钟保留窗口按真实来源处理。 |
| AKShare 当前新浪股票通道 | D1，W1/MN 可从 D1 基础派生 | 默认 A/H 新浪现有适配只允许D1；不能因其他 AKShare 通道有分钟能力就把当前通道标成支持。 |
| AKShare 当前新浪国内期货 | M1 M5 M15 M30 H1 D1 | 当前 endpoint 不提供原生 H4/W1/MN；需按支持范围选择或明确派生模式，不能虚构原生接口。其他市场新适配按接口真实能力记录。 |

OANDA 原生粒度一手文档：<https://developer.oanda.com/rest-live-v20/instrument-df/#CandlestickGranularity>。
Binance interval 一手文档：<https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#klinecandlestick-data>。
Yahoo 锁定 SDK 及能力源码：<https://raw.githubusercontent.com/ranaroussi/yfinance/1.7.0/yfinance/scrapers/history.py>；当前本地 `backend/alerts/provider_capabilities.py:10`。
AKShare 官方接口文档链接及本地 endpoint 限制见前篇 `provider-full-catalog-feasibility-20261109.md`，本地 `backend/alerts/provider_akshare.py:64`。

这里“可维护”不要求供应商每个品种都提供九周期。对每个品种保留供应商真实周期、来源保留窗口；能派生时明确基础周期与派生语义，仅为用户选中的品种获取数据。
