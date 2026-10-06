# 实际跨源接续与独立周期聚合验证

日期：2026-10-07，前置 `0d42ef2`，Ubuntu独立项目 `market-watch-three-layer`。

## 实际行为

- EURUSD、XAUUSD 已通过认证HTTP保存明确 Dukascopy历史 Bid→OANDA Practice Bid 映射，
  实际使用入口建立共享组合。核对标的、币种、准确源代码和价格口径，黄金明确披露产品差异，
  不把经济标的相同解释为执行产品等价，不进行价格平移或量合并。
- 两条组合固定历史发布版本和最近NY17日界T，从T开始取得实际OANDA确认M1，
  后续stream/REST使用既有共享拥有者。旧历史清单校验和保持不变。
- 九周期先接续M1再派生。保存的固定输入版本逐桶独立计算Decimal OHLC与观测根数，
  对照公开组合读取。W1/MN包含两来源原价和两段量证据，统一量为空。
- 首轮180秒验收未通过：确认M1已接续，但聚合与历史维护共用循环，每批128桶之后还等待，
  新确认事件持续增长，任务未全部追上。实际探针多数claim/build/commit合计几十至几百毫秒，
  月桶约0.7秒；证明单批计算速度与循环吞吐不同，不将超时当作供应商失败。
- 新独立 `composite-aggregate-worker` 使用同一持久任务、租约、版本顺序和公平claim。
  有工作时50ms间隔、闲置500ms，不访问供应商，不产生实时需求。
  历史worker新增可选 `--without-composite-aggregates`，默认旧部署行为仍兼容。
  本验收Compose显式分离，两进程由原claim协议防并发重复发布。

## 已验证证据

- 最终本地聚合/组合图表/接续/历史/回放 **50 passed /36.13s**；
  独立实际PG聚合及图表 **18 passed /79.36s**，含并发claim、旧owner拒绝、失败重试、
  固定旧输入、部分事件未完成不发布和恢复；这批未改变数据库schema。
- 实际两条固定组合九周期OHLC与来源M1独立计算相等，历史checksum、T未变化。
  初次验证失败与只读挂载的报告权限失败保留，报告阶段只使用root读取本项目ignored输入。
  新worker实际运行且积压追上；后续同组合观察等待 **9.32秒**，这是已有任务追上样本，
  **不是重新创建冷历史的首次准备性能**，没有重复下载或重置固定基线。
- 浏览器实际EURUSD/XAUUSD组合概览、接续、M1/H4/D1/W1/MN固定产物读取通过；
  materialized=true、M1 partitions=0。图表实际渲染并切换H4。
  管理与接续浏览不改变使用计数，三桌面宽度、键盘、200%内容缩放通过，无pageerror。
  首轮脚本误用小写来源显示名称失败，修正为实际Dukascopy标签后复验通过。
- 测试只释放 `acceptance-cross-source` 的准确租约，浏览器图表租约按原期限自动过期。
  未启用策略或通知、未重启旧观察实例、未改生产。

脚本 `scripts/verify_cross_source_composites.py`、`web/tests/cross-source-composites-real.browser.cjs`。
Ignored证据：`cross-source-setup-first-failure.{json,log}`、`cross-source-aggregate-profile.json`、
`cross-source-setup.json`、`cross-source-check.json`、`cross-source-browser-real.{json,log}`、
`cross-source-{EURUSD,XAUUSD}-{seam,chart}.png`、`cross-source-release-final.json`、
`cross-source-worker-final-local.log`、`composite-worker-postgres.log`。

## 环境与启停

Ubuntu本机PG14、独立volume/network，迁移aj37。API/UI <http://127.0.0.1:16629>，原生origin16630。
API、历史/原生历史/聚合/pricing worker、web、chart-origin及PG运行；delivery禁用。

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml up -d --no-deps history-worker composite-aggregate-worker'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml stop composite-aggregate-worker'
```

仍需旧Watch策略统一输入、3–10品种/多图/维护并发、日历与映射修订实际切换、
完整兼容和容量/恢复质量。48小时三层新观察未启动，完整A–E目标未完成。
本报告只覆盖有限真实区间的价格和来源证据，不承诺全历史覆盖或全目录供应商质量。
未推送/PR/生产发布或下单，MT4后续。
