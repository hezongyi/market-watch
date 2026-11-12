# 简化登录页（2026-11-12）

用户要求登录页去掉点阵背景和动画、默认浅色、去掉左下角说明，右上角只保留主题按钮。

本轮为 P0 局部界面/默认值变更。`SimpleLogin` 直接显示纯色背景，不再导入或挂载粒子画布，不启动背景动画/监听；移除动画开关、右上角介绍和页脚。首次访问默认浅色，已有明确保存的浅/深色选择继续有效。独立外观预览使用同一组件和浅色默认值。密码显隐、必填、登录错误和目标地址返回逻辑保留。

## 构建与自审

- 代码提交 `128b63f3`，干净构建；后续提交仅记录验收。
- 经 `mw-docker build` 完成 TypeScript、Vite 和完整原生图表静态资源构建。新 worktree 复用本机固定版本许可库，未提交许可资源。
- `git diff --check` 通过；本人自审确认只变更登录显示、主题缺省值、相应样式和预览引用，无 API/后台/数据库变更。
- 没有为局部样式增加实现镜像测试；使用已部署页面的浏览器验收。不查询或追踪 CI。

## Ubuntu 开发验收

Ubuntu 本机 Docker project `mw-dev`：https://192.168.7.232:18443/login 。启动 `mw-dev up`，停止 `mw-dev stop`，状态 `mw-dev status`。

Web 镜像 `market-watch-web:dev-simple-login-20261112`，ID `sha256:dbdb84eb1388efef8c2c895fd6e9b163ca031bc2ef9f2b55ccbf704f80d280a5`，标注 task `mw-simple-login-20261112` / project `mw-dev` / purpose `development`。只重建 Web 容器，四个后端容器 ID、启动时间与镜像均保持一致。旧 Web 镜像、私有配置和启动器已留档，`mw-dev web` 指向本候选源代码和镜像。

Chromium 实测：

- 系统深色偏好下首次打开仍为浅色；浅/深色切换及刷新恢复均通过。
- 右上角只有一个主题按钮；无粒子 canvas、背景图片、页脚或运行中的 Web animation。
- 1440×900 桌面，以及 375×812、320×568、667×375 手机/横屏均无横向溢出，表单和主题按钮可见。
- 键盘操作主题按钮、密码显隐、空密码验证、真实登录及 `/settings/account` 目标返回通过；零 page error/失败资源。
- 五张图表均显示数值，数据中心 50 行，零脚本/资源错误；浏览器已关闭。
- `/readyz` ready，38 个运行角色健康，三条实时输入 connected+ready。

私有证据：`~/.local/share/market-watch-dev/updates/simple-login-20261112/`，包含构建、镜像身份、容器核对、浏览器报告与桌面/手机截图；不保存凭据或浏览器完整状态。
