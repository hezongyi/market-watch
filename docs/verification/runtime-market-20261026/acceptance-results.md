# 阶段 0：验收记录（阈值待确认）

基线 `78697159067e1c1bc6c38be8ca8218cd12c29179`，隔离实施分支 `refactor/runtime-market-consolidation-20261026`。代码/调用边界与退役影响见 `implementation-reuse-inventory.md`、`ownership.md`、`data-retention-inventory.md`；并发原始数据与结论见 `baseline.md`、`results/baseline-summary.json`。固定镜像、Ubuntu 资源和 schema 证据见 `results/environment.json`、`results/instance-inventory.json`。

已完成：合同选择 127 passed；十个相关 PostgreSQL 套件 150 passed、1 skipped（需另挂 v1.14.0 旧源码的既有升级专项，不计作通过）；运维合同 97 passed、68 subtests passed，缺应用依赖的三个 DatasetTests 在固定镜像内另行 3 passed；报告分母回归 3 passed；原子来源输入 SQLite/PostgreSQL coherency wrapper 2 passed。wrapper 输出见 `results/atomic-source-postgres-contracts.txt`。

五场正式 owner 进程均正常停止，无未发布确认输入；已生成信号都有 NoticeEvent 和 stub server acceptance。按窗口 oracle，normal、busy、candidate(1s)、slow-source 均无事件窗口错漏；candidate aggressive control(0.05s) 漏一个末段盘中事件，应视为争用/正确性失败，不计作目标预算通过。每场仍有 1–2 个输入/规则配对没有 ready judgment，详情保留在 summary 和 `known-risks.md`。不以预测百分位掩盖这些未处理对。

慢源只模拟 ProviderInterest 返回 TimeoutError；没有模拟真实外部网络断线恢复、ntfy 服务端故障或手机到达。candidate 是约 2160 根 M1 历史及九周期和 EMA 的合成准备；1 秒循环就绪 28.20 秒，0.05 秒对照 14.04 秒。单样本 fixture 不认证周日代表数据全量处理、长期 p99 或生产恢复时限。没有新服务拓扑、HTTP/browser/SSE、目标低优先级调度器或真实恢复测量；这些属于后续阶段验收。

人工门槛：用户已于 2026-10-27 接受 `acceptance-thresholds.md` 所列业务门槛，确认范围和依据见该文件。待本 PR Backend CI 通过后阶段 0 签收；阶段 2 按固定门槛验收。本阶段不合并 main、不发 tag、不部署生产、不执行真实通知或永久清理。
