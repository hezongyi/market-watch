# OANDA 平台原生参数与固定身份

日期：2026-10-07。本阶段实现与定向真实验收；完整 A–E 与长期质量尚未收口。

## 实现

- 数据中心平台目录增加“配置原生参数”。桌面页面支持 Bid/Ask/Mid、平滑开盘价、
  日对齐 0–23 点、IANA 时区与七种周对齐，保存后显式打开配置图表。
  无效参数保留表单；默认参数继续使用原 ticker 和缓存身份。
- 配置保存到既有不可变 `SourceSeries`，完整 SHA256 身份包括来源、channel、
  practice 环境、账户哈希、准确品种、价格口径与全部参数。
  `MWP:NATIVE:<32hex>` 是可保存的紧凑引用，解析时检查完整身份、碰撞和当前账户。
  配置与查询范围分开；周期缓存在 `native_period_identity` 中记录准确 granularity。
  原生配置不会注册第二层数据集、启动维护或创建实时需求。
- 原生请求原样向 OANDA 传递参数并选择对应 bid/ask/mid OHLC，保留来源 volume 与 complete。
  没有 M1 重算。不同参数进入不同内存及 PostgreSQL 缓存身份，worker 使用相同保存元数据。
  高周期标签按原生对齐时区，D1/W1 结束使用当地日期规则；H4 最后桶处理 DST 日长变化。
  原生月柱从前月最后一天的对齐时刻开始，UTC0 也如此，不能套用自建月线规则。
- 报价与前日收盘使用相同口径和原生会话边界。图表标题、详情及刷新保留配置；
  TradingView 大写 ticker 在后端与桥接层规范化到同一身份。
  自建维护入口拒绝用该配置推断原始 M1；第二层/第三层仍使用自己保存的规则。
  自定义日/周对齐的交易日历未验证时，既有原生告警门槛继续阻止创建；
  对齐参数不能充当供应商实际开闭市证据。已运行旧告警及默认身份不重定向。

## 验证

- 最终相关本地契约 **105 passed /49.39s**；最后报价与告警日历门槛 **24 passed /1.25s**。
  实际隔离 PostgreSQL **20 passed /49.13s**，包含并发配置幂等和按参数隔离的周期缓存。
  TypeScript/Vite 构建通过，保留既有大于 500kB chunk 提示；Ruff、JS 语法、diff 检查通过。
  最终全量 **1056 passed /223 skipped /245.41s**，33 项既有 Alembic 弃用警告，跳过项不计通过。
  运行后新增的报价/日历门槛测试由最后 24 项定向复验覆盖；应用代码与最终全量一致。
- 实际 OANDA EURUSD 四套配置、21 组周期页面：Mid/平滑/UTC0/周一覆盖九周期，
  默认 Bid、Ask、伦敦 8 点/周五配置各核对 H4/D1/W1/MN。
  独立供应商请求逐柱核对 OHLC、volume、complete、时间标签及结束时间；
  每套重复请求复用缓存，向前分页游标独占，参数缓存互不混合。
  配置及无 client 的 API 历史请求前后 demand/interest 数量相同。
- 额外真实供应商九组历史窗口验证纽约、UTC、伦敦周/月对齐：
  春秋 DST 周线、闰年与跨月月线，相邻原生开始时间等于计算结束时间。
  这些证据覆盖本次样本；不能据此宣称全部历史假日或所有 IANA 时区的交易日历已验证。
- 真实许可图表 H4/D1/MN 显示准确 Mid、平滑、UTC0、周一配置，HTTP 历史加载返回相同口径，
  刷新保存固定 ticker。1024/1440/1920、键盘顺序、200% 内容缩放及无 pageerror 通过。
  验收脚本只删除自己创建的工作区；生产和其他任务未修改。
  结束后主动 MarketDemand=0；原生有限历史 interest 按既有 TTL 到期，不将尚未到期的缓存
  预取条目宣称为零，也不广泛删除与其他图表可能共享的资源。
- 首轮新增测试缺少目录夹具，第二轮夹具缺少资产类型，均已修正并复验。
  定向复跑曾指定不存在的测试路径、以及新增断言缩进错误；未将这些运行当成通过。
  实际 oracle 最初未规范化 tuple/JSON array，随后上游参考游标偏离可见柱；修正后 21 组通过。
  浏览器先发现标签混入选项文字，已改显式关联；后续脚本错误涉及大写 ticker、
  lastHistory 数值/窗口键，以及只监听同步 data 而遗漏异步 history-loads 的响应。
  最终脚本检查真实异步返回和可见输入，失败证据保留。

脚本：`scripts/verify_native_parameters.py`、`web/tests/native-parameters-real.browser.cjs`。
ignored 私有证据：`native-parameters-real.json`、`native-parameters-dst-raw.json`、
`native-parameters-browser.json`、`native-parameters-browser-delivery.log`、各周期/缩放 PNG、
`native-parameters-fixed-metadata-{tests,pg}.log`、`native-parameters-quotes-calendar.log`、
`native-parameters-full-regression-final.log`。登录、账户、token、许可资源不提交。

## 实际环境与剩余工作

Ubuntu 本机 Compose `market-watch-three-layer`，PostgreSQL 14，migration ak38（本阶段无新迁移）。
UI/API <http://127.0.0.1:16629>；许可图表 origin <http://127.0.0.1:16630>。
工作树根执行，保留数据库及其他项目：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime start api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
```

完整目标仍需规模搜索、实际日界/映射修订启用、3–10 品种/多图与历史维护并发、
来源故障与恢复、完整桌面/兼容审计及单独 48 小时工程观察。新观察尚未启动。
未推送、PR、生产改动或下单；MT4 后续。
