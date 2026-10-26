# 股票接入与RRS修复合入集成分支（2026-10-26）

已按用户“整理下分支，然后合入集成分支”完成本地合并，主开发入口继续使用 `market-watch-integration-20261024`，工作树 `/home/quant/repos/market-watch-integration-20261024`。

集成原HEAD `d0df172e`；股票接入交付 `53fb056a`、RRS收口 `b0db8d2f`；合并提交 `f2da7ee0`。股票与RRS分支存在继承关系，因此一次非快进合并纳入全部7个交付提交，保留原始历史和失败/验收边界。无需重复cherry-pick或覆盖集成分支。

## 分支整理

| 原分支 | 归档名称 | 处理 |
| --- | --- | --- |
| integration/equity-qfq-mwa-20261025 | archive/equity-qfq-mwa-20261025 | 原HEAD 53fb056a、工作树和全部内容保留 |
| fix/rrs-sparse-history-20261026 | archive/rrs-sparse-history-20261026 | 原HEAD b0db8d2f、工作树和全部内容保留 |

仅归档本次已收口的两个任务分支。其他分析/开发分支和未提交现场保留，不删除工作树、数据或备份。

## 合并核对和验证

两侧只有advanced-host/bridge.js共同改动，Git自动合并无冲突，已检查合并差异。231个接入/RRS路径中其余路径与交付分支逐字一致；集成独有路径也保持原内容，包括手机功能移除和架构文档。未复活已删除的移动端工作区。

- 合并后6个后端相关文件121项通过，包含原5项RRS失败、AKShare/Yahoo、原生历史任务和维护模式。
- 10组前端命令全部通过，覆盖周期能力、FXCM/指标身份、RRS契约、自选预热/订阅/偏好、告警桥接。
- Web TypeScript/Vite/data-center构建通过；保留既有chunk大小提示。
- 无冲突项，git diff --check通过。仅本地集成检查，未重复跑全后端、PG、实盘浏览器或远程CI。

合并前Git bundle已实际恢复为bare仓库，三分支引用逐一匹配，fsck通过。私有备份 `/home/quant/repos/archives/market-watch-equity-rrs-integration-20261026` 保留；除主集成工作树预期合并外，其余12个工作树的HEAD、Git状态、暂存/未暂存差异摘要及原未跟踪文件摘要均匹配，只有上述两个分支名按预期改变。

## 运行与已知限制

本轮未构建Docker、重启或更新mwa，当前mwa继续运行RRS API r1 / workers r12 / Chart r10 / Web r1，集成源码不冒充已部署源码。集成已有手机功能移除，mwa尚未部署该部分。

股票接入交付、RRS修复与用户收口决定保持：162项RRS相关回归及冻结真实1957根日线复算通过；OANDA连接阻塞导致真实图表RRS D1/H1/H4与分页未验收。前轮1工作区/3偏好未知归因差异继续留证；本次RRS操作前保护审计通过，不重写前轮审计。

本轮仅本地分支整理与兼容合并，保留既有产品验证，新增合并交互检查。没有推送、PR、main合并、候选tag或生产发布，没有操作mwa/其他任务的Docker资源。
