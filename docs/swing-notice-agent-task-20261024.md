# Market Watch：Swing 价格展示与即时通知调整 — Agent 执行任务书

状态：方案已完成，业务实现尚未开始。日期：2026-10-24。

本文件可独立交给执行 Agent。阅读、生成本方案不构成实施授权；用户明确要求执行本任务书后，再按下述步骤完成开发、验证与 Draft PR。无需回看对话或打开 HTML。

## 1. 目标、基线与边界

完成以下用户需求：

1. Swing 的价格显示跟随所在图表的实际价格格式；XAUUSD 当前固定五位小数的问题应消失。
2. 每个 Swing 实例的最新 high、low，在价格轴与图例各只显示一组，保留四条绘图及最新水平桥接线。
3. 即时通知移到右下角，从下向上滑入，向下滑出。

执行以仓库 `AGENTS.md` 为准，初始风险分类 **F0 / Ubuntu R1**：兼容的原生图表展示与浮窗调整，不改变计算、数据库 schema、持久格式、消息调度或确认协议。如发现必须改变这些边界，先说明影响并重新判断范围。

| 项目 | 固定值 |
| --- | --- |
| 主 checkout | `/home/quant/repos/market-watch` |
| 今日集成 worktree | `/home/quant/repos/market-watch-integration-20261024` |
| 集成分支 | `market-watch-integration-20261024` |
| 基线完整 SHA | `59ed3a3f3fc727da76d13149934d999ebee04218` |
| 实施分支 | `fix/swing-format-notice-placement-20261024` |
| 实施 worktree | `/home/quant/repos/market-watch-swing-notice-20261024` |
| task / Compose project | `mw-swing-notice-20261024` |
| 候选 UI / chart 端口 | `18780` / `18781`，启动前检查空闲 |

保留现有集成基线、其他任务现场和长期验收实例。开发验收只用 Ubuntu 本机 Docker；不访问或操作 Unraid 生产。实施完成到 Draft PR 为止，合并、正式 tag、生产发布、永久数据删除须另获明确授权。不要主动派生子 Agent；若用户另行授权并行，再按隔离规则分工。

## 2. 已确认事实与实施决策

### 2.1 Swing 精度

`advanced-host/indicators.js` 为普通 Python study 设置 `format: { type: "price", precision: 5 }`，Swing 继承了固定五位。`advanced-host/bridge.js` 用 `10 ** meta.precision` 设置主图 pricescale，但 `advanced-host/price-format.js` 还提供部分来源的自定义格式化。因此目标是**实际主图 formatter 的结果**，不能按 XAUUSD 名称写死两位，也不能只读取存储精度。

本地原生探针已用合成 XAUUSD、两位元数据复现：主图 `2,700.12`，Swing 图例重复 `2,700.12000`、`2,690.34000`。该证据不是实时行情，也不是 Docker R1。

实施要求：

- 仅 Swing 优先改为原生 `format: { type: "inherit" }`。当前许可库类型声明存在 `StudyPlotValueInheritFormat`。
- 先验证自动精度、手动精度、自定义 formatter、切品种及切数据系列。若原生继承无法覆盖应用自定义 formatter，以探针证据为依据，在现有格式适配层补齐狭窄的 Swing 路径。
- 计算、比较、原始数据不舍入。其他 Python study 格式保持现状。
- 用旧版真实保存入口生成 workspace/template 测试输入，检查是否存在旧 precision override。若有，先验证公开 API 的精度重置行为，再仅迁移 Swing 展示精度；不能假定 API 已支持，也不能重建 study 或批量改写其他指标。

### 2.2 每侧一个标签

后端 `backend/alerts/swing_sr.py` 的 `KEYS` 是 `high/high_left/low/low_left`，前端偏移为 `[0, -high_strength, 0, -low_strength]`。每侧两条价格相同是绘图设计；旧文档 `docs/swing-support-resistance-indicator-plan-20261012.md` 曾明确要求每侧两个标签。本任务改变展示约定，保留算法与全部绘图。

