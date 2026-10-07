# 固定组合输入接续后聚合验证

日期：2026-10-07。此为C阶段有界读取基础，不是公开组合图表、完整指标或策略交付。
Ubuntu独立project `market-watch-three-layer`；API健康，访问<http://127.0.0.1:16629/market-data>。

## 实现

`composite_series.read_window`读取明确组合修订/输入版本的有界窗口：固定历史版本只取T之前，
明确映射目标的不可变确认M1引用只取T之后，之后才按配置NY17/UTC0聚合。
重用既有日/周/月坐标，不把D1或其他高周期简单拼接；窗口最多32天，按周期扩至完整桶。
不下载、不创建需求、不激活修订；外层长期物化与索引分页尚未实现，不能当成十年图表性能交付。

- 原始价格不平移、不补缺口。H4/D1按NY17相位，W1/MN按NY17日期归属，DST换时明确测试。
- 每桶分开报告时间结束、来源确认、覆盖完整；缺失分钟只凭适用来源有限闭市证据排除，
  NY17本身不证明闭市。闭市证据按T分段归属；冲突观测保留并报告。
- 标明seam_crossing/seam_at_start/mixed_source，供后续策略接缝政策使用，不假装政策已经接入。
- 不同来源或不兼容量单位的总volume为null；保留各段实际观测量和单位，不能据此推断完整桶量。
- 确认价格输入版本可回看，不读取mutable来源头部替代旧策略输入。
- 可选stream临时分钟只在当前账户owner/epoch/租约、新鲜可交易报价与有效bid/ask下返回，
  与确认输入区分。记录该次临时分钟快照、epoch及live revision；过期owner排除。
  临时分钟不证明整分钟覆盖/来源确认；不可与显式固定确认输入版本混用。

## 证据

- 聚合/固定读初次8项；增加临时柱owner保护后9项通过。
- 实际UbuntuPG固定读/临时柱与需求/实时owner联合8项通过。
- 最后收紧临时观测不证明完整分钟覆盖后：本地聚合/日历/实时最终定向40项通过，实际PG聚合2项通过。
- 全后端866通过/116跳过属于上一批状态，包含当时8项聚合；最后的新增和收紧另有定向证据，
  不声称全量运行覆盖最后变更。
- 真实已存OANDA历史/REST数据：本周读取2584根实际M1，H4/D1/W1/MN均与同一固定输入M1的
  open/high/low/close逐项数值相等。周/月包含固定接续点，不创造实时需求。
  实际映射是OANDA历史接OANDA实时；不同来源价格差和量语义由混合Dukascopy/OANDA单元测试证明，
  尚未宣称实际跨供应商组合或策略端到端通过。
- 改动Ruff及diff检查通过。

脚本：[`verify_composite_series.py`](../../../scripts/verify_composite_series.py)。
ignored证据：`composite-series-real.json`、`composite-series-real.log`、
`composite-series-final-local.log`、`composite-series-final-postgres.log`、`composite-series-usage-postgres.log`。
启停方式沿用[输入阶段](composite-inputs-stage.md)；实际pricing-worker生命周期验证后已经停止，
API及历史worker/web运行，数据库af33；未改动旧观察、生产或任何交易执行。

## 待接续

索引/物化分页、公开组合图表及搜索，映射/组合UI/MCP，策略明确接缝政策/预热/恢复防重与
显式修订切换、原生Dukascopy入口、统一回测周期输入、桌面完整验收、负载和最终质量观察。
完整A–E目标未完成，未push/PR/生产发布或下单，MT4继续延期。
