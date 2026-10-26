# A 股与港股日线备用源评估

评估日期：2026-10-25 UTC
范围：仅评估 A 股与港股 D1 行情。聚焦现有 AkShare 东方财富来源故障时的备选，包括腾讯、新浪、Tushare，以及现有 yfinance 接入是否可直接用于港股。未改业务代码或验收实例。

## 结论

- **A 股短期日线候选：腾讯证券（AkShare `stock_zh_a_hist_tx`）排第一。** 2026-10-25 当前开发出口探针中，`SZSE:000001` 和 `SSE:600000` 分别请求 2026-10-01 至 2026-10-23，均返回 12 行及预期英文字段。它与当前不可用的东方财富 `stock_zh_a_hist` 是不同上游。该探针只证明该时点开发出口可达且能解析响应，未验证复权、成交量单位、数值质量或 `mwa` 验收实例。
- **A 股替代候选：新浪 `stock_zh_a_daily`。** 官方 AkShare 源码明确支持日线、qfq/hfq 和复权因子，但源码也警告大量抓取容易封 IP；本轮没有当前出口实测，优先级低于已有腾讯探针。
- **港股日线候选：AkShare `stock_hk_daily`（新浪）排第一。** 最新开发出口探针中，`00700`、不复权返回 5,499 行，覆盖 2004-06-16 至 2026-10-23，包含 date/OHLC/volume/amount 字段且尾部 OHLC 合理。旧的多年度 OHLC 失败证据与此复测冲突，应视作过期或针对旧数据/旧口径的失败记录；最新探针目前只覆盖一只股票的一种复权值，不能据此宣布港股整体验收通过。
- **现有 Yahoo `yfinance` 不能原样用于港股。** Yahoo 上游使用的港股代码形如 `0700.HK`，但项目现有 Yahoo 适配器将港股标的排除在允许范围外。用户已确认 Yahoo 使用 yfinance 且不需要重做，因此本评估不建议重写或扩展 Yahoo 适配器；只记录它目前不能直接承接项目港股请求。
- **Tushare Pro 作为有账户/权限的正式替代备选。** 官方文档提供 A 股日线、港股日线和单独的港股复权行情接口；覆盖广，但港股历史日线需单独开通权限。使用前需确认账户权限、积分/费用和项目数据展示/缓存授权，本轮未测试 token 或数据响应。

建议先分别对腾讯 A 股、AkShare 新浪港股单只样本做字段及数值核验，并保持供应商身份独立；若需要可管理的商业数据服务，再评估 Tushare 权限和授权。所有来源切换都应显式进行，失败不能映射为空数据成功，也不要在同一历史序列中无标记混合不同来源。

## 项目约束

- 项目当前 A 股适配身份为 `eastmoney-a`，D1 endpoint 是 `stock_zh_a_hist`；港股 D1 走 `stock_hk_daily`，来源身份为 `sina-hk`。参见 [provider_akshare.py](../../../backend/alerts/provider_akshare.py)。更换供应商时须建立独立来源身份，不能复用原 endpoint 或 provenance。
- 项目适配器目前把 A 股 volume 按 lots 解释、港股按 shares 解释。腾讯 AkShare 源码称返回 volume 为股并对部分板块自行换算；AkShare 新浪 A/HK 源码返回接口原始 volume。上线前须确认每个源的单位与项目契约一致。
- 本产品当前只要求 D1，因此分钟历史、原生周/月覆盖不作为本次排名标准。
- 本报告的网络探针均为开发出口的观察，不等价于 `mwa` 长期验收实例测试、供应商 SLA 或数据质量验收。

## 候选排序

