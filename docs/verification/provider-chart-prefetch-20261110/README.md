# 平台单图预取候选验证记录

状态：实现已更新 Ubuntu 开发实例；用户于 2026-11-10 接受六源当前性能优化结果并同意收口，停止追加调优。慢尾、失败与未达原目标的事实保留。独立复审已完成；CI/Draft PR 交付状态见下方收口记录，未合并或生产发布。分支 `perf/provider-chart-prefetch-20261110`，基线 `bc2ae3db`。无 schema 迁移，风险 F1（重要历史获取链路与持久设置）。

## 实现

- 六源独立 initial/reserve 总量，持久保存在现有 Preference 中；0 独立关闭可选行为，真实 countBack、from 区间、指标前缀继续满足。设置入口为“历史数据与预取”。
- 唯一缓存/分页核心、当前周期有限后台目标、任务世代与来源租约。设置降低或关闭后旧 worker 不可恢复旧目标；无进展停止本轮但不伪造历史边界。
- PostgreSQL 提交后通知、提交/结果长轮询、丢通知时有界重读；前端成功结果先交付，消费者清理有界进行。
- 六源当前单图在工作区和周期确定后提前准备一页，与原生图表初始化并行。布局 MainSeries 身份优先，Study/多图不启用；变更/销毁取消旧消费者。
- worker 只证明必需覆盖，不组装/丢弃最终响应或指标；API 按最新一致快照读取并交付。接近 I/O 截止收到的有效页可用 3 秒有限收尾，取消、generation、租约、整体任务过期与 SQL 时限不放宽。Yahoo/AKShare/FXCM 预算通过公共来源映射接入实际入口。
- 六源单图首图优先于无图表目标的侧栏解析，首图结束后两帧或 5 秒恢复；真实图表目标不等待。两组 OANDA 缓存启动诊断显示收益；其冷样本接受情况单独记录。
- Yahoo 工作区创建/打开只读本地维护身份，过期元数据由 leased worker 刷新；resolver 复用同一准备结果。已验证的交易所时区传给固定版本 SDK，避免额外 timezone HTTP，不改变复权、价格或会话口径。元数据 I/O 遵守显式/总/I/O 最早截止，不能消耗落库收尾预算。
- 相同商品周期的首个真实需求等待一次启动任务，失败直接呈现并消费该结果；用户显式重试可发起新任务，避免自动再等一整轮。真实 countBack、区间、指标输入仍通过共同核心重新核对覆盖。FXCM 仅在原生 I/O 开始前让等待中的后台请求让位，保留健康会话，不中断在途快照。

## 运行与回退

实际主机 Ubuntu quant-server，本机 Docker project `mw-dev`，地址 https://192.168.7.232:18443/ 。开发源码 checkout `/home/quant/repos/market-watch-dev`，候选代码在独立 worktree。用户已明确授权复用开发实例验收，并停止其他已核实任务实例；数据库和备份保留，未操作生产。

```bash
mw-dev status
mw-dev up
mw-dev stop api data-worker market-runtime notification-worker
```

启动/停止只用于此开发实例相关服务。修改源码后显式重启相应服务，前端 Vite 使用源码，原生资源使用生成后的指纹 bundle。当前原生脚本 `chart.2ebf2f4d9536406e.js`。

回退资料位于私有 `/home/quant/.local/share/market-watch-dev/updates/provider-prefetch-20261110/`：previous-source、source-manifest.json、previous-chart-assets.json。回退时先停止相关服务，按清单恢复旧源码和资源指纹，再启动服务；不删除数据库、不清理价格缓存。持久预取键对旧版本无破坏，旧版可以忽略；恢复配置应保留验收前值，不覆盖并行用户修改。

## 检查结果

