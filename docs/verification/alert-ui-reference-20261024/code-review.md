# 告警 UI：独立 Standards / Spec 审查

2026-10-24。固定基线 `v1.28.0^{}` = `59ed3a3f3fc727da76d13149934d999ebee04218`，初审候选 `581d4d8d24061272565c99571c6c220b2a5f33ef`。使用 `code-review` 技能（`/home/quant/.agents/skills/code-review/SKILL.md`）要求的两个独立只读审查 Agent；没有操作验收实例、真实许可图表或 PostgreSQL。

初审命令：`git diff v1.28.0...581d4d8d24061272565c99571c6c220b2a5f33ef`。规范来源为根目录 `AGENTS.md`、`CONTEXT.md`；需求来源为 `docs/alert-ui-reference-spec-20261024.md` 与外部交付任务书 `agent-task.md`。下列位置为初审候选中的行号。

## Standards

- 未确认违反 `AGENTS.md` / `CONTEXT.md` 的规范问题。版本固定的原生适配局限于单个模块，符合简单维护原则；不重复报告工具可检查的格式问题。
- **低严重度启发式：可能的 Duplicated Code。** `advanced-host/native-alert-shell.js:433` 与 `web/src/advanced/alertPresentation.tsx:33` 分别实现品种图标，18px 图标的圆形、颜色和路径存在差异；未来视觉修改需要同步两处。这是维护取舍，不是硬性规范违反。本轮不引入跨原生壳和 React 构建边界的图标抽象；真实视觉差异仍需批准后的验收核对。
- **P2 正确性问题：取消子页编辑会关闭自动命名。** `ChartAlertDialog.tsx:597` 输入临时名称即调用 `onAutomaticName(false)`，父面板持久化标记，但取消仅返回条件页。再改阈值时，名称不再跟随。应在“应用到草稿”时提交标记。

本轴初审计数：**0 个规范违反、1 个低严重度启发式、1 个 P2 正确性问题**；最高为自动命名取消语义。

## Spec

1. **P2：遮挡中的日志仍会标记已读。** 规格要求“只在日志实际可见时 viewed”；`ChartAlertsPanel.tsx:317` 只检查交叉比例和 document visibility，详情层、编辑窗与清理确认窗仍保留底层日志。被遮挡期间刷新的新日志可能变为已读。应在覆盖层打开期间停止观察，关闭后重新观察。
2. **P2：取消名称编辑会永久关闭自动命名。** 任务书要求“消息/通知子页应用/取消语义不能回退”和新自动名跟随条件；输入时改变父草稿标记、取消不恢复的代码路径违反该要求。
3. **P2：自定义名称的历史日志 tooltip 缺少冻结条件。** 任务书要求摘要包含“名称/条件”；`alertPresentation.tsx:196` 仅为当前规则显示条件。事件自定义名称不含关系/价位时，摘要无法核对历史条件。应从事件冻结 config 生成摘要，并保留十进制字符串精度。

未发现额外范围扩张。本轴初审计数：**3 个 P2 问题**；最高严重度均为 P2，涉及实际可见读取、子页取消和历史条件摘要。

## 修复与独立复核

三项 P2 均在本记录所在提交修复：

- 观察器受 `open/detail/formOpen/cleanup` 生命周期约束，失效回调退出；覆盖层关闭后重新观察可见日志。键盘切页也与鼠标点击一致地关闭详情。
- 自动命名标记仅在应用不同名称时改变；取消、Escape、返回和只改消息不改变模式。
- 历史摘要调用事件自身的 `eventPresentation(...).summary`，不读取当前规则，不通过 Number 转换常数。

两个原审查 Agent 均对增量进行只读复核，确认原问题已修复，未报告新增具体问题；低严重度 SVG 重复仍为已记录的维护取舍。

## 本地验证

从 `web/` 执行：

```bash
node tests/alert-reference-ui.browser.cjs
node tests/alert-editing.browser.cjs
npm run build
node scripts/build-alert-ui.mjs /tmp/mw-alert-ui-20261024-code-bundle
```

全部通过；既有编辑回归为 9 组。扩展组件回归覆盖详情、清理窗、编辑器三类遮挡，先断言目标行在底层列表的几何交叉比例至少 50%，等待两个动画帧后验证没有 viewed，关闭覆盖层后验证可见日志正常 viewed；另外覆盖名称取消/Escape/仅改消息/应用自定义名，以及自定义历史名称下的 18 位小数条件。使用真实 DOM 与组件 CSS、受控接口，不连接验收实例或真实市场服务。Vite 仅有既有 chunk 体积提示。`git diff --check` 通过。

修复后的文件身份：

| 文件 | SHA256 |
| --- | --- |
| `web/src/advanced/ChartAlertDialog.tsx` | `7522097c87029a70db3007e4775a6015cc2c22bd3723a57502dfaa57a72a937a` |
| `web/src/advanced/ChartAlertsPanel.tsx` | `dfc460706731b5f6a959977aa33706088d12d94336d2ec78019cc5edeecf0834` |
| `web/src/advanced/alertPresentation.tsx` | `79a53dfcb032b5f6da2f095c927dafc6099e24e832472c7c7c5a626dee803d60` |
| `web/tests/alert-reference-ui.browser.cjs` | `8a3a6bd156a8d6ff1cd9ba4ba1bd284d7ea1443f363182794ad98fa25ebe809e` |

真实六态视觉、许可图表坐标矩阵、独立 PostgreSQL 与 `$mw-acceptance` R1 仍未执行，继续遵守用户“验收前向我申请”的检查点。完整 CI 等效检查也未宣称完成。
