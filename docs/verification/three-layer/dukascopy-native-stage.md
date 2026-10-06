# Dukascopy 平台原生周期与目录阶段

日期：2026-10-07（Asia/Singapore），前置 `fa8d754`，Ubuntu 独立三层实例。
本阶段验证第一层原生周期；不表示完整 A–E、真实跨源组合或长期质量已经通过。

## 实现

通过锁定的 dukascopy-python 4.0.1 构造 JSON3 请求，九周期直接读取供应商对应周期。
原始 UTC 时间、Bid OHLC 和来源量不进行 M1 聚合、日界改切或价格舍入。
参数固定 offer_side=B、splits=true、stocks=true、向后分页 P，before 排他；
平台缓存独立于第二层 M1 发布、NY17/UTC 派生和组合。来源价格精度未知，8位仅用于显示。

JSON3 不返回确认位：`source_confirmed=null`，`time_closed` 表示原生周期已经结束，
兼容字段 complete 仅按时间结束计算，`completion_basis` 明确披露。UTC 标签不是已验证交易日历；
MCP 返回 calendar_unverified / unknown_calendar，原生告警仍受交易日历门槛限制。
空或短响应不证明历史起点，不标记历史耗尽，不虚构覆盖、价格或闭市。

SDK 全品种目录使用稳定 DUKA 身份，可搜索；数据中心完整分页无250条截断。
平台图表入口创建准确原生工作区，目录浏览不创建数据集、采集或组合需求。
自建登记不把8位图表精度当来源精度，需要明确填写。OANDA目录保留旧身份，并补当前账户目录。
搜索按准确代码及前缀排序，同等级交错来源，防止大目录遮蔽其他来源；
Dukascopy模糊结果不阻止Yahoo查询新股票代码。旧Yahoo匿名缓存身份保持不变。

较大JSON3页实测请求143根H4返回148根：先校验最多8000根的来源页，再保留最新所需根数。
超额页不重算，不截断中间时间，不将超额当历史边界。
HTTP429及HTTP200中的Too Many Requests / Bot blocked都进入来源共享冷却；
原生与历史采集共用Dukascopy单个请求预算，每秒最多一项，避免不同lane叠加突发。
无效数据返回503，缓存保留，失败不伪装为空历史。

## 实际证据

- 修复前全量5项失败：4项Yahoo模糊搜索回退、1项OANDA来源被大目录遮蔽。
  `dukascopy-native-full.log`、`dukascopy-native-regression-repro.log`保留。
  修复后定向89 passed /15.24s；全量1001 passed /197 skipped /411.05s。
  最后完整回归 **1003 passed /197 skipped /349.31s**，`dukascopy-native-final-regression.log`，
  覆盖限流/超额页修复；其后工作区无效ticker422与预算隔离测试由末次30项定向验证覆盖。
- 末次来源/限流/超额页/工作区本地30 passed /4.51s；实际PG来源与资源5 passed /7.32s。
  首轮实际PG原生HTTP与缓存/租约20 passed /114.70s；随后工作区/资源8 passed /7.53s。
  最后工作区无效ticker422复查实际PG1 passed /6.96s，`dukascopy-native-pg-closed.log`。
  所有PG用独立临时schema，未bootstrap或改写共享验收数据库。
- 真实供应商九周期各4根，HTTP缓存重复读取、排他向后分页均通过。
  供应商直接请求与HTTP的UTC起止、OHLC、量、结束/确认字段逐项一致；
  实际MCP series_search、market_get_bars H4通过，未验证日历状态明确。
  `dukascopy-native-parity-verified.json`、`dukascopy-native-parity-verified.log`。
  后续同游标H4少返回一根最新柱，整页相等检查失败，`dukascopy-native-parity-recheck.json`保留。
  H4/W1/MN按UTC时点扩大直读窗口后，每根缓存柱均有完全相同的来源价格/量证据；
  脚本明确记录supplier_cursor_variation，不把来源短页当作删除旧观测的依据。
- 实际许可图表从数据中心打开准确Dukascopy身份；H4、D1、MN加载并截图。
  三桌面宽度1024/1440/1920、键盘和200%内容缩放，目录完整分页、精度未误填通过。
  `dukascopy-native-browser-real.json`、`dukascopy-native-browser-last.log`及截图。
  脚本仅删除本次创建工作区，未修改其他工作区或已有固定版本。
- 浏览器首轮字段标签误用、原生库大写ticker误判均保留失败日志。
  实际环境发现缺少原生历史worker，补齐后任务开始推进；随后暴露HTTP200供应商限流及超额页。
  `dukascopy-native-large-repro.log`、`dukascopy-native-current-repro.log`、
  `dukascopy-native-shape.log`、`dukascopy-native-large-final.log`保留真实失败/修复证据。
  不把四根小样本当作首次图表完整页的验收。
- 前端构建、Ruff、JS语法与diff检查通过；不提交凭据、许可库或截图。

## 环境与启停

Ubuntu本机Compose project `market-watch-three-layer`，独立PG14/网络/volume，迁移aj37不变。
管理 `http://127.0.0.1:16629/market-data?tab=platform&source=dukascopy`，原生origin16630。
API、history-worker、native-history-worker、pricing-worker、web、chart-origin、PG运行。
delivery禁用，测试实时预警仍暂停；没有生产部署、真实下单、推送或PR。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d --no-deps native-history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml restart api native-history-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker native-history-worker pricing-worker web chart-origin'
```

## 仍需交付

统一搜索其余业务入口、组合自选报价与旧Watch策略接入、完整参数口径配置、
真实Dukascopy→OANDA接续及3–10品种并发、映射/日历修订切换、容量/恢复与完整桌面兼容。
SDK列出品种不等于逐品种覆盖或实时已验证，本阶段不是全目录长期供应商质量保证。
48小时观察尚未启动，稳定版本后单独执行，到期不自动通过；MT4后续。
磁盘曾降到约0.9GB，清理两个已结束本任务pytest目录约78MB，未删除其他任务资源或全局prune。
