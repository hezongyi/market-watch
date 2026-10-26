# Rolling Range Squeeze：移植与验收记录

## 最终状态（2026-10-24）

用户已明确回复“同意进行验收”。候选已更新至原 mwa，真实业务专项通过；下文“尚未更新／等待授权”等段落保留为历史过程，本节取代其当前状态。

- 功能分支最终产品提交：`92e18405`，仍从指定 `v1.28.0` 基线开发。
- mwa 集成分支：`integration/rolling-range-squeeze-mwa-20261024`。API/10 workers 和 Web 产品源码为 `3ac6f743f947a1ae33bcdf55bb15efa031a7f760`；Chart 产品源码为 `4e5351cfd40b59914174119222e2f1786cba2abc`，额外只有原生指标告警计算起点接线修复。完整实际镜像身份见本目录 `mwa-summary.json`。
- 已合入当前 mwa 的 `59f07cdd` 告警 UI，并保留其分钟确认/快照恢复、Swing、Supertrend 精度、BBANDS 填充和通知行为；未使用旧 tag 直接覆盖现有实例。
- 15 服务 running，API/PG healthy；数据库/gateway 容器身份、完整环境/挂载/端口/网络/命令/资源/重启策略，以及保护浏览器身份和启动时间保持。
- 统一启停仍为 `/home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。实际主机 Ubuntu `quant-server`，主入口 `https://192.168.7.232:18280`，chart origin 18281。任务私有操作与精确回退位于 `/home/quant/repos/.mwa-rolling-range-squeeze-20261024/`。

### 本轮最终检查

| 检查 | 实际结果 |
| --- | --- |
| PostgreSQL 14.24 与指标核心 | 修复后 24 passed（19 指标/5 PG）。另将此前缺少数据库的两个既有模块与 5 项新 PG 合同一起重跑，43 passed，0 skipped/failed；两批重叠，不相加。独立 task project/数据库/schema，不使用 mwa 可写数据库。 |
| PostgreSQL 暴露的兼容性问题 | observed 前缀与原算法标识拼接超过既有 varchar(40)；改为 `rrs-pine-v6-v1`，补 strict/observed 长度断言，无 schema 变更。SQLite 不约束该长度，不能替代此检查。 |
| 接入与告警 | 后端定向 41 passed，Web 构建和 squeeze dialog 通过；既有 alert reference 与 native price-line 浏览器检查通过。真实原生告警曾因新 coordinator 起点未接入旧告警入口而失败；现复用 `indicatorBindings.calculationStart`，红灯后修复，squeeze 合同和既有 9 项桥接测试通过，真实草稿打开并取消通过。 |
| 实际 mwa 原生图表 | XAUUSD H1，K=3/lookback=20/low_pct=50/confirm=true。279 个框和 162 个 PctRank 标签全部与 Python 坐标/文本对应；SMA 默认样式、隐藏/恢复、自定义首框颜色、告警入口、删除清理通过，pageerror 为空。临时 context，未创建真实告警。 |
| 实际冻结行情独立数值对照 | 完整相同起点 1,258 根。K=3/lookback=20/50%：6,194 个数值、96 个 null，279 框/162 标签；默认 K=10/lookback=252/5%：5,210 个数值、1,080 个 null，31 框/18 标签。两组最大绝对误差 0，框边界及标签排名亦一致。 |
| 数据与现场 | 六张持久表数量及完整行哈希保持：工作区 0/10、偏好 30、数据集 130、历史版本 15、产物 135。已有 23,887 条通知的状态均保持，新增 1 条，未删除；手机 ack 保持。不宣称通知整表未变化。工作区/偏好/通知写入在临时验收 context 中拦截，未恢复覆盖真实内容。 |
| 测试资源 | task-owned PG 已停止，原容器及卷保留；没有清库、seed、迁移或删除永久资源。没有 push、PR、main 合并、正式 tag、生产发布或 Unraid 操作。 |

