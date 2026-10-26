# 分钟确认与快照恢复：实现与验收收口

日期：2026-10-24。基线 `v1.28.0^{}` = `59ed3a3f3fc727da76d13149934d999ebee04218`；分支 `fix/confirmation-snapshot-20261024`；隔离 worktree `/home/quant/repos/market-watch-confirmation-snapshot-20261024`。风险 F1：修改重要确认后台链路及可选 JSON 证据，无 schema 迁移。

代码阶段遵守“当前只代码实现，验收前申请”；用户随后明确授权“进行验收”。长期实例已更新至干净产品提交 `3e674dd752de366c334702b2673a4c1be9cd0443`：实现提交 `37b21783` 合入实例当时的 Chart 产品 `09b8ba14`，保留 Swing、全局右下角通知、Supertrend 精度和 BBands 填充。原生浏览器验收、含 PG 的后端全量及用户人工验收均通过，本次任务收口。运行产品仍为上述 `3e674dd7`；本次收口提交只补测试与文档，不重新构建产品镜像。不创建 PR，不 push、合并或发布生产；未应用会话候选、修改既有消息确认、执行 seed/reset/schema 迁移。

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
| 独立 PostgreSQL 最终专项 | `acceptance-postgres-specialized.txt`：19 passed，包含 10 项真实事务/worker/transport 确认场景及 mapping/observed 兼容性 |
| 实际候选 API 镜像与独立 PG | `acceptance-image-check.txt`：86 passed，覆盖确认、快照及错误证据契约 |
| 合入既有 UI 修复后的前端 CI 本地等效 | `acceptance-web-ci.txt`：61 commands passed |
| 含 PG 的最终后端全量 | `acceptance-backend-full.txt`：2890 passed，3 skipped，77 warnings，3180.05 秒；零失败、零错误 |

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

历史代码阶段无 PG 的全量运行中，38 项初始化错误来自 `test_native_update_diagnosis.py`（15 项）和 `test_provider_stream_acceptance.py`（23 项）直接读取缺失的 `TEST_POSTGRES_URL`；没有跳过或改写测试来隐藏环境缺失。唯一断言失败是 `test_oanda_payload_semantics.py` 原先要求 HTTP 错误 detail 只含 code/message，现已更新为保留两字段并核对新增有限证据，最终 163 项定向回归通过。获得验收授权后复用任务独立 PG，运行真正含 PG 的全量，结果以上表及最终报告为准。

本人按 Standards/Spec 两个维度自审：沿用现有会话解析、Preference JSON、通知身份及恢复入口；未加 schema、调度框架或新的高频轮询。逐项核对原任务书，代码机制及兼容测试已覆盖；原生行为及 PG 专项已验收，最终后端全量和用户人工验收也已通过，按下表如实记录。遵守本任务“不使用子 Agent”要求，未开展独立 Agent review。

## 验收范围与证据边界

| 场景 | 代码证据 | 实际验收 |
| --- | --- | --- |
| 缺失/过期/错 scope + unknown empty | 不误报、不假 ready；真实 worker/adapter 的有界 HTTP 请求测试 | 独立 PG 专项通过 |
| 有效运行规则与历史不同 | 重分类、历史身份不变；闭市、开市、DST 与边界测试 | 实例只读核对：两个过期、一个缺失，保留 unknown |
| 真实观测缺口与合法稀疏数据 | 实际事务、回补、跨批缺口及 provisional REST 观察测试 | 独立 PG 专项通过 |
| TLS/401/维护/旧 owner/epoch、采样隔离 | 既有定向回归保留 | 定向回归及候选镜像专项通过 |
| 多图忙等待、凭据再到期、旧工作区取消 | 实际 bridge/reloadHistory VM 测试及既有恢复回归 | 原生多图、XAU D1 三指标恢复及文档/周期取消通过 |
| 快照真正修订、TTL、身份、epoch、日历 | 后端拒收与安全证据测试、价格逐行比较回归 | 浏览器 missing/revision 注入恢复 + PG/API 真实拒收通过 |
| SSE 断开/重连/恢复/卸载 | 原通道行为、evidence 和 ended 测试 | 临时浏览器代理断开真实 socket，open/error/open 通过 |
| 未读、已处理、手机确认 | 消息/通知回归保留，代码不改变确认语义 | 既有 23,837 条已读/处理状态和 7 条手机 ack 保持 |
| 旧 JSON/旧客户端 | 可选字段、旧 health JSON、无证据响应测试 | 保留真实记录，候选镜像及兼容回归通过 |

原生脚本要求 `MW_TEST_BASE_URL`、`MW_TEST_CHART_URL`、`MW_TEST_CREDENTIALS_FILE`、`MW_TEST_ARTIFACT_DIR`；使用临时浏览器 context、已有 readOnlyAcceptance 配置 shadow 与通知写拦截，保留长期浏览器现场。实际已验证多图真实 HTTP 重载挂起超过 3 秒、deferred attempts=0、释放后一次原生刷新恢复 XAU D1 的 Swing/Supertrend/RSI，参数/样式/计算起点/范围保持。通过仅供临时浏览器使用的 loopback CONNECT 代理断开真实 SSE，观察到 open→error（CONNECTING）→open，pageerror=0；普通浏览器 offline API 未能断开既有 SSE，不能拿它作为断连证据。missing/revision 为浏览器内存注入，真实价格读取、PG 和图表均沿用实例；不删除服务端快照，也不宣称生产 TTL 特例已复现。六种真实后端拒收与 TTL 边界由 PG/API 专项覆盖。原生文档重载取消实际原因为 `credential_superseded`，周期切换为 `viewer_removed`，均 attempts=0；不声称原生文档重载触发了 workspace epoch 增长，显式旧 epoch 取消由 VM 用例覆盖。最终浏览器报告 `passed=true`、pageErrors=[]，五次持久写全部被 shadow 拦截。参数/样式比较使用当时现有配置，并非非默认参数持久保存验收；后者留给人工检查。最终截图在取消测试后为 H4，D1 三指标已在前段断言。

