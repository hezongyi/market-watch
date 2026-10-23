# 自选切换延迟：修复候选与验证结果

候选 `defdcf9` 已更新至长期 `mwa`。首屏优先、成功价格与清理解耦、后台及生命周期有界已有证据；自建／组合的活动图诊断样本明显缩短，但平台仍慢。最终快速连切复核出现活动 H1 等待 90 秒未就绪，**业务验收未全部通过，不能宣告性能问题解决或其他链路零退化**。

用户于 2026-10-23 要求先汇总优化前后与目标，再决定阶段收口或继续调度改造。已暂停新增改造，保留当前候选和失败证据，未自动回滚。决策摘要见 [OUTCOME-20261023.md](OUTCOME-20261023.md)。

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
| 三个 Docker 制品 | **构建、镜像检查与 mwa 更新通过** | 13 应用服务换版；15 服务运行，API／PG healthy；环境、挂载、端口、网络及 API MCP 配置保留 |
| 独立双轴审查 | **最终阻断项为零** | 报告分别列在下文 |
| 长期 mwa 原五图／指标／翻页／连续切换 | **部分通过，最终连切未通过** | 三类价格、原四个 study 的有效值、平台与固定历史翻页通过；一轮连切通过，最终复核活动 H1 90 秒未就绪 |
| GitHub CI、远端 PR | **本任务未推送或创建** | 本地回归不冒充远端 CI；[PR 草案](PR-DRAFT.md) 已准备 |

106 项后端检查对应 `f7e6ee7` 的后端代码；`git diff f7e6ee7 defdcf9 -- backend` 为空，后续修复仅涉及前端及文档。PostgreSQL 容器为 `mw-watchlist-latency-tests-20261022-postgres-1`，没有使用 mwa 或其他任务的可写数据库。检查结束后已停止本任务 PG，保留配置与 volume。没有对长期实例执行迁移、清库或试验映射／告警写入。

前端命令来源是 `.github/workflows/ci.yml` 的 `Indicator runtime regressions`、`Watchlist bridge regressions`、`Single application regressions`；浏览器命令对应 `Watchlist native DOM regressions`。原有偏好通知测试的过时字符串提取及 draft RPC stub 已修正，修正后的测试在基线和候选均通过；缺失的本地依赖经本 worktree `npm ci` 补齐。

详细本机日志位于 `/tmp/mw-watchlist-latency-tests-20261022/`：`web-regressions-final.log`、`browser-regressions.log`、`build-api.log`、`build-web.log`、`build-chart.log`。该临时目录不承诺长期保留；本页保留最终结果和固定制品身份。

### 修复前失败、修复后通过

- `advanced-history-loading.cjs`：成功 result 已返回、cancel 持续 pending，价格仍必须立即交付；覆盖四生命周期上限、排队取消、准入时已过期、最终归零及清理失败计数。
- `advanced-market-request-scheduling.cjs`：原释放／报价占满四槽及四次指标续租占满四槽均能阻塞活动首屏；修复后后台占用不超过二，并覆盖当前焦点、公平服务和固定 reserve。
- `advanced-history-admission.cjs`：四个成功句柄清理未完，旧焦点四项排队后切换焦点；原实现下一次 HTTP 提交为 `old0`，修复后为 `new`，模块正常流量的第二层队列为零。使用实际 bridge、实际 TS loader 和异步消息，不替换调度算法。
- `test_price_defaults_skip_busy_capacity_lock_and_can_warm_on_next_read`：另一事务持续持有容量锁时，修复前超时，修复后价格返回且未登记可选预热；释放锁后的下一次价格读取可登记两项默认预热。该超时用于锁依赖判断，不是产品延迟 SLA。

`deep/probe-cleanup.cjs` 是旧缺陷证人，刻意断言“价格仍在等待清理”，修复后预期失败；修复验收使用上述真实模块回归。`deep/probe-queue.cjs` 已核对当前 bridge 哈希和镜像内完整源码，并完成候选浏览器观测。四次切换活动 H1 首屏派发等待均为 0 ms；最终加载、清理、排队及清理失败计数均为 0。四次仍触发 3 秒诊断慢告警，此阈值不是已批准 SLA。

## Standards

前次审查未发现硬性规范违规或具体正确性缺陷。唯一非阻断建议为 Mysterious Name：`interaction` 实际表示任意请求的队列下标，本次已改为 `selectedIndex`。

