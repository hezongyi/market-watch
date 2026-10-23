# 验证记录（进行中）

主机：Ubuntu `quant-server`。代码候选 `9770d5d`，Draft PR [#94](https://github.com/hezongyi/market-watch/pull/94)。
本任务仍未完成验收、未合并、未发布。

## 已完成

- 72 个 requirements.lock 包版本逐项一致；独立 `.venv` 包含 MCP 2.3.0。
- 组合/native MCP/共享读取最新专项：45 passed（包含协议 schema、校验、部分可读/重试、null、稀疏信号、临时快照、回收、空准备、R1 脚本冷到完成及脱敏）。
- 公共元数据观察边界修复后：原实时报价用例 + 组合/共享读取 21 passed；固定指标、行情流、网页展示/快照相关回归 102 passed。
- Ruff（全部修改 Python）与 `git diff --check` 通过。
- 任务专用 Compose 展开通过；MCP 开启、固定 Host/Origin、internal 网络、独立 PG/volume/端口、无供应商凭据和外部投递。
- 最新 API 镜像通过 `mw-docker build` 构建，归属/commit/dirty=false 标签及固定镜像 ID 见 `candidate.json`。
- 源码提交 `9770d5d` 的完整 [CI 39933990391](https://github.com/hezongyi/market-watch/actions/runs/39933990391) 已成功完成：
  后端 2846 passed、18 skipped；PG 映射迁移兼容 1 passed、observed 指标策略兼容 8 passed；
  Web build/runtime/DOM 回归与 Compose 检查全部通过。完整日志留在主机 `/tmp/mw-composite-final-ci.log`。

## 完整本地检查的真实结果

首次完整本地 pytest（未连接 PostgreSQL）得到：2202 passed、619 skipped、1 failed、38 errors。
单个失败是共享读取绕过公共 metadata 时钟观察边界，已在 `9770d5d` 修复并复跑原用例。
38 个设置错误全部是既有 PostgreSQL fixture 因 `TEST_POSTGRES_URL` 未设置抛出 KeyError，
集中在 `test_native_update_diagnosis.py`、`test_provider_stream_acceptance.py`。
不把这次本地完整运行写成通过；完整结果须由配置隔离 PG 的最新 CI 和本机定向 PG 检查补证。

## 尚未执行/正在执行

- 本任务 Ubuntu PostgreSQL 定向/并发检查：未执行。
- Ubuntu R1 的真实网关 HTTP 协议 smoke：未执行。
- 启动门槛受阻：2026-10-23 10:05 UTC，5 分钟负载 6.45（门槛 ≤4），磁盘余 27 GiB、可用内存约 5 GiB。
  已报告用户协调；未停止/修改其他任务。本任务尚未创建容器、网络或数据库 volume。

## 用例证据映射

| 用例 | 当前证据 | 缺少的证据 |
|---|---|---|
| A1 | tools/list 原集合 31、只读 scope 24、新字段/依据 schema 和原权限回归 | R1 HTTP |
| A2、A4、A5 | 冷启动/部分/完成、EMA/RSI、不同参数缓存、网页数值与 K 线对应测试 | R1 HTTP + 本机 PG |
| A3 | 非活动修订元数据、MCP 显式读取和共享读取测试 | 本机 PG |
| A6 | 完整历史起点、进度、重试、已完成可见覆盖在任务结束前可读的既有/新增用例 | R1 冷到完成 |
| A7 | 长周期预热、缺口、稀疏信号、未收盘尾根及原算法回归 | 本机 PG |
| A8 | 临时快照输入对应与确认状态不推进测试 | R1 HTTP + 本机 PG |
| A9 | 参数冲突、错类型输入、外来修订、输入越界、无固定算法、容量、未知/回收/空组合；完整 CI 预算/审计回归通过 | 无 |
| A10 | 组合/活动修订/MarketDemand 不变、供应商入口禁止、R1 脚本事实前后相等 | R1 数据库前后事实 |
| A11 | 读完选择后另一事务切换活动修订/推进输入；SQLite 用例通过，PG 参数化已登记 | 实际 PostgreSQL 执行 |
| A12 | 旧 managed/provider、质量点/动态依据透传和 102 项相邻回归；完整 CI 通过 | 无 |

启动/停止/seed/drain/验证命令及私有目录见 [runbook](README.md)。

## 逐项审计定位

下列均为仓库中的具体断言位置；执行结果以以上记录为准，登记测试不等于 PostgreSQL 或 R1 已通过。

- A1：`test_composite_mcp.py::test_indicator_discovery_and_composite_validation` 检查完整权限集合 31、输入及输出 schema；
  `test_native_mcp.py::test_authentication_scopes_expiry_revoke` 保留权限验证。R1 token 只有两个只读 scope，预期可见 24 个工具。
- A2/A4/A5：`test_composite_indicators_cold_partial_retry_and_browser_parity` 比较共享网页路径的 bars/indicators，逐指标核对依据及真实 start；
  `test_sparse_signal_gap_and_different_parameters_remain_readable` 核对不同参数使用不同任务；
  `test_high_period_chart_labels_do_not_replace_source_point_times` 检查周标签不会替换指标源时间。
- A3：`test_mcp_explicit_nonactive_revision_uses_selected_price_metadata` 和
  `test_series_access.py::test_selected_nonactive_revision_supplies_all_metadata`，后者也登记到 PG contract。
- A6：组合冷启动/部分/重试协议用例；`test_fixed_indicators.py::test_historical_page_reads_full_origin_and_persisted_outputs_without_m1`、
  `test_completed_visible_coverage_is_readable_before_full_history_finishes` 检查完整初始化起点和可见结果提前可读。
- A7：组合长周期 null、稀疏/缺口、未收盘尾根用例；
  `test_fixed_indicator_display.py::test_batch_oracle_preserves_worker_null_and_dependency_semantics` 参数化覆盖既有缺口与依赖算法。
- A8：`test_provisional_snapshot_and_unclosed_confirmed_bar` 核对展示快照、临时值、确认状态不变；输入冲突在 A1 校验用例中。
- A9：协议校验、外来修订/回收/空准备、容量及全部固定规格先验校验用例；
  `test_native_mcp.py::test_host_origin_body_quota_and_disable`、`test_deadline_and_disconnect_set_cancellation` 覆盖现有预算/取消入口。
- A10：组合协议用例把 `renew_demand`、provider 数据入口替换成直接失败，并核对组合和活动修订；
  R1 脚本的 `facts` 对比真实数据库中的组合/活动修订及 `MarketDemand` 数量，后者尚待执行。
- A11：`test_series_access.py::test_revision_and_input_are_selected_before_metadata` 在选择后用另一事务切换活动修订并追加确认尾部，
  强制过期 ORM 缓存，再断言旧修订、旧输入与旧尾部。已登记到 `test_series_access_postgres.py`，本机 PG 执行尚待完成。
- A12：native MCP 兼容用例和 `test_provider_calculation_evidence_and_quality_survive_output_model`，
  另有行情流、固定指标和网页 reload 回归；最新配置 PG 的完整 CI 已通过。

交付门槛仍缺：真实 Ubuntu R1、Ubuntu 定向 PG 及最终证据提交；若后续提交改变源码，必须重核对对应 CI 和候选镜像。
Draft PR 已建立；不进入合并或生产操作。
