# 实施与验收进度

任务：`mw-single-frontend-20261026`；F1 / Ubuntu R2。基线 `bec830c3959703287555f935984e80396622d32b`，分支 `refactor/single-frontend-chartalert-20261026`。

阶段 0–4 已实现：HTTP/MCP 共用 ChartAlert 应用层及六个新工具；旧 Watch/演练/旧图表活动入口与执行需求退出；保留历史数据和只读确认；提供精确、可重复的旧状态退役工具。Advanced Charts 直接挂载，小运行时负责会话、工作区、行情、告警、通知和数据中心；原生控件保留，删除外层业务 iframe/消息桥。唯一 web 构建/镜像/服务提供同源静态资源、API/MCP/SSE；增加 API 所有的告警循环业务健康。

本机主机 `quant-server`，地址 `https://localhost:19643`；独立 PG14.24 在 `127.0.0.1:19644`，project `mw-single-frontend-20261026`，volume 为同名 project 的 postgres-data。私有 env/凭据/TLS/许可库未入库。2026-10-26 检查根盘剩余 34 GiB；其他任务保持运行。

已完成验证：关键 PostgreSQL 107 passed；ops 98 passed/67 subtests；CI 中非浏览器 runtime 检查 62 passed；原生告警编辑、价格拖动、保存竞争、工作区/通知回归通过。完整前端构建通过固定指纹补丁。最终 API/Web 候选上 PostgreSQL 关键链路 86 passed、HTTP/MCP 八项验收通过。真实私有图表库浏览器九项通过且无 page errors：同源直接挂载、键盘数据中心无 iframe 回退、原生布局身份保存/版本推进、创建并绑定告警、设置资源独立、原地址刷新、手机只读、历史/现代通知定位、会话过期安全返回登录。合成行情在关闭浏览器时由实际 API 告警循环产生一次事件。

阶段 5 已完成并独立提交：HTTP/MCP/worker 共用可取消行情查询实现及错误类型。Standards/Spec 审查发现的重点均已处理：定时器取消追踪、归档 fixture 测试、MCP 图格 UUID、真实指标身份、切换取消旧 HTTP 请求、provider 边界 QueryError 翻译。

补充验收证据：HTTP/MCP 八项验收见 `acceptance.json`；真实 Binance 只读 K 线见 `real-source.json`；合成 R2 数据库在 API 重启后继续推进且没有重复计数，旧 Watch/通知/Outbox 退役状态及现代 Outbox 见 `background-after-restart.json`；精确退役预览和应用结果见 `retirement-preview.json` 与 `retirement-applied.json`。关键 PostgreSQL 套件 107 passed，ops 97 passed/67 subtests，阶段 5 定向回归 424 passed，web CI 最新模拟 72 passed，完整私有前端及 Ubuntu API/Web 镜像此前均构建通过。

最终浏览器验收发现 pinned 图表控件在会话过期销毁时可能对已拆除的 vendor API 执行清理并中断 React 路由；运行时逐项记录 teardown 异常并继续清理，由所属 iframe 生命周期释放 widget，同时保留未完成告警接入的停止栅栏。`advanced-inflight-cancellation.cjs` 覆盖异常可见性及后续清理。受管 Ubuntu 构建还暴露 Docker 多平台 OCI 索引问题；`mw_docker.py` 现在只导出 linux/amd64，并过滤 attestation，同时兼容无 platform descriptor 的单镜像索引，新增归档回归测试。Ubuntu 本机 `quant-server` 的最终候选：API `sha256:d0bd32ff8abac0edd498b03d2f7dd05616b3c989b633c41b4eed1376e81ccb67`，Web `sha256:65b5adf54412d39760536a3f7624f22094acc00a670db0b4b45a35decaee1117`；隔离地址 `https://localhost:19643`，PG14.24 `127.0.0.1:19644`。PostgreSQL、API、Web 与所需 worker 均健康。浏览器结果见 `browser-final.json`，HTTP/MCP 结果见 `acceptance.json`。build/browser/HTTP 验收、`.venv/bin/python -m pytest -q tests/ops`（98 passed/67 subtests）、Ruff 与 `git diff --check` 通过；PostgreSQL 仅有 Alembic config deprecation 与容器只读 pytest cache warning。分支已推送，Draft PR #99 已创建；最新运行时提交 `497ec2e2` 已通过销毁异常诊断回归、`test:single-frontend -- --unit`、Ruff 和基线差异空白检查；对应 Web 候选重建并复跑九项浏览器验收通过，零 page errors。PR CI 状态以 #99 的最新 checks 为准，尚未合并或生产发布。

补充 CI 收尾：取消的旧 run 日志暴露显式黄金数据集测试仍期待 HTTP 异常；共享查询已迁移到 `QueryError`，现已同步断言。该文件 38 passed、Ruff 通过；旧 run 中另一项 provider 连接复用测试在隔离 PostgreSQL 中单项及整文件 21 passed，等待最终 PR CI 全量结果。

启动/停止（仓库根目录执行；停止保留 volume）：

```bash
docker compose --env-file /home/quant/.local/share/market-watch-tasks/mw-single-frontend-20261026/acceptance.env -p mw-single-frontend-20261026 -f deploy/ubuntu/single-frontend.acceptance.yaml up -d --no-build
docker compose --env-file /home/quant/.local/share/market-watch-tasks/mw-single-frontend-20261026/acceptance.env -p mw-single-frontend-20261026 -f deploy/ubuntu/single-frontend.acceptance.yaml stop
```

不合并、不发布生产、不删除永久数据。告警 owner 仍为 API，重启期间允许判定暂停。
