# 指标窗口实施与验证记录

更新：2026-10-06。实施基线 `62488c6`（v1.7.0），分支 `feat/indicator-selector`，worktree `/home/quant/repos/market-watch-indicator-dev`。原方案 worktree 与其他任务改动均保留。

## 已实施

- 自有指标窗口接入公开 header button；枚举、添加、参数设置、显隐和移除都使用公开图表 API。顶部名称/别名/ID 搜索，精确/前缀/包含排序；左侧来源导航；独立滚动列表；详情按需展开；窄屏分类选择。
- Python 中文显示名与原生注册名分离。原生 study 名、metainfo ID、输入顺序和 plot 顺序保持稳定；不为内置条目猜测主副图信息。
- 当前图表按实体 ID 管理，允许同名多实例；活动图表变化刷新列表；异步添加绑定发起时图表。添加后可直接进入原生设置，关闭后返回并保留查询；窗口有显式 Tab/Shift+Tab 循环、Escape 关闭与焦点恢复。
- 后端公开目录只序列化显式声明，不执行算法、不导出 calculator/history_requirement。注册验证输出声明和参数规则；计算验证 key/顺序/一维数值/长度，输入只读；自定义预热声明优先。8 个既有算法与原预热规则保持稳定。
- 未新增指标、计算缓存或依赖升级。兼容和扩展方法见 [维护说明](../../python-chart-indicator-maintenance.md)。

## 已通过的检查

| 检查 | 实际结果和边界 |
|---|---|
| 后端测试 | `test_chart_indicator_contract.py`、`test_chart_workspace.py`、`test_indicators.py`、`test_advanced_workspace.py` 共 54 项通过；`test_advanced_preferences.py` 另 2 项通过。涵盖目录不执行算法、非法输出、预热声明、0/NaN、缺口、分页、长历史与未来追加、原生工作区及偏好存储 |
| v1.7.0 数值差分 | 1200 根人工 OHLC，含未完成 K 线及 gap_before；8 个指标输出、null、曲线顺序与 `62488c6` 的计算结果逐项相等 |
| 前端 | `npm run build` 通过；picker 搜索、Python Adapter、progressive-indicators 脚本通过；Ruff 与 diff whitespace 检查通过 |
| 实际 v31 浏览器 Interface | `advanced-indicator-picker-native.browser.cjs` 使用本地许可库、Playwright 路由提供静态资源及合成行情，无运行服务器。公开按钮、搜索、同名多实例、显隐/移除、原生设置返回、多图、延迟添加、原生 study 保存恢复、浅深色、375px、Tab/Escape/焦点均通过。报告和截图见同目录 `native.json` / `native-*.png` |
| 旧版本布局/模板/样式 | `advanced-indicator-compatibility.browser.cjs` 先使用 git `62488c6` 的旧 Adapter 创建 8 个 study、原生布局与模板，再由当前 Adapter 恢复；原生实体 ID、参数顺序、SMA(60)、BBANDS(25,2.5)、MACD(8,21,5)、颜色/线宽/显隐和 histogram plot2 均通过。证据 `compatibility.json`。合成行情，无服务器，不替代真实环境验收 |
| Compose | 独立配置的 `docker compose ... config --services` 成功解析；有 pg/migrate/api/web/chart-origin/tls；整合 v1.8.0 后另增独立 history-worker，无通知 worker |

浏览器依赖缺失时，仅把 Ubuntu deb 的动态库解压到 `/tmp/mw-indicator-browser-libs`；没有修改系统库。上表中的无服务器测试只证明图表库 Interface，完整产品证据另列于下文。

## Ubuntu 真实环境验收

**2026-10-05 已在 Ubuntu 22.04.5 LTS 主机 `quant-server` 部署本任务独立实例并通过完整验收。** Docker 权限由用户配置 quant 的 docker 组解决，当前旧会话用 `sg docker -c '…'` 执行。API/PostgreSQL 健康、迁移退出 0；资源详情见 [runtime.json](runtime.json)。实例保留运行。

