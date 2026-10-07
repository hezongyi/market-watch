# Issue #13：最终实施与验收记录

2026-10-07 23:14 SGT 后续：发布 PR [#21](https://github.com/hezongyi/market-watch/pull/21)已提交；用户授权后固定镜像ID退役工具已修复，10个本任务验收project经过真实备份恢复验证全部退役。原地址不在线、卷已归档删除，旧启停命令只记录验收时方式，直接重启需先重建独立环境/恢复归档。详见 [退役终态](resource-retirement.md)。以下保留22:27验收时事实。

2026-10-07 22:27 SGT。两份深入方案已实施，r6 全部应用验收通过并整合到 `analysis/issue13-performance`，产品合并提交 `63bad46`。冻结候选 `bcaefcf33d14c4be150e8d2d6e886329cdae74d7` 的 175 个 backend/根目录 migrations 文件与合并结果逐字节相同。未推送、未发布版本、未生产部署。

产品保留固定 origin 读取下推与合法前驱；生产和探针共用 monitor，默认周期 0.75 秒，逐告警记录读取/提交时间；采样 11→2 SQL、完整 payload/freshness/marker 校验；就绪工作等待 20→5ms、事务提交后跨进程唤醒与 2 秒兜底；全局服务序号、每目标失败隔离、4096 行/75ms 合作预算及可恢复完整聚合小片。历史与聚合继续推进，不采用永久 M1 优先、跨告警缓存或并行 evaluate。

| 要求 | 实测与判定 | 权威证据（相对本目录） |
| --- | --- | --- |
| v1.14.0 整合、来源/身份和 additive 迁移 | ec00080 为祖先；最终源码字节相等；真实升级/待处理回退守卫在完整回归中执行 | `v114-integration.md`、`results/optimized-r6/{product-source-manifest,merged-source-verification,full-regression-result}.json` |
| 空闲 CPU≤5%/降低≥80%、SQL≤2/s/降低≥90% | 三轮均值 1.161%/降 97.20%、1.543/s/降 97.71%；零历史/audit 读取与发布更新，快照稳定 | `results/optimized-r6-baseline/idle-{1,2,3}.json`、`measurement-audit.json` |
| 实时/修订 M1 p95≤15s/p99≤30s，全部分母 | 84/84 实时、87/87 修订、20/20 混合输入；终态没有遗漏输入 | `results/optimized-r6-baseline/{live,revision}-*.json`、`results/optimized-r6/supplemental/` |
| 全部就绪目标等待≤10s，含末尾未服务年龄 | 专用 90 目标持续最长 4.769s；组合故障 5.351s，每目标至少 8 轮，末尾 90 个持续重排目标的右截尾年龄全部计入 | `results/optimized-r6/{fairness/result,rotation-faults,terminal-wait/result}.json` |
| 回填≥660.52bars/s 且≥可比旧80% | 三轮 2717.99–2726.05bars/s，对应旧比1.87–1.96倍，等待5.633–5.751s | `results/optimized-r6-baseline/backfill-*.json`、`results/v114-baseline/` |
| ASGI100/200ms、evaluate200/350ms | 120+120 热态，49.061/108.167ms 与13.864/17.635ms；无告警 staging 读取 | `results/optimized-r6/consumer-microbaseline.json` |
| 同价330s50输入、正常330s310输入 | 50/50/50、310/310/310，所有 marker/payload/判断逐条重建；同价无价格/量修订和额外信号 | `results/optimized-r6/{observation-alert,normal-input-alert}/{result.json,timeline.jsonl}` |
| 可见→判断保守上界p95≤1s/p99≤2s | 同价0.723/0.772s，正常0.805/0.855s；最终通过原严格门槛，未使用用户“1秒左右”容差 | 上述结果与 `consumer-artifact-audit.json` |
| TCP120请求500/1000ms，10唯一触发 | 231/322ms，10/10/10，10唯一signal；告警保守上界p95/p990.831s | `results/optimized-r6/network-alert/result.json` |
| M30/W1/MN 独立 oracle 与消费者一致 | 10身份、4阶段120 cases；chart/CSV/MCP/告警相等，重复幂等，离线独立重算 | `results/optimized-r6/high-period/`、`consumer-artifact-audit.json` |
| 全后端及真实PG并发合同 | 1389 passed/2 skipped/65 warnings，775.41s；世代/失败/锁/迁移/预算/缺口/前驱/修订等包含在内 | `results/optimized-r6/full-regression-result.json` |
| 提交前后崩溃、通知丢失、新进程恢复、重复重启幂等 | 真实 SIGKILL，提交前可见不变、世代保留；提交后快照保留；离线输入无历史通知仍恢复；幂等通过 | `results/optimized-r6/{publication-crash,publication-postcommit}.json` |
| 旧应用回退后新应用接续 | 真131bf3c旧应用在 additive schema运行、新版本恢复，原始证明保留；不同时运行两个发布拥有者 | `results/optimized-r6/application-rollback.json` |
| 90目标+连续输入+大回填+锁+失败重试 | 故障快照回滚；锁与退避期间健康服务32/28次；无缺失、锁错误或未完成重试 | `results/optimized-r6/rotation-faults.json`、`recovery-artifact-audit.json` |
| 覆盖原始/结构化证明等价、完成后无audit读 | 62522 audit/27939 structured 重放与独立 union 全等；完成后audit读取0 | `results/optimized-r6/coverage-replay.json`、`recovery-artifact-audit.json` |
| 实际UI双图/切周期/切身份/save/reload、CPU≤1.5 | 6阶段通过；EURUSD/XAUUSD双图保存与重载，零page errors/failed requests；实际应用+浏览器1.45CPU、PG单列，内部离线网络 | `results/optimized-r6/browser/`（截图已人工查看） |
| 全数值与消费者、恢复原始证据独立审计 | 79数值门槛全部通过、missing空；两个artifact audit通过 | `results/optimized-r6/{numeric-assessment,consumer-artifact-audit,recovery-artifact-audit}.json` |
| Ubuntu真实隔离与终态、实际源码与合并相等 | 自己project/network/volume/DB/port；五个持久服务均已停止；依赖镜像与只读挂载核对 | `results/optimized-r6/{consumers-runtime,delivery-environment,merged-source-verification}.json`、`browser/services-runtime.json` |
| 文件完整性与保密 | 最终终态/执行源码哈希逐文件校验；不提交env/凭据/私钥/许可库；历史失败与跳过保留 | `evidence-manifest.json`、`audit_evidence.py`、`final-delivery-audit.json` |

发布三重复数据明确继承 r5：这些负载不运行 monitor，其他174个产品及迁移文件相同，r6自己的初始快照亦核对一致。复制数据保留原r5来源/host/state，不重标为r6实测。完整消费者、并发、UI、恢复和覆盖均在r6自己库实际重跑。详情见 `inherited-publisher-evidence.json`。

组合故障探针的 RULES 持续重排负载吞吐622.90bars/s是观测，和专用可比回填不是同一负载；回填双门槛由三轮专用测量证明。完整回归的2个skip为可选日历依赖和匹配PG dump/restore工具缺失，不能把skip称pass。验收是本地合成负载与有限窗口，不证明供应商I/O、外部通知送达、生产容量或生产SLA；宿主竞争与限流观测保留。

实际运行主机为 Ubuntu quant-server。本项目PG `127.0.0.1:19703`；真实浏览器验收使用网页 `https://192.168.7.232:19645`、chart `https://192.168.7.232:19646`。验证完成后五个服务全部停止，当前地址不在线，卷 `mw-issue13-optimized-r6_pgdata` 保留。私有env位于/tmp，0600，不进仓库。

只启动/停止本任务服务的方式：

```bash
# PG（自己的验证库）
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized-r6.env -p mw-issue13-optimized-r6 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized-r6.compose.yaml up -d --wait postgres'
sg docker -c 'docker compose --env-file /tmp/market-watch-issue13-optimized-r6.env -p mw-issue13-optimized-r6 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized-r6.compose.yaml stop postgres'
# UI：重新启动已验证的隔离服务，沿用私有材料及冻结产品挂载
sg docker -c 'docker compose --env-file /tmp/mw-issue13-optimized-browser-private/compose-r6.env -p mw-issue13-optimized-r6 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized-r6.compose.yaml -f /home/quant/repos/market-watch-issue13-r6-acceptance/docs/verification/issue-13/optimized_browser.compose.yaml up -d --no-build postgres api publisher web chart-origin'
sg docker -c 'docker compose --env-file /tmp/mw-issue13-optimized-browser-private/compose-r6.env -p mw-issue13-optimized-r6 -f /home/quant/repos/market-watch-issue13-plan/docs/verification/issue-13/optimized-r6.compose.yaml -f /home/quant/repos/market-watch-issue13-r6-acceptance/docs/verification/issue-13/optimized_browser.compose.yaml stop api publisher web chart-origin postgres'
```

资源收尾记录：按AGENTS要求执行 `mw-docker retire --task mw-issue13-optimized-r6 --project mw-issue13-optimized-r6` 预检查，工具拒绝识别以sha256 ID固定的PG镜像，其实现仅识别postgres标签格式。没有执行`--apply`或删除任何资源。共享依赖镜像和证据卷保留，任务未在生命周期工具中标记退役完成。修正工具兼容性、归档并实际恢复验证后再退役属于独立基础设施后续，应用实现与验收不因此改判失败。禁止绕过工具删除卷、全局prune或迁往unraid。
