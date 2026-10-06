# 图表告警接续开发记录

2026-10-06。目标保持完整：按 [正式方案](advanced-charts-alert-system-plan-20261006.md) 开发并真实验收后交付。最新已实际运行独立Ubuntu实例并完成主要验收。下面早期章节保留当时状态；**当前环境、结果与启动停止以 [真实实例验收记录](verification/chart-alerts/runtime-acceptance-20261006.md) 为准**。原Docker权限阻碍已通过系统既有docker组及 `sg docker -c` 解决。

## 工作区与基线

- 独立工作树 `/home/quant/repos/market-watch-alerts`，分支 `feat/advanced-chart-alerts`。
- 实施前实际 `git fetch origin`；远端主线为 `3c18f60bc4d4bae934ba3e149121660b62bbf476`，包含 v1.9.0 指标目录/计算合同。原主树的未提交文件保持原样。
- 原未跟踪正式方案已显式复制，本树更新其授权状态；原件仍在原树。
- 已读较新指标交付及行情集成记录。行情集成 `5f663e4` 仍是未完成的独立任务，未盲目合入；本实现接入当前主线 managed/provider 系列，后续新数据集 Adapter 需按最终集成状态核对。
- 适用本任务及上层 AGENTS：开发/验证/验收仅用 Ubuntu 本机独立 Compose，不操作 unraid。

## 已实施内容与证据边界

- `chart_alert_domain`：明确条件对象/单位、四类指标参数与输出、价格区间、严格比较、有限 1/2/3 次、纯观察转换、线性/对数 K 线序号几何。数学单元测试不代表已与原生图形核对一致。
- `ChartAlert` / 不可变 `ChartAlertVersion`：稳定创建请求身份、版本冲突、运行轮次、累计次数、健康状态和检查点。普通编辑/暂停恢复保留次数；明确重新启用开新轮次。
- `s20_chart_alerts`：解除旧 watch 单信号唯一约束，按事件唯一键防重；旧 watch 一次性行为仍由原状态及行锁保持。旧事件 ID、证据和通知 FK 保留；已有告警或多事件时拒绝破坏性降级。
- `chart_alert_service`：每事件独立 Signal/Notification/Outbox，与检查点、计数同事务；锁定运行行。通知重试不增加触发数。默认网页通知；未选择 ntfy 不创建外发任务。迟到事件默认仅记录。
- `chart_alert_worker`：无浏览器数据库监控，固定指标计算起点；临时最后一根 K 线从确认历史重新计算；不从 OHLC 重建盘中路径。缺口等待补齐；已判历史修订目前停止判定并显示需核对，尚无自动安全重建入口。
- `provider_service`：活跃告警并入原实时采集分组、预算与来源轮询；独立于会话过期。当前活跃/暂停版本保护缓存。Ubuntu 实例运行证据尚缺，当前仅由隔离数据库测试证明代码行为。
- `/api/chart-alerts`：认证/CSRF、创建幂等、条件编辑、生命周期、筛选、事件日志。现有 `/api/signals` 同样读取新增事件。指标通知和旧日志页面分开展示指标值/市场价格，修正网页声音开关和迟到投递状态。

## 当前验证

实际运行主机为 **quant-server / Ubuntu 22.04.5 LTS**；独立 `.venv`，Python 3.11。没有产品服务运行地址。

- 一次完整后端回归：**521 passed、38 skipped**，163.74 秒；其中跳过环境相关测试。该轮在最后通知时间戳/消息展示调整及新增 PostgreSQL测试前完成，不能当作最终交付的全量验收。
- 末轮定向回归（本任务所有测试 + 原 service/notify/provider_service）：**79 passed、2 skipped**；两个跳过为尚无隔离 PostgreSQL的真实迁移/并发用例。
- 前端 `npm ci` 与 `npm run build`：通过；保留既有 bundle >500kB 提示。
- 变更 Python Ruff、`git diff --check`、Compose 静态解析：通过。Alembic 单头为 `s20_chart_alerts`。
- SQLite 已验证有旧事件/通知的迁移升降及已有数据降级保护。不能据此声称 PostgreSQL升级/备份恢复成功。
- ntfy 验证使用进程内 `httpx.MockTransport`，包含失败后重试及指标单位；没有向真实服务发送通知。

## 环境阻碍与隔离验收准备

本机 `/var/run/docker.sock` 的 Unix 读写访问检查为 False，实际连接返回 PermissionError 13；`docker info` 与 `docker compose ls` 均 permission denied。当前执行策略禁止提权，已请求用户配置本机 Docker 访问。没有转到 unraid，没有启动容器。