冻结行情含一个平台标记的交易缺口：独立逐语句 oracle 在同一输入分段内比较，保留既有 provider 输入策略。不能把该结果说成 TradingView Pine 实际执行/导出对照，也不能声称跨缺口语义与 TradingView 无差异。原生标签仍使用 balloon，非 Pine label_down 像素级复刻；详细边界见下文。

实际业务证据位于 `/home/quant/repos/.reports/market-watch/20261024-rolling-range-squeeze/acceptance/`，包含真实截图、原生结果、冻结行情数值对照和数据保留记录。仓库仅保留脱敏摘要，不包含凭据、许可库或受保护浏览器状态。未在最终提交重跑整套后端/全部浏览器矩阵，早期全量失败/跳过记录不改称为全量通过。

### 默认接入与 SQLite 的说明

本次沿用既有 `chart_indicators.register()`、catalog、Python series、`IndicatorState` 及图表适配器。图表库负责原生 SMA、矩形和 balloon 绘制；新增的是 Python 几何/段状态与原生接口的绑定，没有重写图形引擎。内置指标的渲染能力与公开自定义指标/绘图契约应分开核实，不能以自定义指标为由推断缺少原生绘图能力。

SQLite 是 v1.28.0 已有的内存测试夹具与本地默认配置，本次没有引入第二个运行数据库；mwa 实际连接 PostgreSQL。计算模块及独立数值 oracle 不依赖 SQLite。SQLite 快速测试可用，但 PostgreSQL 的长度、并发和检查点语义必须在 PG 验证。

日期：2026-10-24。用户要求：隔离 worktree/branch，以 `v1.28.0` 为基线，将附件 Pine v6 复刻为 Python 指标；使用 mwa，验收前申请；不提交 PR。

## 源码与范围

- worktree：`/home/quant/repos/market-watch-rolling-range-squeeze-20261024`。
- branch：`feat/rolling-range-squeeze-20261024`。
- 基线：`v1.28.0`，提交 `59ed3a3f3fc727da76d13149934d999ebee04218`。
- 原文归档：[rolling-range-squeeze-v6.pine](../../references/rolling-range-squeeze-v6.pine)。SHA256：`16f60b6bce4278e7fb3d9bdf1934412aa8fb8d2b76c161b667fd0fd21951b75e`。
- 风险分类 F0：兼容扩展指标 catalog、Python 状态计算、API/worker、原生图表与告警 UI，无 schema 迁移。
- Python 是计算和几何数据的唯一来源；前端只绘制 SMA、矩形和 PctRank 标签。告警使用同一计算接口的 `signal` 输出。

保留原始四参数及默认值；阈值只读取此前已收盘有效比值，当前值在绘图后入队，nearest-rank 分位数和 `<=` 百分位排名独立实现。预热、零分母、收盘确认、盘中回滚、固定首框/连续扩展框、绿色重画层次、历史保留和独立 500 框/500 标签上限均有检查。坐标使用实际 bar 的时间，保留周末与缺失分钟，不按分钟数推算 K 根的起点。

## 已完成的验证

以下均为 Ubuntu `quant-server` 上的本地检查，尚未更新 mwa：

