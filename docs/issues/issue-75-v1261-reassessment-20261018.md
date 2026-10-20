# Issue #75：v1.26.1 方案调整与重新开发范围

日期：2026-10-18。本轮为 **P0 方案文档修订**；实现仍为 **F1 / R2 / D1**。已读取 [Issue #75](https://github.com/hezongyi/market-watch/issues/75)、PR #77 原认可方案和固定基线源码，未启动服务、运行业务测试或访问生产。

结论：**需要调整方案，保留可靠接收与渠道分离架构，以专业图表为中心从 v1.26.1 重新开发。**旧主页告警/通知列入分阶段退役，不能作为第二套长期通知产品继续接入。修订已落实到[完整方案 V2](../unified-notification-center-plan-20261016.md)，#74 来源和证据细节见[源码合同研究](../research/issue75-v1261-source-contracts-20261018.md)。

## 1. 固定版本与本轮处置

| 对象 | 核验结果 |
| --- | --- |
| 当前源码 | `v1.26.1` = `2fe919a23d4adcb97ca1a98caafbad8693a410d3`，本轮开始时本机 main/origin/main 均在此提交且工作区干净 |
| 原方案基线 | `b6fe6424853c8cbc325fb3ef02e7894aa680d412`；业务代码同 `b53d2973cd70e8610154bc46a9d516e62ccdadd7` |
| 原认可文档 | [PR #77](https://github.com/hezongyi/market-watch/pull/77) 的 `e868fe6c9d0008ff32d46dbed2a125115a86cfe3`；该 PR 合入 `release/v1.25.8-20261016`，两份文档未随之进入当前 main，本轮从其固定提交恢复后修订 |
| PR #85 | 用户明确作废。已于 `2026-10-18T04:36:43Z` 关闭 [#85](https://github.com/hezongyi/market-watch/pull/85)，远端 `feat/issue75-unified-notifications-20261017` 已删除，`git ls-remote --heads` 返回空；GitHub 保留已关闭记录 |
| 新开发依据 | v1.26.1、用户本轮收紧的专业图表范围、原六项已认可可靠性合同及本轮 V2 修订。#85 的代码、迁移、数据库和验收结论均不作为新交付依据 |
| 本轮工作区 | `/home/quant/repos/market-watch-issue75-reassessment-20261018`；`docs/issue75-v1261-reassessment-20261018`，只新增/修订文档 |

Issue 当时仍写“业务代码尚未开始”，而 #85 已经存在；此次作废后，新一轮重新记录 W0–W6 与待验收状态。已于 `2026-10-18T05:03:21Z` 将完整 V2 同步到 Issue #75 正文，包含专业图表范围、旧主页退役、#85 作废和从 v1.26.1 重新开发的要求；回读核对正文一致，Issue 保持 OPEN，W0–W6 与 A1–A20/B1–B9 全部待实施/待验证。Issue 的历史描述和旧 CI 通过数不能替代新基线证据。本轮未发布新的 Issue 评论或 PR，文档文件尚未提交或推送。

## 2. 必须调整的方案

| 调整 | 源码/需求事实与影响 | V2 的具体决定 |
| --- | --- | --- |
| **P1：专业图表来源与旧主页退役** | 用户本轮明确范围。`signals` 同时有 watch/chart 外键，旧查询不筛来源，直接接入会把旧主页信号及声音带入新中心。[S1][S2][S3] | 服务端按真实图表告警关系准入，默认仅 `pro_chart`；旧主页/未知来源只作迁移历史和存量手机兼容。退役旧 Shell 全量 signal 声音/独立网页通知；保留原证据、必要深链和显式手机停止 |
| **P1：接收生命周期跟随登录会话** | v1.26.1 已有统一 AppContext、登录 next、401 草稿保存、离开保护和多条路由。只挂在 AdvancedWorkspace 或 Shell 中，会随导航重建。[S4][S5] | 一个可信父页面 Module 位于已认证应用根部；路由/工作区/原生容器只有展示 Adapter。会话暂停、异步结果栅栏、主体隔离和幂等续传列入新验收；存活范围不等于建设全站新通知产品 |
| **P1：正常入口必须在专业图表** | 当前原生应用菜单已有“通知”、数据中心、规则管理、自选/收藏。现有 nativeAlertShell 还会改写 alerts page factory，不能让另一个 Adapter 直接覆盖。[S6][S7][S8] | 正常图表一个原生通知入口/单气泡；父页面只承接启动与故障降级。保留规则编辑和数据中心；应用菜单直接打开图表中心，其他页面通过现有返回图表/离开保护进入。原生可用性必须新做浏览器探针 |
| **P1：状态转换与真实失败分开** | #74 增加 demand/update/release/cancel、visible_complete、快照续约及有界恢复。图格状态、历史失败和容量消息现有不同通路；只抄 noticeMessages 或解析中文文本会漏来源、误计数。[S9][S10][S11][R] | W0/W1 冻结完整生产者矩阵和源 attempt ID；等待、取消、旧代次回包及恢复中不产生故障。可见完成优先于后台 run 状态；恢复最终失败才形成当前事故，重复状态不增次，真实新失败不被同文本去重吞掉 |
| **P1：当时证据不能依赖短期快照** | #74 提供 execution、coverage、input_evidence 等排查字段；provider/display snapshot 租期为 120 秒，通知计划留存 30 天。该 TTL 已在旧机制中存在，是原方案需要具体落实的留存约束。[R] | 接受事件时冻结脱敏最小证据或匹配留存/授权的持久引用；保留系列/provider/basis/输入与参数身份。业务告警原证据不被展示证据或当前价格覆盖，缺失如实标明 |
| **P2：声音、计数和旧链接去向** | 新旧页面声音原先在 Shell 中按混合 signal 列表差异播放；`pending-count` 是旧待确认，不是网页未读；已有手机 signal 深链和规则管理 panel。[S3][S12][S13] | 旧网页声音消费者退出；父页面唯一声音消费/去重，enabled 与 unlocked 分开。中心未读和待手机确认分开。`panel=notifications` 定位专业图表中心；`panel=alerts` 仍管理规则；旧深链按图表/legacy 来源映射，不新建第二中心 |
| **P2：迁移与验收基线重置** | v1.26.1 唯一 schema head 为 `av49_indicator_demands`。旧截图、seed 和通过数量无法证明专业图表真实生产者已接入。[S14][R] | 全新分支、独立数据库/volume/凭据，从 av49 加性迁移；保留数据的应用回退。保留 A1–A20，增加 B1–B9；先真实来源纵向贯通，再全矩阵与 R2，不用面板种子数据代替功能完成 |

这些调整的主要收益是减少长期维护目标，确保图表错误可回查，避免误报/重复提醒和错误手机停止。实施成本集中在可靠来源、补拉、原生 Adapter 与故障验证，不能因界面看起来像一个铃铛而降为 UI 小修。来源白名单和真实纵向切片应先做，可尽早发现接入错误，减少最后一次性迁移所有提示的返工。

## 3. 保留的架构与兼容合同

原六项认可合同继续有效：可靠源变更加异步投影；独立 `(stream_epoch, change_seq)` 与重连补拉；网页已读/处理与停止手机分离；父页面不依赖图表 ready 的接收/降级；声音预留及持久重复抑制；事故身份、逐次发生及资源预算。

当前 `notify.py`、告警 consume 与旧确认/设备回执的核心合同没有因 #74/#82 自动变成完整通知变更流；仍需补可靠来源捕获。`/api/events` 的 Audit ID 高水位不能直接当新中心游标，不能把所有 Audit 都投影为用户事件。新中心也不能调用告警判定、取行情或发送手机来重建历史。[R]

旧主页退役与共享手机协议退役是不同步骤。专业图表告警仍使用当前 Notification/Outbox/尝试/回执事实；这次不批量 ack、清空 Outbox、删除旧证据或擅自停用已有规则。新中心“已读”始终不能让旧手机确认数量减少；只有含义明确的手机停止动作执行原协议。[S1][S12][R]

## 4. 重新开发顺序

1. **W0/W1**：新建 v1.26.1 实现分支，盘点 Ubuntu 资源及独立 D1 栈；实际探针原生入口/降级/音频激活，冻结专业图表生产者、来源归属、旧入口退役顺序、动作、字段与预算。
2. **W2**：先实现可靠源捕获、异步投影、持久变更、观察及浏览器待同步；证明源提交/崩溃/幂等/状态补拉和旧手机兼容。迁移从 av49 接续。
3. **W3/W4**：先选真实图表失败及真实图表业务告警打通来源→父页面→原生中心→详情/渠道，再迁移完整生产者矩阵；统一声音和观察，退役旧网页消费者，保留历史深链。
4. **W5/W6**：运行 A1–A20 与 B1–B9，包括图表/legacy 混合来源、取消/恢复、跨页/会话、证据到期、并发游标/投影、风暴与应用回退。完成独立 Standards/Spec review、CI、Ubuntu R2 后形成新候选；合并/发布仍遵循仓库检查点。

每一阶段按本轮证据更新状态；保留原 A 编号，新增 B 编号，便于对照原认可方案和新需求。Ubuntu 实例、启动/停止命令、镜像和迁移结果在实际运行后记录，不为尚未运行的栈填写假通过。

## 5. 本轮检查与限制

本轮检查范围：GitHub Issue/PR 元数据、固定提交与相关路径差异、真实来源外键/混合查询、应用与原生 Adapter 接缝、迁移图、文档链接/编号/空白及历史评审一致性。

静态检查通过：4 份 Markdown、85 个链接、70 个固定提交/文件/行号引用；W0–W6、A1–A20、B1–B9 编号完整且唯一；52 个迁移的唯一 head 为 av49；历史评审除日期说明外保持原文；UTF-8、结尾换行、本地链接、引用定义及 Git 空白检查通过。源码自审确认新中心主动来源和旧主页退役范围一致，原六项可靠性合同未丢失。

未运行业务测试、PostgreSQL、Chromium、声音或 R2；未修改业务代码，未创建或发布正式 tag、镜像及生产资源。本轮文档 PR CI 尚未运行。原评审的 29 passed/1 skipped 仅作历史现状证据；关闭的 #85 不提供本轮验收依据。

## 一手证据

以下源码链接固定到 `v1.26.1`，`[R]` 汇总更详细的固定版本来源合同与测试定义引用。

[S1]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/storage.py#L807-L875
[S2]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/backend/alerts/business.py#L264-L290
[S3]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/src/main.tsx#L205-L261
[S4]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/src/main.tsx#L76-L166
[S5]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/src/app/navigation.ts#L3-L46
[S6]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/chart-menu.js#L295-L345
[S7]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/native-alert-shell.js#L1-L139
[S8]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/bridge.js#L2438-L2475
[S9]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/src/advanced/AdvancedWorkspace.tsx#L196-L228
[S10]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/src/advanced/AdvancedWorkspace.tsx#L621-L685
[S11]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/advanced-host/bridge.js#L2785-L2817
[S12]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/src/main.tsx#L799-L827
[S13]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/web/src/advanced/AdvancedWorkspace.tsx#L901-L920
[S14]: https://github.com/hezongyi/market-watch/blob/2fe919a23d4adcb97ca1a98caafbad8693a410d3/migrations/versions/av49_indicator_demands.py#L1-L60
[R]: ../research/issue75-v1261-source-contracts-20261018.md
