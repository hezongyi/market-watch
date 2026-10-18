# Issue #75 验收映射

本轮基线为 v1.26.1，隔离主机 Ubuntu 22.04.5，D1 / PostgreSQL 14.24 / Chromium 153，交互验收使用 Playwriter 0.8.0。下表记录证据覆盖，不把合成来源当作真实业务生产者，也不把模块探针当作完整应用路径。最终产品提交、镜像及 CI 以 execution.md 为准。

“通过”表示列出的合同与本轮路径通过；不扩展为所有浏览器、辅助技术、供应商和生产负载的保证。真实手机投递关闭，设备收到与人听见均不在本轮结论内。

| ID | 本轮证据与结论 |
| --- | --- |
| A1 | Playwriter 原生单入口、降级恢复、深浅色、800×700 紧凑弹窗、双图；最终 sidebar 285px 的 scrollWidth=285，iframe 1440×1000 前后不变。键盘证据见 playwriter-final-ui.json；最终镜像浅色级别与960×667、deviceScaleFactor=1.5的等效缩放布局通过，见 playwriter-final-theme.json（设备指标模拟，不宣称桌面浏览器快捷键缩放）。 |
| A2 | 最终 clean run 1000 条/10 页/1000 唯一，95–294ms/页；来源/工作区/级别/关键词组合与不匹配空结果通过。时间/类型/品种/状态、高水位与条件绑定由后端合同测试覆盖。playwriter-final-contracts.json、source-contracts.log。 |
| A3 | Playwriter 实际业务告警及合成 critical 详情显示独立 ID、UTC/本地时间、客户端报告标记、未知状态及渠道时间线；playwriter-final-narrow.png、playwriter-final-critical.png。 |
| A4 | 真实业务服务生成图表 signal，精确触发值/阈值、规则及原始 evidence 沿用原记录；全量 chart-alert 回归与来源归属合同通过。跨工作区/图格定位校验由独立 Spec 复核和来源/前端合同覆盖；未逐一在浏览器新建四类规则。 |
| A5 | Playwriter 网页 viewed/handled 不改变 pending 手机状态，显式停止沿旧 ack；双 tab AudioContext reserved/started 分离。playwriter-sound-and-stop.json、playwriter-contracts.json。 |
| A6 | 真实历史读取 149 次失败 HTTP 尝试形成 49 个终态发生，归同一事故，仅首个 attention；恢复后关闭。双 tab/刷新声音去重通过。playwriter-history-result.json、playwriter-sound-and-stop.json。 |
| A7 | 保存、指标、行情、历史、收藏、容量和数据中心真实失败可回查，并验证恢复/保留输入；存储拒绝、满、TTL 的准确缺失提示由真实 Chromium Store/Runtime 探针覆盖。 |
| A8 | Ubuntu R2 实际源服务→Audit→独立 worker→数据库事件→Playwriter 详情贯通；源/事故/通知 ID 与渠道时间线有脱敏记录。全部故障注入在 D1，无生产注入或生产观察。 |
| A9 | 独立 PG 的事务中断/回滚及并发测试通过；clean run 两次及最终 UI 第三次重建稳定，task ID/count hash 不变，未新增 outbox/sound attempt。final-rebuild-results.json、final-ui-rebuild.json。 |
| A10 | 原生保存失败+接收失败，刷新后 pending 保留，恢复同 ID 一次接受；ID 冲突、单条/数量/字节/TTL/存储拒绝通过。playwriter-save-durability.json、playwriter-boundary-results.json、后端合同。 |
| A11 | 渠道对账、旧版本拒绝覆盖、仅状态变化补拉由后端与 Runtime 合同覆盖；实际网页/手机状态独立、旧二进制写回执后 rollforward 通过。baseline-compatibility.json。 |
| A12 | 独立 PG 验证反序源提交、发布锁、回滚无游标间隙；高水位、同毫秒因果顺序、稳定跨页由后端/Runtime/Store 合同和最终 1000 条分页覆盖。 |
| A13 | 同 reader JSON/SSE 游标和 changes 相同；游标绑定/过期/tombstone、匹配退出由合同覆盖。最终 UI 实际换代自动清空分页并恢复已同步，无真实 gap 被掩盖、无历史声音/outbox 增加。 |
| A14 | 旧手机 ack、发送结果/设备回执/显式停止通过后端全量及旧二进制兼容；网页独立语义通过 Playwriter。D1 无真实手机送达测试。 |
| A15 | 整个图表 origin 阻断后父页可查询；恢复后 fallback=0、native entry=1、region=1；ready/代次/资源失败由合同覆盖。未穷举许可 JS 与每个 chunk 的全部故障组合。 |
| A16 | 同 profile 双 tab/刷新/重开只一次预留/开始；真实 A→B→A、replay/settings/signals 的 profile/epoch 延续。旧 Shell 自动路径已移除并由 Spec 核查。 |
| A17 | 实际 Chromium 模块探针验证 muted/locked/expired/coordination-limited/failed/unknown、跨 Runtime 原子预留；真实原生手势解锁父音频。不是对物理声音或所有浏览器音频实现的保证。 |
| A18 | 同事故不同文本、新 attempt、恢复后复发、严重升级、同毫秒顺序、跨 profile/context 恢复隔离由后端与 Runtime/Store 合同覆盖；实际历史重复发生与明确恢复通过 Playwriter。 |
| A19 | 真实历史重复故障+1000 可靠任务积压+160 条混合合成 browser intake：124 接受/36 限流；模块队列20、摘要200、critical 优先。应用中可筛选/打开 critical 详情、切换双图；145 秒/13 点资源采样未达限，pending_sources=0。此为短时突发与恢复测试，不是长时间容量基准。 |
| A20 | PG 单链加性迁移、旧二进制读新 schema、保留数据的应用回退/再升级、重复重建通过。最终键盘打开/关闭/焦点返回和可访问名称/region/status 的语义树通过 Playwriter；主体/凭据访问隔离由合同覆盖。未运行真实屏幕阅读器或跨 OS 辅助技术。 |
| B1 | 真实 A→B→A、replay、手机通知设置、声音设置、signals 路由保持 profile/epoch；signal 深链进入图表中心对应详情，/market-data 兼容地址打开原生数据中心；401 重登 next 回原路径。playwriter-final-lifecycle.json。 |
| B2 | 图表/设置/数据中心取消保留草稿，保存503留原页，明确放弃后导航；真实401保存本机草稿并显示恢复提示。挂起旧200响应，401后释放，19秒内无通知请求、progress不变；重登续接，实际UI退出/重登可用。 |
| B3 | 真实指标终态失败/重试、历史终态读取、容量保存、数据中心创建、收藏保存及原生保存失败均有 Playwriter 证据。409 重试耗尽/StrictMode/重复快照/旧代次由前端和来源合同覆盖；并非每种故障均在浏览器再注入一次。 |
| B4 | indicator/display/provider 测试覆盖 visible_complete、pending、release/cancel、过期快照恢复和当前代次终态；实际 Python STOCH 失败后用户重试成功。playwriter-indicator-result.json。 |
| B5 | 原生/父降级互斥、主题、双图、窄屏、数据中心、收藏/容量和既有图表管理功能的本轮路径通过。vendor 许可库未修改；原生规则/画线及排序全套回归由 Web CI 覆盖。 |
| B6 | 原生手势→父 AudioContext 解锁，enabled/unlocked 分离，双 tab/刷新不重复；边界状态由实际 Runtime/Store 探针覆盖，旧 Shell 路径退役。 |
| B7 | 持久 evidence 最小快照、脱敏、身份/归属校验由后端合同及独立复核覆盖；详情读取历史记录，未以新价格覆盖。快照过期恢复/取消/正常 tick 不报故障由前端专项覆盖。没有等待七天真实时间流逝。 |
| B8 | 单链 av49→aw50 加性迁移、旧二进制手机事实、保留新表应用回退/rollforward、重复 rebuild、独立未读/待手机确认标签均有实际 PG/Playwriter 证据。 |
| B9 | 来源归属合同排除 legacy/unknown；旧 Shell 全量 signal 自动声音退役；实际兼容历史可查，图表深链转新中心，手机停止保持显式。旧规则与共享手机表未被迁移重写；历史 rebuild 不重响/重发。 |

来源接入与代码规范的独立审查结论无 P1/P2，不替代上述实测范围。先前中间测试库和首次失败 CI 的限制、最终 clean run 及修复后的结果均保留在 execution.md。