- 相关配置、缓存、后台、来源与任务 Python 回归 165 passed；后续含直接查询、指标合同、OANDA 实时所有权的检查 156 passed。新增区间/前缀回归 1 passed。最新 native-load 与 provider-chart 入口检查 131 passed。计数存在重叠，不累计宣传。
- 真实 PostgreSQL 唯一临时 schema 上 31 passed；后续真实区间/指标前缀 1 passed。包含一页复用、有限收尾、取消禁止提交、并发设置降低和提交后 LISTEN 通知。未重置开发主 schema。
- 完整 `npm run build` 通过，包含许可原生资源；`npm run test:single-frontend -- --unit`、`advanced-history-loading.cjs` 和 `resolve-recovery.cjs` 通过。后者新增主图优先、真实图表绕过、旧工作区等待释放不发起 I/O。
- 开发实例真实 HTTP 检查 initial/reserve=0：启动准备不创建 dataset/task，真实必需请求仍返回 20 根；原设置已恢复。
- 最新 Standards/Spec 独立增量复审均完成，无新增 P1/P2；此前最早 I/O 截止和 prepare 失败后重复取数两项 P2 已关闭，FXCM 后台让位增量亦通过。此前 402 记录仅代表当时尝试，已非当前阻碍。
- 本轮相关 Yahoo/chart/native-load 回归 181 passed；FXCM/service 52 passed；配置/信号/AKShare/workspace/runtime 等 81 passed（各组不累计为独立总数）。真实 PostgreSQL 唯一临时 schema 上 14 passed，覆盖六源准备后复用、取消、有限收尾、覆盖与指标前缀。完整前端构建及 single-frontend unit 检查通过。

## 最新 OANDA 冷品种实测

D1 单图无指标、1600×1000。每次整页使用新浏览器上下文；导航前确认该品种任意周期均无 ProviderDataset 和历史任务，无清缓存、无 mock 行情 HTTP。首次可见同时要求非空真实 bars、原生 dataReady/可见区间，再等待两帧。登录及临时工作区创建不计时。

| 场景 | 商品 | 耗时（秒） |
|---|---|---:|
| 整页冷开 | USDCZK | 6.46 |
| 整页冷开 | EURTRY | 5.25 |
| 整页冷开 | USDTRY | 5.68 |
| 整页冷开 | GBPPLN | 6.30 |
| 整页冷开 | EURHUF | 5.83 |
| 页内冷切换 | EURSGD | 2.61 |
| 页内冷切换 | AUDHKD | 5.11 |
| 页内冷切换 | NZDHKD | 2.82 |

整页中位数 5.83 秒，最大 6.46 秒；页内切换中位数 2.82 秒，最大 5.11 秒。原约 3 秒的整页目标未达，页内也存在慢尾。用户随后明确接受当前 OANDA 性能并同意收口，按该调整后的标准记录接受；不改写实测或宣称原目标达成。所有尝试都保留，不用热品种替代。准备任务一页、真实需求读同一缓存已确认。

初始原型三个新品种为 6.48/5.65/5.34 秒，与最终版本分组保留。主线程剖析和两组侧栏刷新对照仅是缓存诊断，不计冷验收；自选表 MutationObserver 合并对照无稳定收益，未采用。

完整原始 evidence 在私有目录 `/home/quant/.local/share/market-watch-dev/evidence/provider-prefetch-20261110/`；仓库仅提交脱敏分段 [oanda-implementation-metrics.json](oanda-implementation-metrics.json)。

## 限制和待收口

最新五个整页价格/错误/冷缓存断言全部通过，临时工作区已清理，偏好未改变；但一个原有工作区的 revision 在共享开发实例验收期间变化，harness 的“原有工作区不变”断言失败。保留现场，不回写或覆盖该工作区，不能报告整份浏览器 harness 全绿。另一次诊断偏好前后清单比较不一致，也保留失败记录。

主机 4 CPU，在验收期间观察到 load average 12.67/11.69/10.89。无法将该轮时间归结为单一代码原因，不从耗时中估算扣除负载，不清理或停止归属不明的其他进程。后续稳定性能验收需错峰。

各轮冷开测试已结束，失败记录见下节。用户已接受六源当前结果；Yahoo/FXCM 慢尾与失败、后台不足目标等作为已知限制保留，独立复审已完成，CI 见交付记录。不将 OANDA 的接受扩大为其他来源或全部任务通过，不合并、不打正式 tag、不操作 Unraid。


## 六源最新阶段结果（尚未通过验收）

