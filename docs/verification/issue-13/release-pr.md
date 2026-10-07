# Issue #13 发布 PR 与操作说明

远端 PR [#21](https://github.com/hezongyi/market-watch/pull/21) 的合并前复审发现并修复了覆盖投影在旧应用写入后过期、最老聚合回填独占服务两个 P1 阻断（`a6ecbbb`），以及核验误撤回合法闭市完整性的 P2（`9e51fcf`）。最终产品为 `9e51fcf`，迁移 head 为 `aq44_aggregation_service_order`；当前验证与复审见 [PR #21 修复验收](pr21-fix/review.md)。本 PR 准备 v1.14.0 后的发布性能修复，不自行确定版本、合并主线或部署生产。

历史交付基点 `1636af3`，产品合并 `63bad46`，r6 验收冻结源 `bcaefcf`，原始记录见 [r6-closeout.md](r6-closeout.md)。其 175 个产品/迁移文件字节相等证明只适用于修复前产品；`a6ecbbb` 已改变产品及迁移，不能据此宣称当前产品与 r6 相同或全部性能场景重新跑过。历史原始证据保留。

没有变化时发布 worker 进入低成本等待；新输入在事务提交后唤醒；历史、修订和高周期聚合按可恢复小片推进，全局服务序号保证多目标轮转，失败仅延后其目标。覆盖证明改为增量投影，正常完成路径不从审计重建覆盖。告警固定 origin 下推并保留合法前驱；生产/探针共用 0.75 秒 monitor。

历史 r6 验证：Ubuntu 本机独立数据库与端口，完整后端1389通过/2跳过，79数值关卡通过；同价50/50/50、正常310/310/310，认证上界p95为0.723/0.805秒；90发布目标持续等待4.769秒，组合故障5.351秒；三轮回填2717.99–2726.05bars/s；真实双图/save/reload、提交前后崩溃及覆盖重放通过。该旧回退探针未覆盖旧 ingestion 新增证明，本次补充真实旧进程写入回归。当前完整回归、真实聚合公平性及备份恢复结果单独记入修复验收，以上历史数值不作为当前代码的重新测量。

迁移前，发布负责人需完成正式镜像固定、正式数据库备份与恢复验证，停止所有旧写入者和发布拥有者。此文是可审查的操作方案，尚未获得生产执行授权。容器内工作目录为 `/app`、`PYTHONPATH=/app/backend`，数据库配置来自私有环境，不能写入仓库。

1. 使用最终新应用镜像执行 `alembic upgrade head`，从 `am40_chart_revision_demand` 经 `an41_publication_state`、`ao42_coverage_projection`、`ap43_publication_service_order` 至 `aq44_aggregation_service_order`。迁移为 additive，保留原始覆盖证明、可见快照及待处理聚合任务。
2. 按真实发布身份逐项运行 `python -m alerts.publication_admin coverage --instrument IDENTIFIER --limit 500 --until-complete --verify`。普通页有界；最终 `--verify` 会在身份锁内扫描全量证明，应安排维护窗口。未通过verify不能跳过兼容读取或宣称覆盖迁移完成。
3. 只启动一个新发布拥有者。检查请求世代、历史/聚合进展、覆盖相等、快照与修订，观察CPU/SQL/输入完整性和延迟。Ubuntu合成验收不是生产或供应商SLA。

应用回退时停止全部新写入者和publisher，以新版本维护入口运行 `python -m alerts.publication_admin prepare-rollback --workers-stopped`。该入口先分页使全部 publication/checkpoint 身份的覆盖投影完成标记失效（包含尚未发布身份及其所有来源/口径检查点），再重建旧bucket jobs；不确认任何待处理世代。保持 additive schema及原始证明，切回上一正式应用镜像，再启动唯一旧publisher。实际旧 `131bf3c` ingestion 新增分钟及旧publisher接续已在本次隔离PG回归验证。

重新升级时再次停止旧写入者，执行上述迁移与逐身份 `coverage --until-complete --verify`，核对旧写入期间新增或修正的原始证明后再启动唯一新publisher。未完成核验时保留兼容读取。显式 `--verify` 对已完成投影也真实重扫；无变化重复核验不增加发布修订。正常 publisher 不执行全量证明扫描。行政核验可能撤销失效证明对应的高周期 completeness 并重排聚合，必须安排维护窗口。

不把 `alembic downgrade` 作为快速应用回退方式。待处理请求存在时schema回退守卫会拒绝；如必须撤回schema，需另行维护计划、数据备份和pending确认。生产备份、正式镜像、版本与切换时间由正式发布步骤确定，不由本PR代替。

已知限制：两项完整回归跳过来自可选日历依赖/匹配PG dump工具；发布三重复性能明确继承未运行monitor的r5字节相等组件，r6全部monitor消费者及恢复重新实际运行；宿主竞争/限流记录保留，未证明外部通知送达或供应商I/O。PG、Python、chart等跨任务依赖镜像只保留，不进行全局回收。最终资源退役结果单独记入 [resource-retirement.md](resource-retirement.md)。
