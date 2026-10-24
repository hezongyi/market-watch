# 分钟确认与快照恢复：代码交付记录

日期：2026-10-24。基线 `v1.28.0^{}` = `59ed3a3f3fc727da76d13149934d999ebee04218`；分支 `fix/confirmation-snapshot-20261024`；隔离 worktree `/home/quant/repos/market-watch-confirmation-snapshot-20261024`。风险 F1：修改重要确认后台链路及可选 JSON 证据，无 schema 迁移。

用户最新要求为“当前只代码实现，验收前申请”。本记录交付实现与本地检查。尚未将候选部署到长期 Market Watch 验收实例，尚未执行新增原生浏览器脚本，不创建 PR。无生产配置应用、消息已读/已处理修改、正式 tag 或生产切换。

## 已实现行为

- 历史分钟与 worker 调度复用同一完整身份绑定的有效运行会话规则，既有 unknown/closed 分钟可按新审核配置重分类。下一分钟报价不再证明上一分钟有数据，持久历史身份不变。
- unknown 空响应保留等待、原故障与有界探测；只有真实已观测待确认且逾期的分钟产生 `m1_late`。真实缺口继续等待回补；没有数据证据的稀疏分钟不伪造确认，也不永久阻断后续真实数据。补旧缺口时仍检查同批次新出现的缺口。
- 来源状态集中显示配置缺失、过期、身份不匹配或边界等待，不新建配置通知表。故障证据附会话状态、revision、审核窗、expected/expectation 与观测时刻。
- GBP_USD 加入有限生成器白名单，沿用 FX 规则；审核窗仍最多七天，纽约 DST 与保守边界保留。[运行手册](../../runbooks/oanda-live-session-review.md)包含复核、应用前核对和回退边界。
- 快照恢复区分 deferred/restored/failed/cancelled。忙等待不花三次实际失败预算，复用已有生命周期和五秒维护入口唤醒；保留单系列/周期恢复合并、人工重试、旧工作区/凭据保护。原有 `reloadHistory` 调用仍返回布尔值。
- 保持 TTL、价格/时间/OHLC/volume、revision、epoch、日历校验；错误从 API 经 RPC 传递有限失效原因、attempt_ref 和单向 credential_ref。共享恢复失败在指标详情关联同一依赖事故；日志记录比较、重载与取消原因。
- SSE 增加 readyState、online、visibility、发生/恢复/结束时刻及有界重连计数，保留 EventSource CONNECTING 原生重试、CLOSED 重建及代次/顺序/取消保护。

## 复现与回归

本机证据目录：`/home/quant/repos/.reports/market-watch/20261024-confirmation-snapshot-implementation`，原分析与任务书位于相邻 `20261024-production-unread-analysis`。这些目录不提交原始私有数据。

修复前正式用例已产生分钟分类 RED 与忙等待 RED，分别留存在 `backend-red.txt`、`snapshot-red.txt`。自审新增“旧事故回补掩盖新缺口”用例再次 RED，见 `moving-gap-red.txt`，随后扩大 pending 检查范围修复。

| 检查 | 当前证据 |
| --- | --- |
| 确认链路、会话、通知兼容及快照定向回归 | `backend-targeted-final.txt`：163 passed，35 skipped（PG 分支）；含最终源码与更新后的 HTTP 契约断言 |
| 快照 TTL/identity/epoch/calendar/legacy/missing 及原有读写保护 | 已纳入上述定向回归，保留六种真实拒收、脱敏证据与 HTTP 诊断头关联断言 |
| 前端 CI 中全部本地命令 | `local-web-ci-final.txt`：61 commands passed；最终取消证据断言另行通过 |
| 运维本地回归 | `ci-ops.txt`：97 passed，66 subtests passed |
| 前端构建 | `npm run build` 通过，保留原有 bundle 大小提示 |
| Ruff、语法、diff | 变更 Python 的 Ruff、变更 JS 的语法检查、`git diff --check` 通过 |
| Compose 静态展开 | `compose-static-final.txt`：四份 CI Compose 配置通过；只使用临时占位配置，未启动服务 |
| 后端全量本地回归 | `local-backend-full.txt`：2234 passed，619 skipped，1 failed，38 errors；详见下段，不是完整通过 |

最小重复命令（仓库根目录及 web 目录）：

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_confirmation_session.py backend/tests/test_live_pricing.py \
  backend/tests/test_notice_reliability.py backend/tests/test_oanda_recovery.py \
  backend/tests/test_live_session.py backend/tests/test_provider_display_snapshots.py \
  backend/tests/test_notification_center.py backend/tests/test_oanda_payload_semantics.py
