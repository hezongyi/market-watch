# 工具栏入口与模板顺序补验

用户在人工验收时反馈系统消息入口没有相邻图标的悬停反馈、左侧间距偏大；随后要求将指标模板放在指标之后，并启用验收实例 Yahoo 源。

风险 F0：原生 UI 适配及现有配置开关，无 schema 或持久格式变更。最小检查为原生组件本地验证、Web 与原生 bundle 构建、Ubuntu R1 页面复验及 PR CI。**当前仅本地检查完成，未部署、未完成本轮浏览器复验或最新 CI。**

## 已确认的原因与修改

此前 Playwriter 在实际验收页读取的系统消息入口是 `createButton({useTradingViewStyle:false})` 创建的 div，未挂载原生工具栏按钮。CSS 将其固定为52px；相邻原生按钮宽38px，入口前的分隔容器仍占9px。实测两个图标中心距离54px，相邻普通图标为38px。原有适配器仅允许键盘导航，入口无原生交互类或 hover 规则。该次自动化浏览器的 hover 媒体查询为false，不能把它的悬停截图作为桌面鼠标绘制效果的完整验证。

现在在公共 API 的占位容器中挂载固定版本图表库导出的 `ToolbarIconButton`（模块51061）。实际渲染为原生 button，具有 `button-GwQQdU8S` 和 `isInteractive-GwQQdU8S`；悬停颜色及背景由原生 CSS 提供。容器改为38px并去掉自身padding，入口前的整个分隔容器隐藏。角标保留，文字同步更新原生tooltip。业务点击与键盘处理沿用现有控制器。

指标模板保留原生实例和菜单，使用工具栏组的flex order放到现有指标入口之后；同步处理测量工具栏与重建，释放时恢复原有order和分隔样式。没有移动React持有的DOM节点。

## 本地验证

- `npm run build`、最终 `tsc -b`、`node scripts/build-alert-ui.mjs /tmp/mw-toolbar-alert-ui-20261020` 通过。首次原生bundle命令从仓库根目录运行，因相对入口路径失败；从web目录重跑通过。
- 原生模块渲染、点击单次触发、释放、模板在普通/测量/重建工具栏的顺序及释放恢复均通过，见[结果](local-native-result.json)。该检查使用JSDOM和本机许可库的真实组件；不证明浏览器布局、hover绘制或实例已更新。
- `node tests/native-chunk-recovery.cjs`、`node tests/native-preference-notice.cjs`（web目录）通过；`git diff --check`通过。

复现本地模块检查：

```bash
MW_JSDOM_PATH=/tmp/mw-jsdom/node_modules/jsdom node docs/verification/toolbar-followup-20261020/local-native-check.cjs
```

## Yahoo与未完成项

只读检查实例现有私有 `integrated-compose.json`：API、全部worker、projector及migrate的 `ALERTS_YAHOO_ENABLED` 已为字符串 `true`，代理配置存在。此前候选override没有覆盖该开关。没有输出代理内容或其他私有配置。当前未读取运行容器设置，也未验证Yahoo行情请求，因此不将文件配置等同于实时运行状态。

2026-10-20接续后的执行沙箱拒绝Docker socket连接（operation not permitted），Playwriter relay无法启动，本地Chrome启动失败，GitHub API也无法连接。此前最终归档CI `39417146466` 的最新结果未能读取。没有修改验收实例、私有配置或保护浏览器。

后续需恢复可访问Ubuntu Docker/Playwriter的执行环境：使用mw-docker构建本候选的Chart/Web，按原实例配置只更新必要应用服务，核对全部运行后端的Yahoo实际开关并完成真实读取。再用自己的页面检查浅/深色hover、38px间距、角标0/1/99+、Enter/Space/Escape、模板图标顺序与原生菜单、窄屏和刷新。通过后记录新镜像ID、部署与浏览器证据，并核对PR CI。此前批次验收证据保留，本补丁尚未交付。
