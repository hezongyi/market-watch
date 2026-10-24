# NR4 / NR7 Python 移植与最终验收

分支整理（2026-10-24）：最终源码现统一在 `market-watch-integration-20261024`，原开发及 v1/v2/v3 工作树已归档退役。详见[整理与恢复记录](../nr-consolidation-20261024/README.md)。下文各运行版本及路径保留为当时的验收事实。

当前追补：加载期间闪动已修复，运行 Chart 为 `c68fd817`；四周期连续画面验收及最新运行身份见 [加载连续性修复](loading-continuity.md)。下文保留此前 b1 丢图专项记录。

状态：**已修复历史翻页丢图根因，并完成授权验收**。记录时间 2026-10-24T13:34:20.993238+00:00。

更正：此前操作记录在实际像素复核前写过“验收完成”，该结论过早。本记录以修复后的两次实际截图、交互及数据审计为最终依据，取代旧的待授权、v2 候选和提前收口记录。无 push、PR、main 合并或生产／Unraid 操作。

## 代码及运行版本

- 原开发树 `market-watch-nr4-nr7-20261024` 保留 v1.28.0 / `59ed3a3f` 基线和原始开发差异。
- 当前整合树 `/home/quant/repos/market-watch-nr4-nr7-mwa-v3-20261024`，分支 `integration/nr4-nr7-mwa-v3-20261024`；整合基线 `4e5351cfd40b59914174119222e2f1786cba2abc`，保留现有告警、快照恢复及 Squeeze 工作。
- Chart 产品提交 `b1a479a7cda8a98a2968239abd390c310267c0b0`；CI 增加重启回归的提交 `9e0c03c400e19ad56d8b0445ce455cd96e216634`。文档提交不改变已构建镜像的源码身份。
- API／10 workers 仍来自 `8b7ee3eea8467866da89c0f3fc53989da5cc94e1`：`sha256:089fbb3cb00aa453b30053661ad77cb5000b86bea8738782d2df086e311b8772`。
- Chart：`sha256:34dd43689ce32c132e7a5c62b07ad06bc86afa04f0d05b08d8926daa1ccf321f`；已部署 bundle `host.0b246b07f9ac5537.js`。
- Web 保持 `3ac6f743f947a1ae33bcdf55bb15efa031a7f760`：`sha256:af3de39e8cab597c70837df98ebd95aada4b0d0534c0620ecab268c02de5a0de`。整个实例有多个组件提交。
- 镜像均用 Ubuntu `mw-docker build` 构建，task/project/purpose 明确，构建源干净。精确提交内容摘要见 [manifest](candidate-manifest.json)。

## 丢图根因与修复

原生历史翻页可暂时重启 study。原生结果适配器保留数值行与 coverage，但 coordinator 将暂时没有 scope 的 consumer 移除，同时清空 NR 绘图缓存。新 consumer 依据保留 coverage 只取较早的 prepend；原生数值完整，新绘图缓存却只剩早期数据，最新区间的框、线、箭头被撤掉。

已捕获失败链：252 行 snapshot → 尾部更新 → detach/clear → 199 行早期 prepend → 单行 append；实际截图填色像素为 0。两个只读 agent 独立核对原生库与生命周期，并用真实 coordinator + renderer 的 VM 链路复现。

修复：NR 本地绘图 binding 缺失时，强制补取完整 scope 的 snapshot，随后才恢复增量。保留 `ownerStudyId`、隐藏／删除及过期异步结果清理。撤掉无效的 `bringToFront` 排序尝试，避免 public 排序调用写入撤销栈。没有修改许可库，也没有把主序列挂载探针当作产品修复。

[回归失败证据](restart-regression-before.log) → [修复后通过](restart-regression-after.log)；新增测试覆盖重启+prepend、普通 prepend 仍增量、重启+tail，并接入 CI。详情见 [根因证据](root-cause.json)。`display:8` 为透明 StatusLine carrier，已更正测试中误写的 DataWindow 解释。

## 验收结果

