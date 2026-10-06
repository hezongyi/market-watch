# 同步设置方案审核与修订记录

> 本页为 v1.8.0 迁移前的历史实现/验收记录；焦点来源等旧合同已由用户修订。当前分支的代码、Ubuntu 实例与复验结论见 [v1.8.0 迁移验收](chart-range-v1.8.0-acceptance.md)。

2026-10-04。审核模型 **`gpt-6.1-sol`**，推理强度 **`max`**；agent 为 `/root/sync_settings_plan_review`。首轮审核基线 `b892850`，实现基线 `e40315f`，分支 `feat/chart-bar-range-mapping`。

按用户要求审核 [同步设置方案](chart-sync-settings-plan.md)，核对现有源码和 [Ubuntu 探针记录](verification/chart-bar-range-mapping/sync-settings/feasibility.json)。agent 只读审查；主 agent 修订文档。本轮不修改产品功能、镜像或部署，不覆盖当前 Ubuntu 验收会话。

## 首轮结论及修订

审核确认方案覆盖用户要求：范围映射改名、原生一致开关、布局末尾“同步设置…”、仅焦点用户操作触发柱宽同步、日期互斥，以及不接触 K 线的高低价显示。以下是首轮发现的归档摘要；优先级保留审核结论。

| 优先级 | 审核发现与证据 | 修订位置及处理 |
| --- | --- | --- |
| P1 | 暂停所有权不完整。除 guard、capture 外，`viewports.js` 的 `edgeRangeSync`、restore/deferLegacy 及 bridge 初始化也直接关闭/恢复；嵌套和旧 workspace finally 可覆盖最新期望。原生 date/time handler 使用 `undoHistory.setWatchedValue`，保存服务据此 dirty，internal 标志不能消除此副作用。 | 第 4 节列完整迁移表，以唯一逻辑 mode 和独立 time 期望管理状态；暂停 token 带代次、幂等释放、嵌套最后释放按最新期望恢复。阶段 A 必须实测无 Undo/dirty 的有效态写入口，禁止清空 Undo 或借全局 loading 标志掩盖。 |
| P1 | 异步缩放归因不闭合。公开 `barSpacingChanged` 只有新值，程序修改同样触发；原生快捷键动画约 250ms，输入时间窗口无法识别旧动画和新操作交错。 | 第 3 节明确 begin/step/end/cancel/applyPeer 合同及实例、workspace/layout/focus 代次；阶段 A 选定有完整因果证据的公开路径或 SHA 校验最小动作 adapter，先证明再传播。 |
| P1 | 标签交付路径未证明。探针只有 pane 矩形、内部轴方法与 formatter，没有安全轴占位、碰撞或外部空间证据；一行/两行随 hover 切换可能触发 resize。 | 第 5 节将真实 slot 外部保留行作为必要回退；固定最大高度、配置驱动预留/释放，hover 不重排。轴标签未满足安全准入时首版只用信息条；外部空间本身也需阶段 A 实测。 |
| P2 | fallback 没有完整继承目标可见性合同，可能在来源图、M1 无目标或时间完全屏外显示过期价格。 | 第 5 节统一填充/标签投影，要求合格目标和真实横向交集；仅价格纵向屏外可回退。leave/menu/开关/load/reset 清空，迟到任务不复活。 |
| P2 | `setBarSpacing` 会 `correctOffset`，边缘合法 offset 也随 spacing 改变；原定位承诺过强。交错状态、保存失败和性能通过标准不足。 | 第 3、8 节明确原生边界优先，记录最左/最右的 spacing、offset、右侧时间；补动画中程序修改、错序/重复 release、旧 workspace、保存 A/B 交错及失败重试，联合检查逻辑期望、native 状态、Undo/Save/dirty，增加明确性能预算。 |
| P3 | 新标签需求覆盖旧 spec“不增加价格轴标签和统计文字”的建议；默认值和 Undo/Redo 探索不应扩张首版硬要求。 | 开头显式覆盖旧建议；默认色及标签默认开启仍标为建议；第 3 节把 Undo/Redo 传播列为后续可选探索。 |

证据入口：

- [viewports.js](../advanced-host/viewports.js)：capture、restore、legacy 同步及 edgeRangeSync 的直接 set/restore。
- [range-sync.js](../advanced-host/range-sync.js)、[bridge.js](../advanced-host/bridge.js)：加载暂停、期望状态及工作区生命周期。
- 原生 `library.e2f8b3a016c9e1a0b7a5.js` 第 756 行 date/time handler、第 223 行 Undo/保存监听、第 617–618 行柱宽与 offset 限制；许可资源不随文档复制。
- [bar-range-mapping.js](../advanced-host/bar-range-mapping.js)：既有有效目标过滤与真实水平交集。
- [feasibility.json](verification/chart-bar-range-mapping/sync-settings/feasibility.json)：输入和事件探针、尚未证明的标签几何。

## 复审

