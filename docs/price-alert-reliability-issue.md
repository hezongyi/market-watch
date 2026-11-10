# 价格告警可靠性（实施 Issue 草案）

固定基线：`v2.0.3-rc.1` / `ef57bed61f66715a4c5ec2797f9abd67cb23d2fb`。
实施分支：`feat/price-alert-reliability-v203rc1`。

需求与完成标准以 [实施任务书](price-alert-reliability-v203rc1-implementation-plan.md) 为准，保留 A01–A24 全部验收范围。

风险分类 F1：新增持久输入、数据库迁移和后台判定链路。必须验证真实 PostgreSQL 事务、增量升级、并发、行为回退、Ubuntu 隔离 R2、浏览器全链路、固定负载性能，并完成独立 Standards/Spec review 和 CI。

不合并、不发布生产、不切换常驻实例。其他工作树、实例及数据保持独立。

## 实施进度

- 已核对远端 tag SHA，独立工作树已建立。
- 已实现输入表、增量迁移、流式/REST 同事务日志、触价分类、创建/编辑/恢复基准、顺序批次消费和执行转移的初版。
- 已在 Ubuntu 任务独立 PG 验证输入事务、回滚、并发和完整 Alembic 升级链。
- 当前证据与明确未完成项见 [验收记录](verification/price-alert-reliability-v203rc1/README.md)。
- 后续仍须完成收盘顺序消费、日志硬保留上限及所有连续性边界、到期结算、执行故障手机通知/独立巡检、UI、旧数据完整接管/回退、完整隔离验收与交付。
- 当前未完成验收，不能据此宣称可靠性保证已交付。
