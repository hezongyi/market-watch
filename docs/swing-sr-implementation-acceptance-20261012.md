# Swing V1 实施与验收记录

2026-10-12；Ubuntu 本机 `quant-server`。实现目录 `/home/quant/repos/market-watch-swing-sr-20261012`，分支 `feat/swing-sr-v1-20261012`，基线 `8c65edfdee15f0281750e888711cf8ecd20de1a0`。

## 交付结果

Swing 支撑阻力指标已接入 Python 计算、历史分页、共享实时更新和原生图表。独立 Docker 实例已构建并运行，真实应用浏览器验收通过。审阅入口为 **<https://localhost:16443/advanced-charts>**，图表源为 <https://127.0.0.1:16444>；均绑定本机 loopback，使用验收自签证书。地址中的 localhost 指 Ubuntu `quant-server` 本机。

验收实例保留运行，当前工作区留有默认 Swing（high=5、low=5、统计开启且位于名称下方），4002 根冻结 OANDA H4 数据已恢复，包括末根盘中候选。管理员登录凭据位于 `/tmp/mw-swing-sr-20261012-private/credentials.json`，不在本文中展示。

本任务在独立功能分支提交并准备 PR 审阅。许可库、凭据、TLS 私钥和完整浏览器状态未加入 Git；浏览器截图和结果位于 ignored `artifacts/`。没有生产发布或真实通知。

## 实现

- `backend/alerts/swing_sr.py`：严格对称窗口，两侧独立 strength（默认 5，整数 1–500），平局拒绝，同价新事件计数；累计同类柱数间隔，缺口不跨段配对；整数显示采用精确 ROUND_HALF_UP。确认时间为右窗口末柱结束，候选由确认检查点克隆重算，不写入持久确认状态。
- `chart_indicators.py`：显式 `series_presentation_v1` 与受校验的公开展示白名单；普通指标继续使用原协议。价格直接取 OANDA 原值，没有平移或校正到 FXCM。
- managed、provider 与 fixed-history：统计固定完整输入起点，分页只裁剪显示；候选和展示保持同一评估截止点。provider 读取和共享 worker 使用可重复读快照，可见柱、指标、展示采用同一 revision 并排除观察时刻之后的行。
- `indicators.js`、`bridge.js`：四条原生 circles，high_left／low_left 各自固定负偏移；四 plot 历史请求合并。显示开关和位置作为 Boolean／Text study 输入保存，计算参数和缓存键只包含两项 strength。
- `swing-sr-display.js`：每 study 最多两条有限水平桥，归属 study，不保存、不进 undo；随候选、隐藏、删除、参数、系列身份和多图生命周期同步。统计默认置于应用自有的实例名称下方，可选 pane 左下卡片；通过公开 pane adapter 定位，不读取许可库私有 DOM 类名。
- `drawing-projection.js`：遵循原生 `isSavingEnabled()`，不将推导桥写回工作区，普通用户画线仍保留。
- `study-templates.js`：原生指标入口被既有自定义入口关闭后，模板按钮也消失；新增公开 API 工具栏入口，复用 `nativePreferences` 和原有 preferences API，支持命名保存、应用、覆盖确认、删除及只读模式。覆盖确认前关闭 HTML 模态保存弹窗，避免原生确认按钮被顶层弹窗拦截；取消后恢复名称和表单。
- 展示快照按完整系列身份、周期、参数、请求次序、截止柱、统计起点和 revision 管理；旧响应、旧参数和不完整统计范围不能覆盖较新展示。

## 第 7 节验收矩阵审计

