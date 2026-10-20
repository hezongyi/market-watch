# Issue #75 独立 Standards 复核

时间：2026-10-18 15:59 UTC。任务分类：F1 / R2 / D1。本报告是 Standards 轴独立审查，不代替 Spec 审查或验收签收。

## 范围与基线

- 工作树：`/home/quant/repos/market-watch-issue75-implementation-20261018`。
- 基线：`v1.26.1`，`2fe919a23d4adcb97ca1a98caafbad8693a410d3`；覆盖实现检查点 `67d24ace0a7c1794524bfb77eebfb6dc3bb49372` 及后续修复，最新 CSS 增量为 `df6460cb978413ca003ad87c6f16d14bd2ddbe1a`。
- 规范来源：仓库 `AGENTS.md`；代码异味仅作启发式判断，与硬性规范违规分开。
- 重点：通知 Runtime/Store、provider/market 回调、真实 data-center API wrapper 与注入式对话框、native history 来源/范围身份、后台可靠来源与接收顺序。
- 当前产品差异快照（17:20 UTC CSS 增量后）：输入路径为 `advanced-host`、`backend/alerts`、`web/src`；对 `git diff 2fe919a23d4adcb97ca1a98caafbad8693a410d3 -- advanced-host backend/alerts web/src` 的输出计算 SHA-256，结果为 `a1320eb720a36ebc35e6f86a70165561c9977c8770bb40f9c0ed37ba0c534819`。文档和测试文件不在该指纹输入中。

## 实际验证

以下由本审查者执行，退出码均为 0：

- `web` 下运行 `node tests/notifications-runtime.cjs`、`node tests/advanced-provider-subscriptions.cjs`、`node tests/advanced-market-stream.cjs`，均到达最终 PASS；`npx tsc --noEmit` 通过。
- 编译实际 `NoticeStore`，使用 fake-indexeddb 6.2.4 执行六项探针：TTL、完成观察保留期、拒绝证据保留、事务中止原子性、同毫秒 A/恢复/B 顺序、独立连接并发顺序，全部通过。
- 四项预算探针通过：16 KiB 事件、12 KiB context、1000 条 pending、10 MiB pending、claims/observations/meta 数量及各自 2 MiB 限制；拒绝后已有记录保留。
- 真实 Runtime 临时探针通过：挂起首个 stage，排队旧 report/resolve 后切换 generation/subject；旧排队项丢弃，新会话继续。

Store 探针及结果位于 `/tmp/mw75-standards-idb-20261018/`；未编辑产品代码。

## 结论

**未发现剩余 P1/P2；未发现所审查差异违反 AGENTS.md 的硬性要求。** 未将启发式代码异味提升为阻断项。

确认 `faultIngress` 在执行前检查 generation；故障与恢复按入队顺序落盘。有效 owner、订阅 generation、workspace/session/epoch 约束旧回调。数据中心实际写请求经过通知 wrapper，取消与业务成功结果隔离。Native 恢复键包含请求范围；图格定位验证身份。IDB 顺序字段独立于 TTL，上传不越过瞬态失败；服务端按持久接收序投影。Composite 保留显式 connection_error，恢复要求健康且有效的当前来源。

## 局限

fake-indexeddb 证明逻辑与事务合同，不能替代真实浏览器的配额、崩溃和磁盘故障验证。本轮未独立重跑 PostgreSQL 迁移、Docker R2/D1、Playwriter、音频或性能验收；不将父任务尚未完成部分记为通过。结论仅适用于上述源码快照，不代表整体验收完成。

## 16:54 UTC 增量复核

只读审查 `git diff da5a2eb -- web/src/notifications/runtime.ts web/src/notifications/native.tsx web/src/notifications/notifications.css`：未发现新的 P1/P2 或具体阻断问题。

确认 epoch reset 使用瞬态 status，保留已有真实 gap，并重置 health 刷新时机；筛选控件使用 border-box、min-width/max-width 与可收缩 grid 列，约束局限于通知筛选区；入口查找同时核查布局矩形、computed visibility 及 aria-hidden/inert 祖先，排除隐藏测量副本。

本审查者重新执行 `node tests/notifications-runtime.cjs`，包含新增 reset 后恢复且保留真实 gap 的回归，最终 PASS、退出码 0。三个产品文件的 `git diff --check` 通过。本增量未独立运行 TypeScript、重建或 Playwriter；焦点回归、气泡锚点与 vendor 样式实际效果仍由最终镜像的浏览器复验确认，不提前记为通过。未修改产品代码、未提交。

## 17:20 UTC CSS 增量复核

限定审查 `git diff df6460c^ df6460c -- web/src/notifications/notifications.css`：未发现新的 P1/P2 或阻断问题。Severity 文本改用通知面板主题变量；暗色值保持原值，浅色 danger/warning 分别为 `#b42318`、`#82580e`。按相对亮度公式计算，在已定义浅色背景 `#fff`、`#f4f5f7` 上的对比分别为 6.57/6.03、6.27/5.74，均超过普通文本 4.5:1。

该 CSS 提交的 `git diff --check` 通过。本次未新增全量测试、构建或浏览器验收；未将旧提交 CI 状态当作新提交验证。仅更新审查文档，未修改产品、未提交。