| 市场/顺位 | 候选 | 已知覆盖与现有证据 | 鉴权、限制及复权 | 接入代价与主要风险 |
|---|---|---|---|---|
| A1 | 腾讯证券：AkShare `stock_zh_a_hist_tx` | AkShare 源码实现 A 股历史日线，支持日期范围和指数；当前开发出口对深市 `000001`、沪市 `600000` 各返回 12 行（2026-10-01 至 2026-10-23）。 | 不需要 token 参数；官方未找到限频、SLA 或生产使用保证。接口可选 none/qfq/hfq。源码按板块换算 volume/amount，实际单位还需抽样核对。 | 已有 AkShare 依赖，接入成本低；当前最实用的 A 股日线候选。仅测过两只股票未复权短区间；不得直接当作通过验收或支持长期稳定性。 |
| A2 | 新浪 A 股：AkShare `stock_zh_a_daily` | AkShare 官方文档和源码提供个股日线，可设日期区间，并支持 none/qfq/hfq 与 qfq/hfq factor。 | 无 token；AkShare 源码明确写明“大量抓取容易封 IP”。没有正式 SLA/请求配额证据。 | 与腾讯一样是公开网页行情接口，缺少生产保障；本轮未探测网络和数据质量。若腾讯长期不稳定，可作为另一个独立源做小样本对照。 |
| A3 | Tushare Pro `daily` / `pro_bar` | 官方文档列 A 股未复权日线及通用行情接口；`pro_bar` 支持日线 none/qfq/hfq。 | 需要 token 和积分权限；日线文档列出最低 120 积分试用频率及基础积分档位。商业展示、缓存、留存、再分发权限需按当前协议确认。 | 有明确接口/权限体系，适合有预算时评估供应商化服务；当前无 token/连通性和数据质量实测，且积分规则可能调整。 |
| 港1 | 新浪港股：AkShare `stock_hk_daily` | 官方 AkShare 文档列港股日线；当前开发出口 `00700` none 返回 5,499 行，2004-06-16 至 2026-10-23，尾部 OHLC 看起来合理。既有项目记录也验证过近期两根 D1 bars。 | 无 token；无正式 SLA/限频承诺证据。源码支持 none、qfq、hfq 和复权因子；仅 none 做了本轮长区间探针。 | 现有 AkShare 已接入，接入成本最低。老的多年度 OHLC 失败记录被新探针质疑，需以明确规则重跑一致性测试；复权和 volume shares 仍待验证。 |
| 港2 | Tushare Pro `hk_daily` / `hk_daily_adj` | 官方分别提供港股日线和港股复权行情。日线文档称每日约 18 点更新；复权接口提供复权因子。 | 港股历史日线需要在权限中心单独开通；积分/权限及协议按账号确认。文档注明复权因子可能因除权等原因刷新。 | 若需要更明确供应商权限管理，可作为付费/积分候选；本轮未申请权限或实测。要验证更新时效、单位和复权算法。 |
| 港3（不直接可用） | 项目现有 Yahoo/yfinance | Yahoo Finance 使用的港股代码形态通常为 `0700.HK`，但现有 `provider_yahoo.allowed()` 只接受配置的美国交易所，并排除 `.HK/.SS/.SZ/.BJ` 股票符号。 | 现有 adapter 按 Yahoo 源级限速/代理控制。 | 无需也不建议重做 Yahoo；它不能原样服务当前港股 provider 请求。只作为已接入的其他市场来源保留，不列入港股可直接启用候选。 |
| 港4（不优先） | AkShare `stock_hk_hist` | 官方文档为港股历史 D1/W1/MN；该函数走东方财富。项目此前记录该 endpoint 请求失败，且此前多年度 OHLC 验证失败。 | 可设 none/qfq/hfq；当前 A/HK 故障疑似在东方财富 API 路径，换成这个 endpoint 不能构成上游隔离。 | 对本次故障隔离价值低于新浪、腾讯或 Tushare；已有失败证据，不建议当备用源。 |

## 关键探针与证据边界

1. **腾讯 A 股（当前开发出口，2026-10-25，本轮低频探针）：** AkShare `stock_zh_a_hist_tx`，`SZSE:000001` 和 `SSE:600000`，日期 2026-10-01 至 2026-10-23，各返回 12 行；字段 `date/open/close/high/low/volume/turnover/amount`。只证明当前开发出口能访问并解析接口；未验证复权、单位、OHLC/连续性、北交所或验收实例。
2. **新浪港股（当前开发出口，2026-10-25，本轮低频探针）：** AkShare `stock_hk_daily(symbol="00700", adjust="")`，5,499 行，2004-06-16 至 2026-10-23；字段 `date/open/high/low/close/volume/amount`，尾部 OHLC 合理。只测了一只股票、不复权；未验证其他港股、复权、volume 单位、全序列缺漏/重复或 `mwa`。
3. **旧港股失败证据需要降级处理：** 本目录早先 `provider-capabilities.json` 记录旧多年度响应未通过 OHLC 校验，`akshare-hk-validation.json` 记录某次 D1 unavailable；另有 `akshare-hk-recent-validation.json` 仅验证近期两根 bars。它们与上述 2026-10-25 新开发出口长区间探针有冲突。当前报告用最新单样本结果更新排序，但未能重现或解释旧错误的具体数据/参数差异；旧失败不可再单独作为“新浪港股日线不可用”的结论，新探针也不足以消除风险。

