# Issue #13 发布 PR 与操作说明

交付基点 `1636af3`，产品合并 `63bad46`，实际验收冻结源 `bcaefcf`。远端 PR [#21](https://github.com/hezongyi/market-watch/pull/21)。本 PR 准备 v1.14.0 后的发布性能修复，不自行确定版本、合并主线或部署生产。最终验收见 [r6-closeout.md](r6-closeout.md)，原始证据及限制完整保留。

没有变化时发布 worker 进入低成本等待；新输入在事务提交后唤醒；历史、修订和高周期聚合按可恢复小片推进，全局服务序号保证多目标轮转，失败仅延后其目标。覆盖证明改为增量投影，正常完成路径不从审计重建覆盖。告警固定 origin 下推并保留合法前驱；生产/探针共用 0.75 秒 monitor。

验证：Ubuntu 本机独立数据库与端口，完整后端1389通过/2跳过，79数值关卡通过；同价50/50/50、正常310/310/310，认证上界p95为0.723/0.805秒；90目标持续等待4.769秒，组合故障5.351秒；三轮回填2717.99–2726.05bars/s；真实双图/save/reload、提交前后崩溃、旧应用回退及覆盖重放通过。固定镜像ID退役与保留共享依赖修复由52项ops测试验证；数据库退役另以真实dump/restore、全业务schema行数及内容指纹证明。

迁移前，发布负责人需完成正式镜像固定、正式数据库备份与恢复验证，停止所有旧写入者和发布拥有者。此文是可审查的操作方案，尚未获得生产执行授权。容器内工作目录为 `/app`、`PYTHONPATH=/app/backend`，数据库配置来自私有环境，不能写入仓库。

1. 使用最终新应用镜像执行 `alembic upgrade head`，从 `am40_chart_revision_demand` 经 `an41_publication_state`、`ao42_coverage_projection` 至 `ap43_publication_service_order`。迁移为 additive，保留原始覆盖证明和可见快照。
2. 按真实发布身份逐项运行 `python -m alerts.publication_admin coverage --instrument IDENTIFIER --limit 500 --until-complete --verify`。普通页有界；最终 `--verify` 会在身份锁内扫描全量证明，应安排维护窗口。未通过verify不能跳过兼容读取或宣称覆盖迁移完成。
3. 只启动一个新发布拥有者。检查请求世代、历史/聚合进展、覆盖相等、快照与修订，观察CPU/SQL/输入完整性和延迟。Ubuntu合成验收不是生产或供应商SLA。

应用回退时停止全部新写入者和publisher，以新版本维护入口运行 `python -m alerts.publication_admin prepare-rollback --workers-stopped`，分页重建旧bucket jobs。保持 additive schema及原始证明，切回上一正式应用镜像，再启动唯一旧publisher。实际旧131bf3c应用接续已在隔离库验证；不把新旧publisher同时运行作为切换策略。重新升级可由新版本读取持久世代接续。

不把 `alembic downgrade` 作为快速应用回退方式。待处理请求存在时schema回退守卫会拒绝；如必须撤回schema，需另行维护计划、数据备份和pending确认。生产备份、正式镜像、版本与切换时间由正式发布步骤确定，不由本PR代替。

已知限制：两项完整回归跳过来自可选日历依赖/匹配PG dump工具；发布三重复性能明确继承未运行monitor的r5字节相等组件，r6全部monitor消费者及恢复重新实际运行；宿主竞争/限流记录保留，未证明外部通知送达或供应商I/O。PG、Python、chart等跨任务依赖镜像只保留，不进行全局回收。最终资源退役结果单独记入 [resource-retirement.md](resource-retirement.md)。
