# 供应商与品种类别抽查

日期：2026-11-15。Ubuntu 任务实例，地址及固定镜像见 [主验收记录](../README.md) 与 [部署记录](../deployment.json)。本次只读检查真实目录、身份与添加列表，不据此宣称每个源实时/历史抓取均可用；没有添加/删除真实品种、创建任务或切换实时。

## 覆盖

实际目录包含 6 个采集源、26 个 source/asset_type 组合；选 38 个代表品种，补主要股票市场及新浪/腾讯来源/复权变体。原生接口返回 45 行，自建创建目录返回 38 行；两处 UI 共 76 张截图。37 个样本在添加自选 UI 显示，NVDA 因已有自选被排除；38 个样本在添加自建 UI 均显示。另用 4 组实际查询核对新浪/腾讯的 22 条返回，未混淆来源。

| 采集源 | 类别/市场覆盖 | 样本数 | 添加自选 UI | 添加自建 UI |
| --- | --- | --- | --- | --- |
| akshare | 沪A、深A、港股、期货；额外核对腾讯系列 | 4 | 4 显示 | 4 显示 |
| binance | 加密现货 | 1 | 1 显示 | 1 显示 |
| dukascopy | 外汇、贵金属、股票（港/美/英/日/德）、指数、商品、ETF、基金、债券、加密、OTHER | 14 | 14 显示 | 14 显示 |
| fxcm | 外汇、贵金属、指数、OTHER | 6 | 6 显示 | 6 显示 |
| oanda | 外汇、贵金属、CFD | 5 | 5 显示 | 5 显示 |
| yahoo | 美股、ETF、外汇、指数、期货、加密 | 8 | 7 显示，1 已关注排除 | 8 显示 |

## 发现与修复

1. Dukas `COMMODITY` 已明确是商品，但共享资产大类为 other 时被手机标为待分类：仅修复手机只读分类为“商品”，不改底层资产身份。
2. Dukas 已验证股票市场使用 HK/GB/DE 代码，手机映射缺项：补为港股/英股/德股。
3. OANDA 目录明确 `CFD` 类型却遗漏产品形式：补显示 CFD；底层标的未提供可靠细类时仍标待分类，不凭描述猜成股指或商品。
4. Dukas 实际目录将 ETF 类型归一化后，遗漏 `group=ETF_CFD` 的既有产品形式：沿用项目已确认的 ETF CFD 规则，补显示 CFD，并让自建批量展示读取该只读字段。股票组 `STCK_CFD` 与 `STK_CASH` 不足以确定经核实的合约/所有权，不照此推断股票 CFD。

94 项后端回归通过，构建并仅更新本任务 API；抽查 issues/pageErrors 均为空。修改未涉及分页 SQL、前端样式、报价、sparkline 或订阅策略。

## 元数据边界

- `BUGG.GB/USD`（Dukas）与 `10USNote`（FXCM）目录类型为 OTHER；缺少经确认的产品细类，保留待分类，不从品种名称猜 ETF/债券。
- `AU200_AUD`（OANDA）只能确认 CFD，显示“待分类 / CFD · 模拟 · bid”；其底层股指细类需要目录提供可靠依据。
- 当前没有真实期权、加密永续/交割的目录样本；已有夹具验证只证明 UI 可区分，不能填作真实供源抽查通过。北A 等不存在的市场样本亦不补造。
- 本次窄屏浏览器检查不替代 Android 系统字号、键盘、物理返回或实际行情收发验收。

## 逐样本证据

[机器可读结果](proof.json) 保存目录分组计数、每条样本的代码/类别/供应商/口径、两处 UI 结果和实际上游查询；未保存登录、令牌、账户标识或完整私有配置。