- 本地专项：后端 **152 passed**、隔离 PG14.24/JIT **90 passed**、原 API 镜像内 **104 passed**。范围有重叠，不相加。后续修改仅涉及 Chart 协调／绘图。
- 修复后：NR 重启回归、VM 绘图、JS 语法、通用 runtime contracts、真实许可库 NR fixture 均通过。Fixture 包括两个实例、保存布局恢复、D/W 切换、五档字号、样式、隐藏和删除。CI 未推送执行，本地命令已执行。
- 真实实例两次独立上下文，使用**已部署原始 assets**，没有网络源码注入、强制 redraw 或手动修补：NR7 实际截图填色像素最终均 **34,967**，等待原生翻页后仍存在。[截图](actual-nr-visible.png)；[第 1 次](visual-run-1.json)、[第 2 次](visual-run-2.json)。
- 实际 XAUUSD/OANDA bid/H1/NY17：日形态当前 native scope 252 行，4 框、12 线、5 信号，API 几何与 21 个原生对象一致。隐藏恢复、颜色、Huge24、信号开关、删除清理通过。周形态当前视窗 3 线，无框／信号；完整周形态框由合成 fixture 覆盖。
- 真实冻结 **1,258 根完整 H1 × 3 模式 × 13 输出**，独立 literal Pine 赋值顺序 oracle 比较所有值/null，最大绝对误差 **0**。保留平台标记的一个缺口分段；没有执行 TradingView Pine 导出或声称跨缺口连续等价。OANDA 日历未认证。[数值证据](numerical-oracle.json)。
- 原 Pine 未定义 alertcondition；NR 原生告警尚未映射。本次未扩展告警功能；既有 RSI 告警草稿可打开／取消，未写入规则。[交互证据](browser-result.json)。
- **15 服务运行**，API／PG healthy。有效环境、端口、挂载、网络、命令、资源与重启策略一致；DB/gateway/Web 容器、保护浏览器 ID 与启动时间未变。[服务审计](runtime-services.json)。
- 六张保护表全行哈希不变：工作区 0/10、偏好 30、数据集 130、版本 15、产物 135；原 **23,888** 条通知状态与 **7** 条手机确认未变。没有 seed、迁移、恢复或清库。[数据审计](data-preservation.json)。
- 本次部署窗口无 NR traceback、HTTP500、连接池超时或服务重启。反复诊断的整个 API 容器日志中有 **82** 次请求断开 CancelledError；最终 Chart 更新后的窗口有 **6** 次，同属 chart_api 请求取消路径。未宣称全栈零异常或长期稳定性。[日志摘要](log-summary.json)。

历史后台全套未重新跑绿；此前 2263 passed / 618 skipped / 1 fixture failure / 38 缺 PG 环境错误，受影响夹具／PG 专项另行验证。额外探测旧 `indicator-range-events` VM 夹具缺少 crypto，固定基线 8dc8a24e 也失败，本次不计入通过项，见 [基线失败](legacy-range-fixture-baseline.log)。

## 实现边界及操作

Python `NR4_NR7_BREAKOUT_V1` 唯一计算金融逻辑和几何坐标，JS 映射原生 rectangle/trend_line/Text。保留上一完整目标周期 `[1]`、NR7 优先、并列最窄、前一边界交叉、中线重启及 Pine 赋值顺序。箭头低/高点锚定、居中、字号 7/10/12/18/24、颜色与信号开关及 500 对象限制均保留。

- 原始 [LuxAlgo Pine](../../references/nr4-nr7-luxalgo.pine) SHA256 `84e15423015effdd055f77210800fadbfc94f9970e86931db22d2ecced684917`；保留 CC BY-NC-SA 4.0。
- 支持目标周期 1/5/15/30/60/240/D/W/M，须不低于图表周期且边界对齐；不支持任意 Pine 周期或低周期重建。
- UTC0、NY17、Yahoo 时区／会话参与计算身份；既有输入质量语义不变。
- 原生 Text 居中依赖固定 TT v31.1.0 私有适配点，升级许可库须复验。
- 保守 F1：JSON checkpoint/worker 通路，无 DDL。只在用户“同意进行验收”后更新既有长期实例。

实际运行主机：Ubuntu **quant-server**；project `mw-issue75-v2-20261018`。

- 主入口：<https://192.168.7.232:18280>；Chart origin：<https://192.168.7.232:18281>。
- 统一启停／状态：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。
- 本任务审计：`python3 /home/quant/repos/.mwa-nr4-nr7-20261024/operate.py audit`。
- 原 NR 更新前的回退 overlay 保留在私有 `pre-nr-rollback-override.json`；`rollback-override.json` 指向本次修复前 8dc 图表实例。未执行回退。
- 任务隔离 PG 已停止，容器／卷保留；退役预览拒绝未注册 PG-only project，未绕过／删除。长期实例及其保护卷不参与退役。

凭据、私有配置、许可库及完整浏览器状态未提交。失败的探针保留在私有诊断目录，未计为最终通过证据。