| 每侧绘图可见性 | 价格轴和图例标签归属 |
| --- | --- |
| 两条都可见 | 优先未偏移的 high 或 low |
| 仅未偏移可见 | high 或 low |
| 仅左移可见 | high_left 或 low_left |
| 两条都隐藏 | 无标签，不强制显示绘图 |

原生 display flags：Pane=1、DataWindow=2、PriceScale=4、StatusLine=8、All=4294967295。使用公开 `getStyleValues()` / `applyOverrides()` 核实并修改 display，不假设存在 `setStyleValues()`。非标签承担者仅移除轴和图例位；保留绘图区、数据窗口及用户颜色、线宽、可见性。不要把 All 直接替换成简单位和而丢失其他有效位；使用库的实际语义并通过渲染验证。

复用 `advanced-host/swing-sr-display.js` 的 study 事件和已有 250ms 刷新入口，只在状态确实变化时写回。不新增轮询；没有 snapshot 或统计被隐藏时，也要执行标签规范化。覆盖加载、应用模板、用户单独隐藏绘图、双图和多个 study 实例；不跨实例或跨 high/low 去重。保留现有 study/algorithm ID、输入、plot 顺序以及最新有限值桥接线。

### 2.3 即时通知位置与动效

当前 `advanced-host/native-notification-surface.js` 强制 top/left50%/translateX(-50%)；`NativeInstantNotice.tsx` 计算顶部位置；CSS 入场向下、退场向上。需要同步修改实际原生 Surface 与 React 几何，不能只改外层 CSS。

| 场景 | 新规则 |
| --- | --- |
| 桌面 | 可用图表区域右下角，右/下各16px，最大宽355px |
| 侧栏或底部工具区展开 | 避让其实际边界；保持16px间距 |
| 视口宽 <480px | 视口右下角，右/下各12px，宽≤min(355px,视口宽−24px) |
| 长内容、短视口 | 限制最大高度并内部滚动，操作按钮可达 |

浮窗仍为覆盖式、非模态，不改变图表画布尺寸。边界读取封装在固定版本原生适配器 `native-alert-shell.js` 的 `overlayBounds` 入口，不把库内部 DOM 选择器散入业务组件。共享 Geometry 支持互斥的 top/right 或 bottom/right；即时浮窗用 bottom/right，消息中心继续 top/right。清除旧 top、left、居中 transform；resize、侧栏和底部栏开合后重新定位。

- 入场：translateY(+16px)→0，opacity0→1，220ms ease-out。
- 退场：translateY(0)→+16px，opacity1→0，160ms ease-in。
- 同步修正顶部专用 clip-path，避免阴影、底部边缘或滚动内容误裁剪；仅动画位移与透明度。
- 保留 enter/shown/exit、换条先退后进、同一事件更新不重播、退场快照不可交互、reduced-motion 跳过位移和等待。
- 系统消息完全呈现后才计时，悬停/焦点暂停；交易告警未确认不消失、新告警继续排队；动画不提交确认。

## 3. 修改入口

| 文件 | 工作 |
| --- | --- |
| `advanced-host/indicators.js` | Swing 继承格式及新建时标签默认值 |
| `advanced-host/swing-sr-display.js` | 标签归属及旧配置恢复规范化 |
| `advanced-host/price-format.js` | 仅在探针证明需要时补充 Swing formatter |
| `advanced-host/native-alert-shell.js` | 可用区域、侧栏和底部边界 |
| `advanced-host/native-notification-surface.js` | right/bottom 与旧样式清除 |
| `web/src/notifications/NativeSystemMessages.tsx` | 共享 Geometry/Surface 类型 |
| `web/src/advanced/nativeAlertUI.tsx` | 若边界接口扩展，同步 overlayBounds 类型 |
| `web/src/notifications/NativeInstantNotice.tsx` | 定位、尺寸和最大高度 |
| `web/src/notifications/native-instant-notice.css` | 动效、裁剪和滚动 |
| `web/src/notifications/Panel.tsx` | 更新“顶部居中”说明 |
| `docs/swing-support-resistance-indicator-plan-20261012.md` | 增补新展示约定，保留历史验收事实 |
| `docs/notification-ui-contract-20261019.md` | 更新当前定位与动效合同 |
| `web/tests/swing-price-presentation.browser.cjs` | **待创建**，原生精度/标签/保存恢复回归 |
| `web/tests/instant-notice-placement.browser.cjs` | **待创建**，真实 Surface 布局/动画/交互回归 |

