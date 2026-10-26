# 原方案完成审计

结论：**尚未达到整体完成条件**。本轮按原始目标复核，未将目标缩成股票接入或只看已通过的检查。

原计划原文已逐字保存为 [managed-history-modes-akshare-yahoo-implementation-plan-20261024.md](../../managed-history-modes-akshare-yahoo-implementation-plan-20261024.md)，SHA256 `23ecf67354d7ed1dda1d05b244cf3eb9ff2df3b6fdfe6500cd6a19ed26e0dfe5`。原文的实施前状态与旧端口属于历史计划；实际实施及后续用户决定如下。

## 范围与后续决定

- 独立工作树 `market-watch-equity-qfq-mwa-20261025`，分支 `integration/equity-qfq-mwa-20261025`，集成基线 `ba5407b218c0d5ffb5b946cb83bba4af67f3965e`。原 history-modes 工作树及原任务环境保留。
- 用户已明确批准在现有 `$mw-acceptance` 验收，因此沿用长期实例及私有配置；迁移、失败和恢复验证使用独立任务 PostgreSQL，未把长期实例替换为空实例。
- 用户明确不提交 PR；这优先于原计划的 Draft PR 步骤。没有远程 Issue/PR、推送、main 合并或生产发布。Issue 草案已保存。
- 用户后续明确股票本期只需日线，暂不新增日线派生周/月展示；通用 base_d1/native_periods 引擎及其日周月合同继续验证。平台新浪 A/H、腾讯 A 用供应商 qfq；自建新浪 A/H、Yahoo 用 none 与同源依据计算 qfq。腾讯仅平台，Yahoo 复用已有 yfinance。
- 现有 FXCM、手机及指标功能来自明确的集成基线，保留其行为；不由本轮授权推断发布或扩大其他指标任务。

## A01—A17 的证据与边界

| 项目 | 当前可证明的范围 | 证据 |
| --- | --- | --- |
| A01 旧 M1 | 旧身份与块升级保持；新旧未修改读取代码在恢复副本上比较同一旧 M1 版本，256 原始行和100根图表一致；不外推所有旧消费者 | `legacy-reader-compat.json`；PG `test_postgres_pre_modes_migration_keeps_m1_payload` |
| A02 无 M1 的 D1 | D1/W1/MN 引擎、固定指标与实际三源 D1 图表可用；股票新接入周/月展示按后续用户决定延期 | `plan-required-postgres.log`；`managed-render-r12/report.json` |
| A03 周月/稀疏 | 跨年/稀疏 OHLCV、闭合状态及固定指标 fixture 通过；不能据此声称所有指标稀疏行为已通过，另有5项RRS基线失败 | `test_d1_cross_year_week_month_sparse_input_and_fixed_indicator_without_m1`；`failed-nodes-catalog-followup.log` |
| A04 能力交集 | M3 排除、已验证周期交集、精确图表能力与fallback的定向检查通过 | `web-ci-summary.json` 的 history-mode-frames；原报告能力矩阵 |
| A05 独立范围 | 原生周期不同起点与保留、无M1可选、实际期货M5/D1通过 | PG `test_native_periods_have_independent_windows_and_never_derive_native_week`；原期货浏览器报告 |
| A06 滚窗修订 | 原窗口缺失不删旧段，重叠可信修订形成新版本，旧版本保持 | PG rolling-window与qfq-basis-revision合同 |
| A07 部分失败 | 超时/空响应/限流保留旧周期stale，其他成功周期发布 | PG one-period-timeout、inherited-failed-period合同 |
| A08 全失败 | 无有效推进，首次失败unavailable，不伪造空产物成功 | PG first/all-failure合同 |
| A09 恢复/取消 | 取消IO、过期owner、checkpoint接管和重试通过；旧M1路径继续验证 | PG cancel/owner/partial-retry合同 |
| A10 调度/编辑 | 仅到期周期、配置revision与409、暂停合同通过 | history-maintenance及only-due-frame PG合同 |
| A11 原生/派生 | 故意不同W1的fixture保持原生结果，不替换为D1 reducer | PG independent-windows/native-week合同 |
| A12 远期修订 | 全维护范围none/qfq/hfq及同源依据修订，固定旧产物保持 | PG remote-daily-revision/qfq-basis-revision；真实未来公司行动长期观察未执行 |
| A13 四市场 | 新浪A/H、RB0期货、Yahoo代表标的成功，端点/单位/精度/标签已记录；不保证全市场或所有夜盘 | provider-capabilities；sina-factor-live；sina-futures-m5-label；stored-evidence |
| A14 共享/按需 | 并发采集和去重PG合同、真实重复读相等、无股票分钟订阅；共享忙等待修复已实图通过 | source-history-store PG；native-busy PG；platform-browser-r11；全源长期并发性能未宣称通过 |
| A15 回收/引用 | 跨周期原块与固定指标引用保护、平台缓存和归档分离 | PG retention/qualified-chart合同 |
| A16 非法观测 | 非正/非法OHLC/量/错代码拒绝，其他周期可用；仅v2精度尾差规范并保留原值 | provider与PG合同、HK真实负例；不扩大容差修复严重非法值 |
| A17 隔离/成本 | Ubuntu独立PG14.24、实际恢复103表及来源请求/耗时已记录；长期mwa配置保持 | backup-restore；compose-static；live JSON；runtime-audit |

