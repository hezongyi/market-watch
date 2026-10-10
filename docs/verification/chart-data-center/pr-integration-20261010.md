# 数据中心 PR 主线整合验证

日期：2026-10-10。PR 分支：`feat/data-center-pr-20261010`。

整合基线为 `origin/main` 的 `012a679`（v1.15.1），保留统一 SSE、OANDA 恢复及周末恢复功能。原数据中心分支和验收实例保留。

## 本轮检查

- `npm run build --prefix web`：TypeScript、Vite 和数据中心独立资源构建通过；Vite 保留大资源包提示。
- 后端定向回归：181 项通过、74 项跳过。覆盖品种展示与身份、平台/自建目录、搜索分页、数据中心、Yahoo 精度、统一 SSE、OANDA 恢复、报价和任务记录。74 项 PostgreSQL 专项未配置 `TEST_POSTGRES_URL`，不作为验收通过。
- 报价展示兼容性整理后，品种展示和 SSE 报价再次验证：28 项通过。
- JavaScript：价格格式 38 项、主题 22 项，以及启动元信息、统一实时回调、provider 订阅生命周期、工具栏生命周期、原生 hook 安装/升级/幂等/禁用和资源缓存契约通过。
- 相对主线 `git diff --check` 通过；新增差异文本扫描未发现私钥、GitHub token、OANDA token 或密码赋值。

冲突处理保留原生数据中心与指标 UI、主线报价快照接口和实时订阅。只读来源状态继续展示，原生数据中心桥接允许读取对应状态接口。VM 测试补齐 CSP meta 所需的 DOM 环境。

## 运行实例与验证边界

Ubuntu 本机 Docker，Compose project：`mw-symbol-display-20261010`。使用 `sg docker` 确认 9 个服务运行，API/PG 健康。

访问：<https://192.168.7.232:19963/advanced-charts>；图表来源：<https://192.168.7.232:19964>。

该实例仍运行原数据中心验收候选，**本轮未部署主线整合后的 PR 提交**，原生浏览器历史验收证据见本目录其他记录及指标窗口验收目录。本轮不宣称完成整合提交的 Docker 全栈或 PostgreSQL 并发验收。

可用 `sg docker -c 'docker compose --env-file /tmp/mw-symbol-display-20261010/compose.env -p mw-symbol-display-20261010 -f /home/quant/repos/market-watch-data-center-impl-20261008/artifacts/symbol-display/compose.yaml stop'` 停止现有实例并保留数据；使用 `sg docker -c 'docker compose --env-file /tmp/mw-symbol-display-20261010/compose.env -p mw-symbol-display-20261010 -f /home/quant/repos/market-watch-data-center-impl-20261008/artifacts/symbol-display/compose.yaml start'` 启动已有容器。完整重新创建须使用该实例已有私有 Compose/env 配置；凭据、许可库和私钥不入库。实例仍用于验收，未退役或清理资源，未部署生产。