2026-11-10 19:43–19:56（Asia/Singapore），同一开发实例、同一原生脚本。OANDA 见上节独立样本，其他五源本轮结果如下。中位数仅统计成功显示的样本，失败保留计入总尝试，不能据此报告全量成功率或性能达标。

| 来源 | 成功显示 / 尝试 | 成功样本中位数（秒） | 失败 |
|---|---:|---:|---|
| Binance | 3 / 3 | 8.42 | 无 |
| Dukascopy | 3 / 3 | 14.20 | 无 |
| Yahoo | 1 / 4 | 24.75 | 2 次创建工作区 HTTP 500，1 次等待图表 90 秒超时 |
| AKShare | 5 / 5 | 10.94 | 无 |
| FXCM | 2 / 5 | 35.39 | 3 次等待图表 90 秒超时 |

本轮 18 个由 harness 创建的临时工作区已全部删除。`preferences_unchanged=false` 和 `original_workspaces_unchanged=false`，未覆盖偏好或恢复并行改动；整份 harness 判定失败。超时样本未完成冷获取证据链，标记 `cold_proven=false`，不能当作成功获取的性能值。原始错误、成功样本和尝试总数见 [six-source-cold-metrics.json](six-source-cold-metrics.json)。这些结果用于定位后续问题；主机争用与共享状态变化尚未排除，不推断所有慢耗时均由供应商造成。

测试结束后将最后的 NATIVE→OANDA 公共来源映射同步至开发 checkout，更新私有 source manifest，并重启 API/data-worker；不改 schema、价格缓存和用户偏好。

## 五源统一启动后的冷品种实测

2026-11-10 12:20–12:29 UTC，开发实例真实 D1 单图，沿用上述冷证据及可见标准。本轮是统一启动扩展后的完整尝试，不与早先失败混合计算。

| 来源 | 正常出图 / 尝试 | 中位数（秒） | 最大（秒） |
|---|---:|---:|---:|
| Binance | 3 / 3 | 5.46 | 14.92 |
| Dukascopy | 3 / 3 | 8.84 | 8.88 |
| Yahoo | 5 / 5 | 26.26 | 32.16 |
| AKShare | 5 / 5 | 10.28 | 10.78 |
| FXCM | 5 / 5 | 14.51 | 36.37 |

21 个临时工作区全部清理，原有工作区 revision 未变；偏好 raw JSON 比较失败，因此整份 harness `passed=false`。当轮未保存偏好完整前后快照，不能证明只是排序差异，也未回写偏好。后续 harness 改为按 id 排序且保留完整私有前后快照。脱敏结果见 [all-source-startup-metrics.json](all-source-startup-metrics.json)。

后台快照：Dukascopy 三个品种均到 4000 根；AKShare 两个到 4000，另外三个以 `no_progress` 结束本轮（1000 根、`satisfied=false`，不称补齐或历史到头）；Binance/Yahoo 目标均记录完成，其中不足目标数量的样本需要结合合法边界核对；FXCM 本轮结束快照仍有未完成目标，不称储备完成。完成目标保留的旧重试 error 字段只代表此前尝试，不能据此把完成状态改成失败。

### Yahoo 专项与 FXCM 分段

旧 Yahoo profile：2067 根完整路径 22.60 秒，其中认证累计 18.52 秒，SDK 初始化时区路径 14.10 秒（嵌套，不相加），实际历史 HTTP 3.27 秒，解析 0.61 秒。对已验证时区的复用旨在去掉重复网络探测，不以减少必需 bars 或跳过校验换速度。

修正后 12:47–12:50 UTC 的五个新品种：VST 18.15、MRVL 13.49、CSGP 14.29、OLED 22.47 秒，TSM 失败。成功样本中位数 16.22 秒，但这是 4/5 的条件统计，不代表全量达标。TSM worker 在约 18.84 秒失败（`pages=0`），界面明确显示“平台历史暂不可用，请重试”，harness 为等待真实出图至 90 秒而记失败；没有继续自动启动第二个完整取数任务。直接来源复查曾返回 `invalid_data` / OHLC 高低关系无效，后续再次读取真实 2067 根正常；未放宽校验、伪造数据或把重试作为冷成功。5 个临时工作区均清理，完整偏好前后快照按 id 比较一致，原有工作区 revision 一致。见 [yahoo-metadata-reuse-metrics.json](yahoo-metadata-reuse-metrics.json)。

