# 范围/柱宽最终验收证据入口

最新范围：仅范围映射、同步设置、柱宽同步。见 `docs/chart-range-main-integration-acceptance.md`。

- `scoped-final/`：撤回范围外修复后的专项、部署及人工工作区准备证据。
- `summary.json`、`final-*.json`：原候选2检查点，169项/14组功能通过。该原始汇总的兼容阻塞/等待修复字段描述早先扩大范围的阶段，现由用户范围决定取代，不改写历史失败为通过。
- `review-final.md`：用户指定reviewer的最新范围复核与历史记录。
- `historical-failures/`、`compatibility-fixes-20261006/`：独立历史/指标问题和已撤回候选的诊断，非当前功能交付。

当前Ubuntu部署chart2/API1，`host.d0a96d61fcfcc340.js`。PR人工验收前不合并，未生产部署。