同一 `gpt-6.1-sol / max` agent 完成只读复审，结论：**首轮 P1/P2/P3 均已在方案层闭合，可作为审核后的条件式方案交付；技术可行性尚未证明。** 没有新增必须在本轮进行产品验证的结论。

复审另给出两处 P3 文字收紧及一处可选调度澄清，均已采纳：

- “无有效 bar”明确为来源没有有效 K 线；目标未来空白继续遵守原日历槽投影与可见交集合同，不误删既有未来映射。
- 生命周期清除的是标签内容和待更新任务；稳定占位容器由配置/布局决定保留或释放，与空 rail 不重排一致。
- 操作 end 只标记输入完成，最后一步仍走同一 rAF 合并队列，提交或取消后释放 token，不额外调用 setter。

主 agent 检查两份文档的本地链接及 `git diff --check` 通过；本轮无需运行产品测试。

## 关闭范围

本记录中的“修订”是方案文本闭合，不代表对应功能已实现或技术门槛已验证。阶段 A 仍须在 Ubuntu 隔离 Docker 完成三项书面决策：用户操作因果链、无 Undo/dirty 的暂停执行入口、标签空间与回退几何。三项未闭合不进入阶段 B/C。当前用户验收实例保持原版本。

## 2026-10-05 补充审核

用户再次要求“方案要起 agent gpt 6.1sol max 审核，然后修订”。本轮新启动两位 **`gpt-6.1-sol / max`** agent，分别复核需求与候选实现的符合性（`/root/sync_final_spec_review`）及标准/可维护性（`/root/sync_final_standards_review`）。检查基线 `279b1ef` 后当前未提交候选，结合既有方案与阶段 A 技术决策；本轮主 agent 只修改方案及本记录，未修改产品代码、重建镜像或部署。

候选入口已选为：SHA 校验原生缩放动作 adapter、内部有效态的窄写入作用域，以及主 pane 之外的固定 36 CSS px 信息栏。入口选择与部分证据存在，不代表最后验收通过；候选源码、阶段 A 明细和最终证据尚未提交。

### Standards

硬违规：未发现违反 AGENTS.md 的候选改动；未见新增提交凭据、许可库或 unraid 开发部署。

- **P2：暂停期间无法通过时间同步菜单关闭逻辑选择。** `sync-settings.js` 仅修复/拦截日期行，原生时间行仍按有效值反转；逻辑 time=true、执行值=false 时，点击重复请求 true。方案第 2、4、8 节明确日期/time 菜单读取逻辑期望，真实鼠标/键盘修改后释放暂停按最新选择执行。候选实现仍待修。
- **P3（判断项）：外观规则可能重复。** `sync-settings.js` 预览与 `bar-range-mapping.js` 填充各自定义主题色和透明度，可能不同步。方案第 2 节要求共用计算规则；候选实现仍待整理。

### Spec

- **P1：用户日期/time 撤销与内部暂停写入未真正分流。** 协调模块把 `select()` 与暂停 `apply()` 都走无 Undo 入口。审核 agent 按本许可库 public/internal watched value 与 `setWatchedValue` 路径建立内存复现：用户开启 date→暂停→Undo→release 后逻辑 date 仍 true；暂停中菜单关闭没有新增 UndoCommand。方案第 4、8 节补用户选择可撤销与暂停中 Undo/Redo 的门槛；“暂停不新增 Undo”不能替代该证明。候选仍待修。
- **P1（待实测闭合）：保存 A/B 的原生保存状态。** bridge 按 editRevision 保留宿主 dirty，但原生 A 成功流程可能通过 `chartSaved(true)` 清掉 B 的 Save 状态。方案第 6、8 节要求完整原生回调后同时检查宿主/native 未保存与实际 Save 菜单，再保存并读回 B。候选必须实测或修复后证明；现有宿主 dirty 断言不足。
- **P2（方案/测试合同）：保存失败恢复。** 原有 `AdvancedWorkspace.tsx` 失败后保留恢复草稿并 blocked，同 ID 直接重试会被拒绝。方案第 6、8 节改为沿用复制恢复/另存为独立副本的安全路径；扩展测试同 ID 重试断言与既有合同冲突，应修订测试，不能取消既有保护。

本轮检查：11 项模块测试通过，包含 coordinator、range guard、sync snapshot、viewports、edge sync、mapping、生命周期、保存竞态、reserve lifetime/scheduler 和补丁安装合同；`git diff --check` 通过。这些检查不替代上述待修门槛。当前 Ubuntu 候选 `16243/16244` 可访问；重新运行扩展浏览器验收通过 13 项后，在保存失败后的同 ID 重试断言失败，页面错误为零。前次 `final-extended.json` 在初始化 timeout，不能记为最终通过。本轮完整结果保留于 `/tmp/mw-sync-settings-implementation/resumed-extended.json`，未作为通过证据归档。

Ubuntu Docker socket 当前拒绝 quant 访问，sudo 需认证，已请求用户配置权限。没有重建或更新候选，也没有操作既有 `16043/16044` 实例或 unraid。本轮收口为方案审核修订；实现仍未完成最终验收。