## 4. 执行顺序与可运行命令

下面命令仅在用户授权实施后执行。任一步失败先修复或记录阻塞，不能跳过验收并标记完成。

### A. 盘点、创建 worktree 与任务记录

先读主仓库及实施目录适用的 `AGENTS.md`；检查基线、worktree、分支、同名 Docker task 和私有 preview 目录。没有 Issue 时建立本地 Issue 草案，记录目标、F0理由与最小检查，不自动发送消息。

```bash
git -C /home/quant/repos/market-watch worktree list
git -C /home/quant/repos/market-watch-integration-20261024 rev-parse HEAD
git -C /home/quant/repos/market-watch-integration-20261024 status --short
git -C /home/quant/repos/market-watch branch --list fix/swing-format-notice-placement-20261024
```

仅当目标分支与目录均不存在时：

```bash
git -C /home/quant/repos/market-watch worktree add \
  -b fix/swing-format-notice-placement-20261024 \
  /home/quant/repos/market-watch-swing-notice-20261024 \
  59ed3a3f3fc727da76d13149934d999ebee04218
```

已存在时核对归属、分支、状态后恢复执行；不得 reset、删除或覆盖未知现场。集成基线变化时仍从固定 SHA 开始，记录差异；如存在明确的更新基线指令则按用户指令调整。

在实施 worktree 的 `docs/` 保存本任务书副本、Issue 草案和不含秘密的 `swing-notice-execution-20261024.md`。记录每阶段完成/待办、实际命令、结果、候选 SHA、镜像、端口和证据位置，以便中断续跑。

### B. 本任务依赖与原生探针

从实施 worktree 执行：

```bash
cd /home/quant/repos/market-watch-swing-notice-20261024
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
cd web
npm ci
```

若 `.venv` 已存在先验证可用性，不覆盖。浏览器使用仓库已有 Playwright 配置；缺少 Chromium 时在 web 目录执行 `npx playwright install chromium`。不得使用会隐式安装新版本的裸全局测试工具替代锁定依赖。

本机许可库来源 `/home/quant/repos/market-watch/advanced-host/charting_library`，基线新 worktree 中不含该忽略目录。核对来源版本和目标后，将完整目录复制到本任务 `advanced-host/charting_library` 供 fixture/Docker context 使用；目标已存在先比较。不得提交或公开许可库。主 checkout 的 `.venv`、`web/node_modules` 可作诊断参考，不修改共享依赖来完成本任务。

先在尚未修改的基线生成旧 workspace/template 的私有测试输入，设置非默认颜色/线宽/强度、单独隐藏绘图及统计开关。再运行实际原生库探针，确认 inherit、display override、旧 precision override 行为。可复用：

- `web/tests/swing-sr-native.browser.cjs` 与 `web/tests/fixtures/swing-sr-native.html`；
- `web/tests/fixtures/swing-sr-feed.py` 生成真实算法输出的合成行情 fixture；
- `web/tests/swing-sr-application.browser.cjs` 的登录和应用路径模式，但它硬编码旧实例，**不得原样运行**；
- 当前合成数据复现截图 `/home/quant/repos/.reports/market-watch/20261024-swing-notice-analysis/swing-baseline-probe.png`，仅作为辅助。

