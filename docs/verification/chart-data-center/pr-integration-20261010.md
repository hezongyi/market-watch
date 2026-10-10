# PR #27 主线整合与复审验收

日期：2026-10-10。分支：`feat/data-center-pr-20261010`。主线基线：`012a679`（v1.15.1）。

## 修复与复审范围

- `fd81a50`：统一 SSE 报价回调和初始快照的显示精度；保留源报价。任务控制按服务器响应及 desired_state 解除等待，避免恢复/重试后后台立即失败导致按钮永久锁定。
- `5145c75`：控制响应优先采用 task_status，区分已发布版本与仍在派生的任务状态。
- `368488a`、`616f04e`：修正主线继承的过期迁移、OANDA 生命周期和休市状态测试契约；保持现有运行逻辑。
- `616f04e`：只读来源状态与平台/自建/组合/任务/创建页共享可用高度；修复来源状态占用高度导致外层滚动和标题位移。详情页面保留原有滚动。
- 浏览器脚本按当前目录选择式创建流程和供应商能力更新；映射选择等待准确目录 ID，避免异步搜索替换第一行引发竞态。

## 实际运行环境

Ubuntu quant-server 本机 Docker；task / Compose project：`mw-pr27-review-20261010`。独立网络、volume `mw-pr27-review-20261010_pr27-pg`、数据库及端口。没有在 unraid 创建实例。

验收运行地址：`https://192.168.7.232:19973/advanced-charts`；图表来源：`https://192.168.7.232:19974`；PostgreSQL 仅绑定 `127.0.0.1:19975`。

13 个服务实际运行，API/PG 健康，`/readyz` HTTP 200。数据库从 Ubuntu 原验收项目一致性快照实际恢复，最终包含 17 个历史版本、5 个维护计划、1 个组合；未修改源实例。

全部候选镜像通过 `mw-docker build --task mw-pr27-review-20261010 --project mw-pr27-review-20261010 --purpose acceptance` 和 Ubuntu 专用 builder 构建，dirty 标签为 false：

| 组件 | 源提交 | 镜像 ID |
|---|---|---|
| API | `5145c75` | `a765ebe5330a426e8bb1c3e0a3e034029c11bf306094fb3d1a7e54d86c62acab` |
| Web | `616f04e` | `b5a9d567203f017d4589ed09f12144d80c160708d40b7e335bc019558e2fbdc8` |
| Chart origin | `5145c75` | `b0d38f855be66debf6a679c3221b81804fe5dbba64d6c5e77d385f837cfc1f42` |

后续产品差异仅 Web CSS；API 与 chart 源码无后续差异。部署 host bundle 拼接内容与当前全部 host 源文件逐字匹配。部署数据中心 CSS 与本机构建 SHA256 同为 `d14083edde89e55141b6b1df118486226cbf8611cb8573ee797b139edd7372f8`。本机 node_modules 复用既有验收依赖，因此不以本机 JS bundle 哈希与容器产物一致作为断言；浏览器验证直接加载部署资源，不启用 LOCAL 资源替换。

## 验证结果

### 后端与构建

- 全部后端：首次真实 PostgreSQL 运行 **1734 passed, 14 failed, 11 skipped**，保留原始日志。14 个失败涉及过期迁移 head、会话 fixture、启动租约和休市可用性断言；修订前与主线对应产品文件无差异。
- 最终重跑全部涉及失败的文件并补上 chart-alert PostgreSQL 专项：**50 passed，0 failed，0 skipped**。保留并发提交、owner fencing、取消、数据库安全日志、迁移回滚保护及闭市证据断言。
- 初始跳过的 8 项 chart-alert PG 已实际补跑；其余 3 个跳过原因：可选交易所日历依赖、未提供旧 v1.14.0 源进程、主机无匹配 PG dump/restore 二进制。后两项不是本 PR 新功能门槛；本次实例退役另外执行 Docker 内真实备份恢复校验，不将跳过项计为通过。
- TypeScript/Vite/native 数据中心构建通过，保留既有大资源包警告。
- JavaScript 价格格式 38 项、主题 22 项，任务控制、SSE 顺序/代际/极值、启动元信息、provider 订阅/请求生命周期、工具栏生命周期、原生 hook 和资源缓存契约通过。
- `git diff --check` 通过。

### 部署浏览器

使用真实许可图表及部署资源。实际读接口/行情/历史；故障、长列表和破坏性命令仅作用于明确请求 fixture，证据不会把模拟后台动作描述为真实供应商动作。

已通过：

- 自建/组合管理：真实配置范围、详情返回、65 行连续加载、失败重试、标题固定、外层无溢出、组合候选单次创建和目标拒绝；暗/亮、桌面/平板/375px。
- 平台行情：Yahoo/Binance/Dukascopy 目录与能力入口、165 行连续加载、滚动恢复、取消/过期回复、打开命令/故障状态。
- 生命周期：挂起图表请求不阻塞管理、关闭取消请求、重新打开隔离旧查询、保留指标/绘图/图表范围、真实触摸模式只读。
- 原生指标：类别/详情/键盘添加、独立重复实例、收藏服务器持久化、layout 存取、异步插入及版本不匹配兼容路径。
- 商品代码搜索：真实 provider/history/composite 与来源组合、固定历史唯一 ticker、125 行 offset/cursor、过期查询隔离和键盘/375px。
- 图表联动：实际 Yahoo 图表加载重试、固定历史选择、准确账户目录映射、观察列表、对比图、指标参数选择。
- 真实 SSE 精度：Yahoo AAPL 源价格 **336.64** 经服务器事件进入 native 回调，值未改变，`mw_display_pricescale=100`。监听仅计实际 market-event 调用，排除命名和 HTTP 初始回调；这是供应商延迟快照，不是周末新成交验收。

最终任务、创建、原生窗口和缩放套件结果及资源归档状态将在本次验收结束时补齐。

## 启停与资源归属

私有配置位于当前 worktree 的 `artifacts/pr27-review/`，凭据、TLS 私钥、许可库、数据库 dump 和浏览器完整状态不入库。

运行期间启停命令（在该 worktree 中）：

```bash
sg docker -c 'docker compose --env-file artifacts/pr27-review/compose.env -p mw-pr27-review-20261010 -f artifacts/pr27-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/pr27-review/compose.env -p mw-pr27-review-20261010 -f artifacts/pr27-review/compose.yaml stop'
```

退役必须先预览 `mw-docker retire --task mw-pr27-review-20261010 --project mw-pr27-review-20261010`，然后执行 `--apply`，真实备份/恢复验证通过后再删除该任务容器、卷、网络与无引用候选镜像。其他 Ubuntu 项目及生产实例不在本次清理范围。
