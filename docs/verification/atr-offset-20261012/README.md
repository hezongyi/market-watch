# ATR offset acceptance — 2026-10-12

实现基线 `463b863482a908c3d7317f5e191e4f291f1a6d4a`（PR #52 合并后的 main），dirty task worktree。主机 quant-server，Ubuntu 本机 Docker；task/project `mw-atr-offset-20261012`。详细操作见[开发记录](../../atr-offset-alert-development-20261012.md)。

## 结果与范围

PR #54 复审发现的三项 P1 已修复；**最新结果以[修复与最终复审](review-fixes/README.md)为准**：扩展 Python 328 passed / 1 skipped、最新 ATR 67 passed、真实 PostgreSQL 151 passed及追加 5 项补验，完整浏览器与最新 11 张截图通过。以下保留初始实现的原始验收记录。

- [Python 回归](python-tests.txt)：277 passed / 1 skipped（无 TEST_POSTGRES_URL 的既有通知 PostgreSQL 测试）。包括新增 ATR 合同、原告警/provider/composite 回归，以及新基线 Supertrend/fixed-indicator 回归。其后新增 NY17 worker 用例独立通过；最终 Docker 也覆盖它。
- [Node bridge/RPC](node-tests.txt)：10 passed。
- [PostgreSQL](postgres-tests.txt)：99 passed；独立 PG14 数据库内唯一 schema，包含新 ATR、事务/并发和迁移测试，无 PostgreSQL 跳过。
- [真实实例浏览器](runtime-browser.json)：实际 HTTPS/API/许可图表和原生 React renderer，不 mock HTTP；可控 Binance OHLC adapter。包含保存、编辑、生命周期、属性修改、真实鼠标拖动、刷新、后台采集、通知及重启去重。最后一轮与三个新基线镜像一致。
- [表单夹具](form-browser.json)：实际 React 表单，API 捕获夹具；默认关闭/开启预填、较小周期、无效参数、编辑保存、关闭偏移、深浅色及 375px 视口。此夹具独立于完整应用验收。
- 截图：[实际画线拖动与刷新](runtime.png)、[深色表单](form-dark.png)、[浅色 375px 表单](form-light.png)。
- [实际网页逐图审阅](visual/README.md)：补充登录真实实例后的 11 张截图，逐张查看规则、深浅色编辑、消息、通知、默认关闭/开启、画线等待、事件及当时证据；浏览器无异常，未修改告警。ATR 功能显示验收通过，保留长编辑标题截断这一轻微视觉瑕疵。
- [运行镜像](images.txt)记录三个镜像的实际 ID 和基线标签；[退役预览](retire-preview.json)仅记录本任务归属资源，没有执行删除。
- 三个镜像通过专用 BuildKit 和 mw-docker 构建；Ruff、diff check 通过。构建有原有 Web bundle 大小提示。

| 契约 | 证据入口 |
| --- | --- |
| 缺失/null offset 和旧请求 hash | test_legacy_null_config_keeps_original_hash_and_request_replay |
| 上下方向、相等不触发 | test_all_offset_directions_remain_strict_at_equality |
| 固定/水平/趋势/对数/SMA 原目标 | test_worker_targets_preserve_geometry_and_indicator_semantics |
| ATR 刷新不误报且首笔不漏，保留原目标运动 | test_refresh_keeps_first_real_sample、test_atr_refresh_keeps_original_moving_target_cross_semantics |
| H4/D1 共用收盘边界，更小周期固定 | test_h4_d1_shared_close_uses_old_day_then_rebases_on_first_new_price、test_smaller_atr_timeframe_is_fixed_through_evaluation_bucket |
| NY17、DST、周末的真实 worker 判定 | test_managed_ny17_dst_weekend_uses_confirmed_friday_atr |
| 同根盘中排除当前日线，确认延迟安全恢复 | test_intrabar_h4_d1_reference_stays_fixed_and_delayed_confirmation_recovers |
| 缺少预期参考不回退，补齐后基准恢复 | test_missing_latest_atr_waits_then_recovers_without_gap_signal |
| 固定起点、分批初始化、重启及 Wilder 对照 | test_atr_forward_initialization_persists_fixed_origin_across_bounded_pages、test_restart_checkpoint_matches_talib_and_consumes_only_new_input |
| managed/provider/published 修订 fence | test_independent_atr_revision_blocks_while_main_input_is_unchanged、test_atr_volume_refresh_does_not_block_but_price_revision_does |
| 重读保留价格确认时点 | test_unchanged_provider_overlap_does_not_rewrite_first_price_confirmation |
| composite 跨周期水位/固定修订/修订恢复 | test_composite_cross_frame_atr_watermark_seam_and_price_correction |
| 连续跨接缝的拒绝与显式接受 | test_composite_cross_frame_atr_continuous_seam_policy |
| 回滚和 PostgreSQL 并发只消费一次 | test_transaction_rollback_does_not_double_translate_or_deliver、test_concurrent_refresh_consumes_difference_and_event_once |
| provider 无浏览器、第二周期去重/清理保护 | test_provider_second_frame_polled_shared_and_protected_without_browser、runtime-browser.json |
| GeometryQuery 旧接口兼容 | test_provider_geometry_request_uses_main_dataset_without_offset_contract、完整实例画线操作 |
| 通知边界及快照、重启不重复 | runtime-browser.json、原告警通知回归 |

测试代码：[普通合同](../../../backend/tests/test_chart_alert_offsets.py)、[PostgreSQL 合同](../../../backend/tests/test_chart_alert_offsets_postgres.py)、[浏览器](../../../web/tests/atr-offset-runtime.browser.cjs)。

## 环境状态与限制

实例地址 `https://localhost:17443`，图表 `https://localhost:17444`，只监听 quant-server 本机。保留给用户复核，任务仍进行中；已执行 retire 精确预览，未 apply。结束复核后必须按[生命周期规则](../../../deploy/ubuntu/README.md)归档数据库并实际恢复核对，再删除明确归属资源。验收证据采集于提交前；用户随后授权提交 PR，生产尚未部署。

凭据、TLS 私钥、许可资源和完整浏览器状态不在证据目录。运行时原始 sink/采集日志及截图留在 `/tmp/mw-atr-offset-20261012-private/evidence`。截图仅证明该可控数据场景的 UI；完整端到端报告才记录操作断言。

没有供应商实盘取数、收益回测、生产检查或长期质量观察。可控来源用于证明价格序列/确认时点/投递契约；不把 0.2 表述为盈利或最优参数。