探针结论写入执行记录；原生能力不成立时按第2节限定的备选路径处理。若公开 API 无法保持约定兼容性，记录具体反例后停在范围检查点，不靠未经验证的私有 API 完成。

### C. 实现并创建行为回归

按依赖顺序先完成 Swing 精度/标签及保存恢复，再完成通知边界/Surface/React/CSS/文案，最后同步合同。围绕用户可见风险新增两个浏览器测试；文件目前不存在，必须先创建，不能把下面命令当成现成检查。

两个新脚本统一支持环境接口：

| 环境变量 | 用途 |
| --- | --- |
| `MW_TEST_BASE_URL` | 隔离 UI 地址，例如 `https://localhost:18780` |
| `MW_TEST_CHART_URL` | 隔离 chart origin，例如 `https://localhost:18781` |
| `MW_TEST_CREDENTIALS_FILE` | 本任务私有 credentials.json，只读取 login_password，不打印 |
| `MW_TEST_ARTIFACT_DIR` | 本任务截图、断言结果与动画采样目录 |

脚本校验参数，使用 `ignoreHTTPSErrors: true` 处理本机自签名证书，退出码非零表示失败；不得默认连接旧任务或生产实例。测试当前候选的原生 API 和真实 Surface；纯模拟 DOM 测试不足以替代验收。三位精度、手动格式、自定义 formatter、确定性枢轴可用测试专属合成 fixture 补充，明确数据来源，不改共享 D1 seed 来迁就测试。fixture 的本地服务由测试显式启动并在 finally 关闭。

在 `web` 目录运行现有检查：

```bash
npm run build
node scripts/build-alert-ui.mjs /tmp/mw-swing-notice-20261024-ui
node tests/chart-price-format.cjs
node tests/notifications-runtime.cjs
node tests/notifications-persistence.cjs
node tests/swing-fixed-identity.cjs
node tests/swing-sr-adapter.cjs
```

`swing-sr-adapter.cjs` 会调用 worktree 根 `.venv/bin/python`，因此不能省去 Python 环境。需要时复用现有 native browser 回归，先检查其 fixture/artifact 路径；不要调用指向旧实例的应用测试。检查通过后自审、提交候选，再构建验收镜像，使提交、镜像与验收对象对应。

### D. Ubuntu R1：只读资源检查

```bash
hostname
docker compose ls
docker ps --format '{{.Names}} {{.Ports}}'
ss -ltn
free -h
df -h / /var/lib/docker
uptime
```

需要服务：PostgreSQL、API、web、chart-origin、TLS 网关及一次性 migrate/seed；通常不需 worker。preview 的 UI 常驻资源上限约1216MiB/0.75CPU，启动工具会做更保守的空闲资源检查；按 `deploy/ubuntu/README.md` 核对本机预算及现有任务。端口或资源冲突不停止别的任务，先报告事实；端口可在本任务内改为空闲值并同步镜像 origin 和测试参数。不要新增调度器、锁槽位或共享数据库。

### E. 带归属构建与隔离 UI preview

本机安装版 mw-docker 较旧，缺少 UI preview 需要的 chart-origin 标签。**构建与 preview 统一显式使用本 worktree 的 `deploy/ubuntu/mw_docker.py`**：这是仓库维护的 mw-docker 实现，不覆盖主机安装版，不绕过归属或标签检查。若执行时工具已更新，仍可使用下列明确入口。

以下从实施 worktree 根目录、依赖和许可库准备后执行。若候选端口更改，先同步下列 build arg 和 prepare 参数。

