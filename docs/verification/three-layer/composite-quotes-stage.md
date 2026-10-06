# 组合自选报价与只读证据验证

日期：2026-10-07，前置提交 `22eefb1`，分支 `feat/market-data-integration`。

## 实现

- 已建立组合的自选列表、HTTP `/composites/{id}/quote` 与只读 MCP `composite_get_quote`
  共用读取器。搜索、候选、自选读取不创建组合、租约，不访问供应商。
- 当前账户、活跃拥有者、连接世代、心跳、报价来源时间及接收时间必须通过校验，
  且报价有限、正值、Bid≤Ask、可交易，才显示15秒内的抽样 Bid。
  报价就绪与确认尾部恢复就绪分别返回，恢复中也可显示真实新报价。
- 无有效报价时显示同一组合固定修订已接受的确认 M1 收盘；明确保存的时间和类型。
  未结束分钟、未经组合接受的目标来源数据不作为确认报价；不生成涨跌值或百分比。
- 公开 snapshot 保留准确十进制价格、基线、T、输入版本、源世代/时间或确认柱来源分段。
  原生库显示值使用浮点，审计准确价格不经过浮点舍入。数据中心共用报价就绪校验。

## 验证

- 实际 PostgreSQL 报价与组合图表定向 **15 passed /51.62s**，独立临时schema。
  覆盖实际事务、无需求副作用、拥有者/世代/账户/过期报价拒绝与存储回退。
- 本地最终接口/报价 **38 passed /37.46s**。
  HTTP/MCP使用固定查询时钟核对全部事实，报价精度、错误输入与无创建副作用通过。
- 最终全量后端 **1018 passed /204 skipped /320.16s**。
  首轮1016通过/2失败是原MCP工具数量断言未包含新增只读工具，已更新并复跑全量。
  跳过场景不记通过。原日志保留 `composite-quotes-full-regression.log`。
- 实际Ubuntu OANDA Practice EURUSD：闲置时保存确认收盘、显式图表需求后抽样Bid，
  只释放本次命名租约；原生图表关闭且租约过期后回到最新确认收盘。
  两种状态均取得相同来源观察的HTTP/MCP逐字段证据，不强行等同不同tick的连续读取。
  保存收盘与固定M1图表的价格、时间、来源分段相同。
- 实际许可原生图表读取大写组合ticker，收到人类品种名、抽样Bid、时间和中文类型，
  未生成涨跌。浏览器无pageerror，仅删除本次创建工作区；其它工作区/规则不修改。
- Ruff、JS语法、diff检查通过。

脚本：`scripts/verify_composite_quotes.py`、`web/tests/composite-quotes-real.browser.cjs`。
证据位于ignored `artifacts/data-integration`：`composite-quotes-pg.log`、
`composite-quotes-final-interface.log`、`composite-quotes-full-regression-final.log`、
`composite-quotes-real-{stored,sampled,release,after-release}.json`、
`composite-quotes-browser-real.json` 与 `composite-quotes-native-real.png`。

## 实际环境与启停

Ubuntu本机独立Compose `market-watch-three-layer`，PG14，迁移aj37不变。
API/UI <http://127.0.0.1:16629>，许可图表origin16630。delivery禁用，测试规则暂停。
worker、web、chart-origin与数据库运行；凭据/许可资源不提交。工作树根执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml restart api'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker native-history-worker pricing-worker web chart-origin'
```

## 接续范围

这批不证明真实跨源接续、多品种并发、旧Watch接线或整体质量通过。
完整A–E目标继续，48小时新三层质量观察未启动。未推送/PR/生产发布或下单，MT4后续。
