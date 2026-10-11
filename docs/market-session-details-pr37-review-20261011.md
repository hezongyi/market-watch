# PR #37 合并审查（2026-10-11）

历史结论（修复前）：**暂不建议合并，request changes**。最新修复和复核以[修复报告](market-session-details-pr37-fix-20261011.md)为准。审查对象为 head `3b05da73fa012c22b2af0095826c291d5f3fdcf3`，目标 main `75f8f3476afc1b6c25236928ca353f5fb6e745f1`。GitHub 显示 `MERGEABLE / CLEAN`，没有自动检查记录；这只表示文本可合并。原实现验收已覆盖很多行为，但仍有以下可复现契约缺口。

## Standards

**P2：按品种名跳过不同实际身份的日历行。** `backend/alerts/market_calendar.py:360–361` 在没有 profile 且代码匹配内置映射时省略实际数据集，没有检查通道／环境／账户；`:343` 同样只用 source/symbol 跳过没有 profile 的原生缓存。违反 `CONTEXT.md` 的完整数据集身份定义及 `docs/adr/0001-explicit-market-dataset-identity.md` 的 Node/Python 独立归属规则。

SQLite 内存数据库登记真实支持的 `dukascopy/python/historical/XAU/USD/public` 数据集。其 `session_status` 返回 unknown；同一时刻 `calendar_rows(query=XAUUSD)` 只返回通用 JSON3 的 verified/closed 行，实际 Python 范围消失。应只在完整身份及适用判定均一致时省略重复规则；其他范围独立保留 unknown 行。证据见 [calendar-identity.json](verification/market-session-details-pr37-review-20261011/calendar-identity.json) 和 [复现脚本](verification/market-session-details-pr37-review-20261011/calendar-identity.py)。

规范轴共 1 项已证实问题，没有把一般代码气味作为阻断。

## Spec

1. **P2：日历与详情对同一实际系列给出不一致结论。** 与规范轴是同一个缺陷，需求 §6.5 明确“状态与商品详情、图表标题使用同一判定和规则版本”，§1 要求实际品种逐项映射。实际 Python 系列未核实，清单却只呈现同名 JSON3 已核实规则；修复位置及复现同上。
2. **P2：报价流失败事件未更新保留报价的失败提示。** 需求 §3：“读取失败时保留同一身份下最后成功的价格和时间，并显示‘更新失败，保留上次数据’。”`advanced-host/bridge.js:2236–2248` 的 quote 分支只处理 quotes/reset，遇到 worker 的 status/error 仍推进 sequence 后直接 return。`backend/alerts/market_stream_worker.py:220` 会在计算失败时实际生成该事件。对现有事件处理源码做 VM 复现：失败事件接受后 callback 次数为 0，原快照仍无 fetch_status，因此没有要求的失败文案；polling fallback `bridge.js:1358` 也只有独立错误通知。应保留同一绑定的价格和时间，更新失败展示，恢复成功后清除提示，并验证旧世代事件不得影响新订阅。见 [quote-status.json](verification/market-session-details-pr37-review-20261011/quote-status.json) 和 [源码复现脚本](verification/market-session-details-pr37-review-20261011/quote-status.cjs)。

需求轴共 2 项，均 P2。两个轴的同一日历问题不能算成两个独立缺陷。未发现范围扩张；已如实记录的官方证据访问失败、未来未知例外不是新增阻断项。

## 独立验证与边界

- 原 PR 工作区未改产品代码、未改已有提交。临时 worktree `/home/quant/repos/market-watch-pr37-review-20261011` 合并最新 main，无文本冲突；通过 Ubuntu `mw-docker` / `market-watch-ubuntu` 构建合并结果 API 镜像。
- 后端相关 13 套回归覆盖会话／报价与 main 的历史价格精度改动，最终 **235 passed**；[测试日志](verification/market-session-details-pr37-review-20261011/mw-pr37-review-tests-final-20261011.log)。首轮 231 passed、4 个 live_session 测试缺少镜像内 `scripts/oanda_live_sessions.py`；只读挂载该测试辅助文件后重跑，不能把首轮缺文件误判为产品回归。
- host 回归、38 项价格格式、PR diff 空白检查通过。本轮没有重新运行原生浏览器，原 PR 的 36 场景／15 次周期加载证据仍是其原基线上的历史验证。
- 日历缺陷分别在 PR head 的宿主 SQLite 与临时合并结果容器中复现；不访问供应商、账号或生产。
- 测试容器具名、network none、SQLite 内存数据库、无端口／持久卷。完成后精确清理 review task 镜像，无 PG 卷需备份恢复。没有访问 unraid、没有 PR 评论或正式 review 提交、没有合并。

## 收口

最终回归 235 passed；审查 task 已结束，精确清理清单仅本任务 API 镜像，清理结果见 [cleanup-applied.json](verification/market-session-details-pr37-review-20261011/cleanup-applied.json)。临时 worktree 的未提交合并已撤销；原 PR 仍为 `3b05da7`，新增报告及证据保留本地未提交，没有推送修复或发表外部评审。修复上述两个缺陷、补对应回归并在最新 main 集成结果验证后，再判断可合并。