- 实际访问：产品 `https://localhost:18443`，图表静态 origin `https://localhost:18444`。仅绑定 Ubuntu loopback，自签 TLS；远程浏览可转发这两个端口。密码仅在 `/tmp/mw-indicator-acceptance/login.json`。
- 上游取回真实 Binance BTCUSDT M5 2000 根；六个实例 SMA(20)/SMA(60)/EMA/RSI/MACD/BBANDS 全部 10 条曲线都有有限数值，逐根与公开十字光标返回的原生显示值核对，误差不超过 5 位小数显示精度。实际 API 返回每实例至少 100 根；证据 [full-stack.json](full-stack.json) 保存时间范围、参数、实体 ID 和逐点样本。
- 完整产品脚本 19 项通过：中英文/别名搜索、原生/Python 来源、分类空结果、内置 SMA 添加/移除、连续添加、直接设置与返回、独立实例管理、主题/375px/键盘、多图切换、延迟添加归属、数据库工作区/模板恢复、v1.7.0 旧布局/模板恢复、收藏服务器保存/刷新恢复。旧布局的 8 个实体 ID、参数、颜色/线宽/显隐均保持一致。
- 真实页面截图 [深色](full-stack-dark.png)、[浅色](full-stack-light.png)、[窄屏](full-stack-narrow.png)。应用 pageerror/console/API 错误为空。库已有的偶发 Google Analytics 加载尝试被既有 CSP 阻止，单独记 `policyBlocks`；不允许成功外连，也不忽略其他错误。

**收藏兼容采用用户已授权方案：** 新窗口“收藏 → 打开原生收藏”，沿用原生 settings_adapter 的同一服务器收藏；关闭后返回新窗口。公开 Interface 不提供运行时收藏读写，因此新列表行不另设星标或维护第二份收藏。上述完整产品验收实际验证了星标变化、服务器保存和刷新恢复。

验收过程中修复了 `.dockerignore` 漏掉 picker 文件的问题，以及原生构造先解析默认自选列表、稍后才恢复用户列表导致请求无关品种的问题。构造时现直接使用保存的活动列表。隔离实例只使用公开 Binance 数据，自选列表明确设为 BTCUSDT，不读取生产 OANDA 凭据。

环境限制记录：Docker Hub 直连超时，数据库改用本机已有 `postgres:14-bookworm`，独立数据库与新卷仍从空库迁移。应用镜像按本分支 Dockerfile 正式构建。旧布局恢复同时加载 8 个指标曾碰到上游 8 秒请求期限；仅将验收实例的期限改为允许上限 30 秒，生产默认值未改。

显示值验收不用 `exportData`：本地许可包缺少其 `zh.20866` chunk。改用公开 `crossHairMoved.entityValues`，不访问私有图表对象或修改 vendor 文件。合成行情的 Interface/旧版本兼容测试仍保留，与真实环境证据分别记录。

## 与最新主线的整合验证（2026-10-06）

PR #9 对照主线 `b700911`（v1.8.0）整合。唯一文本冲突位于图表 Dockerfile 的 COPY 行，已同时保留主线 `native-navigation.js` 和本任务 picker JS/CSS；其余文件自动合并。新增本任务独立 `history-worker` 执行主线历史任务协议，验收脚本观察正式 `/charts/history-loads` 的提交/结果响应，同时兼容原 `/charts/data`，不绕过 worker。

整合后前端构建、picker/Python/progressive、原生 hook/导航/容量边界、历史加载/通知脚本通过；相关后端测试含新增原生历史/容量路径共 72 项通过。整合后的 19 项真实产品验收全部通过，pageerror/console/API 错误为空；重验结果记录在 [main-integration.json](main-integration.json)，镜像仍只部署到本任务 Ubuntu 实例；主线生产未操作。

## 正式 Review 与修复后重验（2026-10-06）

按 code-review 技能分开完成 Standards 与 Spec 两轴独立审查。Standards 发现 P2：嵌套 series/schema 的额外 callable 可令整个目录 API 序列化失败；现明确投影公开字段，增加 JSON、认证 API、禁止调用算法和副本隔离回归。Spec 发现 P3：详情缺少各指标用途与计算说明；现补齐既有 8 个 Python 指标的可靠说明，原生条目继续只展示公开 API 能确认的字段。两轴复审均无剩余发现，详见 [review.md](review.md)。

受测功能提交 `fcd9ac8`；最终整合提交 `0ca7af3` 仅合入最新 main `2ee5cb7` 的生产交付文档，与受测功能提交的运行代码、测试及构建输入一致。75 项相关后端测试、picker 搜索、前端构建、Ruff 和差异检查通过。仅重建本任务 Ubuntu project，完整产品新增详情断言后共 **20 项通过**，全部 10 条真实行情曲线逐点核对通过，pageerror/console/API 错误为空；结果与截图为 [review-integration.json](review-integration.json) / review-integration-*.png。当前实际镜像 ID 与源码关系已刷新到 runtime.json。

