# 2026-10-06 矩形外框与原生同步设置复审

按用户要求沿用 GPT‑6.1‑sol / max Spec、Standards reviewer。当前实现撤销底栏和价格轴适配，使用 pane overlay 在真实极值 bar 的矩形外侧绘制高低价；标签、引线都避开可见 K 线与图例，精确匹配有效价格 tick。同步设置使用原生 NoticeDialog、正常左对齐入口和原生说明图标；鼠标选项位于弹窗内部，避免原生外点击关闭。

已修并复核：tick 相对容差误锚点、说明图标键盘提示、18px复选框与勾号、原生下拉鼠标选择边界。Spec、Standards 当前开放 P1/P2 为 0。最新运行资产 `host.6a46e53eefd5abae.js`（rectangle-ui8）与22个宿主模块和CSS字节一致。

当前独立实跑：设置31、稳定性9、原生弹窗6、菜单8、扩展保存恢复20、导航8项通过，无页面异常；外框模块17项通过。八图标签60秒新增工作p95 3.7ms，提交延迟p95 3ms。几何13项也已在ui8通过，映射39项复验也已通过，本轮最终134项/8组浏览器检查完成；[本轮证据](rectangle-ui/runtime-ui8.json)与[历史失败诊断](rectangle-ui/diagnostics/)分别保留。用户已人工通过柱宽同步，外框/设置修订待人工验收，不合并或发布生产。

下文是旧底部信息栏候选的历史审核，不描述当前矩形外框实现。

# 范围收口后的只读复核

2026-10-06，用户指定 gpt-6.1-sol/max，既有 Spec/Standards reviewer 复核撤回提交 `31e1e39`。本轮仅范围映射、同步设置和柱宽同步；下方早先的历史/指标修复建议已由用户范围决定取代，不是本PR当前阻塞。

- **Spec：0未解决P1/P2。** 产品源码 `advanced-host web/src backend scripts` 与已审 `fd4dcad` 一致；后端和 `indicators.js` 与 main 一致。范围映射、互斥同步、实际用户缩放来源无需焦点以及完整价格数字仍符合需求。
- **Standards：0违规、0新增P1/P2。** 范围外修复已完全撤回；epoch/editRevision保护、独立价格数字span和22模块构建完整。保留的Python脚本变化只适配隔离验收目标与DB端口，不是后端产品修复。
- 两位reviewer独立读取HTTPS实际宿主并核验22模块逐字节一致；资产 `host.d0a96d61fcfcc340.js`，Ubuntu Docker chart候选2/API候选1镜像匹配。新5组专项及用户人工验收由最终证据另行记录，不从旧结果推定本轮完成。
- 历史前缀和指标问题独立跟进，不阻塞本次功能收口。人工验收前不合并，未生产部署。

# 早先扩大范围的兼容检查点（历史记录）

2026-10-06。用户指定 `gpt-6.1-sol / max`，既有 Spec/Standards agent 只读复审。

## Spec

本次源改动未发现新增 P1/P2；整体兼容验收尚未完成。

范围/同步14组169项及四图容量边界通过，同候选2 `host.d0a96d61fcfcc340.js`。运行宿主与22模块逐字节一致，28构建源、137运行Python指纹匹配。date=true/time=true保存前后Undo命令数保持、暂停状态恢复且native save/dirty均结束，异步捕获revision/epoch拒绝保护保留。

指标首次20项通过，后续复验19项+4错误；实浏览器堆栈和实际vendor VM确认既有Python时间对齐buffer不足，`indicators.js`与main无差异。连续历史整体因SMA201首次前缀加载超90秒未通过，不能将PG更正、单次reset和保存重开部分成功称为整体通过。

建议WIP PR保留失败证据、暂不合并；下一阶段定义有界时间buffer与过旧feed行为，保留precise映射及原错误断言。当前无法证明`new_unlimited_var`受原生容量严格约束，不宜仅以无限buffer或额外一格处理。

## Standards

静态审核0违规/0新增P1/P2：22模块构建清单完整，Ubuntu任务目标白名单与专用数据库约束保留，价格数字独立span、提示可省略，指标逐plot5有限样本和后端误差断言完整。最终绑定核验完成：`fd4dcad`中page作用域修复确认，无待修P1/P2。HTTPS实际host与22模块/动态许可版本前缀逐字节一致，28构建源、137后端源码及导入alerts包无SHA差异；Ubuntu本机Docker socket、11容器项目/镜像ID/网络/PG专属volume与loopback端口核验一致。169/14组JSON数量、SHA、host及errors匹配，boundary通过，manual配置与入口一致。归档未发现凭据、私钥、许可库和PNG文本元数据，链接均存在。

范围验收通过；指标19项后4错误与前缀90秒超时明确full_pass=false，整体compat incomplete。人工验收待用户，未合并/未部署生产。
