# PR #115 复核修复与验收（2026-10-29）

范围：从 PR head `56544e4b488cc9f78cc609dca2815a21e1177709` 修复六项 review 问题。风险 F1：涉及实时可用性、切换通知及持久数据清理；不改 schema，保留迁移兼容、真实 PostgreSQL、备份实际恢复与独立 Standards/Spec 复核。

## 修复与判据

| 问题 | 修复 | 验收依据 |
|---|---|---|
| 告警锁影响无关组合 | SQL 按 composite_id 过滤后再 FOR UPDATE | PostgreSQL 两事务：A 持锁，B evaluator 仍可取自己的规则 |
| 成功 run 清理无关来源 | 仅 previous/target 的精确 collection identity，核对 SourceSeries 完整身份 | 无关来源过期分钟仍保留；来源锁协调写入与删除 |
| 长时间离线仍读过期输入 | UTC 30×24h 下界统一约束候选、准备、复查、确认、读图及指标 | 40 天离线不发过期请求；过期 live 月柱不可见，固定历史保留 |
| 原始缓存与旧聚合遗留 | 增加整页过期 fetch、无有效引用 blob、整柱过期旧聚合 | 保护历史引用、窗口内内容、跨界页/柱、有效修订；PostgreSQL 使用 BIGINT 转换毫秒时间 |
| shadow 失败不提醒 | 按 run 汇总一次通知/Outbox；仅暂停绑定过期修订的告警 | 同一 run 重试仅一条通知；窗内显式候选规则继续 active |
| 淘汰候选持续消耗 | 激活时冻结其余未激活候选，清准备/聚合租约 | 后续输入不再推进淘汰候选，调度及迟到提交受 fencing |

独立复核额外发现并修复：孤立 blob 按 hash 排序的保留前缀可能导致漏清。现按 keyset 扫描，游标与删除/统计同事务持久化，跨调用续跑；未扫描到底不标 completed。回归使用 limit=chunk=1，并保留前面的窗口内 blob。

## 实际环境与复现

实际主机：Ubuntu 本机 Docker。复用本任务 worktree `/home/quant/repos/market-watch-runtime-track-c-20261028`，Compose project/network `mw-track-c-20261028`；独立数据库与 volume 未重置。源码只读挂载 `/candidate`，依赖镜像固定为 compose 中的 digest。未接触 Unraid、生产或其它任务实例。

本次只启动 PostgreSQL（`127.0.0.1:15612`）及一次性测试容器；API/Web 未启动，`127.0.0.1:18091` 本次不提供服务。测试使用随机独立 schema；恢复用随机源库和随机恢复库，校验后由测试清理其临时库。原有任务数据库、卷和备份保留。

```bash
cd /home/quant/repos/market-watch-runtime-track-c-20261028
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml start postgres
# 测试命令及套件见 results/pr115-review-fixes/commands.sh
bash docs/verification/runtime-market-20261026/results/pr115-review-fixes/commands.sh
docker compose -p mw-track-c-20261028 -f deploy/ubuntu/runtime-track-c.acceptance.yaml stop postgres
```

## 验证结果

- 主相关回归：**308 passed**，包括 PostgreSQL 清理/激活/shadow、来源页、迁移升降级兼容；10 条既有 Alembic 配置弃用警告。
- 依赖回归：**209 passed**，见 `docker-dependent-final.txt`。
- 新增边界验收：**31 passed**，见 `docker-boundary-final.txt`，含真实 PostgreSQL 旧产品删除与历史/有效引用保护。
- 备份实际恢复：**5 passed**。`test_postgres_dump_restore_of_signal_and_outbox` 实际 pg_dump → 新库 pg_restore，比对全表计数及工作区、偏好、队列 JSON 内容；不是只读 dump 清单。
- 全库测试收集：**3437 tests collected**；补跑 PostgreSQL 聚合兼容套件 **10 passed**。首轮远端 CI 发现测试改名后 PostgreSQL 合同引用未同步，已修正并补这两项检查。
- Ruff、diff whitespace 检查通过。
- Standards 与 Spec 独立复核均通过，无剩余阻塞。复核分别独立验证 25 项与 52 项；最终小幅测试预期调整由主 agent 在 Docker 验证。

日志目录：`results/pr115-review-fixes/`，最终证据摘要见 SHA256SUMS。早期失败日志保留：容器禁用 resident symbols 导致旧测试夹具为空，已显式固定测试配置；PG JSON 毫秒时间原 INTEGER 溢出，已改 BIGINT；旧测试预期可展示过期月柱，已按新的可用性规则修正。

## 边界

本次验证为应用代码与真实数据库验收；供应商使用 fixture，没有真实备用供应商自动切换、外部通知送达或生产删除证据。原 Track C 验收历史保留原提交、时钟和范围；其中超过 30 天接缝场景不再作为当前可用性规则的通过依据。A04b 的真实来源切换仍按既有部分交付状态记录。

修复更新 PR #115；合并与生产发布仍是独立操作。

## 最新 CI 时钟修复（2026-10-29，基线 bda46b3c）

远端 run 40820398011：17 failed / 3428 passed / 3 skipped。16 项是确认/恢复/死锁测试使用 1970 固定行情时钟，但新 live_window 检查仍读取真实时间；1 项是 MCP synthetic seed 的临时时钟在返回时恢复，后续指标 drain 无法服务过期接缝。

本补丁风险 P0，仅调整四个测试文件的局部 monkeypatch：固定窗口校验与原采集时钟一致，MCP HTTP 查询与指标准备使用同一 fixture 时间。生产可用性校验、schema、后台链路均不修改。复用现有失败用例，不增加镜像实现细节的测试。

Ubuntu 本机 Docker project mw-track-c-20261028（独立 PostgreSQL 127.0.0.1:15612），先复现 confirmation 与 MCP 两项：2 failed in 5.40s。修复后运行四个完整受影响套件：55 passed in 92.49s；再运行 test_track_c_review_fixes.py 与其 PostgreSQL 套件：23 passed in 32.02s，包括超窗拒绝、40 天离线、清理范围和通知/fencing 合同。Ruff 与 git diff --check 通过。

复现命令使用现有 deploy/ubuntu/runtime-track-c.acceptance.yaml 的 data-worker 一次性容器，显式将 ALERTS_OANDA_ACCOUNT_ID 置空、ALERTS_OANDA_RESIDENT_SYMBOLS 设为 EUR_USD,XAU_USD，与 CI 默认配置一致；TEST_POSTGRES_URL 指向本任务 postgres。四个套件：test_confirmation_session.py、test_composite_mcp.py、test_oanda_recovery_postgres.py、test_pricing_publication_deadlock_postgres.py。

此轮仅启动 postgres 与一次性测试容器；完成后 stop postgres，保留原数据库/volume。未做生产操作。远端全量 CI 由补丁推送后重新运行。