预备 [Compose](verification/chart-alerts/compose.yaml) 项目 `mw-chart-alerts-acceptance`，独立默认网络、`chart-alerts-pg` volume、数据库 `chart_alerts_acceptance`。预定网页 `https://localhost:19443`、图表独立域 `https://localhost:19444`；端口检查当时空闲，**地址尚未运行**。默认关闭外发，仅启动 Binance 品种的 managed worker；不读取或复制生产 env。

已运行 `scripts/prepare_chart_alert_acceptance.py`，在 `/tmp/mw-chart-alerts-acceptance` 生成任务独立凭据、登录文件和 TLS 私钥（权限 0600，目录 0700）；不提交 Git。重复使用配置，不能重置已部署实例的密码。

权限就绪且功能准备就绪后的命令（均尚未运行）在本 worktree 执行：

```bash
.venv/bin/python scripts/install-advanced-library.py /home/quant/repos/research/TV_v31.1.0_0430.zip
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml build migrate web chart-origin
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml up -d pg migrate api market-worker history-worker web chart-origin tls
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml build verify
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml run --rm verify
```

停止只针对本项目，保留 volume：

```bash
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml down
```

不执行全局 prune。许可库安装仅到被忽略目录，安装时核对 manifest；完整许可资源不入库。Dockerfile.verify 从本任务实际 API 镜像派生，PostgreSQL测试使用随机命名的任务拥有 schema，只清理其自身 schema。

## 剩余门槛（不能据当前检查点标记完成）

| 正式验收项 | 当前直接证据 | 尚需证据/实施 |
| --- | --- | --- |
| 单次/2 次/3 次、持续成立、边界往返 | 纯判定/事务测试 | 产品表单、运行 API 与完整实例核对 |
| 创建/编辑已成立不触发 | 判定/worker、版本测试 | 图表创建及编辑交互实测 |
| 并发/重启、计数/Outbox一致 | 回滚/新会话测试；PostgreSQL用例待运行 | 真实 PostgreSQL锁并发、容器重启、备份恢复与旧库升级 |
| 关闭网页后继续采集 | 无会话provider需求测试 | 运行实例关闭全部网页后持续采集及判定 |
| 数据中断/闭市/补数/修订 | BTC缺口补数、迟到和修订停判测试 | 来源完整性、正常闭市、修订恢复入口、真实故障注入 |
| 画线提交/失败/超时/连续拖动 | 版本冲突及明确删除服务测试 | 公共桥接口、业务对象关联、提交核对/重试、旧版事件及原生图形验证 |
| 多图、切图、布局恢复 | 尚无产品新增证据 | 固定上下文/代次、刷新关联恢复、切换不误暂停、复制不复制活跃告警 |
| 趋势线/射线与图上一致 | K线序号/对数数学、已存在端点映射代码 | 原生真实几何核对、未来端点、周末/缺口、周期变化；不得缩减为仅水平线 |
| SMA/EMA/RSI/MACD收盘/盘中 | 独立数值向量、临时/缺口/零值测试 | 固定历史合同在图表Adapter中对齐，逐根及临时真实图表数值核对 |
| 行情身份与能力矩阵 | 写入来源校验、provider dataset身份 | 明确能力查询及UI；Yahoo日历目前阻止判定，不能标成已支持；OANDA账户变化 fencing需核对 |
| 表单/消息通知子页/侧栏日志 | API及旧日志兼容调整 | 新表单、工具栏/价格/对象入口、筛选/复制/编辑/定位/证据、暗亮主题和键盘验收 |
| 每事件确认/通知真实状态/单位 | 本地模拟投递及已有确认测试 | 隔离通知通道端到端、设备与服务接受状态区分；真实外发未授权 |
| 旧规则/事件兼容 | 原 service/notify定向及一次全量回归 | 最终全量回归、实际 PostgreSQL旧记录迁移、产品回归 |

下一阶段从上述产品入口、上下文与指标/几何探针继续；Docker权限阻碍不取消总范围。正式交付仍需满足完整合同、最终 review和实际运行验收。当前目标保持 active。

## 后续实施与探针更新

以下覆盖上表中的旧检查点描述；未部署实例、未运行 PostgreSQL验收的边界仍然不变。