增量 `f7e6ee7..defdcf9` 只读复审未发现新增硬性违规或可具体指出的正确性缺陷。续租纳入两后台位；容量快照、派发预占、逐 ID 确认及 `history_client` 围栏与实施合同一致，本地元数据未进入 HTTP 查询身份。符合 F1 分类与兼容验证要求，没有破坏数据集身份约束。无新增非阻断建议。审查者没有访问实例或私有配置，测试沿用主流程证据。

## Spec

初审发现两项 P2：指标续租遗漏后台预算；清理重叠时模块 FIFO 绕过动态焦点。二者均已修复，跟进只读复审确认关闭；未发现新增 Spec 缺陷，阻断项为零。

复审确认未准入读取留在 bridge 队列，清理释放额度后按当前焦点选择；快照与未确认预占共同限流；取消、旧 iframe 消息隔离及旧父窗口退路符合更新合同。审查者独立执行并通过 `advanced-history-loading.cjs`、`advanced-market-request-scheduling.cjs`、`advanced-history-admission.cjs`、`advanced-inflight-cancellation.cjs`、`advanced-provider-request-lifetime.cjs`；未访问实例或私有配置。

双轴最终结果：Standards 硬性发现 0；Spec 未关闭发现 0（初审 2 项 P2 已关闭）。

## mwa 更新、业务验收与决策边界

用户明确确认“更新并验收”后，2026-10-22 23:49:42–23:50:10 UTC 在 Ubuntu `quant-server` 更新 13 个应用服务。换版前运行配置逐项展开并与实际容器比对，保留后来新增的 API MCP 三个配置键。持久 manager 的 candidate overlay 已同步固定候选及完整现有环境，后续 start 不会降版。PG／gateway 容器未替换，没有 seed、迁移、清库或额外整套实例。

2026-10-23 最终只读盘点：15 服务 running、API／PG healthy、restart=0，环境、挂载、端口、网络和固定镜像再次核对通过。工作区 revision 78、完整内容哈希与偏好哈希均保持。部署审计见 [mwa-update-audit.json](mwa-update-audit.json)。

相同 1600×1000 原五图工作区的成对诊断值见 [mwa-latency-comparison.json](mwa-latency-comparison.json)。这不是受控 A/B：每场景一例，首例两版均未完全静稳，缓存、供源时点及共享主机负载未锁定。不能计算可靠提升比例或 p95；平台首例也有变慢，不隐藏反例。

补充业务检查保留原 H1／M5／W1／D1／H4 和 study 数 0／3／0／0／1，没有关闭 reserve、指标或新鲜度检查。原生 EMA、Python Supertrend 与 Swing 在三类行情上均读到实际有限数值；平台和组合历史翻页显示真实较早 OHLC，缓存满足时不强制重复 HTTP。第一轮连切完成且生命周期最终归零、采样峰值为普通 4／后台 2／报价 1／生命周期 4。报价曾暂时标为 stale，之后自然刷新至 ok；这不证明长期报价零退化。

验收保护器曾有两项判定问题，已单列而未当作产品故障：登录前 401／被阻止保存的通知查询 404；缓存翻页没有新的 datafeed 回调。修正后最终一轮仍在五次快速切换后出现**活动 H1 90 秒不就绪、其他四图就绪、M5 两项 Python study 无数值**。没有 pageerror 或意外 HTTP 错误。根因未定位，未证明由本次改动引入，也不能归因为主机负载。完整分轮摘要见 [mwa-business-acceptance.json](mwa-business-acceptance.json)，私有截图与原始数据保存在任务私有操作目录。

因此本轮代码／制品／换版已完成，完整业务验收和稳定快切目标未完成。建议保留已验证的修复，优先最小化连切未就绪，再细分平台任务认领、填充、ready、轮询与结果应用。若证据显示跨类别资源持续互阻，再评估更广的调度改造；不根据单个失败直接全局重写。

长期入口：`https://192.168.7.232:18280`；Chart：`https://192.168.7.232:18281`。启停／状态入口保持：

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py stop
```

本次完整私有配置、换版前快照及精确回退覆盖位于 `/home/quant/repos/.mwa-watchlist-latency-20261022/`。若之后决定回退，只能结合当前 base、该目录 `rollback-override.json` 指定这 13 个应用服务，并恢复 `previous-candidate-override.json` 至持久入口。不要使用 manager 的历史默认 rollback 或整栈 recreate。本次没有执行回退、合并、正式 tag 或生产发布；按用户要求等待本轮结果决策。
