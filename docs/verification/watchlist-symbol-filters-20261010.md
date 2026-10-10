# 自选表添加商品代码：统一搜索筛选

## 变更

- 基线：远端 main `f08a524b86acfdaa4d595c08f5389cfc86a1c150`。
- 自选表“添加商品代码”与主“商品代码搜索”共用列表右上的两个原生下拉框，默认“全部行情”和“全部来源”。
- 行情类型选项：全部行情、平台行情、自建行情、组合行情；来源选项仍从数据源配置读取。
- 仅适配原生 `searchInitiationPoint: watchlist`；保留自选表的连接组件、行操作、底部提示与 Enter / Shift+Enter 行为。
- 两个弹窗共用 Tab 焦点约束，关闭时移除监听。

## 验证

实际环境：Ubuntu 本机 Docker，独立 task/project `mw-watchlist-filters-20261010`。
图表镜像通过 `mw-docker build --component chart --purpose acceptance` 和专用 `market-watch-ubuntu` builder 构建。
浏览器直接读取最终镜像中的 `native-ui.js` 与已安装的许可图表库；目录、报价、历史使用浏览器中的确定性数据源 fixture。本次未部署 API 或数据库，未验证真实供应商连接或后端目录接口。

验收访问入口为 `http://127.0.0.1:19983/harness.html`；该 harness 由 Playwright route 提供，仅在验收脚本运行时可用。

最终 Chromium 报告：**10 项通过，浏览器异常 0**。

- 列表右上恰好两个原生 Select，旧来源按钮不再显示。
- 三种具体行情类型与来源组合返回精确 ticker。
- 点击行添加、移除正确 ticker，窗口保持打开，当前图表商品不变。
- ArrowDown / Enter 添加、移除；Shift+Enter 添加并关闭。
- 重新打开默认全部行情 / 全部来源，文本搜索正常。
- 下拉框支持键盘打开、Escape 仅关闭下拉并恢复焦点。
- Tab / Shift+Tab 焦点保持在自选表弹窗内。
- 深浅主题，1440 / 768 / 375px：两个下拉框可见，无水平溢出。
- 主搜索两个筛选框与行情筛选回归通过。
- 主搜索 Tab / Shift+Tab 回归通过。

`node --check advanced-host/native-ui.js`、`git diff --check` 通过。
私有可重跑 harness、Compose、构建日志、截图与 `report.json` 位于 ignored 的 `artifacts/watchlist-filters/`。

## 启停与退役

启动：`sg docker -c 'docker compose -p mw-watchlist-filters-20261010 -f artifacts/watchlist-filters/compose.yaml up -d --no-build'`。
停止：将同一条命令的 `up -d --no-build` 换为 `stop`。
验收完成后，使用 `mw-docker retire --task mw-watchlist-filters-20261010 --project mw-watchlist-filters-20261010` 预览，再执行 `--apply`，删除该任务容器、独立网络及无引用候选镜像；该任务没有数据库或数据卷。

此次为本地界面修改，尚未推送、合并或发布到生产。