| 检查 | 结果与范围 |
| --- | --- |
| Python 独立对照与集成 | 第一批 170 passed：squeeze、告警领域/值/计算、catalog 合同、Swing、Supertrend。随后 95 passed：包含补充舍入测试的 squeeze、固定历史、固定绘图、供源输入。两批有重叠，不相加。 |
| HTTP 告警补验 | 1 passed：认证后普通/组合 capabilities 列出指标；实际创建告警保留 bool false、K=1、low_pct=0.1 与 signal 输出。 |
| 回归修复 | 发现旧批量接口可省略 end，新引擎最初依赖 end 导致 KeyError；改为沿用 Swing 的可选 end 约定后，chart_workspace+squeeze 39 passed。 |
| Node CI 等效 | 工作流三段共 54 条命令通过；缺少 fake-indexeddb 时在 task artifacts 安装后重跑失败命令及后续命令，原失败日志保留。含桥接告警 9 tests 与新增 squeeze-contract。 |
| 实际原生图表 | 10 组通过，pageerror 为空：坐标、标签、样式、不保存派生绘图、自定义颜色、实际矩形坐标回滚、隐藏、模板、多实例、窄屏浅色。 |
| 实际 React 告警对话框 | 新增浏览器检查通过：勾选/取消 bool 与最小数值保存，原文标题/消息及 signal > 0 默认条件。 |
| 构建 | 完整 Web Vite/TypeScript 构建、独立 alert-ui 构建、隔离 scratch 原生 host 资源打包通过；Vite 有既有大 chunk 提示。 |
| 静态检查 | 修改的 Python 文件及 fixture Ruff 通过；git diff --check 通过。 |
| 全量后端 | 首次完成：2247 passed、618 skipped、1 failed、38 errors、35 warnings，1015.26 秒。唯一 failure 为 end 可选兼容性问题，已修复并在后续 39 项重跑中通过；38 errors 均为两个既有 PG 测试模块未配置 TEST_POSTGRES_URL，尚未验证，不称全量通过。 |
| 原生 MCP 排查 | 同宿主机依赖环境单独重跑 25 passed；不是上述初始化错误来源。 |

原生探针使用仓库已有许可 Charting Library，本报告不包含许可库。400 根合成 H4 数据由 `scripts/rolling_range_squeeze_native_fixture.py` 生成，参数 K=3/lookback=20/low_pct=50/confirm=false。证据：[probe JSON](squeeze-native-probe.json)、[深色截图](squeeze-native-dark.png)、[窄屏浅色截图](squeeze-native-narrow-light.png)。合成数据用于稳定复现，不冒充真实行情验收。

复现主要命令（`MW_PY` 指向本机已有环境，避免更改共享依赖）：

```bash
MW_PY=/home/quant/repos/market-watch/.venv/bin/python
PYTHONPATH=backend "$MW_PY" -m pytest -q backend/tests/test_rolling_range_squeeze.py
PYTHONPATH=backend "$MW_PY" scripts/rolling_range_squeeze_native_fixture.py
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node web/tests/squeeze-native.browser.cjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node web/tests/squeeze-alert.browser.cjs
node web/tests/squeeze-contract.cjs
```

全量宿主机回归为补齐缺失的 mcp/mcp_types，将 mcp 2.3.0 及依赖安装在 ignored `artifacts/python-deps`，使用 `PYTHONPATH=backend:artifacts/python-deps`；未改写共享 Python 环境。临时依赖并非精确锁定的镜像环境，不能代替候选镜像检查。fake-indexeddb 6.2.4 同样只安装在 task 的 ignored `artifacts/node-deps`。全量运行开始于 end 修复前，进程已导入旧模块；失败用例已在修复后的独立进程重测，未声称重复全量。38 个 PG 初始化错误位于既有 `test_native_update_diagnosis.py`（15 项）与 `test_provider_stream_acceptance.py`（23 项），共同原因是 fixture 读取不存在的 `TEST_POSTGRES_URL`；未连接真实验收数据库来绕过隔离。

## 忠实度边界

- 尚无 TradingView 实际执行/导出对照；数值证据来自独立逐语句 Python oracle，不称为 Pine 引擎实测一致。
- 标签使用本平台原生 balloon，文本、位置、颜色一致性已检查；外形不与 Pine `label.style_label_down` 像素一致。
- 平台参数 K/lookback 增加 100000 上限；原 Pine 只设下限。每根排序/扫描 lookback，超大参数的性能未承诺。
- 普通缺失分钟按项目 observed 策略计算，缺少分钟不直接触发 reset。显式 strict 缺口或无效完整性会重置计算状态并保留历史绘图，这是平台输入策略。
- 告警标题与消息提供原文默认值，仍遵循平台 close/intrabar 与触发次数设置；默认 close、最多一次。盘中模式依赖平台采样，不能重建未观测路径。未发送真实通知。

