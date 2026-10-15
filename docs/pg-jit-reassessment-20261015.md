# PostgreSQL 14.24 与 JIT 重新评估

## 建议

不把“为旧版本止血”固化为所有 Market Watch 连接永久关闭 JIT。建议 #65 改为可按服务配置的“继承 / 开启 / 关闭”，应用默认继承数据库设置，保留回滚旧 PG 时显式关闭的能力。

生产暂时保留现有 Market Watch 专属关闭设置。完成配置修正后，先用单个聚合 worker 的连接级开启做受控验证，记录任务吞吐、查询延迟、数据库进程内存和宿主机压力，再决定扩大。此次没有修改生产设置、重启生产服务、合并或改写 #65。

统一未来 Ubuntu 验收基线到 PostgreSQL 14.24 的已核验固定镜像；启动时实际检查 `server_version_num=140024`、JIT 是否可用及应用连接的实际 JIT 状态。后续更新补丁版本应显式审查并同步镜像白名单。PG17 兼容性测试另用独立数据库和 volume，不直接替换既有数据目录。

## 生产现场只读核验

2026-10-15，通过已有 `ssh unraid` 连接，对现有 `postgresql14` 查询实际服务端版本与配置，没有创建远端测试实例。

- 主机：Unraid `192.168.7.33`。
- `postgresql14` 正在运行，镜像引用为 `postgres@sha256:dcc2ca942d8518144f387a0c2630188427835f984caaed0418b986928e761809`。
- 二进制和 SQL 查询均报告 `14.24 (Debian 14.24-1.pgdg12+2)`。
- 连接 `postgres` 数据库时 `jit=on`；连接 `market_watch` 时 `jit=off`。
- `pg_db_role_setting` 实际记录为 `market_watch/* jit=off` 及 `market_watch/market_watch_app jit=off`。后者是“角色在指定数据库”的设置，并非整个实例的全局关闭。
- 现有 12 个 Market Watch 生产服务运行中，API 为 healthy。

因此，生产 PG **已经升级**，不依赖 #65 合并。未来恢复继承时，需要同时核对数据库默认设置和 `ALTER ROLE ... IN DATABASE ...` 设置；只删除代码里的 `jit=off` 不会恢复。

## 方法与范围

- 实际运行主机：Ubuntu `quant-server`，本机 Docker。
- 工作树：`/home/quant/repos/market-watch-jit-reassessment-20261015`，分支 `research/pg-jit-reassessment-20261015`。
- 应用查询来源：`dbb55c1c9f34d785ddf825f8ea539b0759f6e948`；没有修改应用查询实现。依赖复用 v1.25.4 应用镜像，由 `mw-docker` 的 `market-watch-ubuntu` builder 构建本任务的专属标签镜像，代码以只读方式挂载。
- Compose project：`mw-pg-jit-reassessment-20261015`，独立内部网络、volume、数据库、资源限制。没有公开宿主机端口，没有网页入口；仅本任务内部地址 `postgres:5432/jit_assessment`。
- PG 固定镜像：`postgres:14-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872`，实际版本 14.24，LLVM JIT 可用。
- 原始 JIT 阈值保持默认：100000 / 500000 / 500000；只有单独的重复内联控制实验显式设为 0。
- 数据全部合成：139 个品种、60761 项任务、200160 根 M1。品种与队列规模参考生产 `pg_class.reltuples`，没有复制生产业务数据。生产行情表估计约 2100 万行，本轮没有等规模恢复，不能把本轮耗时当生产容量承诺。
- 主对照交替执行 on/off，每种预热两轮后取 7 次中位数；分析型控制查询取 5 次中位数。查询实际执行结果计算摘要，断言 on/off 一致。
- 调度 SQL 从真实 `aggregate_once()` 的执行边界捕获；分钟 SQL 从真实 `aggregate_touched()` 捕获，没有手写近似替代查询。另完整执行 worker，事务末尾回滚，确保输入相同，并验证产生 8 根相同聚合柱、无重试错误。