### 补充复审结论

两位同模型/强度 agent 已只读复审修订稿：Standards 的逻辑期望菜单与共享外观规则均在方案层闭合；Spec 的用户选择撤销、A/B 原生保存状态及安全恢复合同均在方案层闭合。需求审核建议显式保留阶段 A 门槛，已采纳：三项技术决策及用户选择可撤销门槛闭合后，才进入或继续 B/C。

结论为**方案文本复审通过，可作为带技术验收门槛的实施依据**；上述候选实现问题没有因文字修订而关闭。仅两份方案文档纳入本次提交，已有产品代码与未完成证据保留在隔离 worktree。


## 第三轮 GPT‑6.1‑sol / max 审核与当前关闭表

2026-10-05，按用户指定新启动 `/root/sync_plan_current_review`（`gpt-6.1-sol`，`max`）只读复核方案；继续使用同模型/强度的 Spec 与 Standards agent 复审实现。历史章节保留当时状态，当前判断以本节为准。Ubuntu Docker 权限现已由 `sg docker -c` 可用，不再属于卡点。

方案审核未发现新增 P1。两个 P2 文档问题与两个 P3 说明均已采纳：增加当前关闭表；阶段 A 写清 date/time 命令只保存各自字段及新增柱宽开关首版不进 Undo 的策略；主方案冻结首版固定外部 36px 信息栏，轴对位绘制/碰撞留为后续；补可复跑脚本及交付 URL/Compose/摘要合同。六项用户交互均保留。

| 发现 | 修订/验证 | 当前状态 |
| --- | --- | --- |
| 暂停期间 date/time 菜单反转错误 | 菜单读取逻辑 snapshot，统一鼠标/Enter/Space；native input aria 状态同步 | candidate8 choices 4项通过，关闭 |
| 用户选择与内部暂停共用无Undo入口 | SHA handler 分流逻辑命令与内部有效态；暂停中Undo/Redo实测 | candidate8 choices及模块通过，关闭 |
| time Undo覆盖后来柱宽模式 | time命令只存bool，date命令只存模式，epoch隔离旧命令 | choices混合操作及模块通过，关闭 |
| 保存A完成清掉B原生Save状态 | SHA chartSaved读宿主剩余dirty；实际Save菜单保存并服务器读回B | candidate8 extended 20项通过，关闭 |
| 保存失败测试误要求同ID直接重试 | 沿用blocked/复制恢复副本合同，不取消原ID保护 | extended安全恢复副本通过，关闭 |
| 弹窗预览与真实颜色规则重复 | 共用mapping.fillColor(draft) | 源码复核及main外观通过，关闭 |
| 旧存档同步偏好丢失/启动pause入口失效 | 加载前导入原生1/true，按原始state缺_mwSync判断旧格式 | candidate8 legacy 6项通过，关闭 |
| candidate7迟到getBars永久保留legacyPause | callback仅loading时暂停，启动/load恢复后清掉入口 | legacy实际native值正确、pauses=0、legacyPause=false，关闭 |
| 键盘焦点在取消/关闭/默认时Enter却确认 | Standards第三轮发现P2；Enter按聚焦button执行自己的动作，普通输入才确认 | candidate9 modal 5项通过；完整回归与字节归档均已完成，关闭 |

candidate8 已串行通过同步设置66项、范围回归75项、几何5项及原生日期保存恢复（passed=true），所有页面错误为空。几何覆盖DPR2、真实BTC长价格、实际多轴、八图窄窗、125%等效尺寸及16px有效字体；不把等效尺寸称为浏览器缩放UI或全部操作系统字体设置。candidate8不是最后键盘修复的通过证据。以上为candidate8当时状态：最后candidate9结果、镜像/源码绑定与交付归档当时待补齐，现已完成，见下节最终闭合。


## 最终闭合：candidate9

Standards复审确认键盘P2关闭，Spec复审确认旧发现全部关闭，无新增P1/P2；方案agent复审确认两个P2、两个P3文档修订全部闭合。最终157项浏览器场景（同步设置82、范围回归75）、原生日期保存恢复、14个模块脚本、9个syntax检查及build均通过。最后candidate9结果、真实held截图、镜像/image ID与当前源码匹配摘要已归档，见[最终实现验收](chart-sync-settings-acceptance.md)。

主agent另外补深浅主题原生/扩展开关尺寸、滑块位置及颜色比较，四组开/关状态一致，Space无法开启被禁用项，6项通过。首次比较捕捉到CSS过渡中的位置差；等待原生过渡稳定后比较最终状态通过，未改产品代码。保留测量方法范围，不称动画逐帧完全一致。

所有历史“待修/待验收”保持当时记录，当前没有遗留P1/P2。仅部署Ubuntu独立候选16243/16244，未操作16043/16044用户实例或unraid；权限通过本机sg docker使用。实现与验收完成，不包含生产合并/发布。