确定性、PG、真实接口与浏览器证据保持各自范围；以上不把历史浏览器执行改写为最终镜像重新执行。完整逐项说明在 [原任务报告](../history-modes-20261024/report.md) 与 [当前业务报告](README.md)。

## 命令、环境与交付物

- 当前 Python 3.11.15、Node v22.23.2；本地 `alembic heads` 为 `ay52_history_modes (head)`。使用原任务专用 venv 只读执行、`PYTHONPATH=backend` 指向当前工作树，没有修改其他任务环境。
- 原计划§9.2逐字列出的五个PG测试文件现已单独执行，**62 passed、0 skipped**，166.07秒：`test_history_maintenance_postgres.py`、`test_history_artifacts_postgres.py`、`test_source_history_store_postgres.py`、`test_series_access_postgres.py`、`test_history_modes_postgres.py`。见 `plan-required-postgres.log`。
- 原§9.1相关后端由已执行的全量与定向回归覆盖；原前端三个命令在75项CI同命令结果中有独立exit=0记录，构建和5份Compose静态检查通过。变更夹具Ruff通过。远程CI未运行，不创建PR以获得远程CI。
- 完整后端首轮3120通过、20失败、3跳过；最初失败节点重跑16通过/8失败是历史结果。补齐目录测试替身后，两文件SQLite+PG **11通过**；原失败节点与新增回归最新为 **19通过/5失败**。这不等于取得干净的全量结果。
- `history-modes.browser.cjs`、原生期货创建/图表、股票平台四源与自建三源真实浏览器证据已保存；不同执行轮次与后续股票日线范围在报告中区分。
- 工作树/分支/本地提交、Issue草案、A01—A17报告、capability matrix、精确镜像、来源摘要、旧库升级/恢复/旧读取、启动停止命令、资源与私有凭据边界均已有可检查文件。旧二进制限制详见 [rollback-compatibility.md](rollback-compatibility.md)。

## 尚未满足的门槛

1. **后端全量不是绿色。** 剩余5项RRS失败在原基线同环境复现。原计划同时写明“CI 必需上下文全部通过后再进入交付”和“当前其他任务包括…rolling-range-squeeze，不修改它们”。因此没有用“既有问题”替代全量通过，也没有擅自修改该指标任务；已向用户请求是否将这5项修复纳入本轮。
2. **数据保留审计未通过。** 1个既有工作区和3条既有偏好变更归因仍未知。网关日志有相应时间的保存请求，但不包含请求体/操作身份，不能证实行为主体；见 `preservation-write-window.json`。没有原行删除，未reset、恢复、替换基线或豁免差异。

目标保持 active，本轮新增了可核验成果，未将本次目标标记完成。当前镜像与业务代码不变，不需要为仅测试/证据补充重复部署。
