# PR #46 修复与最终复审

审查固定 base 为 `7b5c61416390d6db2c26ccdde07716b81affc36c`，最终受测产品提交为 `d2108df01d900c234052da469a2a74b09043735b`。原 PR 实现为 `3f14266619f0bc78309e2e276f7837460f542ff3`，随后完成三次修复提交：`c5b0ff0`、`0f52b07`、`d2108df`。

## 已关闭发现

| 问题 | 修复与验证 |
| --- | --- |
| P2 审核到期仍显示 verified | 最新 audit 的复核期限在读取时计算维护状态；覆盖截止日、次日、续审与新期限届满，并用实际 HTTP 验证 source_session 和 legacy 两种日历的待核实计数 |
| P3 空 JSON 配置误报审核成功 | CLI 按选用的文件动作进行验证；`{}`、`null`、`[]`、`false`、`0` 在预览/应用模式均拒绝且无成功输出或写入；合法文件应用加审核正常提交 |
| legacy 审核记录未关联 | 日历行与 audit 绑定有效配置 revision；闭市前、中、后 row_id 稳定，顶层 calendar_version 仍表示实际会话证据；更换配置不继承旧审核 |
| 无效保存 revision 导致页面错误 | 使用已有缓存 Profile 模型提前验证；7 种坏 revision 和5种坏配置保持可读、unknown/unverified，实际 HTTP 返回 200，fallback 显示身份不关联旧审核 |

来源适用范围尚未开始、已经结束或处于边界分钟时，审核不能使其成为 verified。复核记录不改写来源 profile 或交易时段认证。早期布局失败候选已由实际许可引擎的后续回调证据排除，不计为最终发现。

## Standards

独立规范复审：0 项硬性违规，0 项实质性 Fowler smell，无剩余正确性阻塞。另用私有内存 SQLite 确认异常版本号降级后不会借用 fallback 版本的旧审核。

## Spec

独立规格复审：0 项剩余发现；审核状态、合法与无效 CLI 操作、legacy 身份、异常 profile 降级以及适用范围保护均符合合同。规格代理核对了最终代码和测试报告，其受旧执行环境限制而中断的 TestClient 运行未计作完整通过。

## 验证

最终产品在 Ubuntu `quant-server` 使用每个 fixture 独立内存 SQLite 和 FastAPI TestClient：**95 passed，0 failed，0 errors，0 skipped**，耗时约6秒。原始 JUnit 结果见 [pr46-calendar-regression.xml](pr46-calendar-regression.xml)。

复跑命令，在项目根目录使用已安装完整依赖的 Python 环境：

```bash
PYTHONPATH=backend python -m pytest -q \
  backend/tests/test_calendar_review.py \
  backend/tests/test_market_calendar.py \
  backend/tests/test_calendar_profile.py \
  backend/tests/test_source_calendar.py \
  backend/tests/test_data_center.py \
  backend/tests/test_live_session.py
```

相关 Python 文件 `ruff check` 和完整固定范围 `git diff --check` 通过。原 head 的广泛验证为202次后端通过、2次跳过、8个前端脚本通过及web构建通过；这些保留为未改动范围的证据，没有把先前执行记为最终 head 的全部端到端重验。

最初的独立 PostgreSQL 审查环境为 Ubuntu Compose project `mw-pr46-review-20261012`，监听 `127.0.0.1:20046`，使用隔离网络及 tmpfs 数据。该审查环境已精确清理，无持久卷。最终日历测试没有新的部署实例、供应商访问或共享数据库写入。

## 发布与验收边界

源码发布版本为 `v1.21.0`。受测产品之后仅整理版本元数据、日志和源码清单，正式标签指向最终 main 合并提交，实际状态可由 GitHub PR #46 和 tag 引用核对。

PR 原作者的 Ubuntu 浏览器与视觉证据见 [实施记录](implementation-status.md)和[合同审计](completion-audit.md)；本次未独立复跑全部20份浏览器报告。供源 I/O 为任务合成 fixture，真实供应商链路未计为已验收；Android/iOS 实机由用户后续验收，按[既定决定](acceptance-decision.md)不阻塞合并。当前授权只包含合并和推源码 tag，不构建或部署生产实例。
