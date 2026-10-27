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

用户已于2026-10-27明确接受建议业务门槛，确认记录见 acceptance-thresholds.md。阶段0门槛检查点与基线 CI 已通过 PR #100，阶段0完成。阶段1A 已由 PR #101 验证通过。当前 PR #102 是阶段1边界切片，最终 SHA `2e85bfc5` 的 Backend（3094 passed、3 skipped）、Web、Compose、分类检查全通过；该 PR 通过不代表阶段1的实时开关资格语义或后续阶段完成。不涉及合并 main、正式发布、生产操作、真实 ntfy 投递或永久删除。

合同回归 127 passed；十个任务 PG 套件 150 passed、1 skipped（需要 v1.14.0 源码挂载的旧进程专项，不计通过）。运维检查 97 passed、68 subtests，三个应用依赖项在基线镜像另跑 3 passed；事件分母两项回归包含于运维检查。新脚本 ruff 通过。schema head `ay52_history_modes`。试跑校正与失效证据见 `probe-corrections.md`；正式采样采用连续业务时钟、61×2秒/场，包含四场及同资源快重建对照，测量期间不并跑性能/PG套件。

正式五场采样均已结束。normal、busy、candidate(1s)、slow-source 各13个事件且按窗口 oracle 通过；aggressive candidate(0.05s) 只有12个，末段盘中窗口缺失。前四场仍各有1–2个未处理输入/规则对，完整分母已保留。candidate(1s) 28.20s 就绪。报告、原始 JSONL 压缩副本和只读实例盘点均已生成；candidate 更快但事件缺失，不能作为可接受预算。environment.json 记录其他 Docker 项目同时运行、host load约6–9。业务门槛已接受，阶段1可推进；阶段2仍须按固定门槛验收。

2026-10-27：阶段 1 实时开关切片在独立 worktree `/home/quant/repos/market-watch-runtime-switch-20261027`、分支 `refactor/managed-realtime-switch-20261027` 推进。实现基于阶段 1 边界 Draft PR #102 当前代码 `210083f6`；持久配置复用 Preference，不改 schema。详情及 PG 隔离环境见 `stage-1-realtime-switch.md`。兼容初值为一次性持久快照，显式 off 优先；既有启用状态和有效消费者状态可保留，新注册纯历史数据默认 off。资格检查覆盖开关、来源新鲜度、接缝准备、规则周期发布及聚合水位。曾发现并修正 resident OANDA 无条件采集、未准备状态进入告警资格，以及历史 join 错误默认打开。

最终阶段门槛继续推进：SQLite 跨模块合同 **234 passed**；隔离 PostgreSQL 开关、告警并发、OANDA owner/recovery **48 passed**。ruff 和 `git diff --check` 通过。独立 Standards/Spec review 已发现并修复四项问题：resident 实时流绕过开关、告警资格漏接缝/周期准备、历史 join 默认打开、直接 OANDA 浏览器 lease 被错误套用 managed 开关。全后端无 TEST_POSTGRES_URL 的一次运行 2436 passed、9 failed、661 skipped、38 setup errors；PG fixture 缺环境变量，且执行时处在较早代码状态，不作为最终通过证据。当前 Draft PR #102 未被本分支修改；实时开关分支尚未推送，最终独立 review 与该分支 CI 尚未完成。
