# 原生告警 UI 对齐 v1.18.0

2026-10-11。基线为正式 tag `v1.18.0`，提交 `e75694c79e62ff8a464916278f35c9148cce6241`。实施工作树为 `/home/quant/repos/market-watch-native-alert-ui-v118-20261011`，分支 `feat/native-alert-ui-v118-20261011`。原 v1.14.1 实施工作树与其未提交内容保留。

本目录验收对应实施提交 `1741c9c` 的代码与运行快照。PR 提交时另合并最新 main（v1.19.0），新增的提交前复验与当前源码摘要见 [PR 提交记录](../pr-submit/README.md)；本目录原哈希、版本、截图和 Docker 验收证据保持历史原样。

## 对齐内容

- 在 v1.18.0 上迁入已实施的真实 widgetbar、原生告警窗口/控件及共享 React renderer。保持父页面 API、CSRF 和工作区草稿隔离。
- 合并图表 bridge 与 AdvancedWorkspace：保留统一行情 SSE、数据中心会话/API/取消和来源搜索分页过滤，同时接回告警会话、草稿、UI RPC 与原生布局切换生命周期。
- 图表 Dockerfile 保留新版 data-center、price-format、chart-theme、native-ui、native-indicator-dialog 和 toolset patch；改用仓库根构建上下文并编译共享告警内容。build-assets 同时包含新旧功能，许可资源 URL 哈希继续覆盖主 library 与 patched toolset。
- 独立验收 Compose 增加 `market-stream-worker`，使用 v1.18.0 的统一行情流。
- 版本文件、后台业务、数据库迁移、生产默认 Yahoo 配置直接采用正式 v1.18.0 基线。本任务验收仍显式禁用 Yahoo，真实浏览器行情来自 Binance。

## 已核验的数据库切换

仅停止本任务写入服务，执行 pg_dump，并在本任务 PostgreSQL 创建随机临时数据库实际 pg_restore。全部 public 表行数与告警/工作区内容核验一致后删除临时恢复库，再执行迁移。

迁移前后 22 条告警、28 个规则版本、14 个事件、14 个通知、3 个 outbox 项和 1 个工作区的行数与完整内容摘要相同。迁移 head 为 `ar45_market_stream`，实际切换用时 72.57 秒。证据见 [cutover.json](cutover.json) 和 [postgres-backup-restore.pre-v118.json](postgres-backup-restore.pre-v118.json)。

升级前的三张验收镜像保留明确 rollback 引用；数据库 dump、私密配置和登录信息仅在私密 /tmp 目录中，不提交仓库。

## 验证

本目录记录本次 v1.18.0 对齐的证据。父目录的验证、对照图及 completion-audit 是 2026-10-08 原实现的历史记录，不视为本次复跑结果。

- `npm run build`：tsc、Vite 和 v1.18 原生数据中心内容编译通过。
- 后台告警 domain/api/service/geometry 与基础 SSE：51 passed；SSE API/worker/history-window/quote 补充：39 passed。
- 告警桥接、UI RPC、统一行情回调和工具栏生命周期：12 项通过；provider subscription transport 单独通过。
- 真实许可库原生 UI integration：12 组通过，0 页面异常；[结果](ui-integration.json)。
- 完整 AdvancedWorkspace + 当前 host integration：4 组通过，0 页面异常/意外 API 路径；fixture 同步覆盖 v1.18 stream 路由；[结果](workspace-integration.json)。
- 真实 Docker 兼容验收：4 组通过；Binance SSE、数据中心 5 类与来源状态、原生指标搜索、草稿恢复和深浅主题均正常；0 页面异常/图表域凭据；[结果](runtime-v118.json)。
- 真实 Docker 浏览器告警回归：8 组通过，包含创建、暂停/恢复、真实画线拖动、四指标快照、刷新恢复和删除暂停；[结果](runtime-browser.json)。
- 运行 API/worker 与内部通知接收器：5 组通过，包含 1/2/3 次上限、区间条件、独立确认、投递重试和历史修订；[结果](runtime-api-worker.json)。
- 缺口/迟到、陈旧样本和实际 API 容器重启：3 组通过；[结果](fault-acceptance.json)。
- 原生消息/通知子页、编辑、复制/archive、日志独立确认和实际 iframe 全屏：4 组通过，0 页面异常/图表域凭据；[结果](runtime-native-ui.json)。

源码摘要、最终运行身份、产物及检查清单分别见 [source-hashes.json](source-hashes.json)、[runtime-environment.json](runtime-environment.json)、[static-build.json](static-build.json) 和 [validation.json](validation.json)。后端实际安装版本为 1.18.0。最终 12 个常驻服务运行，API 与 PG healthy，migrate 成功退出，HTTPS readiness 为 ready。

新版界面截图：[告警深色](v118-alerts-dark.png)、[告警浅色](v118-alerts-light.png)、[原生指标](v118-indicators.png)、[数据中心来源状态](v118-source-status.png)。父目录 17 场景参考对照及已记录的视觉差异继续保留，未宣称本次重新完成逐像素验收。

证据范围严格区分真实 Binance、真实 Docker API/worker 与进程内模拟数据。原实现的“零浏览器订阅观察”和“API 换 IP”是历史证据，本次未复跑。按用户 2026-10-11 指令提交本实现并向 main 发起 PR；Ubuntu 验收实例继续保留，未发布生产。PR 的验证基线为本页记录的 v1.18.0。

## 运行环境与访问

Ubuntu `quant-server`（`192.168.7.232`）本机 Docker，独立 task/project `mw-native-alert-ui-runtime`，既有任务专用数据库、volume、网络与端口。实例保留供用户验收，生命周期任务仍 active。

主站 <https://localhost:19643/>，图表来源 <https://127.0.0.1:19644/>。端口仅绑定 Ubuntu loopback，登录密码沿用原验收密码；私密位置为 `/tmp/mw-native-alert-ui-runtime/login.json`。使用验收自签证书。

其他电脑建立转发：

```bash
ssh -N -L 19643:127.0.0.1:19643 -L 19644:127.0.0.1:19644 quant@192.168.7.232
```

在本工作树启动/恢复和停止（不删除数据）：

```bash
sg docker -c 'docker compose --env-file /tmp/mw-native-alert-ui-runtime/compose.env -p mw-native-alert-ui-runtime -f compose.native-alert-ui.yaml --profile notification-test up -d --no-build'
sg docker -c 'docker compose --env-file /tmp/mw-native-alert-ui-runtime/compose.env -p mw-native-alert-ui-runtime -f compose.native-alert-ui.yaml --profile notification-test stop'
```

构建沿用专用 `market-watch-ubuntu` BuildKit：

```bash
mw-docker compose-build --repo . --task mw-native-alert-ui-runtime --project mw-native-alert-ui-runtime --purpose acceptance --env-file /tmp/mw-native-alert-ui-runtime/compose.env --file compose.native-alert-ui.yaml
```

运行新增兼容回归：

```bash
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu node web/tests/native-alert-v118.runtime.cjs
```

通知接收器只连接本任务 internal network，未投递外部消息。没有生产部署。验收结束后按原有 `mw-docker retire` 精确预览、备份恢复核验与退役流程处理；当前不 finish 或清理验收资源。
