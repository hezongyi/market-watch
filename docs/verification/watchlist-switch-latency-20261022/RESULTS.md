# 自选切换延迟：修复候选与验证结果

代码和制品已准备完成；长期 `mwa` 尚未更新，原五图端到端验收及性能对照尚未完成。不能据此宣称真实切换已达到目标，或其他链路性能没有下降。

## 固定候选

- 分支：`fix/watchlist-latency-20261022`。
- 基线：`983b40246d8d80e5f903fee7fb980e4ae516d03a`。
- 产品提交：`defdcf93ef9482a25af83c09ad0f8c80d5f3519a`，包含先前实现 `f7e6ee7`。后续本目录文档不改变产品代码。
- 工作树：`/home/quant/repos/market-watch-watchlist-latency-20261022`。
- 风险：F1，涉及指标容量准入的重要后台链路；无 schema、持久格式或数据口径变化。
- 构建主机：Ubuntu `quant-server`；三个镜像均经 `mw-docker build`、专用 builder `market-watch-ubuntu`，task/project 为 `mw-watchlist-latency-20261022`、用途 `acceptance`。三个构建标签均为上述提交、`dirty=false`。

| 制品 | 固定镜像 ID |
| --- | --- |
| API／worker | `sha256:e99db5faa570c779780da31bec004413ff278c0e10add18f3a0685a9114a2eaa` |
| Web | `sha256:2ec2306beeba6373cd3cb6f319cdd36e6333c277c6c902e0c2e911789069b6d9` |
| Chart | `sha256:e5d7a70f2896effdc96e3f9a861d26292ccd41b0e085c2a575abb1fbee6e29e0` |

[完整制品身份](candidate-images.json)，Web 构建 origin 固定为 `https://192.168.7.232:18281`。镜像检查只执行了隔离容器中的模块导入／来源比对及 nginx 配置检查，不能替代 R1 业务验收，见 [image-probes.json](image-probes.json)。Chart 镜像内的 bridge 与已审源码完全一致，见 [chart-assets-check.json](chart-assets-check.json)。许可库未提交仓库，检查未输出许可源码。

## 最终行为

1. 成功取得历史 result 后立即交付价格，句柄清理继续执行，使用独立 5 秒预算；失败或真实取消仍等待清理。所有加载加回收最多占四个生命周期，防御队列最多 64 项，取消和准入时的过期检查保留。清理失败记录计数，远端原有 TTL／owner 容量保护继续兜底，不保证远端立即回收。
2. bridge 统一判定用途、准入和公平性。普通并发仍为四，管理两槽保留；reserve、报价、指标释放／续租和辅助缓存读取共享两个后台位，报价单飞；活动首屏优先，每四次普通派发一次 FIFO。尚未执行的原生读取通过额度反馈保留在同一队列，清理释放额度后重新判断当前焦点。旧读取可继续填充原生缓存。
3. 可选默认预热先尝试获取原有事务 advisory lock；忙则跳过本次预热，不等待该容量锁。锁空闲后仍能登记 SMA／EMA 20，前台真实指标需求沿用原有 guard、容量及取消围栏。默认预热尚未全部移出价格事务；非竞争成本是否仍显著，留待实际分段测量。

本地用途、生命周期客户端身份与容量确认不进入 HTTP 请求体或缓存 key。初始额度包括旧工作区未回收句柄；迟到的旧 iframe 确认／结果不能释放新 iframe 的预占。新旧父窗口混用保留容量退路，但完整的动态焦点准入需要本批 Web 与 Chart 配套。

## 验证证据