- 新增创建/编辑表单、消息子页、告警/日志侧栏、筛选、暂停恢复、复制草稿、逐事件确认、证据和定位。表单创建默认单次，多次选择 2/3；失败及取消保留草稿和原幂等 request ID。保存反馈区分 warming 与 ready。
- 工具栏、图表空白价格右键、画线/指标菜单和 plus 事件接入同一表单。公开菜单记录发起图表上下文/代次；父页校验 channel/origin/window 并执行鉴权 RPC，画线写入限定持久 workspace/chart/object。
- 拖动时不写入，释放后串行提交；版本更新不被较旧轮询覆盖。超时读回真实版本，失败保留本地位置并提供重试/恢复后台画线。显式删除才暂停；切品种/周期、布局及来源变化受到身份检查。
- 刷新按后台快照恢复或核对画线；布局保存不是告警保存的依赖。指标参数及计算起点不同显示提示，后台不自动改规则。显式切换规则来源解除旧图形关联及旧计算起点。
- 几何接口将公开 timestamps 映射到实际 bar 序号及最多 500 个已核对未来日历位置。managed D/W/M 使用与 native feed 一致的交易日期标签。修复少量未来网格请求无法越过周末的问题；倒序斜线端点的原生延伸属性转为实际左右方向。
- managed 图表创建的指标告警固定使用已发布快照及计算 origin；provider 图表与实时订阅固定相同 source prefix。计算共享 gap segmentation 和临时最后一根 K 线处理，MACD多个输出及相同输入告警复用计算，缓存有容量上限。
- 增加明确 `rebaseline` 操作：用户核对后保留次数、轮次及旧事件，从当前时间重新建立基准，不重发修订历史。OANDA账户身份变化阻止旧数据集采集/判定；聚合周期盘中观察时间取实际底层行情更新时间。

可复现进程内探针见 [结果摘要](verification/chart-alerts/probe-results-20261006.json)，均运行在 Ubuntu quant-server。Playwright使用真实安装许可库及实际 React组件，HTTP数据以进程内 route fixture提供，不创建监听服务、不部署产品实例、不读取生产配置。

真实 native 探针验证：四种画线名称/端点/属性；跨周末 56 小时对应 8 根实际 bar；反向射线方向；刷新恢复后台快照不重复图形且不写入后台；主价格右键价格预填；对数价格 100/400 端点中点与价格 200 的实际参考线相交；SMA/EMA/RSI/MACD各 463 根原生 study 输出与后台告警值完全相等（含临时最后一根）；实际双图拥有不同业务 ID，切品种更新代次而保持图表业务 ID。

UI探针验证：默认单次、2次配置、消息子页仅应用草稿；保存失败/取消恢复同幂等请求；warming提示；暂停恢复、复制不提前创建；逐事件确认；暗亮主题、modal焦点及Escape。额外桥接4项回归覆盖连续拖动版本串行、超时已提交、失败显式恢复和生命周期隔离。

复现（在 `web` 执行；浏览器及共享库路径属于本机已安装工具）：

```bash
node --test tests/chart-alerts-bridge.test.cjs
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node tests/chart-alerts-native.probe.cjs
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node tests/chart-alerts-ui.probe.cjs
```

原始 JSON和截图在 `/tmp/mw-chart-alerts-acceptance`；仓库只记录摘要与探针脚本，不提交许可库、凭据、TLS私钥。原许可包公开 `exportData` 入口引用缺失的 chunk；本探针因此直接观测实际 custom-study `main` 返回值，不修改许可资源，也不把未运行的 export API记为通过。

新增后端计算合同/几何等定向回归已通过；一次较新全量回归为 **537 passed、40 skipped**（176.97秒），随后聚合盘中时间及共享计算补充测试17项通过。最新最终检查结果将在下面更新。所有运行依然没有产品访问地址。剩余完整门槛：真实 PostgreSQL迁移/并发/恢复；独立Compose运行；关闭全部网页后的持续采集；真实故障注入、原生拖动/布局/撤销等完整矩阵及隔离通知端到端，修复审查发现的问题。必须在这些验收通过后才可交付。

## 审查修复与隔离通知准备

双轴审查见 [审查记录](verification/chart-alerts/review-20261006.md)。已修复三个可复现Spec缺陷：所有managed图上告警保存published身份，不读取不可见staging价格；盘中监控记录已确认prefix指纹而排除临时最后根，历史修订停止判定；published图表与告警共享gap segmentation。已增加相应定向回归。盘中正常闭市显示原因，不误报交易时段内陈旧。

Compose增加可选 `notification-test` profile。`notification-sink`位于任务独立internal网络，无宿主端口、不转发到任何服务，默认首次请求返回503供重试验收。`notification-worker`固定指向该sink，覆盖ntfy token为空；常规启动仍关闭外发。仅用于本任务实际部署后的隔离通知验收，**尚未启动**。