```bash
.venv/bin/python deploy/ubuntu/mw_docker.py build --repo . \
  --component api --tag market-watch-api:mw-swing-notice-20261024 \
  --task mw-swing-notice-20261024 --project mw-swing-notice-20261024 --purpose acceptance
.venv/bin/python deploy/ubuntu/mw_docker.py build --repo . \
  --component chart --tag market-watch-chart-origin:mw-swing-notice-20261024 \
  --task mw-swing-notice-20261024 --project mw-swing-notice-20261024 --purpose acceptance
.venv/bin/python deploy/ubuntu/mw_docker.py build --repo . \
  --component web --tag market-watch-web:mw-swing-notice-20261024 \
  --task mw-swing-notice-20261024 --project mw-swing-notice-20261024 --purpose acceptance \
  --build-arg VITE_ADVANCED_CHART_ORIGIN=https://localhost:18781
.venv/bin/python deploy/ubuntu/mw_docker.py preview prepare \
  --task mw-swing-notice-20261024 --project mw-swing-notice-20261024 --repo . \
  --api-image market-watch-api:mw-swing-notice-20261024 \
  --web-image market-watch-web:mw-swing-notice-20261024 \
  --chart-image market-watch-chart-origin:mw-swing-notice-20261024 \
  --port 18780 --chart-port 18781
.venv/bin/python deploy/ubuntu/mw_docker.py preview up \
  --task mw-swing-notice-20261024 --project mw-swing-notice-20261024
.venv/bin/python deploy/ubuntu/mw_docker.py preview status \
  --task mw-swing-notice-20261024 --project mw-swing-notice-20261024
```

基础镜像需按 README 准备固定版本/digest；工具默认使用本地镜像，缺失先核实再在 Ubuntu 准备，不回退 legacy builder 或直接无标签 docker build。preview 生成任务独立 Compose、网络、volume、数据库、凭据、TLS 和固定镜像引用，默认禁用外部投递、Yahoo、OANDA stream、MCP。不读取根 `.env` 或复用共享数据库。

私有状态位于 `/home/quant/.local/share/market-watch-docker/previews/mw-swing-notice-20261024/`。凭据文件含 login_password、login_hash、database_password，仅本机读取，不进入命令输出、截图、提交或 PR。现有 task/prepare 参数不匹配时先核查归属，不覆盖未知状态或绕过检查。

UI 地址 `https://localhost:18780`，chart 地址 `https://localhost:18781`，均为 Ubuntu 回环 HTTPS，不承诺其他主机可访问。记录 hostname、实际端口、健康状态、镜像 ID/digest/候选 SHA。D1 为合成数据：D1_EURUSD五位，D1_XAUUSD/D1_BTCUSDT/D1_AAPL两位，M1/H1各720条；不足以代表真实行情或生产规模。

两个测试创建完成后，从 `web` 目录执行：

```bash
export MW_TEST_BASE_URL=https://localhost:18780
export MW_TEST_CHART_URL=https://localhost:18781
export MW_TEST_CREDENTIALS_FILE=/home/quant/.local/share/market-watch-docker/previews/mw-swing-notice-20261024/credentials.json
export MW_TEST_ARTIFACT_DIR=/home/quant/repos/.reports/market-watch/20261024-swing-notice-implementation
mkdir -p "$MW_TEST_ARTIFACT_DIR"
node tests/swing-price-presentation.browser.cjs
node tests/instant-notice-placement.browser.cjs
```

无真实 UI/native 验证时不得把 Compose 展开、API-only preview 或 fixture 单独通过称为 R1通过。若修改了候选代码，重跑受影响检查、重建对应镜像、重新 up 并记录实际候选；不要交付旧镜像的验收结果。

保留验收现场供用户检查，不自动退役。仅在确需停止本任务且已确认归属时使用：

```bash
.venv/bin/python deploy/ubuntu/mw_docker.py preview stop \
  --task mw-swing-notice-20261024 --project mw-swing-notice-20261024
```

stop 保留数据库。后续退役须遵守 AGENTS 的归档与实际恢复规则，本任务不授权删 volume、worktree 或备份。

## 5. 必须逐项记录的验收矩阵

