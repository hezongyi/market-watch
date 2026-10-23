# MWA 批次集成与审查（2026-10-22）

初审对象为交付提交 `c4086d1`；本页保留修复前结论和复现，最终状态见同目录 `closeout.md`。

初审结论：本地集成完成；发现 Standards 轴 1 项 P1、Spec 轴 1 项 P2，以及 CI lint 失败，当前不建议合并到 main。

## 集成身份与范围

- 开发 worktree：`/home/quant/repos/market-watch-composite-mapping-20261021`
- 开发 branch：`feat/composite-mapping-native-20261021`
- 已核实交付：`c4086d1f4c01c28afb519cc45e58f5c87b7e9d62`，工作区干净。
- 集成 worktree：`/home/quant/repos/market-watch-integration-20261022`
- 集成 branch：`integration/mwa-20261022`
- 按工作流交接从 `a0785ac` 建立，再 `merge --ff-only c4086d1`，无冲突。
- 审查命令：`git diff a0785ac...c4086d1`，7 个新增提交，34 个文件。
- 合入后的源树与开发交付相同，tree 为 `17647fba61e21f5bc2c3f01dcb55a5a7d06de119`；本报告及复现文件是随后新增的文档证据。
- 相对 main / v1.26.5（`6f74951`）累计 10 个开发提交，保留首轮 PR #93 实现。

本轮核查两步配置、原生控件与图标对齐、映射备注持久化、涨跌计算及浏览器标题。整个批次按 **F1**：新增 `ax51_mapping_notes` schema 与映射身份/说明分离；quote 子项自己的 F0 记录不能替代整批 F1 验证。

需求依据：[两步配置与图标方案](../../mwa-composite-live-source-redesign-analysis-20261021.md)、[待办](../../mwa-ui-pending-20261021.md)，以及 [quote/tab 交付说明](../quote-tab-20261022/README.md)。规范依据为根 `AGENTS.md`、`CONTEXT.md`。按 code-review 技能由两个独立审查者检查 Standards/Spec，再由集成方复现确定性发现。

## Standards

**P1：缺少日末数据时，早盘末价被当成昨收。**

位置：`backend/alerts/quote_presentation.py:64`、`backend/alerts/composite_quotes.py:194`。

新谓词仅要求 `time_closed && source_confirmed`。真实 `history_artifacts._finish` 中，这分别表示桶时间已结束、已有分钟均已确认，不能证明日终价格存在。整天只采到第一分钟时，两者仍为 true。

复现使用真实 `_finish` 生成 NY17 日桶：只有首分钟 `1.10`，`observed_minutes=1/1440`，日末观测缺失，coverage/complete 均 false。两个昨收读取器仍接受 `1.10`；次日价格 `1.12` 被计算出涨幅 `1.81818%`。这是行情正确性缺陷；`CONTEXT.md` 明确区分来源确认、完成柱与覆盖证据，单次已有观测不证明后续区间完整。

建议：区分内部缺口和缺失日终观测，核实有效日终报价或供应商原生 D1 收盘证据。无法核实时省略涨跌。补充“内部缺口但收盘有效”和“日末缺失”两组相反预期的回归，避免把所有稀疏日线统一判为有效或无效。

证据：[脚本](previous-close-repro.py)、[实际输出](previous-close-result.json)。未发现其他确定的规范违规或值得报告的代码异味。

## Spec

**P2：日历版本更新后，旧映射被误判为当前有效，进入可创建状态却无法保存。**

位置：`backend/alerts/composite_center.py:40`；保存侧 `backend/alerts/composite_definitions.py:157`；UI 侧 `web/src/market-data/MappingForm.tsx:35`、`:133`。

触发：保存一条有效映射，再更新 `settings.oanda_calendar_version`。查询仍返回 `valid_for_selection=true`，mapping-check 仍为 ready，唯一映射自动预选；保存时却按新完整 identity 查兼容映射，必然拒绝 UI 传入的旧 `reuse_mapping_id`。同品种选择直接返回，不能原地清除旧绑定。

对应方案第 5 节“已有明确有效映射可复用”及第 8 节服务端核验来源身份；`CONTEXT.md` 的数据集身份包含日历版本。查询有效性和保存兼容性应使用一致的完整身份规则，并保留旧映射及运行组合。

证据：[内存数据库脚本](mapping-identity-repro.py)、[实际输出](mapping-identity-result.json)。此问题与上述 P1 独立。

## 集成方验证

在本集成 worktree 执行：

- 后端 7 模块：`test_composite_matching`、`test_composite_definitions`、`test_composite_api`、`test_composite_quotes`、`test_quote_session_contract`、`test_market_stream_worker`、`test_alerts_mcp_migration`：**78 passed**，含 SQLite upgrade/repeat 路径。
- `cd web && npm run build`：通过；仅既有 bundle 大小提示。
- Node：`composite-mapping.cjs`、`chart-tab-title.cjs`、`chart-tab.cjs`、`multi-chart-resolve-init.cjs`、`resolve-recovery.cjs`：全部通过。
- `git diff --check a0785ac...c4086d1`：通过。
- 两项缺陷均以无网络、无真实数据库写入的复现确认。通过的现有测试没有排除这两个场景。

与 CI 相同的 changed-backend Ruff 检查失败：4 项 `I001`，分别位于 `composite_api.py:3`、`composite_definitions.py:146`、`test_composite_api.py:3`、`test_composite_matching.py:3`。其中第一、三项在审查基线已存在，但这两个文件本批被修改，CI 仍会检查并失败。此处单列工具发现，不计入 Standards 人工发现数。

本轮没有重新运行 PostgreSQL 迁移/旧应用兼容、隔离浏览器端到端或 GitHub CI。新 title 回归已在本地执行，尚未接入现有 CI 命令列表。

开发分支本地既有报告记录隔离 R1、mwa 两步配置、图标对齐、五图恢复通过，集成方已读取；这些属于开发方此前结果，不能表述成本轮重新验收。第二轮部分结果仅在开发 worktree 的忽略目录 `artifacts/composite-mapping-v2/` 与 `web/artifacts/`，建议最终收口前将脱敏摘要/报告纳入版本化证据。

## 建议下一批

1. 在开发分支或集成分支修正 P1、P2，并补有效的边界回归；确定单一修改入口后再交付准确 SHA。
2. 一并整理 4 处 Ruff 导入，接入 title 回归，补 F1 PostgreSQL upgrade/repeat、旧映射/组合 ID 和备注兼容、旧应用回退保留新表的验证证据。
3. 集成最终 SHA，按变更运行定向检查；需要更新 mwa 时沿用现有交接与回退方式，由同一更新者部署并做最终人工/浏览器回归。
4. 按用户控制的批次节奏统一更新现有 Draft PR #93 并触发一轮 CI。不要为这些小修分别开 PR。
5. review、CI 和适用验收齐全后再报告合并候选；main 合并、正式 tag 和生产发布另按用户本次授权执行。

本次仅本地集成及审查留档，未推送分支、更新 PR、触发远端 CI、变更 mwa、合并 main 或创建 tag。原开发分支及其工作区保持不变。

总计：Standards 1 项（最严重 P1），Spec 1 项（最严重 P2）；另有 4 处 lint 错误和 F1 验证待补。
