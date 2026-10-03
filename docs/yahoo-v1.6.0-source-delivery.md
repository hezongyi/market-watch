# v1.6.0 Yahoo 原生行情与中文搜索源码交付

2026-10-03。新增 Yahoo 原生七周期行情、延迟报价和平台品种中文搜索，继续使用现有指标、工作区、画线与 CSV。Yahoo 仅提供平台系列；美股/ETF 自动复权，其他资产保留供应商价格。默认关闭源开关，所有上游访问使用后端配置代理；未开放 M30/H4，不将小周期合成为大周期。

实现及四项审查修复通过 [PR #5](https://github.com/hezongyi/market-watch/pull/5) 合入 main，合并提交为 `4ef0e845f2acc63e68ede8603d3a622086444e66`；最终受测功能提交为 `b747d5b5656c8dbcca3cab8c9e8dd7e6c28071e9`。发布基线标签为 v1.5.2。此功能采用次版本 1.6.0，附注标签 `v1.6.0` 指向 main 的版本/文档发布提交，以 `git rev-parse 'v1.6.0^{commit}'` 获取固定提交。源码清单见 [v1.6.0-source.json](../deploy/releases/v1.6.0-source.json)。

## 实现、修复与验证

- 七周期 M1/M5/M15/H1/D1/W1/MN 直接使用 Yahoo 原生周期；关闭 repair/back_adjust/prepost，保留原油负价、交易所日期标签和缺失量。
- 目录、图表和报价使用稳定的 Yahoo 身份；中文改名不改变缓存、工作区或画线的价格身份。平台搜索暂时隐藏自建系列，已有自建工作区保留。
- 无效价格返回明确 `invalid_data`，不写成功覆盖或永久边界；滚动窗口不阻止读取已缓存的较早历史；GS/MS 的本地模糊匹配不阻断新增股票搜索；并发目录初始化不发生主键冲突。
- SDK 纯分红、拆股和资本收益事件不生成价格 bar，也不证明前一根完成；部分缺失和非有限价格仍整页拒绝。

最终功能验证为 244 项相关后端及真实 PostgreSQL 回归（228 项相关后端、16 项独立 PostgreSQL），四项前端合约、TypeScript/Vite、ruff 和依赖检查通过。独立规范和需求复审均无阻塞项，详情见 [PR #5 修复验证](verification/yahoo/pr5-fixes.md)。本次发布阶段不重新声称执行这些功能测试，而是逐字节核对运行源码、测试、依赖和迁移与合并基线一致，并执行 1.6.0 的前端和 Python wheel 发布构建。发布核对见 [audit.json](verification/yahoo-release-v1.6.0/audit.json)。

原始实现的 SDK、实际 PostgreSQL 和浏览器记录见 [Yahoo 验收记录](verification/yahoo/README.md)，对应首次实现提交 `e28ef2e`。六品种七周期实际窗口 38/42 通过；四个上游 OHLC 不一致窗口被明确拒绝。后续修复和本次发布均未重跑完整真实网络/浏览器验收，旧记录不作为新源码的浏览器验证。

## 启用与上游限制

源码 schema 从 `p17_volume` 增加至 `q18_yahoo_catalog`，仅给目录添加 `metadata_json`，依赖固定为 `yfinance==1.7.0`。后续部署需先备份目标数据库、安装锁定依赖、应用迁移，并显式配置 `ALERTS_YAHOO_ENABLED=true` 和 `ALERTS_YAHOO_PROXY`（或既有 `ALERTS_MARKET_PROXY`）。本次标签发布不应用生产迁移。

Yahoo 报价显示行情时间及延迟，COMEX/NYMEX 采用保守的 30 分钟标识。分钟历史窗口会滚动；日/周/月的复权与期货换月遵循 Yahoo 口径。上游 OHLC 不一致窗口保持 `repair=False` 并返回 `invalid_data`，不永久关闭该周期。具体样本、冷读时延和初始化占位限制保留在原验收文档。

## 发布与回退

main 与 v1.6.0 附注标签发布源码；没有构建、改标或切换容器，也没有修改生产数据库、账户、布局或真实通知配置。原运行镜像及 Compose 继续由其原清单管理，tag 不代表已部署。

源码回退基线为 v1.5.2，会移除 Yahoo 行情和本次中文平台搜索行为。已经部署 q18 时，关闭 Yahoo 开关不删除其缓存或用户工作区；迁移回退会删除新增目录元数据字段，需要结合目标实例的备份和原运行清单安排。本次没有切换运行环境，无需执行运行回退。
