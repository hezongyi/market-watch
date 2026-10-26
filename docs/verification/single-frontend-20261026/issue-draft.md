# 单一业务前端与 ChartAlert 告警体系收敛

分类：F1。涉及持久规则生命周期、通知待发送任务、后台采集需求与 MCP 契约；不改变 schema、不删除历史记录。执行依据为 `docs/single-frontend-chartalert-consolidation-plan-20261026.md`。

目标：阶段 0—4 全部实现并完成独立 Ubuntu Docker R2 后提交 Draft PR；阶段 5 单独提交。保持当前 Advanced Charts 原生控件、React 业务组件和工作区/草稿格式。禁止合并、生产发布和永久数据删除。

检查范围：ChartAlert HTTP/MCP 跨入口操作、权限/幂等/并发/版本；旧 Watch/组合 Watch/演练/兼容图表全链路退役；混合历史样本和旧待投递幂等退役；采集恢复与确认；单一前端浏览器行为、原生控件、工作区保存竞争与草稿；单产物构建、Ubuntu 工具、Compose、健康摘要与通知定位；迁移 head、PostgreSQL 14.24 回归、CI、自审及独立 Standards/Spec review。

完成证据逐阶段存于本目录。未覆盖项目不得当作通过；Draft PR 描述最终实现、实际 URL/镜像 ID、测试/skip、限制和回退流程。
