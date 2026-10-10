# 自适应价格显示验收

2026-10-09，Asia/Singapore。基线 `19d8b2b` 加本记录同提交的修改。

## 原因与修改

上一版只在 Yahoo 元信息带有 `display_precision` 时提供显示格式；缺少该字段会返回原生格式，暴露八位存储精度。苹果股票的缺字段重放显示 `252.29456789`，见 [修改前复现](adaptive-before.log)。正常最新元信息原本已能显示两位；本次补全缺字段和过高建议精度的路径。

`advanced-host/price-format.js` 统一选择显示精度，不按公司代码设置例外：

- 股票、ETF 默认两位，缺字段或来源建议八位也适用。
- Yahoo / Dukascopy 的通用存储精度与显示精度分开；外汇使用来源合理建议，缺少时回退五位。其他来源已有的原生 tick 精度继续由图表库处理。
- 每次格式化时按价格数量级自适应：低于 1 的价格增加显示位数，上限八位。例如 `0.001234` → `0.00123`、`0.00000001` 保留八位；恢复正常价格时回到基础精度。
- 涨跌额根据当前／前一价格选择精度，不把微小涨跌误当成低价品种；处理负值、负零及无效数值。
- 手动四位／八位、分数报价及可变 tick 设置优先；设置恢复“默认”后使用自动机制。
- 价格、OHLC、指标计算、保存数据和 `pricescale=100000000` 保留原精度。自动规则在品种切换、保存工作区后刷新恢复时生效。

价格轴通过公开 `priceFormatterFactory` 使用规则。截图复查发现原生右侧详情另行使用解析品种的存储 scale，覆盖报价返回的 scale，导致仍显示八位。现有带 SHA256 校验的许可库构建适配器新增一处报价展示 hook：只在原生报价消息的展示字段使用主机给出的 scale，保持品种 scale 和原始 `lp`／`ch` 不变。初始报价、订阅和后续轮询共用规则，自选列表和右侧详情均接入；见 [报价入口修改前复现](adaptive-quote-before.log)。许可资源本体仍不提交。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| 真实 AAPL；缺显示精度、建议八位、正常元信息三个场景；每场景包含默认两位、右侧原生报价详情、低价／极低价／涨跌额、手动覆盖、保存刷新 | 15 组通过；三份 `adaptive-precision-*-report.json` 均 `passed=true`、`errors=[]` |
| MSFT、手动精度、EUR/USD、WTI 期货、原 Binance 精度、MSFT 保存刷新 | 6 组通过；[报告](yahoo-precision-report.json)、[日志](adaptive-yahoo-regression.log) |
| 数据中心打开图表状态、慢来源／慢 K 线提前关闭、加载反馈与重试 | 5 组通过；[报告](opening-report.json)、[日志](adaptive-opening.log) |
| 缺／无效／过高提示、股票／ETF／外汇、低价／负价／微小变化／负零、手动／分数／可变 tick、报价未舍入和 scale 校验 | `node web/tests/chart-price-format.cjs`，38 项通过；[日志](adaptive-unit.log) |
| 原生适配器升级、重复执行、产物语法、禁用恢复到 SHA256 固定的原始库 | 通过，使用临时副本，未修改工作树的私有许可库 |
| 构建与静态检查 | Ubuntu `mw-docker build --component chart`、JavaScript 语法、`git diff --check` 通过 |

浏览器串行运行，共 26 组通过。测试等待所选品种、加载操作结束与原生保存保护解除；刷新等待主机就绪。缺字段／八位提示场景同时覆盖普通解析请求与工作区启动元信息。股票默认两位不依赖后端缓存中的单一最新报价。

[苹果股票价格轴截图](adaptive-precision-aapl.png)。后端和 web 产品代码未修改；本轮仅重建并更新图表服务。

## 实际运行环境与启停

Ubuntu 22.04 `quant-server` (`192.168.7.232`) 本机 Docker，task/project `mw-data-center-review-20261008`，独立网络、PG volume、数据库、19943/19944 端口。专用 `market-watch-ubuntu` BuildKit，`purpose=acceptance`；未使用 unraid 或生产目录。

访问：<https://192.168.7.232:19943/advanced-charts>，图表 origin：<https://192.168.7.232:19944>。密码保持不变；凭据、私钥、许可库与完整浏览器状态未提交。

九个服务运行，API/PG 健康；镜像 ID、任务归属和状态见 [runtime.json](runtime.json)。实例保留供用户验收，生命周期任务仍进行中，本轮未退役或清理资源。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```
