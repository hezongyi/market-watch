# 主页忽略旧草稿、直接加载已保存布局

## 需求草案与范围

每次进入主页直接加载上一次保存在服务器的工作区布局和设置，移除上部状态栏、设置草稿横幅和草稿恢复入口。历史本地草稿不恢复、不提交、不删除，也不阻断新的保存。

基线：main `ff0f04026422f854dd137551783119c319b82d9a`（已合并 PR #120）。独立分支：`fix/load-saved-layout-ignore-drafts-20261106`。

分类 **P0**：前端局部启动策略和界面移除；无 API、数据库 schema、持久格式或后台任务变更。最小检查为前端构建、保存/设置/路由定向回归、CI 和本人自审。额外用 Ubuntu Docker Web 容器验证真实 React 页面与受控图表适配器之间的行为。

## 实现

- 保留既有工作区选择规则：明确 URL 指定的工作区优先，默认入口使用 `mw.last-workspace.v1` 对应的服务器工作区；无匹配时沿用服务器列表默认项。
- 工作区打开时不检查旧草稿、不设置保存阻断；设置初始化不再传入旧草稿的阻断键。
- 删除顶部状态栏、设置草稿横幅/处理对话框、工作区复制恢复流程及对应样式。
- 保留本次编辑中的临时写入持久化、保存冲突和版本检查。当前会话保存失败仍禁止继续覆盖；刷新后重新读取服务器版本。失败判断仅查看当前写入者的工作区草稿。
- 告警编辑表单、退出时未保存更改保护、原生系统消息及历史加载详情保持原有行为。

## 验证结果

- `npm run build:ui`：通过 TypeScript 和 UI 构建。
- 专用 `market-watch-ubuntu` builder 的完整 Web 镜像构建通过（包含本机许可库，不提交许可资源）。候选 `market-watch-web:saved-layout-20261106`，实际本地 image ID `sha256:5e56cc30ca073525d9425995a612b2c8e166227777899f2af12ae642a574a296`。
- 定向回归 8 项通过：`advanced-native-save-race.cjs`、`advanced-native-workspaces.cjs`、`advanced-preferences.cjs`、`advanced-preferences-conflict.cjs`、`preference-draft-banner.cjs`（存储/失败分类单元检查）、`chart-tab-title.cjs`、`single-app-routing.cjs`、`native-preference-notice.cjs`。
- 新增 `saved-layout-startup.browser.cjs`，接入 CI。真实 Chromium + 构建后的 React 应用通过以下断言：默认入口、明确 URL 和刷新均使用服务器布局/设置；没有顶部栏、草稿横幅或恢复入口；旧版、不同写入者以及不可解析的草稿保持原样；旧草稿没有触发写入；手动保存和 snapshot 自动保存正常；本次 409 冲突仍阻断覆盖，刷新忽略该失败草稿并使用服务器布局。
- 本人自审：旧草稿不会进入初始化数据或复制创建请求；新保存只清除本次写入者对应版本；现有冲突及工作区过期响应保护保留。`git diff --check` 通过。

浏览器测试以受控 HTTP 接口和图表适配器替代后端及许可库渲染器，验证页面启动和保存边界；本次未运行真实 PostgreSQL/行情集成验收，也未发布生产。

## Ubuntu Docker 运行记录

实际主机为本机 Ubuntu，隔离 Compose project/task `mw-saved-layout-20261106`，服务仅 Web，128 MiB / 0.1 CPU，无数据库或数据 volume。启动前检查现有项目、空闲端口、内存和磁盘；未改动其他实例。URL 为 `http://127.0.0.1:19846`，仅提供静态候选资源；测试通过浏览器拦截提供受控接口，不能用作真实行情实例。

构建命令显式指定 context/file，兼容本机较早安装的 mw-docker：

```bash
mw-docker build --repo . --context . --file web/Dockerfile --component web \
  --tag market-watch-web:saved-layout-20261106 --task mw-saved-layout-20261106 \
  --project mw-saved-layout-20261106 --purpose acceptance
```

本机任务配置位于 `~/.local/share/market-watch-docker/ui-smokes/mw-saved-layout-20261106/compose.json`：

```bash
docker compose -p mw-saved-layout-20261106 \
  -f ~/.local/share/market-watch-docker/ui-smokes/mw-saved-layout-20261106/compose.json up -d --no-build
cd web
MW_BASE_URL=http://127.0.0.1:19846 node tests/saved-layout-startup.browser.cjs
# 停止并移除本次无状态容器、独立网络；没有 volume。
docker compose -p mw-saved-layout-20261106 \
  -f ~/.local/share/market-watch-docker/ui-smokes/mw-saved-layout-20261106/compose.json down
```

验收结束已执行上述 down，地址不再提供服务；候选镜像暂保留。工作树保留待 PR 审阅。
