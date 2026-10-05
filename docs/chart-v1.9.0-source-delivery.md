# v1.9.0 指标窗口源码交付

2026-10-06。专业图表新增可搜索的指标窗口，并加固 Python 指标的声明、计算与预热契约；属于兼容新增功能，使用次版本 1.9.0。实现通过 [PR #9](https://github.com/hezongyi/market-watch/pull/9) 交付，保留实现、修复、主线整合与验收历史。

最终受测分支提交为 `716ad583da52d59bc4e119127cdb4f60e2000348`；受测功能提交为 `fcd9ac8b1deb21f1fd1972bbeb10488132afefd0`。最新 main `2ee5cb7` 的交付文档已合入，运行代码及测试与受测功能提交逐字节一致。发布准备仅同步 Python/web/锁文件根包版本、CHANGELOG 和发布记录；最终 main 合并提交由 `git rev-parse 'v1.9.0^{commit}'` 解析，正式附注标签指向该提交且不覆盖旧标签。用户已授权合并 PR 与推送标签。

Standards 与 Spec 两轴独立 review 完成，发现的目录序列化 P2 和详情 P3 已修复并独立复审，无剩余发现。75 项相关后端测试、前端构建及 Ubuntu quant-server 独立项目 `mw-indicator-acceptance` 的 20 项完整产品验收通过；真实 BTCUSDT M5 六实例十曲线公开十字光标值与后端逐点一致，应用错误为空。审查、结果和实际镜像来源见 [验收记录](verification/indicator-picker/README.md)、[review.md](verification/indicator-picker/review.md) 与 [runtime.json](verification/indicator-picker/runtime.json)。收藏按已批准的原生入口兼容方案；许可包缺少 exportData 资源，数值核对采用公开 crossHairMoved 事件。既有 CSP 统计脚本限制和验收请求期限边界保留。

本次源码发布不构建或改标容器，不改变运行实例。Ubuntu 验收容器仍来自上述功能提交，包版本为 1.8.0，不冒称由 v1.9.0 标签新构建；访问地址 https://localhost:18443，图表 origin https://localhost:18444，启动/停止方式见验收记录。后续生产升级应另行授权，从标签固定构建逐服务镜像并记录真实 ID，沿用现有 r19 schema 和专用 history worker。

schema 保持 `r19_native_history_loads`，无新增迁移或依赖。源码清单见 [v1.9.0-source.json](../deploy/releases/v1.9.0-source.json)，发布构建/等价核对见 [release-audit.json](verification/indicator-picker/release-audit.json)。源码回退基线 v1.8.0；源码标签回退不会切换运行实例。生产回退须遵循现有逐服务发布清单和备份流程。
