# v1.14.1 发布性能与回退核验修复源码交付

2026-10-08。用户授权合并 [PR #21](https://github.com/hezongyi/market-watch/pull/21) 并推 tag，按兼容缺陷及性能修复采用补丁版本 `1.14.1`；Python/web/锁文件根包版本同步。附注标签 `v1.14.1` 指向本 PR 最终 main 合并提交，通过 `git rev-parse 'v1.14.1^{commit}'` 解析，保留所有旧标签。

发布整理以已复审 PR head `4d07139890889fde35863dd9c692a18e8a635b5a` 为输入，产品提交为 `9e51fcf`。只修改版本、更新日志和交付资料；711项运行源码、迁移、测试及构建/运维输入与该 head 逐字节一致，见 [源码输入](../deploy/releases/v1.14.1-source-inputs.json) 和 [发布清单](../deploy/releases/v1.14.1-source.json)。Python及前端依赖、锁文件依赖包保持不变，根包版本另行核对。历史验收镜像不改标为tag的新构建产物。

最终完整后端及52项ops为 **1455 passed / 2 skipped / 69 warnings / 8 subtests passed，705.39秒**，独立 Standards/Spec复审无阻断。修复旧应用 ingestion 后覆盖投影过期、大聚合回填独占服务以及合法闭市完整性误撤回；0.75CPU worker / 0.75CPU PG下真实50聚合目标持续30秒、每目标至少11轮、最长等待3.052秒。当前源码和历史r6性能/UI/长消费者证据的范围保持区别，见 [修复验收及资源终态](verification/issue-13/pr21-fix/review.md)。本次未重跑全部历史长场景。

发布版本 Python wheel `market_watch-1.14.1-py3-none-any.whl` 与 TypeScript/Vite构建均通过；前端保留既有大于500kB chunk提示。版本构建及哈希验证不冒充再次执行完整运行验收。匹配PG工具/可选日历造成的两项测试skip保留；验收库另用PG容器工具实际dump/restore并精确退役，19722地址已离线。其他17容器未变。

从 `am40_chart_revision_demand` 经 `an41_publication_state`、`ao42_coverage_projection`、`ap43_publication_service_order` 至 `aq44_aggregation_service_order`，新增迁移为additive，保留覆盖原始证明、可见快照及聚合 jobs，无新增应用依赖。正式部署先固定镜像、备份并实际恢复验证，停止旧写入者，升级schema，并逐发布身份 `coverage --until-complete --verify` 后启动唯一publisher。

应用回退须停止新写入者，以新版本运行 `prepare-rollback --workers-stopped`，先失效所有publication/checkpoint身份的覆盖完成标记，再重建旧bucket jobs，保留additive schema及原始证明。重新升级需停止旧写入者并再次逐身份核验；pending世代不能强行schema downgrade。详细操作见 [发布与回退说明](verification/issue-13/release-pr.md)。源码回退点为`v1.14.0`，实际生产回退仍依据前一部署清单及验证过的数据库备份。

本次为源码标签发布。未创建新生产镜像、未切换生产实例或执行生产迁移，未创建GitHub Release。凭据、数据库归档和许可库不提交。仓库无自动CI；当前验收不承诺供应商I/O、外部通知送达、长期稳定性或生产SLA。
