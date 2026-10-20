# 登录页 Particles 组件预览验收

本轮交付外观确认预览，正式登录页尚未替换。预览无密码，也不会发送认证请求。

## 环境与访问

- 实际运行主机：Ubuntu `quant-server`，`192.168.7.232`，本机 Docker。
- Worktree：`/home/quant/repos/market-watch-login-particles-20261019`。
- Compose project/task：`mw-login-particles-20261019`，独立网络与端口，无数据库或共享可写业务数据。
- [预览入口](http://192.168.7.232:18320/login-preview.html)：深色、浅色、390px 窄屏切换，及全屏打开。
- [深色全屏](http://192.168.7.232:18320/login-particles.html?theme=dark) / [浅色全屏](http://192.168.7.232:18320/login-particles.html?theme=light)。
- [短录屏](http://192.168.7.232:18320/evidence/particles-demo.mp4)，18.6 秒，包含无人操作、输入密码、暂停、恢复与浅色主题。
- [MIT 声明](http://192.168.7.232:18320/MAGIC_UI_LICENSE.md)。
- 前端服务内存上限 64MiB / CPU 0.25；浏览器工具另起本任务容器，未改动其他验收服务。启动前检查端口无冲突、可用内存约 9GiB、磁盘约 27GiB。

启动、查看及停止（保留代码和全部证据）：

```bash
cd /home/quant/repos/market-watch-login-particles-20261019
docker compose -p mw-login-particles-20261019 -f compose.login-particles-preview.yaml up -d --no-build
docker compose -p mw-login-particles-20261019 -f compose.login-particles-preview.yaml ps
docker compose -p mw-login-particles-20261019 -f compose.login-particles-preview.yaml stop
```

构建仅使用任务归属明确的 Ubuntu BuildKit 入口：

```bash
mw-docker build --repo . --component web --file web/Dockerfile.login-preview \
  --tag market-watch-web:login-particles-preview-20261019 \
  --task mw-login-particles-20261019 --project mw-login-particles-20261019 \
  --purpose acceptance
```

## 已验证

| 项目 | 结果与证据 |
| --- | --- |
| 类型与构建 | `npm run build:login-preview`、`npm run build`、`git diff --check` 通过。正式构建只有现有的大 chunk 提示。 |
| 深浅主题、窄屏 | Playwriter 实拍见下方；同一个最终组件及现有登录 CSS。 |
| 无操作时运动 | 1.6 秒观测中持续绘制，粒子坐标改变。 |
| 输入与光标 | 聚焦密码框后仍持续绘制，焦点保持输入框，选择位置不跳；显示密码切换保留位置。 |
| 暂停及记忆 | 暂停期间 0 次绘制，刷新仍暂停，再开启恢复。 |
| 减少动态效果 | 0 次持续绘制，静态粒子可见，控制按钮不能覆盖系统偏好。 |
| 实际后台标签页 | 使用独立有界面 Chromium/Xvfb，关闭自动化焦点模拟后切换真实标签页；后台 1.8 秒绘制增量 0，回前台恢复。 |
| 尺寸与密度 | 320×568、390×844、760×600、1440×900、2560×1440、3840×2160；无横向溢出，粒子分布覆盖窗口。大窗口未超过 96 个粒子、300 万 backing pixels。 |
| 高 DPI | 模拟设备 DPR=3 时实际 Canvas DPR=1.5，1400×900 窗口 backing pixels=2,835,000。 |
| 操作隔离 | Canvas `pointer-events:none`、`aria-hidden`，不成为可聚焦控件；预览提交无 `/api` 请求，明确提示仅预览。 |
| 预览入口 | 深浅色和窄屏按钮、嵌入页面与全屏地址正常；根地址跳转保持 18320 端口；录屏可通过 HTTP 下载。 |

浏览器无未捕获异常。浏览器有现有密码表单缺少用户名的 verbose 建议，本轮不改变单密码认证模型。

## 素材及原始证据

- [深色桌面](dark-desktop.png)、[浅色桌面](light-desktop.png)、[深色窄屏](dark-narrow.png)、[浅色窄屏](light-narrow.png)、[预览入口](preview-hub.png)。
- [录屏 MP4](particles-demo.mp4)、[录屏元数据](video.json)。录屏帧通过 Playwriter `getCDPSession` 调用 Chromium screencast 获取，按原始时间戳编码，不加速；不是静态图拼接的演示动画。
- [运动、焦点、暂停、尺寸结果](browser-contracts.json)、[后台切换](background-contract.json)、[DPR 与预览边界](preview-boundary.json)、[入口检查](hub-contract.json)。
- `playwriter-*.js` 保留初始化、观测和录屏脚本；`environment.json` 记录实际运行镜像及隔离服务。截图 `scale:css`。

正式认证、错误密码、CSRF、登录后跳转尚未执行本次组件集成验收：按用户要求，确认预览后才接入正式登录入口，再以真实后端验收。这一限制不影响本轮外观及动效确认。

## 自审

- Magic UI 上游提交与完整 MIT 声明已保存，无新增 UI 依赖；预览镜像公开提供声明。
- 动画每帧只操作 Canvas 和局部对象，不调用 React 状态更新；指针监听不产生组件重渲染。
- 单一调度链；暂停、后台和卸载均取消 timer/rAF；ResizeObserver 与监听器卸载清理。
- 预览和未来正式接入使用同一个 `ParticlesLogin`。旧正式 Login 与认证调用保持原样，确认后再移除旧取模实现。
- 无生产修改、无合并，无其他任务实例或永久数据删除。
