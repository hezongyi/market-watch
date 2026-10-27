# 行情运行组收敛执行记录

2026-10-27：开始阶段 0。基线 `v1.29.1 / 78697159067e1c1bc6c38be8ca8218cd12c29179`，origin/main 同提交；正式 tag 是 annotated tag，比较 peeled commit，不把 tag object SHA 当作代码不一致。

已阅读 AGENTS.md、完整方案及第 12 节、前置完成审计。新 worktree/branch 独立；未复用/删除 release 工作树的私有文件。单前端、旧 Watch 退役、共享查询提取只复核。

风险 F1（重要后台链路与恢复）；阶段 0 新增材料/测量脚本不迁移调度、不改业务表模型。后续适用 PG/R2、Standards/Spec review；各阶段独立 PR，合并前停止报告。

本机前置资源：Ubuntu Docker default；已有 mw-issue75-v2-20261018、mw-single-frontend-20261026 两项目，保留。MemAvailable 6.2 GiB、磁盘可用 26 GiB，swap 几乎用满；不能把争用环境当空闲机容量。阶段 0 只新增 PG（0.75 CPU/768 MiB）和按需 probe（1.5 CPU/1536 MiB），独立 project/network/volume/凭据，无宿主端口，无外部网络；不部署第三个完整网页验收栈。后续五/六服务联合实例预算须重新核实。

基线镜像复用已在本机的正式构建：`sha256:995534fb1c8238b5a71f2155017bafe439000c6f0cb78708f17471d2c6542743`，OCI commit 为本基线且 dirty=false；只读使用，不修改正式 tag。任务代码只读挂载，凭据在 checkout 外。

命令（保留数据，不执行 down -v）：

```bash
cd /home/quant/repos/market-watch-runtime-20261026
docker compose --env-file /home/quant/.local/share/market-watch-runtime-20261026/compose.env \
  -p mw-runtime-20261026 -f deploy/ubuntu/runtime-market.baseline.yaml up -d postgres
docker compose --env-file /home/quant/.local/share/market-watch-runtime-20261026/compose.env \
  -p mw-runtime-20261026 -f deploy/ubuntu/runtime-market.baseline.yaml run --rm probe
docker compose --env-file /home/quant/.local/share/market-watch-runtime-20261026/compose.env \
  -p mw-runtime-20261026 -f deploy/ubuntu/runtime-market.baseline.yaml stop
```

用户已于2026-10-27明确接受建议业务门槛，确认记录见 acceptance-thresholds.md。阶段0产物/验证完成，PR CI Backend 最终检查仍须核实后再标记签收；不涉及合并 main、正式发布、生产操作、真实 ntfy 投递或永久删除。

合同回归 127 passed；十个任务 PG 套件 150 passed、1 skipped（需要 v1.14.0 源码挂载的旧进程专项，不计通过）。运维检查 97 passed、68 subtests，三个应用依赖项在基线镜像另跑 3 passed；事件分母两项回归包含于运维检查。新脚本 ruff 通过。schema head `ay52_history_modes`。试跑校正与失效证据见 `probe-corrections.md`；正式采样采用连续业务时钟、61×2秒/场，包含四场及同资源快重建对照，测量期间不并跑性能/PG套件。

正式五场采样均已结束。normal、busy、candidate(1s)、slow-source 各13个事件且按窗口 oracle 通过；aggressive candidate(0.05s) 只有12个，末段盘中窗口缺失。前四场仍各有1–2个未处理输入/规则对，完整分母已保留。candidate(1s) 28.20s 就绪。报告、原始 JSONL 压缩副本和只读实例盘点均已生成；candidate 更快但事件缺失，不能作为可接受预算。environment.json 记录其他 Docker 项目同时运行、host load约6–9。业务门槛已接受，阶段1可推进；阶段2仍须按固定门槛验收。
