# 实施与验收进度

任务：`mw-single-frontend-20261026`；F1 / Ubuntu R2。基线 `bec830c3959703287555f935984e80396622d32b`，分支 `refactor/single-frontend-chartalert-20261026`。

阶段 0–4 已实现：HTTP/MCP 共用 ChartAlert 应用层及六个新工具；旧 Watch/演练/旧图表活动入口与执行需求退出；保留历史数据和只读确认；提供精确、可重复的旧状态退役工具。Advanced Charts 直接挂载，小运行时负责会话、工作区、行情、告警、通知和数据中心；原生控件保留，删除外层业务 iframe/消息桥。唯一 web 构建/镜像/服务提供同源静态资源、API/MCP/SSE；增加 API 所有的告警循环业务健康。

本机主机 `quant-server`，地址 `https://localhost:19643`；独立 PG14.24 在 `127.0.0.1:19644`，project `mw-single-frontend-20261026`，volume 为同名 project 的 postgres-data。私有 env/凭据/TLS/许可库未入库。2026-10-26 检查根盘剩余 34 GiB；其他任务保持运行。

已完成验证：关键 PostgreSQL 107 passed；ops 97 passed/67 subtests；CI 中非浏览器 runtime 检查 62 passed；原生告警编辑、价格拖动、保存竞争、工作区/通知回归通过。完整前端构建通过固定指纹补丁。HTTPS HTTP/MCP 八项验收通过。真实私有图表库浏览器六项通过：同源直接挂载、键盘数据中心无 iframe 回退、原生布局身份保存/版本推进、设置资源独立、原地址刷新、手机只读。合成行情在关闭浏览器时由实际 API 告警循环产生一次事件。

独立 Standards/Spec 审查发现的五项已修正或正在验证：定时器取消追踪、归档 fixture 测试、MCP 图格 UUID、真实指标身份、切换取消旧 HTTP 请求。完整后端回归仍在运行；阶段 5 将独立提交，随后补充最终容器/后台恢复/通知证据、CI 与 Draft PR。此文件是进度记录，最终结果以 results.md 及 PR 为准。

启动/停止（仓库根目录执行；停止保留 volume）：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-tasks/mw-single-frontend-20261026/acceptance.env -p mw-single-frontend-20261026 -f deploy/ubuntu/single-frontend.acceptance.yaml up -d --no-build
docker compose --env-file /home/quant/.local/share/market-watch-tasks/mw-single-frontend-20261026/acceptance.env -p mw-single-frontend-20261026 -f deploy/ubuntu/single-frontend.acceptance.yaml stop
```

不合并、不发布生产、不删除永久数据。告警 owner 仍为 API，重启期间允许判定暂停。
