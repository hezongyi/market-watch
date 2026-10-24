# RRS 分支整理与最终归并

用户明确要求“按你建议顺序进行收尾”：归并已验收 RRS、补齐早期证据、回归后清理冗余分支和工作树。风险分类 F0：归并已验收的兼容修复，无新增计算逻辑、schema 或部署变更。本文件为本地工作记录，未创建外部 Issue/PR。

## 唯一后续源码入口

- 分支：`market-watch-integration-20261024`
- 工作树：`/home/quant/repos/market-watch-integration-20261024`
- 归并提交：`1ebdbb7087829df1dc0ae46b2a2fadf13ef60230`，同时保留原集成 `6bcce51f` 与已验收 RRS 收口 `1aab8550` 为祖先。
- RRS 产品改动与已人工验收的最终分支一致。原生 Chart 实际运行源码仍为 `bacbcd7d`，API b4e1326a、workers8b7ee3ee、Web970a2550；不是把归并提交冒充运行版本。
- 新旧入口统一登记在本机 acceptance registry；旧任务工作树路径已退役，原始证据和镜像回退材料继续保留。

## 归并完整性

没有合并冲突。逐文件验证 `advanced-host/`、`backend/alerts/`、`web/src/` 与 RRS 最终分支完全相同；原集成的 confirmation-snapshot 回归文件和 preference-draft 验收目录未改变。

补入早期 RRS 的 `docs/verification/rolling-range-squeeze-20261024/README.md` 与 `mwa-summary.json`，与两个早期分支的原始材料完全相同；保留为历史证据。其“最终状态”描述的是当时的验收版本，当前结论请看 [D1计算修复](../rrs-provider-d1-20261024/README.md)、[D1绘图修复与人工通过](../rrs-drawing-history-20261024/README.md) 和本记录。两个最初分支经移植后并非当前分支祖先，因此没有重复合并旧实现；其完整原始提交图另存经恢复校验的 bundle，未丢弃独有提交。

## 必要回归

- 后端 RRS/平台历史专项 **24 passed**，1 个既有 Starlette/httpx 弃用 warning。使用仓库已有 `.venv` 和已有内存 SQLite 测试夹具；没有引入运行数据库。
- 前端 squeeze history/contract、indicator runtime、NR display/restart、preferences/conflict 共 7 个入口通过。偏好测试从 `web/` 目录执行。
- 许可原生库 squeeze 浏览器专项通过：坐标、样式、颜色、撤回、隐藏/恢复、模板、多实例、保存排除及窄屏。
- Web TypeScript/Vite 构建通过，保留既有 chunk size 提示，原日志 `/home/quant/repos/.reports/market-watch/20261024-rrs-consolidation/web-build.log`。
- 临时只读浏览器使用原始部署资源、无源码注入/强制重绘，D1 当前→2023→2021→2019→返回近期、隐藏/恢复、H1/H4与删除全部坐标匹配，pageerror0。本轮补载到更早历史后实际131框/77标签，不能与先前105/62固定计数混用。
- 最初额外复核出现一次 native setVisibleRange timeout，保留失败证据；后续探针同时等待实际 K 线加载范围、核对全部原生几何后通过。未执行TradingView Pine、全量后台或长期稳定性观察。

## 归档后清理

| 已退役分支 | 原提交 | 结果 |
| --- | --- | --- |
| `feat/rolling-range-squeeze-20261024` | `ecd55b85` | 已归档并移除 |
| `integration/rolling-range-squeeze-mwa-20261024` | `1881951d` | 已归档并移除 |
| `fix/rrs-provider-d1-20261024` | `11ead46e` | 已归档并移除 |
| `fix/rrs-drawing-history-20261024` | `1aab8550` | 已归档并移除 |

四个工作树均先确认干净、没有进程以其为cwd、没有运行容器挂载，再归档全部文件（包含 ignored 本地材料、依赖链接及原始截图，排除失效 `.git` 指针）。归档后逐文件/链接对照原件，共验证 41179 个文件与 4 个链接；四个tar归档的SHA256见 [summary.json](summary.json)。

Git完整历史：`/home/quant/repos/.archives/market-watch/rrs-consolidation-20261024/rrs-branches.bundle`，SHA256 `db92c170dca03948322d30f72aa34770f275627423233a3c90bff0dce2a23114`。已独立恢复到 `/home/quant/repos/.archives/market-watch/rrs-consolidation-20261024/restore-check.git`，核对四个tip及全量对象完整性。所有旧工作树和4个本地分支现已移除，其他任务分支/工作树未清理。完整归档含本地私有材料，位于权限0700目录，不提交Git。

### 恢复方式

归档目录 `/home/quant/repos/.archives/market-watch/rrs-consolidation-20261024` 内有 `README.md`、`branch-tips.json`、`archive-inventory.json`、逐文件manifest及清理记录。需要恢复某个旧分支时，先从bundle恢复明确ref，再创建对应worktree，最后解包匹配的tar（从 `/home/quant/repos` 解包，归档已排除 `.git`，保留新worktree元数据）。旧路径已经退役，历史脚本不直接作为当前执行入口。

## 现场与运维

Ubuntu quant-server / `mw-issue75-v2-20261018`，入口 https://192.168.7.232:18280 。整理前后所有17个容器（含2个exited初始化容器）的ID、镜像、启动时间与状态保持；15服务running，API/PG healthy。既有精确配置与保护浏览器身份审计通过。没有替换镜像、重启服务、迁移/seed/清库、删除volume/回退镜像、push、PR、main合并或生产操作。

长期运维仍为 `python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。当前运行审计仍可用 `python3 /home/quant/repos/.mwa-rrs-drawing-history-20261024/operate.py audit`；它不依赖已删除的源码工作树。旧镜像/配置回退仍在同目录，未执行。

使用当前源码入口的只读业务探针：`node /home/quant/repos/.mwa-rrs-consolidation-20261024/browser.cjs`。原始证据 `/home/quant/repos/.reports/market-watch/20261024-rrs-consolidation`；以往 `.reports`、`.mwa`、受保护浏览器及真实数据保持。后续开发与归并统一从本集成分支继续，合并main/发布生产仍需另行授权。