## 耗时结果

下表 SQL 项为 `EXPLAIN ANALYZE` 的执行时间；worker 项为完整 Python 调用耗时，二者不能混作同一种计时口径。

| 场景 | JIT off 中位数 | JIT on 中位数 | 解释 |
|---|---:|---:|---|
| 已过等待阈值的队列、无活跃需求 | 486.551 ms | 505.813 ms | 开启慢约 4.0%，编译约 20.9 ms |
| 索引读取一天 M1 | 0.491 ms | 0.493 ms | 未触发 JIT，差异接近测量噪声 |
| 新任务队列、40 个活跃图表需求 | 1398.413 ms | 1344.745 ms | 开启快约 3.8%，含内联与优化，编译约 301.4 ms |
| 完整聚合 worker，生成 8 根 M15 | 1395.629 ms | 1342.434 ms | 开启快约 3.8%，产物摘要一致 |
| 合成计算密集控制查询 | 714.012 ms | 699.014 ms | 开启快约 2.1%，仅作为控制，不代表业务统计需求 |

空需求表的物理页和统计状态会影响计划成本与是否触发 JIT。本轮正式数据来自同一任务数据库重跑后的状态，需求过期删除后保留物理页；首次全新空表的试跑未触发该查询的 JIT。复测应对照保存的计划成本、JIT 选项和表统计，不应只比较标签或 SQL 文本。

这说明 JIT 收益取决于查询与计划。当前样本没有显示关闭会造成大幅退化，也没有证明所有环境应关闭。复杂任务选择占完整 worker 耗时的大部分，队列选择算法和计划的后续优化可能比切换 JIT 更有价值。

## 连续执行与内存

真实调度 SQL 在同一持久连接上分别执行 60 次：

| 模式 | 第 1 次 RSS | 第 60 次 RSS | 增量 | 第 2–60 次平均后端 CPU 时间 |
|---|---:|---:|---:|---:|
| off | 161044 KiB | 161044 KiB | 0 | 1.368 s/次 |
| on | 161060 KiB | 162076 KiB | 1016 KiB | 1.310 s/次 |

补充快速控制：每种模式使用独立新后端，对 10 行计算强制 JIT 阈值为 0，连续执行 1000 次，确认实际 `Inlining=true`、`Optimization=true`。

- off：RSS 从 15712 KiB 到 15712 KiB。
- on：首次执行后 RSS 92924 KiB，1000 次后 96716 KiB，增加 3792 KiB，呈阶梯增长。
- JIT/LLVM 加载本身增加进程 RSS，其中可能包含共享库页面；不能把各连接 RSS 直接相加当作宿主机独占内存。

本轮未出现快速内存失控，但**没有证明长期零增长或完全排除泄漏**。不能把上述小幅增长直接归因为同一缺陷，也不能把短测包装成长期稳定性结论。这是生产仍先保留关闭、后续受控恢复的依据之一。本轮没有重现 PG14.10 的历史事故，也不新增确认其全部因果链。

## #65 建议调整项

1. 应用默认继承数据库设置；支持显式 on/off，并兼容已有 true/false 配置。
2. 生产模板改为可按服务覆盖的配置；区分生产暂时关闭和应用通用默认值。
3. 修正连接参数合并：当前新增的 `connect_args['options']` 会覆盖数据库 URL 已有 `options`，可能丢失 `search_path` 或 `statement_timeout`。补充实际连接参数保留以及三种模式的回归验证。
4. 统一验收 PG 的固定版本与 digest，并核验实际服务端版本。根 `compose.yaml` 仍为 PG17，多份验收模板仍为可变 `14-bookworm`；备份 Dockerfile 仅固定 `pg_dump` / `pg_restore` 客户端，不能代表数据库服务端升级。
5. 保留官方固定备份客户端镜像和必要的事故证据，将“旧版应急保护”与“升级后长期性能策略”分开描述。

