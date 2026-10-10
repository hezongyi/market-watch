# 本 session 漏合改动核对

日期：2026-10-10。固定远端 main：`b2744e655f3865ba5fee31f543d6b587bee12ee1`。

核对所有 68 个本地／远端分支引用与 34 个 worktree；使用 `git cherry` 对照补丁等价性，再核对具体文件与产品行为。分支名或提交不在祖先链上本身不能证明功能缺失。完整引用及工作树状态见 [branches.json](branches.json)。其他工作树的修改没有被改写。

## 本 session

| 请求 | main 状态 | 本 PR 处理 |
| --- | --- | --- |
| 自选添加商品代码：全部行情／全部来源双筛选 | PR #30 已合入，`b64d579` | 无需重复导入 |
| 统一商品代码与 Yahoo 显示精度、原生数据中心 | PR #27/#28 已合入 | 无需重复导入 |
| 顶部 OANDA 提示迁至独立「来源状态」 | `3631909` 留在 `feat/source-status-20261010`；main 的 Center 仍全局挂载 LiveProviderStatus | 导入完整实现、读取 API 兼容字段、测试与方案；保留管理页布局和位置修复 |
| 行情管理五分类、任务返回与滚动恢复 | PR #31 已合入，`e2129b9` / `7e68bf3` | 保留，并执行集成回归 |
| 启用 Yahoo 供源 | Yahoo 实现 `b747d5b` 已经是 main 祖先；生产真实读取 Settings 为关闭、AAPL 目录 0 | 增加显式启用 overlay 和操作说明；本 PR 未修改生产，仍需正式应用配置与真实联网验收 |
| v1.17.0 发布与生产交付证据 | PR #32 已合入 | 补正文档验证边界：原状态检查验证的是旧顶部区，未验证独立来源页 |

目前未发现本 session 其他已实施但漏合的产品代码。

## 已发现的其他独立任务

以下确实还有差异，日期／范围属于其他任务，未默认并入本 PR。不能将其旧验收当作当前 main 的集成验收。

| 工作 | 状态与依据 |
| --- | --- |
| 工作区标签页 | `feat/workspace-tabs-20261008` 有 8 个独有提交，88 个文件；尚未合入，涉及工作台和图表生命周期 |
| 原生告警 UI | `market-watch-native-alert-ui-impl-20261008` 有未提交修改与新增文件；进行中任务，不能直接取走提交 |
| 部署验证身份 | `feat/deployment-verifier-identity` 独有 `3b92a1b`，含新迁移及权限协议 |
| 商品开闭市、详情更新时间和交易日历 | 根目录 `market-watch-market-session-details-plan-20261010.md` 明确“尚未实施或验收”；是后续实施方案 |
| 旧生产发布文档 | v1.11/v1.12/v1.14.1 独立部署分支尚有未入主线的记录；不是当前产品漏项 |
| 旧图表范围与 OANDA 诊断分支 | 提交 hash 不同，但相应功能已由后续 main 实现；旧分支差异不能直接覆盖新代码 |
| 旧原型和 detached review worktree | 包含历史原型／当时审查暂存；没有作为当前 session 产品需求交付 |

## 已知生产问题

真实登录检查仍发现 Dukascopy 精度溢出、OANDA `m1_late`、Yahoo 关闭，以及许可图表 console 的 `Value is null`。这些是实际缺陷／配置状态，没有已验收修复提交可补合；本次仅补漏合改动，未声称修复这些生产故障。

## 本次集成验收

- 环境：Ubuntu 本机 Docker，独立 task/project `mw-source-status-delivery-20261010`，独立 PG14、volume、network 和端口；没有采集／通知 worker，没有 unraid 测试实例。
- 验收运行地址：`https://192.168.7.232:19983/advanced-charts`；图表 origin `https://192.168.7.232:19984`。验收完成后精确退役，地址关闭；需重新验收时登记新 task/project。
- API/web/chart-origin 三个候选镜像均使用 `mw-docker build --purpose acceptance --task mw-source-status-delivery-20261010 --project mw-source-status-delivery-20261010` 和 `market-watch-ubuntu`；TypeScript/Vite/native UI bundle 实际 Docker 构建通过。
- [19 组浏览器验收](browser.json)通过，页面异常 0；原四分类无全局状态及轮询，来源页异常／旧快照／状态口径、键盘、明暗、1440/768/375px、真实 200% 缩放、请求取消和关闭重开通过。真实应用认证/API/许可 UI；供应商状态和图表 feed 在浏览器中使用明确受控 fixture，不声称真实上游连通。
- [55 项后端回归](backend-tests.txt)通过；[实际 PG14 账户过滤与只读性](pg-status.json)通过，5 次读取隐藏另一账户 2 行，状态与需求指纹保持一致。
- [7 项实际 React 位置回归](position.json)通过，概览 200 → 200、覆盖页 350 → 350、旧位置迁移及焦点恢复、延迟来源快照的分类往返／实际关闭重开滚动和焦点恢复、读取中用户交互优先；来源页／任务路由和有界工作区返回上下文检查通过。
- [Yahoo overlay](yahoo-overlay.json)使用合成私有 env 经 Ubuntu Compose 实际配置合并，11 个后端服务均启用，既有 proxy 值保留；没有部署此 overlay，没有连接真实 Yahoo。
- Ruff 和 `git diff --check` 通过。暗色桌面与亮色 375px 截图实际目视检查通过；私有原始材料在 ignored `artifacts/source-status/`。

验收时启停（当前工作目录，已经结束的 project 不复用）：

```bash
sg docker -c 'docker compose --env-file artifacts/source-status/compose.env -p mw-source-status-delivery-20261010 -f artifacts/source-status/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/source-status/compose.env -p mw-source-status-delivery-20261010 -f artifacts/source-status/compose.yaml stop'
```

复审发现来源页首次异步快照会使旧位置提前恢复到空页（实跑 350 → 0）。修复为等待首次读取结束再恢复，用户操作仍取消迟到恢复；新增回归已通过。19 组 Docker 来源页检查在此局部修复前完成；修复后新增实际 React 浏览器回归及最终 Docker web 构建，不冒称原 19 组全部重新运行。

[退役证据](retirement.json)：`mw-docker retire` 先 preview 再 apply；两个数据库均实际恢复并核对内容，剩余本 task 容器、volume、网络均为 0，三个无引用候选镜像精确删除。私有备份／配置保存在本机生命周期归档，不提交。

最终 `dcea7a4` 的 [Docker web 构建](final-build.json)通过；纯构建 task 已 finish，cleanup 先 preview 再 apply。两轴[复审](review.md)均无遗留发现。