## 推荐验证顺序

1. 在开发环境对腾讯 `000001`/`600000` 的 none/qfq/hfq 重复同一 D1 窗口，对照复权因子/除权日期和 OHLC 合法性，确认 volume/amount 的板块单位；再扩一个北交所样本。保留 endpoint/source identity 为 Tencent。
2. 对新浪港股 `00700` 比较 none/qfq/hfq 同一时间窗，检查 OHLC、成交量/成交额、缺漏/重复与行动公司日期；另取一只不同流动性港股。用一套明确、可复跑的 validation 重现或解释历史 OHLC 失败记录。
3. 如果公开网页源不能满足可用性或授权要求，再根据实际展示/缓存用途向 Tushare 确认 A/HK 权限和授权，取得 token 后做小样本历史核验。
4. Yahoo 保持现有范围，不为本次 A/HK 日线评估改变其接入。

## 一手来源

来源访问日期：2026-10-25 UTC；本轮探针为当前开发出口观察。

1. 项目 AkShare adapter：[provider_akshare.py](../../../backend/alerts/provider_akshare.py)，A/HK endpoint、来源身份与 volume 单位规则。
2. 项目 Yahoo adapter：[provider_yahoo.py](../../../backend/alerts/provider_yahoo.py)，`allowed()` 对股票类型的交易所白名单及 `.HK` 排除规则。
3. AkShare 官方股票文档：<https://akshare.akfamily.xyz/data/stock/stock.html>，条目 `stock_zh_a_hist_tx`、`stock_zh_a_daily`、`stock_hk_daily`、`stock_hk_hist`。
4. AkShare 官方腾讯 A 股源码：<https://github.com/akfamily/akshare/blob/main/akshare/stock_feature/stock_hist_tx.py>，`stock_zh_a_hist_tx` 注释为日频，公开接口请求与 none/qfq/hfq 分支、交易量换算在源码内。
5. AkShare 官方新浪 A/HK 源码：<https://github.com/akfamily/akshare/blob/main/akshare/stock/stock_zh_a_sina.py> 与 <https://github.com/akfamily/akshare/blob/main/akshare/stock/stock_hk_sina.py>。A 股源码提供 D1、qfq/hfq/factor，且明确提示大量抓取容易封 IP；港股源码实现 `stock_hk_daily`，请求新浪行情/复权因子并计算 qfq/hfq。
6. Tushare 官方 A 股日线：<https://tushare.pro/document/2?doc_id=27>；A 股通用日线接口：<https://tushare.pro/document/2?doc_id=109>。分别用于确认日线、积分权限和日线复权能力。
7. Tushare 官方港股日线：<https://tushare.pro/document/2?doc_id=192>，接口 `hk_daily`，文档说明每日更新并需单独开通“港股历史日线”权限。
8. Tushare 官方港股复权行情：<https://tushare.pro/document/2?doc_id=339>，接口 `hk_daily_adj`；说明港股价格乘复权因子得到复权价，并提醒因子历史数据可能刷新。
9. yfinance 官方 `Ticker.history` API 文档：<https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.history.html>。这是上游 SDK 的通用历史下载能力，不代表项目当前 adapter 接受港股；实际支持边界以项目 `provider_yahoo.allowed()` 为准。
10. AkShare 当前 A/HK 故障调查背景：[akshare-network-research-20261025.md](./akshare-network-research-20261025.md)。该调查指向 AkShare A 股 `stock_zh_a_hist` 使用东方财富 `push2his`，并记录已有访问限制类 issue，但不能确定本次现场精确根因。
