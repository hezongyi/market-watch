# 指标窗口实施与验证记录

日期：2026-10-04。实施基线 `62488c6`（v1.7.0），分支 `feat/indicator-selector`，worktree `/home/quant/repos/market-watch-indicator-dev`。原方案 worktree 与其他任务改动均保留。

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
| Compose | 独立配置的 `docker compose ... config --services` 成功解析；仅有 pg/migrate/api/web/chart-origin/tls，无通知 worker |

浏览器依赖缺失时，仅把 Ubuntu deb 的动态库解压到 `/tmp/mw-indicator-browser-libs`；没有修改系统库。实际浏览器测试不代表完整产品、数据库和真实行情验收。

## 尚未完成的验收与待决事项

**本任务 Docker 实例尚未部署，无实际可访问验收地址，真实环境验收尚未通过。** 当前执行环境连接 Ubuntu `/var/run/docker.sock` 报 permission denied；`sudo` 也被 no-new-privileges 禁止。已请求用户配置访问权限。禁止切换到 unraid 绕过此限制。

**收藏兼容方案待用户决定。** 本地 v31 `Favorites.indicators` 只提供构造时默认值，公开 Interface 没有运行时收藏读写。原生 UI 经已有 settings_adapter 保存收藏；按[交接方案](../../indicator-system-plan-20261004.md)不能写内部 settings 键或并行维护另一份收藏。候选实现为新窗口“收藏 → 打开原生收藏”，使用同一原生收藏事实来源，关闭原生窗口后返回列表；尚不提供新列表行星标。此项已提出明确选择，未视作用户批准，也尚未完成真实服务器刷新验收。

待运行完整产品脚本：真实 BTCUSDT M5 行情、SMA/EMA/RSI/MACD/BBANDS、服务器收藏恢复、实际工作区刷新恢复。`advanced-indicator-picker.browser.cjs` 已准备，尚未执行；不能将准备好的测试当作通过证据。

## Ubuntu 独立实例启动与停止

以下是**待执行**的启动方式。端口已检查未被占用，但部署前须再次核实。计划访问地址 `https://localhost:18443`（产品）和 `https://localhost:18444`（隔离图表 origin），仅绑定 Ubuntu loopback，使用开发自签 TLS。

```bash
cd /home/quant/repos/market-watch-indicator-dev
# 已准备私密配置；若首次复现则运行：
PYTHONPATH=backend .venv/bin/python scripts/prepare_indicator_acceptance.py
# 配置存在时脚本退出且保留旧密码；不重新生成。
docker compose --env-file /tmp/mw-indicator-acceptance/compose.env \
  -f docs/verification/indicator-picker/compose.yaml up -d --build
# 导入本任务真实上游行情；脚本断言 pg/indicator_acceptance 数据库及任务标识。
docker cp scripts/indicator_acceptance_history.py mw-indicator-acceptance-api-1:/tmp/indicator_acceptance_history.py
docker exec mw-indicator-acceptance-api-1 python /tmp/indicator_acceptance_history.py
cd web
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
  node tests/advanced-indicator-picker.browser.cjs
```

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


## 完成性核对（2026-10-04）

| 交接要求 | 当前证据 | 状态 |
|---|---|---|
| 隔离 worktree/branch，保留其他任务 | `git worktree list` 与本分支提交 | 已完成 |
| 搜索、分类、列表、已添加实例、直接参数设置 | 实際 v31 浏览器测试；native.json 与截图 | 实现和接口测试通过，待完整产品验收 |
| 浅深色、窄屏、键盘、异步添加归属 | native.json 与实际浏览器断言 | 接口测试通过，待完整产品验收 |
| 收藏星、已有收藏及新入口一致 | 没有公开运行时读写 Interface；候选为打开原生窗口 | 待用户选择，不能认为完整方案已完成 |
| 目录与算法解耦、预热声明、非法输出错误、参数声明 | 56 项相关后端测试与数值差分 | 已完成本轮计算加固 |
| 旧 ID/参数/模板/样式恢复 | 从 v1.7.0 Adapter 生成的原生布局/模板实际恢复：compatibility.json | 图表库接口通过；待完整产品数据库路径验收 |
| Ubuntu 独立 Docker/网络/卷/数据库/端口 | compose.yaml 可解析；socket permission denied | 尚未部署 |
| 真实行情完整验收与实际地址/操作命令/结果 | 完整脚本已准备，无运行结果 | 未通过，无实际验收地址 |
| 不扩展新指标或假设接口、不部署生产 | 实施 diff 与本任务运行检查 | 遵守 |
