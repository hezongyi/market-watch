# 修复 PostgreSQL 告警健康统计的 JSON 分组错误

基线：main / v2.0.5，1bb935bd。分支：fix/chart-alert-health-pg-20261111。

风险 F0：修复兼容健康 API 的只读统计查询，不更改 schema、持久格式或告警执行规则。

问题：SELECT、WHERE、GROUP BY 分别构建 JSON execution_state 表达式，SQLAlchemy 生成不同的绑定键。PostgreSQL 不将 SELECT 和 GROUP BY 中的参数表达式视为相同列，健康统计可触发 GroupingError，影响 GET /api/health。

目标：复用同一个 SQLAlchemy 表达式；健康 API 可用，monitoring/settling/recovering 计数及原有归档、过期过滤保持正确。

最小检查：在独立 Ubuntu Docker PostgreSQL 14.24 上同一回归用例主线失败、候选通过；相关健康统计/告警测试、Ruff、diff 检查、真实认证 HTTP smoke，以及 PR CI 和自审。

Ubuntu 验收实例独立 project/network/volume/database/凭据/端口，保留 mw-dev、CPU 故障现场和 Android。完成验证和 Draft PR 后在合并检查点等待用户决定。