## 复测入口与资源状态

脚本位于 [scripts/pg_jit_reassessment](../scripts/pg_jit_reassessment/)。常规 Ubuntu 环境先用新任务名构建专属镜像，再执行：

```bash
export MW_JIT_RESULTS=/tmp/mw-pg-jit-reassessment-rerun/results
export MW_JIT_IMAGE=market-watch-api:pg-jit-reassessment-rerun
mkdir -p "$MW_JIT_RESULTS"
# TASK/PROJECT 使用新的任务名；本轮名称已退役，不能重新登记为进行中。
mw-docker build --repo . --component api \
  --context scripts/pg_jit_reassessment --file scripts/pg_jit_reassessment/Dockerfile \
  --tag "$MW_JIT_IMAGE" \
  --task mw-pg-jit-reassessment-rerun --project mw-pg-jit-reassessment-rerun --purpose acceptance
docker compose -p mw-pg-jit-reassessment-rerun -f scripts/pg_jit_reassessment/compose.yaml up -d --no-build
docker wait mw-pg-jit-reassessment-rerun-assessment-1
docker compose -p mw-pg-jit-reassessment-rerun -f scripts/pg_jit_reassessment/compose.yaml run --no-deps --rm assessment python /workspace/scripts/pg_jit_reassessment/worker.py
docker compose -p mw-pg-jit-reassessment-rerun -f scripts/pg_jit_reassessment/compose.yaml run --no-deps --rm assessment python /workspace/scripts/pg_jit_reassessment/memory.py
# 仅停止本任务：
docker compose -p mw-pg-jit-reassessment-rerun -f scripts/pg_jit_reassessment/compose.yaml stop
# 结束时先预览，再归档和实际恢复校验后精确退役：
mw-docker retire --task mw-pg-jit-reassessment-rerun --project mw-pg-jit-reassessment-rerun
mw-docker retire --task mw-pg-jit-reassessment-rerun --project mw-pg-jit-reassessment-rerun --apply
```

本轮执行器对用户目录只读，原 `mw-docker` 台账无法写入；临时启动器将该工具的 STATE 和 Docker CLI 元数据放在 `/tmp/mw-pg-jit-reassessment-20261015/`，复用已有本机 socket 权限，仍使用原构建、镜像归属校验、固定 builder、归档和恢复校验逻辑，没有修改已安装工具或其他任务台账。执行入口为 `python /tmp/mw-pg-jit-reassessment-20261015/mw-docker-task.py build|retire ...`。

数值、完整计划、实际 SQL、worker 产物摘要和文件 SHA-256 位于 [验证证据](verification/pg-jit-reassessment-20261015/sha256.json)。私有 Docker inspect、数据库归档及生命周期台账留在临时任务目录，不提交仓库。

本轮已先预览，再执行任务限定的退役：数据库逻辑归档、实际恢复及内容校验通过，`restore_verified=true`。本任务两个容器、专属网络、volume 和无引用专属应用镜像已清理，生产和其他任务未调整。私有归档位于 `/tmp/mw-pg-jit-reassessment-20261015/lifecycle/archives/mw-pg-jit-reassessment-20261015-20261015T083114-02038098`；属于临时任务材料，不是生产回滚备份。

## 官方依据

- [PostgreSQL 14.11 发布说明](https://www.postgresql.org/docs/release/14.11/)：明确修复 JIT inlining 内存泄漏及反复编译后的 OOM。
- [When to JIT](https://www.postgresql.org/docs/14/jit-decision.html)：长时间 CPU 密集查询更可能受益，短查询可能被编译开销拖慢；按估算成本决定编译与内联。
- [JIT Configuration](https://www.postgresql.org/docs/14/jit-configuration.html)：`jit=on` 允许功能，是否对某条查询使用仍取决于阈值和可用实现。
