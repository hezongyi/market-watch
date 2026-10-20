# T-001 局部分隔符调整：执行与本地自检

- 执行日期：2026-10-20。
- 执行代理：`/root/notification_workflow_manager/t001_implementer`。
- 工作树：`/home/quant/repos/market-watch-t001-notification-separator-20261020`。
- 分支：`feat/t001-notification-separator-20261020`。
- 固定基线：`fb33f3a873d29403c6ae5d7de80eecdd160f80cb`。
- 范围：产品待改清单第 20 项。风险为 P0，仅通知入口相邻的局部外观和样式生命周期。

## 实现

只修改 `web/src/notifications/NativeSystemMessages.tsx`：通知入口创建时，在其原生文档中加入局部样式；控制器销毁时移除该样式。

选择器为 `.separatorWrap-MBOVGQRI:has(+ .group-MBOVGQRI .nc-system-entry) > .separator-MBOVGQRI`。它要求分隔符紧邻包含系统消息入口的原生分组，仅将该包装节点内的线条设为 `visibility: hidden`，保留原生占位宽度、入口尺寸和间距。样式会随 DOM 关系自动匹配，适用于入口异步插入或分组重建，不引入轮询、定时器或 MutationObserver。

静态检查依据为既有 `nativeNotificationSurface` 的 v31.1.0 版本约束、固定版本原生工具栏分组结构，以及来源第 20 项已经记录的 DOM 关系。本轮只读检查许可库，没有修改或提交许可库。

调用链自审：`advanced-host/bridge.js` 在工作区/会话失效时销毁 `noticeUI`，并串行创建通知控制器；`web/src/notifications/native.tsx` 调用消息中心的 `destroy()`；消息中心移除本次新增样式后，继续使用既有 `widget.removeButton(entry)`。创建入口、角标同步、tooltip、键盘/点击事件、面板搜索/筛选、通知协议、时区和已读/交易确认代码均未改动。这是代码自审，不能替代实际挂载销毁或切换工作区验收。

采用 ui-ux-pro-max 技能的局部 UI 检查指导：保留已有键盘焦点、点击目标和原生间距，不扩大界面改造。没有为该局部样式新增镜像实现的单元测试。

## 本地自检结果

环境为 Ubuntu 本机，Node `v22.23.2`、npm `10.9.8`；以下命令均在本工作树运行。`web/node_modules` 是指向既有依赖目录的本工作树忽略链接；没有向被复用依赖目录安装或写入依赖，没有修改锁文件。

| 检查 | 结果 |
| --- | --- |
| `git diff --check` | 通过。 |
| `cd web && ./node_modules/.bin/prettier --check src/notifications/NativeSystemMessages.tsx` | 通过。 |
| `cd web && npm run build` | 通过，退出码 0；包含 `tsc -b`、Vite 和 data-center bundle。Vite 输出大于 500 kB 的 chunk 提示。 |
| `cd web && node scripts/build-alert-ui.mjs` | 通过，退出码 0；覆盖实际导入通知入口的原生 alert-ui bundle。生成物为本工作树忽略文件，未提交。 |
| `cd web && node tests/notifications-runtime.cjs` | 通过；输出 `PASS notification intake isolation, permanent rejection, accepted projection gap and business outcome`。 |
| `cd web && node tests/notifications-persistence.cjs` | 未运行完成；退出码 1，加载阶段报 `Cannot find module 'fake-indexeddb'`。现有复用依赖缺少该开发依赖，未将此项记为通过。 |

## 尚未执行的验收

- 未启动开发实例，未构建或部署 Docker，未访问或变更验收实例及其浏览器现场。
- 未做真实 Playwriter 深/浅色及窄屏截图；未实测目标线消失、其他分隔线保留和相邻按钮间距。
- 未做真实入口点击、Enter/Space、tooltip、角标、搜索/筛选、反复挂载销毁或工作区切换检查。
- 未修改任何数据库、真实通知已读状态或交易确认。
- 未执行远端 PR CI；以上仅是本地代码与构建证据，不代表完整技术验收通过。

真实界面验收由独立验收代理后续执行；当前环境资源不足，保留以上未验收项。