FXCM 真实 profile：冷登录 10.64 秒、首个 300 根共 12.66 秒；同 adapter 第二品种登录 0.02 毫秒、300 根共 2.16 秒。本轮慢尾日志则有会话锁等待 29.56 秒、实际快照 1.40 秒，说明不全是供应商传输。后台排队等待源额度时此前不让位，已通过真实代码路径的 red→green 回归修正；最新新品种复测结果见收口记录。既有 20 秒空闲退出保持不变，不添加行情保活请求。

### 当前收口边界

六源共用机制已实施并部署开发实例，专项正确性回归、真实 PG 及独立增量复审通过。用户已接受当前六源性能结果，故停止调优；Yahoo/FXCM 未达到原建议的约 10 秒目标，原失败与储备未完成记录均保留。代码交付/CI 状态见以下收口记录。

## 用户接受与最终开发候选

2026-11-10 用户明确“接受当前的性能优化结果，可以收口”。本次性能优化按当前结果接受，不追加来源协议、跨进程优先队列或会话改造；不将接受解释为原 3/10 秒目标已达。此前已停止其他确认归属的开发/验收实例并保留数据卷；最新 Docker 盘点仅 `mw-dev` 与原有 BuildKit 在运行。

最后一轮开发实例无缓存品种如下，所有尝试均保留：

| 来源 | 商品 | 整页至可见（秒） | 结果 |
|---|---|---:|---|
| FXCM | AUDJPY | 14.75 | 正常，冷证据通过 |
| FXCM | NZDJPY | 48.06 | 正常，冷证据通过 |
| FXCM | USDMXN | 24.44 | 正常，冷证据通过 |
| AKShare | 601818 | 9.19 | 正常，冷证据通过 |
| Yahoo | JEPQ | — | 获取失败，界面有重试提示 |
| Yahoo | VOO | 9.16 | 正常，冷证据通过 |
| Binance | FILUSDT | 5.20 | 正常，冷证据通过 |
| Dukascopy | USDDKK | 9.42 | 正常，冷证据通过 |

本轮 7/8 正常显示，harness `passed=false`，没有用用户接受改写测试结果。8 个临时工作区全部删除，偏好完整前后快照比较一致，原有工作区 revision 一致。见 [final-source-check-metrics.json](final-source-check-metrics.json)。JEPQ 直接来源复查同样返回 `invalid_data` / OHLC 高低关系无效；继续严格拒收，无伪造价格或错误历史边界。

FXCM 最新慢尾说明：NZDJPY 源额度等待 24.71 秒、重新登录 19.50 秒、实际快照 1.27 秒；USDMXN 源额度等待 17.72 秒、会话锁 1.90 秒、实际快照 1.94 秒。当前后台让位仅覆盖同进程排队阶段，不能消除跨进程竞争，后续如需进一步优化另立任务。既有来源约束、后台功能及全部失败记录保留。

最后开发部署核对：25 个候选业务源码与开发 checkout、私有 manifest 的 SHA256 全部一致；API、data-worker、market-runtime、notification-worker、前端、数据库等经 `mw-dev up` 健康检查通过。原生 bundle `chart.2ebf2f4d9536406e.js` 与候选一致。未做 schema 迁移、未清价格缓存、未重置数据库。

代码交付：实现提交 `1dc8fef0`，Draft PR [#127](https://github.com/hezongyi/market-watch/pull/127)。依赖未合并的 [#126](https://github.com/hezongyi/market-watch/pull/126)，以其来源展示分支为 base，合并顺序为 #126 后 #127。首轮 CI 前端失败为旧自选表启动预热测试仍提取已移除代码段；已更新为验证启动不请求整张自选表、当前商品元数据仍交付、重载刷新必要配置。另补齐生命周期测试的主图等待门上下文并断言重置释放。上述 CI 图表/单应用测试在本地全组通过；CI 以 PR 最新提交的实际状态为准。需要用户另行明确授权后才合并 main、创建正式 tag 或发布生产。
