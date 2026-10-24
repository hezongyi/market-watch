# Supertrend价格标签跟随图表精度

用户报告EURUSD的Supertrend价格标签显示为1.12，要求使用图表品种精度。F0 / Ubuntu R1：仅改前端价格展示元数据，使用原生`format: {type: "inherit"}`复用主图格式器；不改数值算法、指标身份、参数或保存格式。

独立分支`fix/supertrend-symbol-precision-20261024`，worktree`/home/quant/repos/market-watch-supertrend-precision-20261024`，从mwa当前前端候选的收口提交`13dda972`派生，保留已验收Swing及全局右下角通知。

## 诊断与实现

- Node契约已实际红灯，旧Supertrend profile固定`price/precision=2`。
- 原生许可库浏览器已复现：相同Python原始结果，主图格式器为`1.11659`，旧Supertrend实际可见标签却为`1.12`。
- 优先检查固定profile、旧工作区精度覆盖、品种切换后格式未刷新。仅将profile改为inherit后复验；自动精度由当前品种决定，手动主图精度和自定义格式器也由原生继承处理。
- 新回归读取真实原生图例DOM并逐值对照主图格式器，覆盖EURUSD五位、其他品种二/三位、切品种、主图手动精度与恢复自动、旧工作区/模板恢复及二次保存恢复、颜色线宽和开关保留、自定义格式器。旧默认保存状态通过原版本真实save/template API生成。

## 最小验收与实例边界

执行Supertrend既有映射合同、相关格式与身份合同、新原生浏览器回归和mwa真实EURUSD验收。只构建/替换Chart；Web、API、workers及其他服务保持当前身份。使用现有mwa，保留真实数据、完整私有配置和受保护浏览器，不PR/push/合并/生产发布或操作Unraid。

证据目录：`/home/quant/repos/.reports/market-watch/20261024-supertrend-precision/`。实际候选、制品身份、检查结果、数据核对与Chart-only回退将在同目录results.md收口。
