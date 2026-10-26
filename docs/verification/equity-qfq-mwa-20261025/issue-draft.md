# 新浪、腾讯股票入口与自建复权依据

风险：F1。涉及不可变归档内容、复权计算产物及后台维护；沿用现有 schema，无新增迁移。

范围：新浪 A/H、腾讯 A 平台默认供应商 qfq；腾讯只作平台入口。新浪 A/H 自建采集 none 和同源因子；Yahoo 自建 auto_adjust=False，保存独立 Adj Close/Close 依据，图表使用本版本依据计算 qfq。缺失依据保留 raw、产物 unavailable，后续任务不被阻塞。旧固定版本与旧来源身份可继续使用，国内期货保持兼容。

实施基线：ba5407b218c0d5ffb5b946cb83bba4af67f3965e；分支 integration/equity-qfq-mwa-20261025。保留原 history-modes 工作树；集成当前 FXCM/手机功能，不回退现有实例。

最小检查：来源/公式/版本/缓存/异常测试、独立 PostgreSQL 契约与迁移兼容；真实股票接口对照；mwa 原生 UI 创建与图表；应用库备份实际恢复；部署后配置与原业务数据保护审计。Standards 与 Spec 独立审查及返工复核。

最终结果及已知边界以 README.md 和证据 JSON 为准。本文件为本地 Issue 草案，尚未创建远程 Issue/PR，不合并、不发布生产。
