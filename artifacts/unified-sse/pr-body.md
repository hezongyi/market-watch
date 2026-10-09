专业图表和自选表原先通过约 15 秒轮询更新自建/固定/组合行情。此改动使用认证的统一 SSE 出口、持久共享计算任务、世代/序号隔离和有界恢复；首次历史加载、分页和必要恢复继续使用 HTTP，后台预警保留独立需求。组合高周期复用当前 bucket 与确认增量，并保持账户、owner、修订和临时/确认语义。

同时修复半秒投递循环反复创建/锁定 client、重写租约的数据库开销。投递读取现有有效 client，仅在页面或活跃 listener 需要续租时批量更新；连续新增 listener 不再饿死旧 listener 的续租。两个问题均有先红后绿的 SQLite 和真实 PostgreSQL 回归。

### 相对原方案的实测成本

旧版本固定为本方案起点 `6fd9273`，优化业务镜像 `32bc00b`。两套 Ubuntu 本机 Docker 使用独立 project、PG、volume、network 和端口，运行各自旧/新 API、web 和许可 chart；相同历史、起始尾价与输入速率，125 秒预热后各测 60 秒。优化版包含新增 worker，旧版没有。

| 场景 | 平均 CPU 核增量 | 平均工作集增量 | WAL 旧→新（MiB/60秒） | 行情 HTTP 旧→新 |
| --- | ---: | ---: | ---: | ---: |
| 单周期 M1 | +0.110 | +101.8 MiB | 0.721→0.879（1.22×） | 8→0 |
| 八周期含 W1/MN | +0.264 | +128.5 MiB | 0.911→2.162（2.37×） | 36→0 |

SSE 逐值接受 10/32 次输入，原生回调 P95 2254/1813 ms；旧轮询允许合并中间值。新 client 每窗口只更新一次，但持久结果/计算任务仍增加 DB 事务、内部流量和 WAL。单窗口、合成 managed 负载；不包含宿主浏览器/fixture CPU/内存，不能推导生产容量、每日 WAL 留存或物理磁盘净增量。历史 6.6× 是同新版本 fallback 对照，不能用来计算本次优化降幅。上述成本是 `6fd9273` 对 `32bc00b` 的实际测量；最新生命周期与历史边界修复未重新测量净开销。

完整数据、方法、原始哈希和限制：`docs/verification/unified-sse/old-release-cost-report.md` / `old-release-cost-summary.json`。

### 验证与交付

- 独立复审发现并修复历史末柱遗漏、provider/managed 递归指标前缀遗漏，以及注册/续租/清理的两处 PostgreSQL 死锁和 Client/Task 并发回收竞态。旧代码有真实 HTTP 或真实 PostgreSQL 红测，新代码对应绿测。默认 `track_history=false` 的原生首读也携带尾柱修订凭据。
- 最终业务提交 `0ba1d285`：本地历史、stream/API、managed 与指标回归 106 passed；真实 Ubuntu PG 历史/生命周期/stream/固定指标/OANDA 锁序与 live 检查 109 passed，无 skip。两组真实 bridge 回调/重连 Node 检查、Ruff、Python 编译及构建通过；三位独立 Standards/Spec/Integration agent 均复审可合并。
- 最终 `0ba1d285` Ubuntu 镜像真实 OANDA Practice 组合闲置首屏、pricing owner 停止/恢复、双账户切换全部通过。验证旧账户报价隔离、历史身份不变、原账户恢复、最后 browser 取消后独立预警继续接数及最终需求释放。
- 更早多周期/EMA/双 API 共享/断网跨柱恢复证据保留各自实际运行 commit；不冒称这些矩阵都在最终提交重跑。完成审计见 `docs/verification/unified-sse/completion-audit.md` 与 `pr25-review-fixes-20261009.md`。
- 两套成本实例已按 `mw-docker retire` 预览、数据库备份及实际恢复逐表校验后精确退役；私有归档保留，资源残留 0。
- Practice 验收实例保留：Ubuntu `http://127.0.0.1:15643`，project `mw-unified-sse-20261008`，启停见验收 README。API/web/chart 镜像对应最终业务提交 `0ba1d285`，`dirty=false`；容器及数据库留作用户验收，未标记任务完成。

最终真实 OANDA Practice 证据及镜像逐容器标签、哈希摘要：`docs/verification/unified-sse/pr25-final-runtime-summary.json`、`pr25-review-fixes-20261009.md`。最终测试报告按实际 commit 分开列在同目录 `pr25-*.txt`，避免把合并 main 前或更早运行结果记到最终提交。

未部署或修改 unraid 生产。凭据、env、许可库、完整浏览器状态及数据库 dump 未提交。基线是原方案起点，不是当前 main 后续 OANDA 生产补丁；正式合并/生产发布前需按现有发布流程核验最终合并版本。长期稳定性未作为本轮短时验收的完成声明。
