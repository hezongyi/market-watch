# 系统消息中心：可接入的共享组件预览

状态：等待用户确认预览界面，未接入当前验收应用。分类 **F0 / R1**：新增可选展示适配器与兼容控件扩展；没有 schema、持久格式、后端或生产行为变化。

预览地址（无需密码）：

https://192.168.7.232:18281/issue75-system-messages-live-preview-20261019/

右上角使用已确认的 A 入口；打开后可以搜索、筛选、向下滚动加载、查看详情、标记已处理/已读及切换系统提示设置。左下说明区支持打开面板、切换深浅主题、重置样例和隐藏说明。提供 21 条系统消息样例以试用连续加载；行情与消息均为样例，操作仅在本页内存生效，刷新恢复初始状态。

## 与后续实现保持一致的方式

本预览不是图片、浏览器临时注入或另一套 HTML 面板。真实原生图表加载以下共享源码：

| 职责 | 共享文件 |
| --- | --- |
| 工具栏 A 入口、开关/定位、非模态与焦点生命周期 | `web/src/notifications/NativeSystemMessages.tsx` |
| 列表、搜索、筛选、详情、设置、阅读操作 | 既有 `web/src/notifications/Panel.tsx`，显式 `nativePresentation` 模式 |
| 连续滚动加载、追加去重、已加载部分刷新及过时响应隔离 | `web/src/notifications/useSystemHistory.ts` |
| 原生 Dialog / DialogSearch / NavButton 与已有控件工厂组合 | `advanced-host/native-notification-surface.js`，复用 `native-alert-shell.js` |
| 面板主题、间距、固定宽度角标 | `web/src/notifications/native-system-messages.css` 与共用 SVG |

只有 `web/src/notifications/preview/` 提供样例行情、样例传输及页面说明。后续接入仍调用同一个 `attachNativeSystemMessages({widget,state,request,onLocate,report,onOpenChanged})`，替换注入数据和定位回调；通过 `update(state)` 推送状态，通过 `destroy()` 清理。无需再另写一份界面。共享组件没有导入通知接收运行时或持久化实现。

正式接入时还需把适配器/样式加入实际 host 资源清单，连接既有传输、工作区生命周期和失效回退，移除旧展示入口以保证互斥，并完成真实消息验收。固定原生组件版本仍为 v31.1.0 / `6b804c486857f27920cf761aa7eb6e29d9bb6362`；没有修改许可库。该版本自定义工具栏的键盘放行约定集中在适配器中。

## 界面与交互

- 原生深灰 Dialog 表面；原生搜索、图标按钮、下拉、复选、操作按钮及菜单。消息列表/详情保留应用语义和数据结构。
- 依用户后续反馈移除分页栏，向下滚动自动加载更早记录；提供加载中、加载结束和失败重试状态。数据传输仍使用既有 before 游标，网络分批不表现为分页按钮。
- 滚动条复用图表库当前实际 `scrollContainer` 样式类及其主题变量，为原生 5px 细条；没有复制皮肤或把浏览器默认粗条称为原生。列表、详情、设置和高级筛选均复用该样式。图表库本身也是通过 CSS 设置浏览器滚动条，并非另一个全局浮层控件。
- 原生控件的布局不应被通用样式重置；尤其搜索框容器恢复其 content-box 计算，避免 24px 输入区被挤成 8px。面板以更明确作用域覆盖旧蓝灰变量，避免样式加载顺序改变外观。
- 搜索显式 `autoFocus=false`，打开面板不自动聚焦搜索框。鼠标打开不自动移动焦点；键盘打开在原生首个标题栏按钮实际挂载后进入控件，不用固定延时猜测。搜索仅通过用户点击或 Tab 进入。无背景遮罩，无焦点陷阱，无图表尺寸变化。
- 点击面板外关闭且保留这次图表操作；菜单 Escape 先关菜单，详情/设置 Escape 先返回列表，列表 Escape 关闭并返回入口。
- 新状态刷新保留搜索、滚动和详情；系统未读数为 0 隐藏角标、超过 99 显示 99+，入口固定 52px。
- 当前仅预览系统消息中心；已确认的顶部即时浮窗、交易告警确认与排队调度仍待统一实施。

## 构建、部署与验证

```bash
cd web
node scripts/build-notification-preview.mjs /tmp/issue75-system-messages-live-preview-20261019
docker cp /tmp/issue75-system-messages-live-preview-20261019/. \
  mw-issue75-v2-20261018-chart-1:/usr/share/nginx/html/issue75-system-messages-live-preview-20261019/
```

实际运行主机：Ubuntu `quant-server`（`192.168.7.232`），本任务隔离 project `mw-issue75-v2-20261018` 的 chart 静态服务。没有新服务/数据库，没有重启或替换原验收 bundle。启动原任务栈：`python3 /tmp/mw75-ui-compose.py up -d --no-build postgres api projector web chart gateway`；停止：`python3 /tmp/mw75-ui-compose.py stop`（会停止本任务整个验收栈，不删除卷）。预览文件为临时静态资源，重建 chart 容器后需按上述命令重新拷贝。

本地检查：生产构建、类型检查、通知运行时回归。Playwriter 运行脚本为 `web/tests/system-messages-preview.playwriter.js`，在任务专用隔离 context/page 中运行，不写后端。结果和真实页面截图见 [验证证据](../../verification/system-message-panel-preview-20261019/README.md)。本轮不把样例传输检查当成真实接收/持久化/告警调度验收，也未执行真实输入法候选窗口、多工作区切换与原生适配失效回退检查。
