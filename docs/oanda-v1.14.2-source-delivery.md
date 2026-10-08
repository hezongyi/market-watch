# v1.14.2 OANDA 本地恢复修复源码交付

后续执行已完成：[PR #22](https://github.com/hezongyi/market-watch/pull/22) 审查与合并、
附注 `v1.14.2` 推送、Ubuntu标签构建、生产切换、单次重试及完整600秒观察。
严格生产窗口仍失败，实际状态与回滚材料见
[正式交付记录](oanda-v1.14.2-production-delivery.md)。下文保留原PR创建时的准备记录。

2026-10-08。用户授权按建议正式发布、执行一次受控鉴权重试及600秒生产观察，
并要求本地补丁先提交 PR、review、合并，再推 tag。本轮采用补丁版本 `1.14.2`，
Python/web/锁文件根包版本同步；不覆盖旧标签、不改变来源身份、依赖或 schema。

本地缺陷包括报价确认与历史计划／发布写入的锁序反转，以及 CONNECT 后 TLS
失败使 owned stream 的单槽池永久占用。修复和真实 PostgreSQL／确定性池回归见
[原始修复记录](investigations/oanda-stream-reconnect-fix.md) 与
[后续证据](investigations/oanda-timeout-follow-up.md)。有限阶段日志随产品发布；
transport read、chunk、完整记录和 publish 四层包装仅在 Ubuntu 验证进程中启用。

运行产品源码与 `b7376b9` 一致，本次另加版本元数据；验证模块保留后续竞态及解析
分类修正。当前717项源码输入哈希见
[输入清单](../deploy/releases/v1.14.2-source-inputs.json)，
[发布清单](../deploy/releases/v1.14.2-source.json) 记录 schema 和残余风险。
已验证的72项 installed-image 选择集、后续10项扩展 pipeline 选择集并非独立全集，
不能相加。标签版本的构建及安装内容另行核对，不给旧验收镜像改标冒充新构建。

完整真实600.025秒窗口因 EURUSD freshness 失败；首响应头停滞、REST TLS 与
历史成熟流读取超时责任未定。用户决定暂停 EURUSD 根因深挖，并将其余故障转为
有触发条件的监测。这个预算决定没有放宽15秒新鲜度或把失败窗口改判通过。

PR review 对固定 head 分别检查 Standards 和 Spec；review 结果、实际 PR 合并
提交及附注 `v1.14.2` 标签以 GitHub／Git 终态核对。本文件创建时它们尚未完成，
不能从计划推断已经合并或已部署。最终发布来源使用 `v1.14.2^{commit}`。

生产切换只使用 Ubuntu `mw-docker` 从已合并标签构建的固定镜像。原先
[发布评审方案](investigations/oanda-release-review.md) 的 b7376b9 候选保留为
准备阶段证据，正式交付由新的标签构建及实际生产清单替代。切换前验证原配置及
旧镜像、备份并在 Ubuntu 独立 PG14 实际恢复检查；仅替换明确的后端服务，保留
原 web/chart/backup 镜像、网络、凭据、用户配置与兼容 schema。

当前旧生产的 `unauthorized` 持久化暂停不会由换镜像自动解除。按用户本次授权，
仅在有效配置及失效 lease 核对后通过现有鉴权接口执行一次受控重试；再次出现
401/403就停止并保留保护状态。生产600秒观察分别报告连接、确认、发布、租约和
报价质量，不声称补丁能解决全部外部故障。没有自动下单或通知测试。

正式部署和回滚记录另行写入实际生产清单；应用回退保留数据库及新数据、不做
schema downgrade、不自动清除鉴权暂停。任务未完成时不退役隔离资源。
