# PR #131：PostgreSQL 锁竞争测试计时修正

2026-11-11；仅修正测试，P0。没有运行代码、数据库 schema 或手机协议变更。

失败 CI：[42988940042](https://github.com/hezongyi/market-watch/actions/runs/42988940042)，`test_optional_activation_does_not_block_cached_native_delivery[interest]` 在 `pending.result(timeout=0.8)` 超时，其余 3811 项通过。

## 诊断与最小复现

原测试将 300ms 请求 deadline 从线程进入时开始，800ms future 等待从提交时开始；都覆盖了请求参数、容量/快照准备和线程调度，而不只覆盖目标 optional activation。CI 日志不足以追溯当时具体慢在何处，但测试确实会把前置延迟误报为锁阻塞。

在本任务 Ubuntu Docker API 中，使用 `TEST_POSTGRES_URL=ALERTS_DATABASE_URL` 的 fixture 为每例创建随机 `provider_<uuid>` schema，完成后只删除该 schema。没有改任务 seed 或其他实例数据库。容器的 provider cache/service/display snapshots 文件与当前 worktree SHA-256 一致。

- 原场景单跑：2 passed；重复 30 轮：60 passed；原 PostgreSQL 全文件：21 passed。
- 通过 pytest hook 仅给 `cache._request_parameters` 增加 900ms 延迟，原 `[interest]` 在同一 future 等待行稳定失败：`1 failed`。该延迟发生在 activation 之前，未修改锁处理。
- 修正后相同延迟：dataset/interest 两例 `2 passed`。
- 突变校验：在 SQLAlchemy `before_cursor_execute` 仅将 activation 的 `set_config('lock_timeout', '1', true)` 替换为 `'0'`。两例均被新断言抓住：实际 SQLSTATE `57014`（statement timeout），期望 `55P03`（lock unavailable）。`2 failed` 为预期结果，不是回归失败。

## 最终断言

把短预算定位在 `service.activate` 入口，用 Event 确认真正进入受测边界后等待响应；外围请求保留独立 watchdog。直接断言 PostgreSQL SQLSTATE `55P03`，证明 optional activation 在真实持有的 dataset/interest 锁上放弃，不靠耗尽请求预算。写事务始终持锁到缓存响应返回，保留 cache hit、必需柱数和 bars 断言。

这不是单独放宽超时：禁用业务锁限制会让新测试失败。临时延迟/SQL 突变只在外部诊断脚本中使用，未加入产品或仓库测试。

最终回归：`test_provider_postgres.py` + `test_provider_cache.py`，**52 passed / 0 skipped**（72.31s）；Ruff 与 `git diff --check` 通过。临时诊断 instrumentation 未进入源码。PR CI 推送后重跑，结果以 GitHub 对该提交的检查为准。

## 完整 CI 作业预算

提交 `cde694de` 的 [43000737600](https://github.com/hezongyi/market-watch/actions/runs/43000737600) 中 Android/Web/Compose 全部通过。后端测试从 10:07:34 持续执行至 10:36:08 的 96%，此前没有 `F`/失败标记；10:36:35 被作业取消。GitHub annotation 明确为 `The job has exceeded the maximum execution time of 30m0s`。原锁竞争场景位于已完成区段；此轮不能计作全量通过。

上轮完整 Python suite 已耗时 1540.77s（25m40s），本轮 runner 下接近 29 分钟仍在正常前进，另有约一分钟依赖/工具准备。30 分钟总作业预算缺少余量。仅将 backend job 总时限改为 45 分钟，保留所有测试、单请求 deadline、锁竞争短预算及 SQLSTATE 断言，不重试或跳过失败测试。最新完整 CI 随提交重跑，结果以对应 GitHub 检查为准。
