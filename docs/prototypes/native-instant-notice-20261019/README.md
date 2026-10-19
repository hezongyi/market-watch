# THROWAWAY — 即时通知原生组件预览

用户要求将蓝灰即时卡片改为原生 `showNoticeDialog` 实拍的深灰外观，使用原生组件和 SVG 图标，先交付预览确认。沿用已选方案 A，只提供一个设计，展示系统消息和交易告警两种内容，不再增加不同布局选项。

预览地址（Ubuntu 本机隔离验收实例）：
https://192.168.7.232:18281/issue75-native-instant-preview-20261019/

`preview.js` 仅注入独立 Playwriter 浏览器上下文中的现有专业图表页面。使用真实图表库 v31.1.0 内部原生 `Dialog` 外壳、`NavButton` 关闭按钮、`Button` 白色按钮及 SimpleDialog 的原生 CSS；图标在 `system.svg` 和 `trade.svg`。没有替换通知运行时、未连接业务动作，也没有修改供应商文件。

原生 `SimpleDialog`/公开 `showNoticeDialog` 强制自动聚焦，其底层 `PopupDialog` 的默认 Portal 还会约束焦点。因此不直接用于被动即时提醒。此预览直接挂载同库的底层 `Dialog`，无 Portal 焦点约束、无背景遮罩，作为一个共用的非模态原生外壳。该接口属于已固定版本的内部接口，并非公开可导入的组件 API。

Playwriter 结果见 `browser-proof.json`：挂载时焦点保持、画布尺寸保持、顶部工具栏间距 8px、屏幕水平居中、深灰底 `rgb(31,31,31)`、白色按钮、图表和自选表外部命中保持。另检查了浅色主题与 850px 宽度下避让自选表。没有页面脚本错误。

预览为便于截图保持显示；用户确认后，实际实现仍需保留现有队列、8 秒自动消失、悬停/聚焦暂停、系统消息与交易告警的不同记录入口，以及版本适配失效回退。当前没有实施这些新外观变更。

再次运行（已登录 task-owned 图表页、Playwriter session 2 中存在 `state.npf` 与 `noticePreviewVendor` 时）：

```bash
node /tmp/mw75-playwriter-runtime/node_modules/playwriter/bin.js -s 2 -e 'await state.npf.evaluate(require("node:fs").readFileSync("/home/quant/repos/market-watch-issue75-native-notice-preview-20261019/docs/prototypes/native-instant-notice-20261019/preview.js","utf8"));'
```

关联：Issue #75、Draft PR #87。本分支仅保留预览原始材料，不合入实现分支。