| 检查 | 结果 | 实际覆盖及边界 |
| --- | --- | --- |
| Python／真实 PostgreSQL 定向回归 | **106 passed，154.96 秒** | 指标需求、strict／observed、固定价格／指标、快照、容量、取消、原生历史；在任务独占 PG14.24 的独立 schema 上运行 |
| CI 三组前端 runtime 命令 | **50/50 passed，15.37 秒** | 包括实际 bridge＋TS 模块联合异步消息回放、原生缓存、取消、预取、报价、管理、偏好、通知与指标 |
| 六条独立 Chromium DOM／React 命令 | **6/6 passed，29.46 秒** | 自选布局／名称、旗标、消息历史、告警编辑、退出行为；全新临时浏览器，不连接受保护 CDP |
| `npm run build` | **通过** | TypeScript、Vite、data-center；保留现有超过 500 KiB chunk 提醒 |
| changed Python Ruff、`git diff --check` | **通过** | 未引入 schema 或持久协议差异 |
| 三个 Docker 制品 | **构建与镜像检查通过** | API 已安装模块的 SHA256 与本地候选相同；Web／Chart nginx 配置有效；未启动业务验收栈 |
| 独立双轴审查 | **最终阻断项为零** | 报告分别列在下文 |
| 长期 mwa 原五图／指标／翻页／连续切换 | **未运行候选验收** | 仍需明确更新指令和实际复测 |
| GitHub CI、远端 PR | **本任务未推送或创建** | 本地回归不冒充远端 CI；[PR 草案](PR-DRAFT.md) 已准备 |

106 项后端检查对应 `f7e6ee7` 的后端代码；`git diff f7e6ee7 defdcf9 -- backend` 为空，后续修复仅涉及前端及文档。PostgreSQL 容器为 `mw-watchlist-latency-tests-20261022-postgres-1`，没有使用 mwa 或其他任务的可写数据库。检查结束后已停止本任务 PG，保留配置与 volume。没有对长期实例执行迁移、清库或试验映射／告警写入。

前端命令来源是 `.github/workflows/ci.yml` 的 `Indicator runtime regressions`、`Watchlist bridge regressions`、`Single application regressions`；浏览器命令对应 `Watchlist native DOM regressions`。原有偏好通知测试的过时字符串提取及 draft RPC stub 已修正，修正后的测试在基线和候选均通过；缺失的本地依赖经本 worktree `npm ci` 补齐。

详细本机日志位于 `/tmp/mw-watchlist-latency-tests-20261022/`：`web-regressions-final.log`、`browser-regressions.log`、`build-api.log`、`build-web.log`、`build-chart.log`。该临时目录不承诺长期保留；本页保留最终结果和固定制品身份。

### 修复前失败、修复后通过

- `advanced-history-loading.cjs`：成功 result 已返回、cancel 持续 pending，价格仍必须立即交付；覆盖四生命周期上限、排队取消、准入时已过期、最终归零及清理失败计数。
- `advanced-market-request-scheduling.cjs`：原释放／报价占满四槽及四次指标续租占满四槽均能阻塞活动首屏；修复后后台占用不超过二，并覆盖当前焦点、公平服务和固定 reserve。
- `advanced-history-admission.cjs`：四个成功句柄清理未完，旧焦点四项排队后切换焦点；原实现下一次 HTTP 提交为 `old0`，修复后为 `new`，模块正常流量的第二层队列为零。使用实际 bridge、实际 TS loader 和异步消息，不替换调度算法。
- `test_price_defaults_skip_busy_capacity_lock_and_can_warm_on_next_read`：另一事务持续持有容量锁时，修复前超时，修复后价格返回且未登记可选预热；释放锁后的下一次价格读取可登记两项默认预热。该超时用于锁依赖判断，不是产品延迟 SLA。

`deep/probe-cleanup.cjs` 是旧缺陷证人，刻意断言“价格仍在等待清理”，修复后预期失败；修复验收使用上述真实模块回归。`deep/probe-queue.cjs` 已更新为核对当前 bridge 哈希和镜像内完整源码，并记录生命周期回落；本次仅检查语法与镜像注入锚点，尚未对候选执行线上浏览器测量。

## Standards

前次审查未发现硬性规范违规或具体正确性缺陷。唯一非阻断建议为 Mysterious Name：`interaction` 实际表示任意请求的队列下标，本次已改为 `selectedIndex`。

