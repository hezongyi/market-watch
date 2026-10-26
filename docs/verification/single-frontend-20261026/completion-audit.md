# 单前端与 ChartAlert 完成审计

2026-10-26；执行依据为 [实施方案](../../single-frontend-chartalert-consolidation-plan-20261026.md) 阶段 0—5 和仓库 AGENTS.md。F1 / Ubuntu R2。工作树 `/home/quant/repos/market-watch-single-frontend-20261026`，分支 `refactor/single-frontend-chartalert-20261026`，基线 `bec830c3959703287555f935984e80396622d32b`。

交付为 [Draft PR #99](https://github.com/hezongyi/market-watch/pull/99)，目标 `main`；未合并、未创建正式发布 tag、未发布生产。代码/测试提交 `d52e007c` 的 [CI run 40360675373](https://github.com/hezongyi/market-watch/actions/runs/40360675373) 已全部通过；后续文档提交的 CI 状态以 PR checks 为准。基线比 main 领先的三个前置提交已在 PR 描述披露。

## 要求与证据

以下路径从仓库根目录定位；测试结果对应实际命令或 CI 中的行为测试，不以字符串检查代替运行验证。

| 方案要求 | 当前实现与权威证据 |
| --- | --- |
| 0.1—0.4：固定基线、风险、调用/依赖、origin/持久键和保留功能 | `baseline.md`、`issue-draft.md`；独立 `.venv`/`web/node_modules`；基线与提交历史可核对。主 origin 及草稿键、通知 IndexedDB 不变。旧宿主 bridge 不读写 localStorage/sessionStorage/IndexedDB；偏好、模板和布局由应用客户端/服务端保存。 |
| 0.5：混合样本隔离 | `scripts/single_frontend_fixture.py` 限定 task、数据库主机/库名及关闭真实投递；`retirement-preview.json`、`background-after-restart.json`。普通/组合 Watch、未知来源、新 ChartAlert、已接受/在途投递混合场景由 `test_legacy_retirement.py` 补齐。 |
| 1.1：HTTP/MCP 共享应用与事务 | `chart_alert_application.py`、`chart_alert_api.py`、`capabilities/chart_alerts.py`；`test_chart_alert_capabilities.py` 覆盖相同配置、来源绑定、真实图格/画线/指标关联和协议错误。 |
| 1.2—1.3：跨入口、权限、版本、幂等与重复观察 | 同一测试覆盖 HTTP 创建→MCP 编辑→HTTP 生命周期，MCP 并发创建与稳定请求重试，旧版本冲突、只读拒绝、单规则/事件/Outbox；`acceptance.json` 为实际 HTTPS/MCP 八项验收。 |
| 1.4：旧工具/HTTP 活动入口退出 | 六个 `chart_alerts_*` 工具取代旧三个 Watch 工具；`test_native_mcp.py`、`test_legacy_retirement.py` 验证发现、权限和 410；HTTP/MCP 验收核验真实候选。 |
| 2.1—2.3：旧判定、恢复、预热和需求保活退出 | `composite_watches.py` 删除；`alert_monitor.py` 仅调 ChartAlert。`market.py`、`live_pricing.py`、`market_usage.py`、组合修订/日历管理移除活动 Watch 依赖；采集、恢复、fencing、当前告警需求仍由 market/live/pricing/composite/usage 回归覆盖。 |
| 2.4—2.6：旧页面、演练、图表、专用代码退出 | `web/src/charts`、旧 Chart/MarketDataPage/ReplayJobs 与专用执行函数删除；Lightweight Charts 从 package/lock 删除。旧 engine 被 MCP 明确拒绝。历史 ORM/迁移、日历/K 线语义和通知确认保留。 |
| 退役工具：预览、精确对象、幂等、审计、锁顺序、在途保护 | `retire_legacy.py` 默认预览、显式 `--apply`；按旧 watch_id 且无 chart_alert_id 定位，Notification→Outbox 锁顺序；拒绝未过期 sending lease，保留 rule/state/armed_at/绑定。`test_legacy_retirement.py` 验证不改未知来源/新告警、不伪造 ack、第二次零变更；隔离样本的预览和退役/重启结果已保存。 |
| 旧消息 claim/retry 与历史引用 | `notify.py` 和 retry 入口仅接纳当前 ChartAlert；退役旧消息显示真实状态。`test_legacy_retirement.py`、`test_notify.py`、history retention 测试证明历史确认有效、旧规则不重启/重投递、组合历史引用继续保护。 |
| 3.1—3.3：直接运行时、React/原生组件、无外层桥 | `ChartApplicationPage.tsx` + `web/src/runtime/{chart,session,workspace,market,alerts,notifications,dataCenter}` 直接 Interface；`chart-runtime.js` 挂载原生控件。浏览器验收确认同源库资源，仅保留 vendor 内部 iframe，无 parent 参数要求。 |
| 3.4：请求世代、释放、保存竞争与网络恢复 | `advanced-inflight-cancellation.cjs`、`advanced-provider-request-lifetime.cjs`、`advanced-native-save-race.cjs`、`advanced-native-workspaces.cjs` 及 CI recovery 系列验证旧结果拒绝、取消释放、当前保存不覆盖新编辑；teardown 异常可诊断且不阻断后续清理。 |
| 3.5：工作区/草稿/关联兼容 | `test_advanced_workspace.py` 覆盖保存、加载、复制和版本冲突；native save race、preferences/conflict、draft banner、notifications persistence 测试保护格式与键。`browser-final.json` 核验旧地址刷新、保存版本和图格身份、告警 association。无 storage/migrations schema 改动。 |
| 3.6：数据中心原生失败可重试、无业务 iframe 回退 | `advanced-host/data-center.js` 移除 fallback；真实浏览器主动拦截首次资源请求，验证错误焦点、Enter 重试和无额外 iframe。 |
| 3.7—3.8：登录白名单、历史/现代通知链接 | `single-app-routing.cjs` 验证安全 next 和旧入口退役；`notify.py` 与 notification-center resolve 生成/解析新链接。真实浏览器核验历史退役说明、现代链接定位和会话过期退出；notify 测试核验确认与重试往返。 |
| 4.1—4.3：唯一静态构建、许可版本校验、任务归属 | `build-single-frontend.mjs` 在 staging 合并 Vite 与固定图表资源；保留指纹补丁/哈希并失败即停。`web/Dockerfile` 用仓库根 context，独立 advanced-host 镜像/入口删除。最新 Web 候选由本分支 `mw_docker.py build` 用 task/project/purpose 标签构建，dirty=false。 |
| 4.4：同源代理与安全边界 | `web/nginx.conf` 代理 API/MCP/SSE，connect-src self，frame-src self/blob，无宽泛 connect 放行；HTTPS 验收核验 Secure/HttpOnly、登录/注销及凭据边界；真实浏览器零 page errors。 |
| 4.5—4.6：部署、Ubuntu preview 和当前文档 | 活跃根 Compose、production 模板及本任务 Compose 只有一个 web；删除 chart-origin 配置。ops/Compose CI 通过。README、CONTEXT、操作/维护与 MCP 文档反映新入口和契约；历史发布清单不改写。生产模板全部后端保持 Yahoo=true。 |
| 4.7—4.8：最小业务健康及 API owner | `chart_alert_health.py` 的限频 heartbeat 与 `alert_monitor.py` 接入；`test_chart_alert_health.py` 验证空规则、失败/停止/过期及单规则 waiting/blocked/stale 区分。实际 `background-after-restart.json` 有 API owner、成功时间和投递积压；readyz 仍只表示基础可用。 |
| 5：协议无关共享查询独立提交 | `fd26a23c` 提取 `chart_query.py` 与 `QueryError`，worker/MCP 直接导入；HTTP Adapter 翻译错误，非转发占位。CI 覆盖 market stream/native/history/composite/provider 和固定/递归指标；未修改算法版本/缺口策略/价格精度。 |
| 静态收口与历史数据边界 | 方案四条 rg 在运行源码及依赖中无匹配；`git diff --check bec830c3` 通过。storage.py/迁移文件没有 diff；保留 Watch/Replay/旧工作区表、Signal/Notification/Outbox、版本和日历。没有每次启动自动执行退役写入。 |
| 自审、独立 review、CI 与 Draft PR | Standards/Spec 独立审查发现的 QueryError、关联、取消和 OCI/teardown 问题均已修复；PR 描述记录结论。代码提交完整 CI 已通过，PR 保持 OPEN/Draft，分支已推送、工作树无待提交实现。 |

## 实际运行与验证

主机 `quant-server`，Docker context `default`，Ubuntu 本地 Unix socket；Compose project `mw-single-frontend-20261026`，独立网络、volume、PG14.24 和私有凭据。HTTPS `https://localhost:19643`，数据库仅回环 `127.0.0.1:19644`。Compose 定义服务 CPU/内存/日志上限；资源盘点见 `resource-checkpoint.json`。

- API 实际镜像 ID：`sha256:d0bd32ff8abac0edd498b03d2f7dd05616b3c989b633c41b4eed1376e81ccb67`。
- Web 实际镜像 ID：`sha256:65b5adf54412d39760536a3f7624f22094acc00a670db0b4b45a35decaee1117`，运行时提交 `497ec2e2`，之后只有测试/文档变化。
- CI `d52e007c`：3072 passed、3 skipped；ops 98 passed/67 subtests；额外 PG mapping 1 passed、observed policy 8 passed；Web 与 Compose 全通过。
- 本机 R2：方案列出的五个 PostgreSQL 文件 86 passed、无 skips；HTTP/MCP 八项通过；最新固定库真实浏览器九项通过，零 page errors。受管完整构建、单前端单元/原生浏览器回归、Ruff 和基线空白检查通过。
- provider 指标/网络/PostgreSQL 顺序回归 51 passed；dataset 错误契约文件 38 passed。
- `background-after-restart.json`：网页关闭后，合成行情由实际 API 循环推进到一次触发；重启后现代事件/Outbox 各一，旧 Watch 取消、旧通知未 ack、旧 Outbox 取消。`real-source.json` 单独保存真实 Binance 只读 smoke，未把合成价格称为真实。

## 未测限制与回退

CI 的 3 个 skips 不计通过；其中备份专项需要匹配 dump/restore 工具，旧采集进程降级/升级专项需要挂载 v1.14.0 源码。它们不构成本次五个 PG 核心套件的替代证据。本次未执行新的全库灾备、正式生产迁移、手机锁屏投递/长期待机或长期压力观察；没有 schema 变更，F1 兼容性依靠当前混合样本、历史迁移/引用回归和 R2 证明。真实外部通知关闭，通知 HTTP 发送/重试/确认由 MockTransport 行为测试覆盖。

告警 owner 仍是 API；API 停机期间暂停判定，不承诺零中断。独立告警进程、ORM 拆文件及第三方图表库升级属于方案第 10 节后续项目，未混入本交付。

应用回退与旧规则状态恢复分开：本候选无 schema/持久格式迁移，但回退旧代码可能恢复旧执行路径，因此不得让旧判定/投递写入者与新候选双跑，也不得因为切换旧镜像自动激活 Watch 或重发历史通知。正式生产切换须另获授权，先停止旧写入者和投递、等待在途结束、保留数据库备份及精确退役清单，切换后验证新规则与历史确认；需要恢复旧状态时按清单单独决定，不能通过启动旧版本隐式恢复。

验收实例保留供 PR 审阅，数据库、私有配置和许可库不入 Git；当前没有退役/删除这些持久资源。启动/停止见 `progress.md`，停止使用 `stop` 保留 volume；后续资源退役按 AGENTS.md 先预览、归档并恢复校验，永久删除另行授权。
