# 四类既有策略的固定组合输入与默认组合搜索

日期：2026-10-07。本阶段实现与定向真实验收；不代表完整 A–E 或长期质量已收口。

## 实现

- `Watch` 的回落、前日突破、价格穿越、SMA 双均线均支持显式 `series_kind=composite`。
  原有规则、状态和旧绑定保留；组合不能误用旧来源 candle 表。
  `market_composite_watch_bindings` 单独固定历史版本/校验和、组合修订、映射、T、日界、
  接缝政策、规则版本与观察方式。图表启用修订、历史日更不重定向已有策略。
- 从同一固定历史周期产物和组合已接受的 M1 派生周期读取，后台每批最多 2000 根，
  事务提交游标和域状态。回落准备可以长期保持，初始化/恢复不能只截取任意最近根数。
  SMA 使用既有明确有限窗口、TA-Lib 0.6.8；指标依赖不足保持未就绪。
- 聚合水位、来源拥有者/账户/连接世代、确认水位、完整依赖、实际闭市与收盘新鲜度分别检查。
  前日突破使用准确的前一交易日日线，最新日线不完整时不回退到更早完整日线。
  默认同源窗口；接受原价接缝影响需显式选择。接缝不比较穿越，修订、恢复、跳过事件建立基准，
  不补发过期通知。显式 tick 模式是抽样 Bid，校验报价世代，缺失观测不追认。
- 判定、signal、notification、outbox 共用事务；逻辑事件键不包含数据修订号或连接世代。
  `market_composite_watch_judgments` 保留无事件基准与当时输入证据；绑定/判断不可变。
  取消释放主动采集需求，固定历史引用和审计继续保留。只有旧固定规则需求时不会订阅新图表映射。
- 新建实时策略默认使用纯组合搜索，明确来源、口径与日界、接缝选择和准备语义；
  旧行情入口显式保留，回放策略入口不变。列表与数据中心显示后端真实就绪原因。
  HTTP 与现有 `alerts_create`/`alerts_list` MCP 共用业务入口及写入幂等机制。

## 验证与限制

- 本地四类功能、完整前日突破、分批预热、恢复/修订、防重、固定修订与引用测试通过；
  实际 PostgreSQL 事务回滚、竞争判定、增量迁移及降级保护通过。
  最后本地策略契约 **16 passed /18.40s**，扩展定向 **39 passed /55.07s**；
  实际 PostgreSQL 完整 **18 passed /116.05s**。长历史接续和不预热历史设置有追加验证。
  最终差量 PostgreSQL **4 passed /23.17s**（其余14项明确未重跑），覆盖最后代码。
  最新全量 **1034 passed /222 skipped /439.20s**，33项既有Alembic弃用警告，跳过不计通过。
  全量运行期间最后补充的“不预热历史起点”按最终策略契约及真实PG定向覆盖。
  Vite构建通过，保留既有>500kB chunk提示；Ruff、JS语法及diff检查通过。
- 实际 Ubuntu、Dukascopy EURUSD 固定 NY17 → OANDA Practice：HTTP 创建四类策略及
  抽样报价规则，SMA 经 MCP 创建并以同一幂等键重试。第二轮准备 39.062 秒；
  价格、回落、SMA、抽样报价就绪。无图表需求时规则保持采集，确认柱和报价继续推进。
  固定图表与策略 OHLC/时间一致，HTTP/MCP 固定身份一致。
- 前日突破在本次真实样本中保持 `warming`：前一日固定 D1 确认分钟有缺口，覆盖不完整。
  实测记录保存了对应 D1，并核对后端阻止策略判断；不宣称该真实日线完整。
  完整日线时的正确突破由本地及真实 PostgreSQL 的独立有限输入场景证明。
- 首轮真实运行未在 180 秒内五条全部 ready：SMA 缺连续 19 根、前日依赖不完整。
  保留原失败分母；第二轮仍检查 SMA 必须实际 ready，日线缺口按数据门槛验收并披露。
  未补价格、未将 unknown 当闭市、未为验收伪造真实触发。真实新触发不是本轮实测承诺。
- 实际浏览器默认搜索、来源/日界、无结果保留输入、管理搜索不增需求、四种策略与旧入口、
  固定修订/真实健康、刷新与取消；1024/1440/1920、键盘、200% 内容缩放通过。
  首轮脚本标题定位错误已保留，第二轮及最终复跑通过，无 pageerror。
  中间重复名字定位失败、与API重启重叠的页面等待及提交等待超时也保留，
  最后脚本使用唯一名字，先等待readyz，检查表单有效性后提交，不覆盖此前失败。
- 本轮真实策略和浏览器策略均已取消。核对 active Watch=0、active ChartAlert=0，
  所有需求过期后 source inactive/not-ready，拥有者 token 为空、expires=0。推送禁用。
- 新迁移 `ak38_composite_watch_bindings` 前的 5,762,281 字节私有备份经实际恢复到
  同一 Ubuntu 隔离 PG 的专用临时数据库核对：Watch/组合修订/历史版本/Signal 数量及头版本相同，
  临时恢复库已移除。新表不会改变旧 Watch。

脚本：`scripts/verify_composite_watches.py`、`web/tests/composite-watches-real.browser.cjs`。
私有证据位于 ignored `artifacts/data-integration`：`composite-watches-real-{first,second}.{json,log}`、
`composite-watches-browser-{first,second}.log`、`composite-watches-browser-real.json` 与两张 PNG、
`composite-watch-backup-{check,restore}.json`、`composite-watch-migration-{stop,upgrade,start}.log`、
`composite-watch-demand-release.json`。备份与短期 token 不提交仓库。
最终回归：`composite-watches-full-regression-complete.log`、`composite-watches-contracts-closed.log`、
`composite-watches-postgres-checkpoint-final.log`、`composite-watches-pg-final-delta-closed.log`、
`composite-watches-build-final.log`、`composite-watches-browser-delivery.log`。
`composite-watches-fixed-audit.json`再次核对真实判定审计与相应固定输入图表，无覆盖历史证据。

## 实际运行与接续

Ubuntu 独立 Compose `market-watch-three-layer`，PostgreSQL 14，migration ak38。
UI/API <http://127.0.0.1:16629>，许可图表 origin <http://127.0.0.1:16630>。
实例不使用生产 volume/端口；旧观察 project 保留。工作树根执行：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime start api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
```

完整目标继续：平台完整参数/口径配置、规模搜索、实际改日界修订启用、3–10 品种/多图与历史维护并发、
来源质量与恢复、完整桌面/兼容审计以及独立 48 小时观察仍需完成。观察尚未启动。
未推送、PR、生产改动或下单；MT4 后续。