| 来源 | 原始类型 | 代码 | 显示分类 | 自选 UI | 自建 UI |
| --- | --- | --- | --- | --- | --- |
| akshare | EQUITY | HKEX:00001 | 港股 | [通过](screenshots/00-akshare-EQUITY-watch.png) | [通过](screenshots/00-akshare-EQUITY-create.png) |
| akshare | FUTURE | SHFE:RB0 | 期货 | [通过](screenshots/01-akshare-FUTURE-watch.png) | [通过](screenshots/01-akshare-FUTURE-create.png) |
| binance | CRYPTO | 0GBNB | 加密 | [通过](screenshots/02-binance-CRYPTO-watch.png) | [通过](screenshots/02-binance-CRYPTO-create.png) |
| dukascopy | BOND | BUND.TR/EUR | 债券 | [通过](screenshots/03-dukascopy-BOND-watch.png) | [通过](screenshots/03-dukascopy-BOND-create.png) |
| dukascopy | COMMODITY | BRENT.CMD/USD | 商品 | [通过](screenshots/04-dukascopy-COMMODITY-watch.png) | [通过](screenshots/04-dukascopy-COMMODITY-create.png) |
| dukascopy | CRYPTO | ADA/USD | 加密 | [通过](screenshots/05-dukascopy-CRYPTO-watch.png) | [通过](screenshots/05-dukascopy-CRYPTO-create.png) |
| dukascopy | CURRENCY | AED/CNH | 外汇 | [通过](screenshots/06-dukascopy-CURRENCY-watch.png) | [通过](screenshots/06-dukascopy-CURRENCY-create.png) |
| dukascopy | EQUITY | 0005.HK/HKD | 港股 | [通过](screenshots/07-dukascopy-EQUITY-watch.png) | [通过](screenshots/07-dukascopy-EQUITY-create.png) |
| dukascopy | ETF | 2822.HK/HKD | ETF | [通过](screenshots/08-dukascopy-ETF-watch.png) | [通过](screenshots/08-dukascopy-ETF-create.png) |
| dukascopy | FUND | IE0005023803.FN/EUR | 基金 | [通过](screenshots/09-dukascopy-FUND-watch.png) | [通过](screenshots/09-dukascopy-FUND-create.png) |
| dukascopy | INDEX | AUS.IDX/AUD | 指数 | [通过](screenshots/10-dukascopy-INDEX-watch.png) | [通过](screenshots/10-dukascopy-INDEX-create.png) |
| dukascopy | METAL | XAG/USD | 贵金属 | [通过](screenshots/11-dukascopy-METAL-watch.png) | [通过](screenshots/11-dukascopy-METAL-create.png) |
| dukascopy | OTHER | BUGG.GB/USD | 待分类 | [通过](screenshots/12-dukascopy-OTHER-watch.png) | [通过](screenshots/12-dukascopy-OTHER-create.png) |
| fxcm | CURRENCY | AUD/CAD | 外汇 | [通过](screenshots/13-fxcm-CURRENCY-watch.png) | [通过](screenshots/13-fxcm-CURRENCY-create.png) |
| fxcm | INDEX | AUS200 | 指数 | [通过](screenshots/14-fxcm-INDEX-watch.png) | [通过](screenshots/14-fxcm-INDEX-create.png) |
| fxcm | METAL | RKG/CNH | 贵金属 | [通过](screenshots/15-fxcm-METAL-watch.png) | [通过](screenshots/15-fxcm-METAL-create.png) |
| fxcm | OTHER | 10USNote | 待分类 | [通过](screenshots/16-fxcm-OTHER-watch.png) | [通过](screenshots/16-fxcm-OTHER-create.png) |
| oanda | CFD | AU200_AUD | 待分类 | [通过](screenshots/17-oanda-CFD-watch.png) | [通过](screenshots/17-oanda-CFD-create.png) |
| oanda | CURRENCY | AUD_CAD | 外汇 | [通过](screenshots/18-oanda-CURRENCY-watch.png) | [通过](screenshots/18-oanda-CURRENCY-create.png) |
| oanda | METAL | XAG_AUD | 贵金属 | [通过](screenshots/19-oanda-METAL-watch.png) | [通过](screenshots/19-oanda-METAL-create.png) |
| yahoo | CRYPTOCURRENCY | 000660-USD | 加密 | [通过](screenshots/20-yahoo-CRYPTOCURRENCY-watch.png) | [通过](screenshots/20-yahoo-CRYPTOCURRENCY-create.png) |
| yahoo | CURRENCY | EURUSD=X | 外汇 | [通过](screenshots/21-yahoo-CURRENCY-watch.png) | [通过](screenshots/21-yahoo-CURRENCY-create.png) |
| yahoo | EQUITY | AAPL | 美股 | [通过](screenshots/22-yahoo-EQUITY-watch.png) | [通过](screenshots/22-yahoo-EQUITY-create.png) |
| yahoo | ETF | QQQ | ETF | [通过](screenshots/23-yahoo-ETF-watch.png) | [通过](screenshots/23-yahoo-ETF-create.png) |
| yahoo | FUTURE | CL=F | 期货 | [通过](screenshots/24-yahoo-FUTURE-watch.png) | [通过](screenshots/24-yahoo-FUTURE-create.png) |
| yahoo | INDEX | ^DJI | 指数 | [通过](screenshots/25-yahoo-INDEX-watch.png) | [通过](screenshots/25-yahoo-INDEX-create.png) |
| dukascopy | EQUITY | AAPL.US/USD | 美股 | [通过](screenshots/26-dukascopy-EQUITY-watch.png) | [通过](screenshots/26-dukascopy-EQUITY-create.png) |
| dukascopy | EQUITY | VOD.GB/GBX | 英股 | [通过](screenshots/27-dukascopy-EQUITY-watch.png) | [通过](screenshots/27-dukascopy-EQUITY-create.png) |
| dukascopy | EQUITY | 7203.JP/JPY | 日股 | [通过](screenshots/28-dukascopy-EQUITY-watch.png) | [通过](screenshots/28-dukascopy-EQUITY-create.png) |
| dukascopy | EQUITY | ADS.DE/EUR | 德股 | [通过](screenshots/29-dukascopy-EQUITY-watch.png) | [通过](screenshots/29-dukascopy-EQUITY-create.png) |
| akshare | EQUITY | SZSE:300750 | 深A | [通过](screenshots/30-akshare-EQUITY-watch.png) | [通过](screenshots/30-akshare-EQUITY-create.png) |
| akshare | EQUITY | SSE:688256 | 沪A | [通过](screenshots/31-akshare-EQUITY-watch.png) | [通过](screenshots/31-akshare-EQUITY-create.png) |
| yahoo | EQUITY | NVDA | 美股 | [已关注排除](screenshots/32-yahoo-EQUITY-watch.png) | [通过](screenshots/32-yahoo-EQUITY-create.png) |
| yahoo | CRYPTOCURRENCY | BTC-USD | 加密 | [通过](screenshots/33-yahoo-CRYPTOCURRENCY-watch.png) | [通过](screenshots/33-yahoo-CRYPTOCURRENCY-create.png) |
| oanda | CURRENCY | EUR_USD | 外汇 | [通过](screenshots/34-oanda-CURRENCY-watch.png) | [通过](screenshots/34-oanda-CURRENCY-create.png) |
| oanda | METAL | XAU_USD | 贵金属 | [通过](screenshots/35-oanda-METAL-watch.png) | [通过](screenshots/35-oanda-METAL-create.png) |
| fxcm | CURRENCY | EUR/USD | 外汇 | [通过](screenshots/36-fxcm-CURRENCY-watch.png) | [通过](screenshots/36-fxcm-CURRENCY-create.png) |
| fxcm | METAL | XAU/USD | 贵金属 | [通过](screenshots/37-fxcm-METAL-watch.png) | [通过](screenshots/37-fxcm-METAL-create.png) |