| 契约验收项 | 最终证据与结果 |
| --- | --- |
| 175 根近期冻结样本 | `test_recent_visible_positions_endpoints_preview_and_confirmation`：6 个 high、7 个 low 可见起点和 5 个历史红段终点全部匹配 |
| 最新候选 | high169=1.12420、low164=1.11711；关闭预览后 high152=1.12760；纯计算与真实 Docker SSE 均验证 |
| 4002 根长数据 | 显式冻结休市日历下 high264／low249，sum3989／3978、count263／248，精确均值15.167300380228136／16.04032258064516，显示15／16；实际 API 断言通过 |
| 历史重叠及独立偏移 | 默认旧新段重叠 5 个位置；JS 和原生探针分别验证 H=3、L=7 的偏移及参数变化 |
| 当前桥 | 实际原生 API 取到两条等价两点线；high169 至174、low164 至174，两端价格一致，2px实色，不向空白未来区延长；历史只留圆点，突破不删价位 |
| 盘中回滚 | 专属冻结库 tick 撤回→恢复→确认→恢复，通过实际共享 SSE 检查桥和预览统计；重复 tick 不重复计数，两个图表均收到撤回／恢复 |
| 确认因果性 | 严格检测时刻、右窗口末柱结束确认；未来追加不改旧确认事件；JSON 检查点和全量／分块一致性测试通过 |
| 平局与同价 | 严格等高／等低拒绝，跨窗口同价新事件更新位置和统计；ROUND_HALF_UP 精确边界通过 |
| 分页与缺口 | provider、published managed、fixed history／composite 的分页保留全范围统计与最新展示；六项真实 PostgreSQL 契约通过；无日历保守分段，显式休市不补柱，删除非假日柱仍产生真实缺口 |
| 生命周期 | 真实应用改参数、隐藏／恢复、H4↔H1、EURUSD↔XAUUSD、删除／重新添加、工作区重载和两图并列通过；同图多实例由原生探针验证；来源身份隔离与迟到响应由 adapter 快照测试、provider 路径与 PostgreSQL 契约验证 |
| 开关／位置／模板 | 两种布局、关闭无占位但保留点线、重开恢复卡片位置；实际 UI 保存模板至 preferences API 后，跨工作区应用并恢复两强度、开关、位置、颜色、宽度及 plot 可见性；工作区保存／重载通过 |
| 视觉 | 实际深色 EURUSD H4 截图与原图核对；近期相同走势范围、13px 柱距，四图例值、两红／两青轴值、双圆点和两条有限实线，无历史斜线。375px 浅色卡片位于 pane 内且无横向溢出；颜色为 V1 约定色值，没有声称像素级还原原图 |
| 兼容与负载 | 现有八个 Python 指标相关数值回归，以及真实 preferences 模板和工作区恢复通过；同参数两图复用四个原生订阅及一个服务端任务，四 listener 一次全量计算；实际 API 耗时见下方 |

来源切换没有连接真实供源进行采集验收；本任务的来源隔离证据来自 adapter 完整身份测试及冻结 provider／PostgreSQL 路径。原作者 Pine 源码未取得，因此不宣称全部未知边界政策与原作者逐句等同。

## 休市政策的证据限度

实际应用在未配置假日日历时识别四个圣诞／元旦交易日内缺口，得到 high261／low246、sum3878／3865、count257／241，均值15.089494163424124／16.03734439834025，显示仍15／16。整数一致不能证明精确统计一致。

本实例使用有限的[冻结验收日历](research/patternsmart-evidence-20261012/swing-acceptance-calendar.json)，使已约定的连续数组基准按应用休市政策复算。已有官方快照覆盖2025圣诞及部分元旦时刻；**2024圣诞和2024年末部分关闭时刻证据不完整，明确采用冻结验收 V1 假设**。该政策只属于本任务数据集，不自动推广生产、所有年份或账户。未配置政策时仍保守分段，真正缺数仍分段。详见[休市与缺口记录](research/swing-frozen-calendar-20261012.md)。

## 已执行验证与性能

- 相关 Python 回归：**283 passed，68.95s**。
- 专属 PostgreSQL 独立测试 schema：**6 passed，9.38s**，覆盖 provider SSE 合并／revision、worker 观察截止点、provider 分页、fixed history／composite 候选及 published 分页。
- 实际应用 Chromium：`swing-sr-application.browser.cjs` 通过，`errors=[]`；数值、SSE、真实模板 UI／API、工作区重载、两图共享、切周期／品种、375px浅色及旧八指标恢复均有断言。
- 模板交互 Chromium：`study-templates.browser.cjs` 验证覆盖取消／确认、删除取消／确认、实际粗指针只读及 dispose／重载。结果记录于 `artifacts/study-templates-acceptance.json`。
- JS adapter、快照顺序与请求合并、market-stream、indicator-picker、chart-style、preferences、native-workspaces 通过；旧 VM 的 python-indicators、history-dedup、provider-subscriptions、history-pagination 使用临时 document stub 通过。
- 前端 build、许可图表真实 Docker build、核心／部署及新增测试 Ruff、JS 语法检查与 `git diff --check` 通过。
- 既有 `advanced-native-save-race.cjs` 因 VM mock 缺 `chartThemeName` 失败；未把它记为通过。真实原生及应用保存已单独验证桥排除，原生探针还验证普通用户画线保留。

实际容器完整4002根统计、裁剪返回175根的5次浏览器请求耗时为252.9／172.9／267.3／173.6／161.9ms，中位173.6ms、最大267.3ms。包含浏览器、TLS、API、数据库和反序列化，是有限串行测量，不是生产吞吐量承诺。两个同参数图表只保留四个原生 listener 和一个服务端 task，两个图表均实际接收到候选撤回／恢复；原生参数重载和旧订阅注销为异步流程，验收等待稳定状态后再检查共享任务；服务端测试断言四 listener 只全量计算一次。离线4002根计算曾测得中位约57ms，不将其混称容器延迟。

可随 PR 审阅的脱敏截图及结果见[浏览器证据](verification/swing-sr-v1-20261012/README.md)。

浏览器原始证据：

