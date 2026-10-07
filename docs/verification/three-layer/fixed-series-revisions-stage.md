# 固定输入图表历史修订复核

日期：2026-10-07（Asia/Singapore）。前置提交 `d7d9528`，分支 `feat/market-data-integration`。

## 行为及边界

固定历史和组合图表支持原生 bridge 已有的 `history_check` 协议。
检查固定组合修订、历史版本、聚合规则及已加载旧桶内的不可变输入修订，
按实际 UTC 桶边界计算范围；Native 日期标签仅用于显示，不当作 M1 修订查询边界。
尾部追加、最后一桶更新、已加载范围之外的改动不触发历史重绘；
范围内旧分钟修订或补洞改变指纹，通过公开原生 cache-reset/resetData 回调重绘。
显式旧输入修订仍重现原指纹，第二层日更也不能改变原固定历史的指纹。

数据库查询使用现有 CompositeMinuteInput 索引及 max(input_revision)，
不反序列化整个尾部 M1，也不以当前最大水位简单地失效所有旧柱。
很长的已加载前缀仍需索引范围聚合；持久桶产物及更细的失效索引继续后续实施。
本批不等于持久物化、完整指标重算、策略判断恢复或显式基线切换已完成。

## 验证

- 本地固定修订、图表/导出、组合聚合、旧工作区及 MCP 定向 **54 passed / 18.77s**。
  `artifacts/data-integration/fixed-series-revisions-regression.log`。
- Ubuntu 独立 PostgreSQL 的固定输入/导出/引用与新增修订契约 **10 passed / 34.77s**。
  `artifacts/data-integration/fixed-series-revisions-postgres.log`。
- `web/tests/advanced-fixed-revisions.cjs` 通过：由真正 Python 数据读取器生成响应，
  原生 bridge 读取大写身份并保存原始 UTC 范围，确认追加仅刷新，旧柱修订调用 cache-reset 和 reload。
  disposable SQLite 内的受控测试数据，不冒称供应商在本次真实运行发生了历史修订。
  固定系列、旧自建修订和布局恢复三个 JS 回归同时通过。
- 新代码 Ruff 和 diff 检查通过。真实 Ubuntu Chromium **9 项通过**，新增实际组合 H4 历史复核
  指纹及 UTC 桶边界检查；原生保存重载、可见 EURUSD 名称、无全局错误弹窗和固定历史 CSV 继续通过。
  `artifacts/data-integration/three-layer-charts-real.json`。数据为实际已接入 OANDA→OANDA 组合，
  并未人工改写供应商分钟来制造本次浏览器的旧柱修订。

## 实际环境

沿用 Ubuntu project `market-watch-three-layer`，管理和主图表 `http://127.0.0.1:16629`，
图表 origin `http://127.0.0.1:16630`。API 已按本批源码重启；pricing-worker 未启动，
旧长期观察及生产未变更。完整启停方式见 [主图表阶段报告](series-access-stage.md)。
实现验收与长期质量观察分开，完整 A–E 目标保持进行中；不推送/PR，MT4 留后续。