容器重建首次访问因 TLS 代理仍缓存旧 API 容器地址返回登录 502；只重启本任务 tls 服务后完整重验通过。未修改其他实例或生产；此前主线整合与失败/限制记录保留。

建议后续正式 tag 为 `v1.9.0`（兼容新增功能）。本轮仅完成分支修复与合并就绪确认，未合并 PR、创建 tag 或发布生产；包版本仍为 1.8.0，正式发布前须同步 Python/web/锁文件及 CHANGELOG。

## Ubuntu 独立实例启动与停止

以下为已实际执行的启动方式。当前访问地址 `https://localhost:18443`（产品）和 `https://localhost:18444`（隔离图表 origin），仅绑定 Ubuntu loopback，使用开发自签 TLS。

```bash
cd /home/quant/repos/market-watch-indicator-dev
# 已准备私密配置；若首次复现则运行：
PYTHONPATH=backend .venv/bin/python scripts/prepare_indicator_acceptance.py
# 配置存在时脚本退出且保留旧密码；不重新生成。
docker compose --env-file /tmp/mw-indicator-acceptance/compose.env \
  -f docs/verification/indicator-picker/compose.yaml up -d --build --pull never
# 导入本任务真实上游行情；脚本断言 pg/indicator_acceptance 数据库及任务标识。
docker cp scripts/indicator_acceptance_history.py mw-indicator-acceptance-api-1:/tmp/indicator_acceptance_history.py
docker exec mw-indicator-acceptance-api-1 python /tmp/indicator_acceptance_history.py
cd web
export LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
# 先生成旧版 Adapter 的布局/模板工件（无服务器合成行情）：
INDICATOR_COMPAT_SYMBOL=MWP:BTCUSDT \
INDICATOR_COMPAT_FIXTURE=/tmp/mw-indicator-acceptance/legacy-fixture.json \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
  node tests/advanced-indicator-compatibility.browser.cjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
  node tests/advanced-indicator-picker.browser.cjs
```

新 shell 在 docker 组权限生效后可直接运行上面命令；旧 shell 可使用 `sg docker -c 'docker compose …'`。只启动已构建实例可用 `up -d --no-build --pull never`。

私密 `/tmp/mw-indicator-acceptance/` 保存 login.json、api.env、compose.env、TLS key/cert；不提交。独立 Compose project `mw-indicator-acceptance`，网络 `mw-indicator-acceptance_default`，卷 `mw-indicator-acceptance_indicator-pg`，数据库 `indicator_acceptance`，镜像标签 `*:indicator-acceptance`。不复用其他实例或生产目录。

```bash
# 停止本任务，保留独立数据卷。
docker compose --env-file /tmp/mw-indicator-acceptance/compose.env \
  -f docs/verification/indicator-picker/compose.yaml stop
# 删除本任务容器/网络，仍保留数据卷。
docker compose --env-file /tmp/mw-indicator-acceptance/compose.env \
  -f docs/verification/indicator-picker/compose.yaml down
```

## 无服务器的图表库浏览器测试

需要本地许可图表库和可启动的 Chromium；资源经 Playwright 路由提供，无后台实例。当前执行环境启动命令：

```bash
cd /home/quant/repos/market-watch-indicator-dev/web
LD_LIBRARY_PATH=/tmp/mw-indicator-browser-libs/root/usr/lib/x86_64-linux-gnu \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
  node tests/advanced-indicator-picker-native.browser.cjs
```


## 完成性核对（2026-10-05）

| 交接要求 | 当前证据 | 状态 |
|---|---|---|
| 隔离 worktree/branch，保留其他任务 | 本分支提交与独立 Docker labels | 已完成 |
| 搜索、分类、直接设置、实例管理 | full-stack.json，native.json | 真实产品通过 |
| 主题、窄屏、键盘、多图、异步添加归属 | full-stack.json 与截图 | 真实产品通过 |
| 原生收藏事实来源与刷新恢复 | 已授权兼容入口；服务器持久化验收 | 通过，新列表不设独立星标 |
| 目录/算法解耦、预热/输出契约、参数声明 | 56 项相关后端测试与基线数值差分 | 已完成 |
| v1.7.0 旧 ID/参数/模板/样式恢复 | compatibility.json；full-stack.json 的真实数据库路径 | 通过 |
| Ubuntu 独立 project/网络/卷/库/端口 | runtime.json；实际 API/PG healthy | 已运行 |
| 真实行情全部曲线数值 | full-stack.json 的公开事件与后端逐点核对 | 通过 |
| 不扩展新指标、不部署生产、保密 | 无新增指标；独立本机资源；提交审计 | 遵守 |