- `artifacts/swing-application-acceptance.json`
- `artifacts/swing-application-comparison.png`（1600px深色、柱距13）
- `artifacts/swing-application-two-charts.png`
- `artifacts/swing-application-narrow-light.png`
- `artifacts/swing-native-probe.json`（本地原生能力探针，区别于实际应用）

## Docker 运行与复现

Compose project／task 为 `mw-swing-sr-20261012`，独立 PG14、数据库、volume、网络及端口。postgres、api 为 healthy；market-stream、web、chart-origin、tls 正常运行；migrate 成功退出。只有 TLS 加入 task 专属 edge 网络发布 loopback 端口，应用和数据库继续使用 internal 网络。没有采集或通知 worker。

构建均通过授权的 `sg docker` 调用 `mw-docker build`，task、project、purpose=acceptance 明确。原基线 chart 使用 `--context advanced-host`；同步最新 main 后沿用包含 React 告警组件的仓库根构建 context，展示及模板脚本由 `advanced-host/Dockerfile.dockerignore` 白名单纳入。

以下为最终运行镜像的 manifest digest（Docker inspect 的 Image ID；与镜像 config digest 不混用）：

| 服务 | 运行镜像摘要 |
| --- | --- |
| API／market-stream | `sha256:a494fbef7187889ee5984267cbc10184b00e265e7ed47b2a10d5a51a2049e601` |
| web | `sha256:7db1f357e1d9747373afe9adf613445bd0b0314d61f9bef844303eadf439a49f` |
| chart-origin | `sha256:cc820b6bb238c05eeeab53f83ef75d05b478a5372ef1649b371975694c705de8` |

API 与 chart 中本任务源文件 SHA256 已与工作区逐一核对；build-assets 从同一 source 打包版本化 host 脚本。

```bash
cd /home/quant/repos/market-watch-swing-sr-20261012

sg docker -c 'mw-docker build --repo . --component api --tag market-watch-api:swing-sr-20261012 --task mw-swing-sr-20261012 --project mw-swing-sr-20261012 --purpose acceptance'
sg docker -c 'mw-docker build --repo . --component chart --tag market-watch-chart-origin:swing-sr-20261012 --task mw-swing-sr-20261012 --project mw-swing-sr-20261012 --purpose acceptance'
sg docker -c 'mw-docker build --repo . --component web --tag market-watch-web:swing-sr-20261012 --task mw-swing-sr-20261012 --project mw-swing-sr-20261012 --purpose acceptance --build-arg VITE_ADVANCED_CHART_ORIGIN=https://127.0.0.1:16444'

# 启动已有实例，保留现有私有配置和冻结数据库：
sg docker -c 'MW_SWING_PRIVATE_DIR=/tmp/mw-swing-sr-20261012-private docker compose -p mw-swing-sr-20261012 -f deploy/ubuntu/compose.swing-sr.yaml up -d --no-build'

# 停止本任务实例，保留数据卷：
sg docker -c 'MW_SWING_PRIVATE_DIR=/tmp/mw-swing-sr-20261012-private docker compose -p mw-swing-sr-20261012 -f deploy/ubuntu/compose.swing-sr.yaml stop'

# PostgreSQL 验证使用独立测试 schema，不重置验收库：
sg docker -c 'MW_SWING_PRIVATE_DIR=/tmp/mw-swing-sr-20261012-private docker compose -p mw-swing-sr-20261012 -f deploy/ubuntu/compose.swing-sr.yaml run --rm --no-deps verification'

sg docker -c 'LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node web/tests/swing-sr-application.browser.cjs'
sg docker -c 'LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node web/tests/study-templates.browser.cjs'
```

当前库已经 seed，不要再次使用普通空库 seed。`seed_swing_sr_acceptance.py --calendar-only` 仅更新任务专属日历；`swing_sr_acceptance_tick.py` 只允许任务专属库、已知4002根范围及尾部，修改撤回／恢复／确认并递增revision，浏览器测试 finally 恢复冻结末根。`prepare-swing-sr.py` 拒绝覆盖已有私有配置；无需再次生成密码。

相关 Python 回归命令：

```bash
PYTHONPATH=backend .venv/bin/python -m pytest -q \
  backend/tests/test_swing_sr.py backend/tests/test_chart_indicator_contract.py \
  backend/tests/test_indicator_state.py backend/tests/test_fixed_indicators.py \
  backend/tests/test_chart_workspace.py backend/tests/test_provider_chart.py \
  backend/tests/test_provider_cache.py backend/tests/test_managed_dataset.py \
  backend/tests/test_chart_alert_values.py backend/tests/test_chart_alert_calculation_contract.py \
  backend/tests/test_chart_export.py backend/tests/test_provider_service.py \
  backend/tests/test_market_stream_worker.py
```

主方案：[Swing 支撑阻力实施契约](swing-support-resistance-indicator-plan-20261012.md)。验收实例供本机审阅，按名称保留，不执行退役、全局 prune 或清理其他任务资源。
