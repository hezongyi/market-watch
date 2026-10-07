# v1.14.0 三层行情与数据中心源码交付

2026-10-07。PR [#20](https://github.com/hezongyi/market-watch/pull/20) 新增平台、自建和组合三层行情及数据中心。用户授权合并并推 tag，使用兼容功能次版本 1.14.0；Python/web/锁文件根包版本一致。附注标签 `v1.14.0` 指向 PR #20 最终 main 合并提交，以 `git rev-parse 'v1.14.0^{commit}'` 解析，不移动已发布的 `v1.13.0` 或其他旧标签。

供应商原生周期、固定自建 M1 发布版本和指定实时来源接续各自保留身份、日历、覆盖和价格口径。组合图表、指标、策略和预警使用可审计输入；回测固定自建发布版本。数据中心提供维护任务、周期发布、版本比较、引用保护及精确回收。盘中报价间隔超过 15 秒先建立恢复基准，旧组合修订图表保持实际目标租约，独立续期和过期。

受测与复审通过的最终功能提交为 `b261423bf6747ccc858dea6eb525181181374d14`，含当前 main `3d5dce8`；发布整理只修改版本和资料。逐文件 SHA256 见 [源码输入](../deploy/releases/v1.14.0-source-inputs.json)，发布范围见 [清单](../deploy/releases/v1.14.0-source.json)。发布输入须与受测提交逐字节一致，版本字段另行核对。原运行镜像已按实际来源记录并退役，不改标为新 tag 的构建产物。

完整后端含独立 PostgreSQL：1324 passed / 2 skipped / 59 warnings。跳过项已补验日历 4 项、真实 PG14.24 备份恢复 1 项通过；修复、迁移、并发及容器内定向检查与 Standards/Spec 结论见 [复审报告](verification/pr20-review-20261007.md)。原完整 A–E、HTTP/MCP 和浏览器实现验收见 [完成核对](verification/three-layer/completion-audit.md)。发布元数据的 Python wheel、TypeScript/Vite 构建及输入哈希单独核对，不冒充重新执行完整运行验收。

新增 `dukascopy-python==4.0.1`，数据库从既有 `u22_chart_alert_actions` 路径升级到 `am40_chart_revision_demand`，具体新增迁移列表见发布清单。实际部署需先备份并验证恢复，再执行 `alembic upgrade head`，启动配置所需历史、原生历史、组合聚合与实时采集 worker。升级保留旧规则和固定版本；schema 回退需依据验证过的备份与实际部署清单，不能仅切回旧源码。

本次源码发布不部署生产。Ubuntu `mw-pr20-review-fix` 专属资源已备份、实际恢复核对并退役；原验收地址不再运行，其他任务和生产保持既有状态。长时间质量观察按用户决定暂缓，不宣称长期稳定性或策略 15 秒 SLA；采样报价不承诺全 tick/瞬时极值。MT4 实时接入与自动下单不在本次交付范围。凭据、许可资源、数据库及完整私有证据未提交。
