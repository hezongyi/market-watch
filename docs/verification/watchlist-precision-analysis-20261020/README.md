# 自选表自建行情价格精度：只读分析

2026-10-20，Ubuntu `quant-server`，长期验收实例 `mw-issue75-v2-20261018`。使用 Playwriter 新建隔离浏览器 context，正常登录并访问 `https://192.168.7.232:18280/advanced-charts/mw75-real`。未操作原用户页面、保存布局、修改自选表、修改产品代码或部署。

## 已复现的问题

| 自建历史系列 | 原始报价 lp | 元数据 precision | 当前自选表 | 按配置应显示 |
| --- | ---: | ---: | ---: | ---: |
| EURUSD | 1.12224 | 5 | 1.12 | 1.12224 |
| USDCAD | 1.4042 | 5 | 1.40 | 1.40420 |
| XAUUSD | 4114.705 | 3 | 4,114.71 | 4,114.705 |

三条系列均为 `MWH:` 固定历史版本；此次结论直接覆盖这三条实际可见记录。原始价格保留完整小数，元数据 precision 也正确。DOM 文本和 aria-label 均已变为两位，排除列宽裁切和视觉遮挡。

截图：[当前自选表](watchlist-current.png)。[浏览器原值、配置及显示对照](browser-evidence.json)。

## 根因

1. `advanced-host/bridge.js` 的 `presentQuote` 调用 `chartQuotePresentation(row, meta)`；所有系列共用此呈现入口。
2. `advanced-host/price-format.js:42` 只传 source、display_precision 和 asset_type 给 `chartPricePrecision`，没有使用自建行情已有的 `precision` 或按 series_kind 分流。
3. 三个固定历史版本的 source 为 dukascopy，asset_type 和 display_precision 均缺失。Dukascopy 命中自定义显示规则，类型与提示缺失后回退到两位，因此生成 `mw_display_pricescale=100`。
4. 同文件 `chartQuoteScale` 优先使用此覆盖值。既有原生报价格式接入点位于 `advanced-host/patch-native-reserve.mjs`，因此该值覆盖了原本按品种精度声明的 pricescale（EURUSD/USDCAD为100000，黄金为1000）。

这是应用提供了错误的展示精度；自选表仍使用原生组件。错误已发生在输入给原生格式化器的配置层。

## 因果验证

读取页面中真实 quoteSnapshotRows、元数据及可见DOM；调用运行版本真实的 chartQuotePresentation/chartQuoteScale。仅用复制的参数运行纯函数，不替换页面函数、不回写元数据或向控件发布测试报价。

- 当前输入：三个系列覆盖scale均为100，与当前错误显示一致。
- 同一原始报价仅补正确asset_type：分别得到100000、100000、1000。
- 同一原始报价仅补display_precision=precision：样本也得到相应正确scale。
- 对照见[pure-format-probe.json](pure-format-probe.json)。

复现脚本 `/tmp/mw-watchlist-precision-check-20261020.js` 已运行，执行真实页面对照并以非零退出：`REPRODUCED: custom history watchlist price does not respect declared precision`。它依赖本次 Playwriter session 8 中自有页面 state；重跑前应重新定位有效页面，不能盲目操作历史会话。

## 建议修复方案（尚未实施）

- 对自建系列明确以该系列元数据 `precision` 为权威。报价呈现不生成供应商启发式scale覆盖，交给已按 `10 ** precision` 声明的原生价格格式化器；系列身份应由明确的series kind识别，不能仅凭Dukascopy来源判断。
- 按配置固定小数位并补尾零，例如USDCAD为`1.40420`。保留原始数值，只在呈现时舍入。
- 平台行情原有供应商显示政策独立保留，避免修复自建历史时改变Yahoo等平台行情。不能只补asset_type让这三个样本碰巧正确；类型默认规则可能仍与自建品种实际配置不同。
- 核对共享此报价格式化入口的商品详情和报价变化显示；区分绝对价格/涨跌额与百分比精度。配置无效或暂未解析时采用明确回退，不能统一硬编码2位。
- 验收覆盖自建5位外汇、3位黄金、整数/2位/其他配置、末尾零、小于1的价格、初次快照和持续更新、切换品种/刷新，以及平台行情回归。直接断言DOM显示、原始价格不变与生效scale，避免只验证辅助函数。

本轮仅完成记录、浏览器复现和方案分析，未实施修复。