增量 `f7e6ee7..defdcf9` 只读复审未发现新增硬性违规或可具体指出的正确性缺陷。续租纳入两后台位；容量快照、派发预占、逐 ID 确认及 `history_client` 围栏与实施合同一致，本地元数据未进入 HTTP 查询身份。符合 F1 分类与兼容验证要求，没有破坏数据集身份约束。无新增非阻断建议。审查者没有访问实例或私有配置，测试沿用主流程证据。

## Spec

初审发现两项 P2：指标续租遗漏后台预算；清理重叠时模块 FIFO 绕过动态焦点。二者均已修复，跟进只读复审确认关闭；未发现新增 Spec 缺陷，阻断项为零。

复审确认未准入读取留在 bridge 队列，清理释放额度后按当前焦点选择；快照与未确认预占共同限流；取消、旧 iframe 消息隔离及旧父窗口退路符合更新合同。审查者独立执行并通过 `advanced-history-loading.cjs`、`advanced-market-request-scheduling.cjs`、`advanced-history-admission.cjs`、`advanced-inflight-cancellation.cjs`、`advanced-provider-request-lifetime.cjs`；未访问实例或私有配置。

双轴最终结果：Standards 硬性发现 0；Spec 未关闭发现 0（初审 2 项 P2 已关闭）。

## 下一步验收与性能边界

`mwa` 最近只读快照为 [mwa-before-update.json](mwa-before-update.json)，2026-10-22 23:29:46 UTC：15 服务运行，API／PG healthy，本任务没有更新任何长期实例服务。候选基线已包含当前 API／Web `1ba2b33` 与 Chart `0bd610e` 的产品源码，没有回退既有修复。

更新提案已经具体化：[候选镜像覆盖](mwa-candidate.override.json) 与 [对应回退覆盖](mwa-rollback.override.json)，仅为 13 项应用服务指定固定镜像；PG、gateway、认证、供源、TLS、数据、端口及受保护浏览器均沿用现场。覆盖文件**尚未应用**，不能单独代替既有完整私有配置；实际更新前须重核实例及其他会话变更，再基于当前配置比对并更新持久运维入口。

长期入口仍为 `https://192.168.7.232:18280`，Chart 为 `https://192.168.7.232:18281`，已有启停／状态命令为：

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py stop
```

这些命令目前仍指向既有运行版本，不会应用本目录的候选覆盖。更新授权按 [mw-acceptance 技能](/home/quant/.codex/skills/mw-acceptance/SKILL.md) 的明确指令规则办理；已完成修复和制品准备后，只需用户确认更新并验收，不要求重复确认保留数据配置。

换版后先做相称的 Ubuntu R1：同一 1600×1000 视口、原 H1／M5／W1／D1／H4 五图和原指标，记录活动首屏、全部图格、首次指标、缓存回切、历史翻页、加载中连切与最终资源回落；保护布局／偏好／通知写入及原浏览器现场。不能靠关闭指标、reserve 或新鲜度检查制造收益。

本次不承诺零退化：后台两槽及忙时跳过预热可能让可选工作更晚完成；公平性以槽位释放后的派发轮次为界，无法抢占已执行的长 I/O。真实前台指标合同保留，但首次指标、报价与预取的延迟仍需实测。远端清理失败继续依赖 TTL，而默认预热在非竞争时仍位于价格事务中。

23:21 UTC 主机有多个其他验收项目，load 为 6.78／5.94／6.18，可用内存约 6.64 GB、磁盘约 33.41 GB。因此没有额外启动整套实例或压力测试，也没有停止其他任务。现有诊断每场景单次数据及 3 秒报警线不构成已批准 SLA；需要 p50／p95 时，再由用户协调稳定窗口，按缓存类别收集足够重复样本。

达到目标后停止扩大重构；仍慢则依据残余分段证据决定默认预热独立事务或 worker／供源的下一项，不预设全局重写。未合并、未创建正式 tag、未发布生产。