## mwa 更新前检查点

目标为 Ubuntu `quant-server` 现有 project `mw-issue75-v2-20261018`，入口 `https://192.168.7.232:18280`，chart origin 18281。保留真实数据库/volume、认证、数据源、TLS、网络/端口、保护浏览器及工作区。统一持久入口为：

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py stop
```

本任务尚未执行这些 start/stop 或任何更新。2026-10-24 只读登记显示，前一项分钟确认/快照恢复已收口，13 应用服务源码统一为 `3e674dd752de366c334702b2673a4c1be9cd0443`，保留此前 Swing、通知、Supertrend 精度和 BBands 底色。不得直接用 tag 基线覆盖这些修复；验收候选应在独立集成 worktree 上以当前运行产品提交为底叠加本 feature，固定提交与镜像。

09:32 UTC 最新只读主机检查：约 29 GiB 磁盘可用、7.8 GiB 内存可用，5 分钟负载 9.73。负载高于仓库启动门槛 4，本任务未启动新 PostgreSQL 或验收应用服务。待条件满足后按 `mw-docker` 带 task/project/purpose 构建，更新 API/10 workers、Chart、Web；无需 schema migration/seed/reset。固定候选、资源与回退清单后，依据用户明确的“验收前要向我申请”取得批准，再做 mwa 业务/原生图表验收。无 push、PR、合并、正式 tag 或生产发布。

## 已固定的集成候选

- 功能提交：`9bb9cab7105c660d7e24a9db332ee440812a24a8`，继续基于用户指定 tag。
- mwa 产品候选：`8570e5d3ad6c1d2f314d095410e4a2926212690c`，branch `integration/rolling-range-squeeze-mwa-20261024`，worktree `/home/quant/repos/market-watch-rolling-range-squeeze-mwa-20261024`。
- 候选以当前 mwa 产品 `3e674dd7` 为底 cherry-pick 功能；唯一冲突是 indicators.js 的 format，解析为 Swing 与 Squeeze 均 inherit，保留独立 Supertrend profile、Swing display 标签、BBANDS 原生底色及分钟恢复逻辑。两边意图均保留。
- 集成后实际重跑：88 passed（squeeze、chart_workspace、reload diagnosis/matrix、composite price confirmation），新指标 10 组原生检查 errors=[]，Web 完整构建通过。快照恢复、恢复生命周期、新指标合同、Swing identity 与 9 项告警桥接通过。Ruff 与 git diff --check 通过。
- 尚无本候选 Docker 镜像；未执行 PostgreSQL 专项；未在 mwa 实际业务数据上验证，不把本地成功冒充验收通过。

## PostgreSQL 专项入口已准备，等待资源

`backend/tests/test_rolling_range_squeeze_postgres.py` 复用仓库隔离 schema fixture：
严格/observed 固定历史分页各一项、供源快照一项、组合盘中预览不落盘一项，以及真实并发请求/worker 归属与 bool 检查点一项。共 5 项收集成功，Ruff 与 diff 检查通过；无 TEST_POSTGRES_URL 时实际为 5 skipped，不能视为通过。

待主机满足启动门槛后，创建本任务独立 Compose project/network/volume/端口和 PG14.24，私有设置 TEST_POSTGRES_URL，再运行此文件及前述 38 项缺失数据库的既有测试。不使用现有 mwa 或其他任务的可写数据库，测试 URL 与凭据不进入仓库或报告。

09:34 UTC 复核：代码工作树干净；mwa 15 服务仍运行，API/PG healthy，尚未更新。5 分钟负载 9.37，仍不能启动新服务；验收授权尚未收到。
