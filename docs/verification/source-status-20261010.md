# 数据中心「来源状态」实施与验收

日期：2026-10-10。方案：[实施方案](../market-watch-source-status-plan-20261010.md)。

## 实现

- 基线：远端 main `98c50eaf601dede1a8fbfa8584c7fe22a5231d18`（v1.16.1）。独立分支 `feat/source-status-20261010`，worktree `/home/quant/repos/market-watch-source-status-impl-20261010`。
- 「任务与记录」下方新增第五分类「来源状态」，原四分类移除公共 OANDA 状态区；来源分类支持地址解析及关闭后恢复。
- 页面包括 OANDA Practice 概览、各品种报价/K 线就绪和时间、交易时段、默认折叠的诊断及任务入口。所有时间明确显示 UTC。
- 首次读取只显示加载；读取失败保留上次结果及成功读取时间。超时、鉴权暂停、已核实闭市、时段未知、未配置和无采集记录分别处理。过期计划明确标注，缺少错误观察时间不补造。
- 页面只 GET 已存储状态。复用 10 秒轮询及请求取消机制，不启动采集、历史下载、账户校验或重试。
- 状态 API 增加兼容字段：配置是否齐备、是否有账户采集记录、连接开始、鉴权探测及与该探测错误匹配的观察时间；品种列表仅返回当前配置账户的 OANDA Practice v20 数据。普通流错误不借用鉴权探测时间。其他实时接口、数据库结构及采集业务规则未调整。

## 实际环境

Ubuntu 本机 Docker，独立 task/project `mw-source-status-20261010`，独立 PostgreSQL 14 数据库、volume、网络与端口。运行 API、web、许可图表 origin、TLS 和数据库；迁移成功到 `ar45_market_stream`。

验收时访问地址：

- 工作台：`https://192.168.7.232:19983/advanced-charts`
- 图表 origin：`https://192.168.7.232:19984`

三个候选镜像通过 `mw-docker build --purpose acceptance` 和专用 `market-watch-ubuntu` BuildKit 构建，标签分别为 `market-watch-api:source-status-20261010`、`market-watch-web:source-status-20261010`、`market-watch-chart-origin:source-status-20261010`。web 构建参数指定上述图表 origin。

账户与令牌为本次独立的虚拟值；没有部署行情采集、历史、通知或报价 worker，实时 stream 与通知关闭。没有使用生产数据，也没有部署 unraid 实例。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript/Vite 与原生 UI 构建 | 通过；保留既有大 bundle 提示 |
| 后端 live API、live pricing、OANDA recovery 回归 | 55 passed，15.45 秒 |
| 来源/任务路由、非法分类回退、外部 URL 边界 | 通过 |
| Ruff、`git diff --check` | 通过 |
| 实际 Chromium 原生/兼容窗口验收 | 19 组通过，浏览器异常 0 |
| PostgreSQL 14 实际快照读取 | 当前账户 2 行、其他账户 2 行隐藏，连续 5 次读取通过 |
| 读取前后数据库指纹 | LiveState、MarketDemand、PricingOwner、Preference 均未改变 |

浏览器覆盖：原四分类无全局状态/状态轮询，首次读取等待，失败保留旧数据，独立报价/K 线就绪，闭市与下一时段，时段未知，超时及过期检查，缺失错误时间，鉴权暂停，未配置与无采集记录，实际 10 秒轮询，离开/关闭时取消正在进行的请求并停止轮询，迟到响应隔离，重开分类恢复。来源浏览过程中没有发出采集需求、重试、下载或其他控制命令。

原生和兼容窗口均验证键盘诊断展开、Tab/Shift+Tab 焦点约束、明暗主题及 1440/768/375px，无横向溢出。200% 使用 Chromium 扩展调用 `chrome.tabs.setZoom(2)`；实际 CSS 视口为 720×500、devicePixelRatio 为 2，刷新与导航可操作。

### 验证边界与证据

登录、工作区、原生许可 UI、兼容窗口及最初状态请求使用真实隔离应用。异常和会话分支通过浏览器对状态接口的受控 fixture 验证；图表解析、报价、历史同样使用浏览器 fixture，避免图表初始化连接真实供应商。PostgreSQL 检查在该隔离数据库中建立两个虚拟账户，再调用实际状态端点逻辑验证账户范围和只读性。本次不声称验证了真实 OANDA 网络连通性。

可提交的汇总证据：[结果 JSON](source-status-20261010-results.json)。

本地日志与截图位于 ignored 的 `artifacts/source-status/`：`backend-tests.log`、`browser.log`、`browser-report.json`、`pg-status.json`、`native-{dark,light}-{1440,768,375}.png`、`compat-{dark,light}-{1440,768,375}.png`、`native-zoom200.png` 和 `compat-zoom200.png`。截图已目视复核。

验收脚本早期因工作区已存在时点击瞬时「新建工作区」按钮、以及后安装虚拟时钟无法接管既有轮询而失败；修正为 API 初始化工作区和实际时间等待后最终全量通过。上述问题属于验收脚本，不计作通过记录。

## 启停与重跑

以下为本次验收运行时使用的命令，工作目录为上述 worktree：

```bash
sg docker -c 'docker compose --env-file artifacts/source-status/compose.env -p mw-source-status-20261010 -f artifacts/source-status/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/source-status/compose.env -p mw-source-status-20261010 -f artifacts/source-status/compose.yaml stop'

LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
  node web/tests/chart-source-status.browser.cjs

sg docker -c 'docker compose --env-file artifacts/source-status/compose.env -p mw-source-status-20261010 -f artifacts/source-status/compose.yaml run --rm --no-deps -v /home/quant/repos/market-watch-source-status-impl-20261010:/source:ro -e PYTHONPATH=/source/backend api python /source/scripts/source_status_acceptance.py'
```

Compose、独立凭据、TLS 私钥及许可库保留在本地私有/ignored 目录，未提交仓库。验收完成后按规则退役；这些地址不是持续运行的交付实例。再次部署需登记新 task/project，通过 `mw-docker` 重新构建，恢复或新建隔离数据库，并调整验收脚本地址保护，不能复用已结束的任务。

本次交付实施与本地验收；生产发布单独执行。

## 退役结果

先通过 `mw-docker retire --task mw-source-status-20261010 --project mw-source-status-20261010` 核对 6 个容器、1 个本项目 PG volume 和 1 个网络，再执行同命令的 `--apply`，已成功完成。`postgres` 与 `source_status` 均备份并实际恢复验证；应用数据库 87 张 public 表的行数和指纹匹配。再次按 Compose project label 查询，剩余容器、volume、网络均为 0；本次无引用候选镜像已清理。

私有备份、角色和配置归档位于 `/home/quant/.local/share/market-watch-docker/archives/mw-source-status-20261010-20261010T113501-c156fdaf/`，未提交仓库。原验收地址已关闭，生产未变更。