| 场景 | 通过条件 |
| --- | --- |
| 2/3/5位自动精度 | 同价 Swing 文本与所在图表 formatter 一致 |
| 切品种/数据系列、手动精度再恢复自动、自定义 formatter | 无旧格式残留，无舍入原始计算数据 |
| 默认四绘图 | 轴和图例各一高一低；四绘图及最新桥接线正确 |
| 分别隐藏四绘图、每侧都隐藏 | 归属按第2节切换，不恢复被用户隐藏的线 |
| 两份 Swing、双图 | 每实例/每图独立，不跨实例去重或串精度 |
| 旧 workspace/template 经真实保存恢复、再保存恢复 | 新展示规则生效；颜色/线宽/强度/可见性/统计开关保留 |
| 统计关闭或 snapshot 尚未就绪 | 标签规则仍生效 |
| 桌面、侧栏与底部栏开合、resize | 可用区域右下角、间距正确，画布尺寸不变 |
| 375px窄屏、低窗口、长内容 | 完整可见，无横向溢出，关闭/查看/确定按钮可达 |
| 入/退场中间帧 | 入场向上、退场向下；采样实际位置/transform和opacity，排除错误裁剪 |
| 连续换条与同事件更新 | 先退后进；同事件不重播；退出快照不可交互 |
| 系统计时、悬停与键盘焦点 | 完全呈现后计时，暂停恢复保持合同 |
| 交易告警确认与队列 | 未确认不消失，不因动画提交确认，新告警正常排队 |
| reduced-motion、深浅主题 | 无位移等待；标签清晰、阴影和内容边缘正常 |

断言须覆盖格式化文本、原生样式、真实屏幕边界、动画中间帧及消息状态。不要只靠静态截图或代码字符串断言。保存脱敏截图和动画采样数据；不能公开包含登录状态、凭据或许可库的完整浏览器 trace/state。

## 6. 完成、交接与停止边界

交付前完成：

1. 自审 diff，确认算法/协议/其他指标无意外变化，执行 `git diff --check`；保留历史验收事实。
2. 本地构建、相关回归和 Ubuntu R1 均有结果，对应同一最终候选。PR 必需 CI 通过；无法运行的检查明确列为未完成，不宣称全绿。
3. 创建/更新 Draft PR，标题围绕三项最终行为，说明 F0理由、最小检查、兼容性、实际候选及证据。用 `gh pr create --draft` 时先用 `gh repo view` 核对仓库与默认目标；描述写文件后 `--body-file`，不直接插值多行文本。没有登录或远程权限时保留本地提交和完整 PR 草案，准确报告该交付阻塞。
4. 执行记录包含每项验收结果、截图/采样位置、主机/URL、task/project、启动/停止命令、镜像 ID 与 SHA、当前实例状态、剩余问题；再次核对集成 worktree 未被本任务修改。
5. 给用户简短交接：实际改变、验证结果、Draft PR、可访问地址和限制。仅在用户明确要求 HTML/网页时另做页面，默认只交付 Markdown。

遇到资源冲突、隔离无法证明、关键原生 API 不满足约定、数据边界或目标冲突时，保留现场，报告具体证据与唯一需要的决定。正常实现与检查不逐步询问。完成 Draft PR、CI及R1后停在合并检查点；不自行 merge、不创建正式发布tag、不发布生产、不删除永久数据。

## 7. 可复制的启动指令

```text
请执行 /home/quant/repos/.reports/market-watch/20261024-swing-notice-plan/agent-task.md。按任务书和仓库 AGENTS.md，从指定 SHA 创建独立 worktree，完成 Swing 精度/标签及即时通知定位动效的实现、相关回归、CI、自审、Ubuntu Docker R1 和 Draft PR；正常步骤自动推进。不要合并、不发布生产、不删除永久数据。遇到任务书规定的范围或资源冲突时保留现场并报告。最终交付 Markdown 执行记录、验收证据和 Draft PR 链接。
```