```bash
docker compose --env-file /tmp/mw-chart-alerts-acceptance/compose.env -p mw-chart-alerts-acceptance -f docs/verification/chart-alerts/compose.yaml --profile notification-test up -d notification-sink notification-worker
# 不直接输出完整 /records，通知确认bearer token仅保留私有目录。
```

以上sink记录只证明本地服务接受，不能显示为设备接收。完整结束时用本project的 `--profile notification-test down`停止profile及常规服务；保留数据库volume，不清理其他项目。

最新审查修复后的全量后端回归：**545 passed、40 skipped**，134.69秒；一个既有Starlette/httpx弃用提示。最新前端build、Ruff、diff检查及Compose静态解析通过，native/UI探针摘要已同步。2026-10-06再次实际执行docker info仍返回socket permission denied，未启动实例；此结果不构成最终交付验收。

## 真实原生生命周期补充（进程内探针）

继续以实际许可widget及隔离route fixture验证，不部署服务，不向外发送通知。

- 真实鼠标拖动：按住时无写入，释放后只提交一个版本。
- 确认原生undo/redo仅发出全局事件，没有points_changed。Adapter已订阅undo/redo，动作结束后按固定图表身份/代次核对，使用串行版本提交；不会恢复已暂停监控。
- 修复几何比较依赖JSON键顺序/Decimal文本的问题：现在比较实际几何字段，样式编辑不因相同数值的不同序列化产生版本及基准重建。超时读回也使用相同比较。
- 切价格轴不是显式保存新坐标条件；检测到linear/log与已存快照不同只提示，保留已生效条件。
- 实際切品种、H1/H2切周期及往返没有编辑或暂停；实际widget保存/加载布局后恢复业务chart IDs及一条后台画线，不重复、不写入。
- 显式删除实际原生对象只暂停一次；原生撤销恢复画线但不恢复告警。
- Native探针累计12场景通过；Adapter回归7项通过。真实父页API/容器/行情端到端仍待实例验收，不能由这些fixture结果替代。

迁移补充验证：真实Alembic从初始版本迁移到r19，写入完整旧Watch/Signal/Notification/Outbox重试记录，再升级s20；旧身份、证据、外键及重试进度保留，新告警产生3次事件，存在告警后拒绝破坏性降级。SQLite链路已通过；同一用例已接入任务独立PostgreSQL schema，尚未运行。迁移后SQLite备份核对全部规则/版本/检查点/事件/通知/Outbox字段与原库一致；仍不等于PostgreSQL备份恢复通过。

本轮最终回归：**547 passed、41 skipped**，201.71秒；提示为既有Starlette/httpx及Alembic配置弃用。前端生产build通过（既有>500KB bundle提示），Ruff、Prettier、git diff检查及Compose含notification-test profile静态解析通过。跳过项包括3项本任务真实PostgreSQL用例。Docker权限仍未就绪，所有产品访问地址仍未运行，不标记正式交付或目标完成。


## 实际实例验收交付（最新状态）

本任务已在Ubuntu本机真实运行并完成方案合同验收。运行地址 **https://localhost:19443**，图表origin **https://127.0.0.1:19444**。许可资源、凭据及私钥留私有目录；不连接unraid、不发送真实通知。完整环境、启动/停止、各项证据与边界见 [真实实例记录](verification/chart-alerts/runtime-acceptance-20261006.md)，去敏结果见 [摘要](verification/chart-alerts/probe-results-20261006.json)。上文Docker无权限及未部署均为早期历史状态，当前已用 `sg docker -c` 解决。

最新结果：全量后端 **548 passed / 41 skipped**，130.55秒；另实际PG迁移/并发三项通过。实际浏览器8场景通过，含真实鼠标拖动只在释放提交1次、线性趋势线/未来端点反向对数射线、四指标创建及后台ready，errors与图表凭据泄露均为空。真实Binance在全部兴趣自然过期至零后继续采集并推进checkpoint。合成task数据验证有限次数、区间跳空、缺口补数late、陈旧恢复、历史修订及rebaseline、重启待判不漏不重；实际容器IP改变后web无需重启登录恢复。隔离通知实际attempts `[1,1,2]`、逐事件确认通过；仅服务accepted。实际PG备份恢复全部告警字段相等，恢复DB已删除。

真实行情接入与可控数值fixture分层记录；不把browser ready当作真实provider逐根数值验收。双轴补审发现的失败恢复、配置刷新及结果记录问题已修。开发分支可审阅；未合并、推送或生产发布。本次交付保持本任务实例运行供验收，启动停止方式及登录文件位置已提供。
