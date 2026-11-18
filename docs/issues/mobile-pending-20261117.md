# 手机端待实现清单收口

用户授权：实施 docs/plans/pending/README.md 中全部未实施项并验证。
基线：最新部署 HEAD aacb80e2；远端 main 1f2005c3，已 fetch。独立分支 feat/mobile-pending-20261117。

范围：触发详情定位专业图表、Dukascopy MT4 USD 离线头寸计算、每日晨报框架及手机全文入口。保留已有市场/图表/通知成果。
风险 F1：晨报新增 additive schema、后台生成 loop、通知类型；其余为 F0。使用隔离 PG 验证迁移、调度恢复、通知兼容，独立 Standards/Spec 审查；浏览器截图/交互、真实许可图表、Android 构建及 URI 单测、mw-dev R1。

不改真实规则/实时开关/供源/通知配置，不向真实 topic 发测试。部署保留数据与旧镜像，F1 回退保留新增表、暂停晨报并阻止旧 worker 误领晨报。真机通知点击单独验收。