人工验收已开放 [XAU 图表入口](https://192.168.7.232:18280/advanced-charts/mw75-real)：核对 D1 三指标、非默认参数/颜色刷新保留、双图切换恢复、切换工作区无旧错误、价格精度/BBands 底色/右下角通知，可选本机断网恢复。用户随后明确回复“我验收了，都达标”，人工验收通过，见本机证据 `manual-acceptance.json`。

重复原生验收（取得本次验收授权后，凭据文件只需含 `login_password`，不要把私有文件放入仓库）：

```bash
cd web
MW_TEST_BASE_URL=https://192.168.7.232:18280 \
MW_TEST_CHART_URL=https://192.168.7.232:18281 \
MW_TEST_CREDENTIALS_FILE=/absolute/private/credentials.json \
MW_TEST_ARTIFACT_DIR=/absolute/private/artifacts \
node tests/confirmation-snapshot-recovery.browser.cjs
```

任务独立 PostgreSQL：project `mw-confirmation-snapshot-test-20261024`，loopback 18792，复用原 volume，不共享长期实例可写数据库。最终专项、候选镜像验证和全量均已完成；测试 PG 已停止，容器与原 volume 保留。标准 retire 预览因该测试 project 未按 acceptance project 登记而拒绝，未执行 apply 或绕过校验，未删除数据；见 `test-pg-stopped.json`。

私有会话候选位于任务私有目录，三品种审核窗为 2026-10-24 00:00Z—2026-10-31 00:00Z；脱敏 diff 位于本机证据目录。尚未应用。执行晚于审核窗需重新取证与生成。

生产事件只有同时间窗口的快照/指标失败证据，不能证明 busy 是该次生产唯一触发因素；SSE 原始断线原因仍未知。本次修复可复现机制并补充后续定位证据。

## 实际运行与数据保护

主机为 Ubuntu `quant-server`，长期 project `mw-issue75-v2-20261018`，App `https://192.168.7.232:18280`、Chart `https://192.168.7.232:18281`。13 个必要应用服务更新，DB/gateway 原容器保持。`mwa-after.json` 证明 15 服务 running、API/PG healthy、配置/挂载/网络/端口/命令/资源/restart policy 不变；保护浏览器身份及启动时间保持。镜像均为干净产品提交 `3e674dd7`：API `sha256:bcdc0426559d2e3c21384dfbb565987da166e907394522c14ddae76a5c746f92`，Chart `sha256:450b159a9fb6cbacaafb7c533c4434698b346a85b02d2cc4e68abca21af5f555`，Web `sha256:53b32e8520ca469185674342fc30d60b8761231750db399c523fce0308133218`。

第一轮只读比较：既有 23,837 条 NoticeEvent 的 viewed_at/handled_at、7 条手机 ack 均未改变；工作区、数据集、历史版本/产物数量与完整行 hash 保持。09:05Z 最终只读检查中，数据集及历史产物仍完全保持，既有消息状态仍零变化，自然新增 50 条 NoticeEvent；工作区仍 10 行但 hash 已变化，人工验收开放后的并发桌面保存单列在 `concurrent-chart-saves.json`，不宣称所有用户持久表完全未变。偏好仍 30 行但 hash 变化，gateway 证据显示并发 Windows 桌面客户端在另一个工作区正常保存（08:35:37Z、08:57:50Z，HTTP 200），见 `preference-concurrent-saves.json`；保留用户现场，不回写覆盖。测试 context 已拦截所有工作区/偏好保存及通知写入。来源只读状态为两个 outside_reviewed_window、一个 missing_profile，均保留 unknown、confirmation_error=null、recovery_ready=false，未伪造闭市或就绪；Yahoo 实际 Settings=true。

08:20Z—09:05Z 有界运行日志聚合：13 个应用服务 HTTP 500=0、连接池超时=0；API 有 38 处 traceback，异常类均为 `asyncio.exceptions.CancelledError`，与客户端断连/临时 context 关闭同类，不能据此宣称零异常。见 `runtime-log-counts-final.json`；不扩展为长期稳定性结论。

统一长期启停：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`；本轮仅应用服务操作：`python3 /home/quant/repos/.mwa-confirmation-snapshot-20261024/operate.py start|status|stop|audit`。实例与保护浏览器继续运行，勿使用临时任务清理处理长期资源。私有 `rollback-override.json` 保存 13 应用的精确旧镜像/原配置，`previous-durable.json` 保存原长期 overlay；未执行回退。最终完整结论及剩余限制以本目录收口记录和本机证据报告为准。

## 收口结论

用户明确反馈人工清单全部达标；原生忙等待恢复、三指标、文档/周期取消、SSE 真实断连重连通过。后端最终全量 2890 passed / 3 skipped（默认条件保留，未跳过失败）/ 77 warnings；分钟确认专项的独立 PG 19 项和实际 API 镜像 86 项另行通过，覆盖全量未单独启用的确认 PG 专用环境。warnings 为既有弃用提示，未隐藏或改写测试使其通过。前端 61 条本地检查全部通过，无新增代码阻断。

最终复查 15 服务运行、配置和保护现场保持；任务测试 PG 定向停止且保留数据，长期验收页继续可用。业务收口不扩大为长期稳定性或生产事故唯一根因结论。没有剩余本任务待验项；PR、推送、main 合并及生产发布不在授权范围内。
