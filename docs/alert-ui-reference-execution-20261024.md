# 告警参考 UI：代码实施记录

状态：**代码已实施，本地定向检查通过；待用户批准验收**。用户最新指令为“先实现代码，验收前向我申请”。本轮不创建 PR，不 push，不更新 `$mw-acceptance`，不发布生产。

## 基线与交付

- 独立 worktree：`/home/quant/repos/market-watch-alert-ui-20261024`。
- 分支：`feat/alert-ui-reference-20261024`。
- 基线：tag `v1.28.0`，解引用产品提交 `59ed3a3f3fc727da76d13149934d999ebee04218`。
- 参考图规格：[alert-ui-reference-spec-20261024.md](alert-ui-reference-spec-20261024.md)。
- 原始取证对照、差异分析、执行方案：`/home/quant/repos/.reports/market-watch/20261024-alert-panel-ui/` 中的 `comparison.png`、`analysis.md`、`agent-task.md`。现有 comparison 是取证时的生产与用户截图对照，尚不是实现后视觉验收。
- 没有改其他任务 worktree。没有复制其他任务尚未提交的修复；当前候选仍基于指定 v1.28.0。

## 实施内容

1. 列表恢复分段页签、独立交易日志徽标、固定双行、SVG品种图标和紧邻的真实状态。去除可见计数行。单击选中/定位，双击或设置编辑；健康、次数、身份与证据通过详情覆盖层保留。
2. 摘要挂在 anchor 所在 document 的 body；支持 hover/focus、300ms延迟、视口夹取、Escape/scroll/resize清理。自定义名与陈旧/阻断等真实健康状态保留。
3. 编辑窗短标题与品种图标、紧凑条件栈、概要行、短底栏。ATR移入高级区，已启用时显式提示；原十进制字符串、409重读、版本/控制修订、取消保留草稿和通知子页语义保留。新默认名可跟随条件，旧/自定义草稿不自动重命名。
4. 后端兼容新增display_identity、批量last_triggered_at和notice关联；历史显示只读冻结身份/配置。新事件额外冻结创建时间，旧事件不伪造缺失时间。list/changes提供独立alert_unread，系统旧计数语义不变。
5. 日志实际可见才viewed，整理捕获点击时最多100条集合，并发4；同步等待服务器确认viewed/handled，失败保留并显示原因。默认收起handled，“显示已清理日志”可找回。清理不调用ack，不改SignalRow、规则、Outbox或手机确认。
6. 增加版本固定的原生价格线展示适配。原生primitive绘制虚线/价格轴；真实主系列价格尺度负责DOM标签/垃圾桶/圆点坐标。使用坐标/数据/缩放事件与ResizeObserver按帧合并；无新16ms定时器、broker调用、vendor修改或持久画线。未知ATR阈值/指标单位/错图不画；归档携带version/control_revision/request_id，失败保留。异步generation、只读和销毁有围栏。
7. 修复新交互会用到的既有单规则GET白名单缺口；价格线归档父RPC仅接受当前工作区、原关联与简单价格常数规则。

风险分类 **F1**：兼容API/UI和既有通知整理状态，没有新增schema或改变判定算法。`chart_alert_service.py`只增加新事件的不可变创建时间证据字段。

## 已执行的本地检查

后端复用现有解释器，显式 `PYTHONPATH=backend`，确保加载**本worktree**源码：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_chart_alert_api.py backend/tests/test_chart_alert_service.py \
  backend/tests/test_chart_alert_notifications.py backend/tests/test_notification_center.py
```

结果 **50 passed、1 skipped**。跳过项要求隔离PostgreSQL，未将SQLite结果冒充真实PG。新增HTTP/数据库测试使用真实告警producer与投影，验证可选字段、历史配置不被后来编辑重写、last_triggered_at真实值、notice读取/整理、系统未读独立，以及Outbox/Notification/SignalRow不被清理改变。

从 `web/` 运行并通过：

```bash
node --test tests/chart-alerts-bridge.test.cjs
node tests/chart-alert-ui-rpc.test.cjs
node tests/alert-editing.browser.cjs
node tests/notifications-runtime.cjs
node tests/notifications-persistence.cjs
node tests/alert-reference-ui.browser.cjs
node tests/native-alert-price-lines.browser.cjs
npm run build
node scripts/build-alert-ui.mjs /tmp/mw-alert-ui-20261024-code-bundle
```

桥接8项、RPC3项、编辑浏览器9组，以及通知运行时/持久化通过。新组件回归加载真实CSS，检查选中不展开、tooltip、独立徽标、18位小数、仅可见日志已读、新到日志不在清理集合、失败保留/重试和找回。新价格线测试是带真实DOM的**受控契约测试**，检查原生坐标使用、版本/异步围栏、失败保留、单位/ATR过滤和订阅释放；不宣称真实许可图表验收。

TypeScript、Vite与共享告警UI bundle构建通过。Vite存在既有大chunk提示，无构建错误。Ruff对受影响后端文件通过；`node --check`检查原生适配语法，`git diff --check`通过。新增两个本机浏览器回归已纳入CI配置；没有远程CI或PR记录。

## 自审与仍需验收的事项

自审检查了：冻结身份、兼容可选字段、ack隔离、失败反馈不被后续刷新清掉、归档白名单、组件卸载、异步旧返回、只读控制及清理集合边界。没有将本轮自审称为独立Standards/Spec review。

后续已补齐独立 Standards / Spec 初审、修复和增量复核，见 [审查记录](verification/alert-ui-reference-20261024/code-review.md)。修复三项 P2：覆盖层后面的新日志不再被观察为已读；取消名称子页不再关闭自动命名；历史自定义名称摘要补充冻结条件及原始精度。扩展组件回归、原有9组编辑回归、前端构建和共享UI bundle再次通过。原生壳/React品种图标的重复实现保留为低严重度维护取舍，没有硬性规范违反。

以下仍待用户批准后执行，均未通过或未执行：

- 原生六态同内容/尺寸/DPR/时区的截图、并排、叠图和像素差异；深浅主题/200%文字/375px与多视口。
- 实际v31.1.0许可图表的价格坐标、滚动/缩放、倒置/对数/百分比轴、多图、切换与销毁，以及原生壳标题/徽标/键盘交互。
- 独立PG上的整理持久性、旧字段兼容与完整行内容不变检查。
- `$mw-acceptance`实时盘点、候选制品构建、必要服务更新与真实页面R1。当前实例可能含其他任务的未合入修复；批准后先比对和协调，不用本基线候选盲目覆盖。
- 完整本地CI等效检查；独立代码review已完成，不替代尚未获批的真实验收。

“添加条件”仍明确单条件限制，通知仍为真实网页/ntfy；无最小tick契约时不提供不精确Number步进。未证明像素等价、长期稳定或所有功能等价。长期实例及其真实数据/配置/浏览器保持，验收操作待用户批准。