cd web
node tests/display-recovery-deferred.cjs
node tests/provider-credential-recovery.cjs
node tests/display-recovery-lifecycle.cjs
node tests/snapshot-error-evidence.cjs
node tests/advanced-provider-subscriptions.cjs
npm run build
```

前端 VM/React/browser fixture 检查都属于本地代码回归，不是长期实例的原生行情验收。未创建 PR，所以没有 hosted PR CI 结果。

收口前全量运行的 38 项初始化错误均为既有 PG 专项直接读取缺失的 `TEST_POSTGRES_URL`，位于 `test_native_update_diagnosis.py`（15 项）和 `test_provider_stream_acceptance.py`（23 项）。按当前仅代码授权不启动数据库，也不改这些测试来隐藏缺少环境的事实。唯一断言失败是 `test_oanda_payload_semantics.py` 原先要求 HTTP 错误 detail 只含 code/message；现已更新为保留两字段并核对新增有限证据，最终 163 项定向回归通过。全量之后新增的缺口修复也包含在该次最终定向回归中；没有再次把无 PG 的全量结果标绿。

本人按 Standards/Spec 两个维度自审：沿用现有会话解析、Preference JSON、通知身份及恢复入口；未加 schema、调度框架或新的高频轮询。逐项核对原任务书，代码机制及兼容测试已覆盖；原生行为、最终 PG 与实际验收仍按下表留待授权。遵守本任务“不使用子 Agent”要求，未开展独立 Agent review。

## 待授权的验收与已知边界

| 场景 | 代码证据 | 后续验收 |
| --- | --- | --- |
| 缺失/过期/错 scope + unknown empty | 不误报、不假 ready；真实 worker/adapter 的有界 HTTP 请求测试 | 独立 PG 专项复测 |
| 有效运行规则与历史不同 | 重分类、历史身份不变；闭市、开市、DST 与边界测试 | 实例状态核对 |
| 真实观测缺口与合法稀疏数据 | 实际事务、回补、跨批缺口及 provisional REST 观察测试 | PG 上复核 |
| TLS/401/维护/旧 owner/epoch、采样隔离 | 既有定向回归保留 | 按最小场景复核 |
| 多图忙等待、凭据再到期、旧工作区取消 | 实际 bridge/reloadHistory VM 测试及既有恢复回归 | 原生多图、XAU D1 + Swing/Supertrend/RSI |
| 快照真正修订、TTL、身份、epoch、日历 | 后端拒收与安全证据测试、价格逐行比较回归 | 原生注入与真实接口组合验证 |
| SSE 断开/重连/恢复/卸载 | 原通道行为、evidence 和 ended 测试 | 真实浏览器 offline/online |
| 未读、已处理、手机确认 | 消息/通知回归保留，代码不改变确认语义 | 实例只读核对 |
| 旧 JSON/旧客户端 | 可选字段、旧 health JSON、无证据响应测试 | 保留实例真实记录复核 |

新增 `web/tests/confirmation-snapshot-recovery.browser.cjs` 只通过语法检查，尚未运行。它要求 `MW_TEST_BASE_URL`、`MW_TEST_CHART_URL`、`MW_TEST_CREDENTIALS_FILE`、`MW_TEST_ARTIFACT_DIR`；使用临时浏览器 context、配置 shadow 与通知写拦截，保留长期浏览器现场。多图忙等待和 missing/revision 注入为浏览器局部合成场景，不主动删除服务端快照，也不能证明生产 TTL 特例已复现。导航切换与真实 TTL 场景仍需验收补证。

授权范围收紧前，任务独立 PostgreSQL 早期专项曾 15 passed；数据库现已停止、volume 保留。后续源码已变化，该结果不作为最终 PG/R1 通过。当前不会重启数据库或构建/部署验收候选。

私有会话候选位于任务私有目录，三品种审核窗为 2026-10-24 00:00Z—2026-10-31 00:00Z；脱敏 diff 位于本机证据目录。尚未应用。执行晚于审核窗需重新取证与生成。

生产事件只有同时间窗口的快照/指标失败证据，不能证明 busy 是该次生产唯一触发因素；SSE 原始断线原因仍未知。本次交付修复可复现机制并补充后续定位证据。下一阶段须先获用户验收授权，再只读核对长期实例归属、其他任务并发、资源和当前代码版本，按 mw-acceptance 技能沿用实例及真实数据/配置。
