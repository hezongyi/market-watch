# 手机端待实现补充批次验收

2026-11-14：本轮五项待实现已完成，并部署到 Ubuntu `quant-server` 的本任务隔离 Docker 实例。实现与本地、浏览器、真实接口验收完成；Android 真机复核仍需用户进行。未执行 commit、PR/CI、APK 构建或 Unraid 生产操作。

## 交付范围

- **自建详情**：首层直接展示历史模式、价格口径、日界线、可用周期、覆盖结论、维护计划和实时状态；各周期范围、版本、精度、映射与轮换信息按需展开。保留旧可用历史时明确最近失败，不把总范围当成各周期范围；读取中、陈旧缓存、认证异常与未开启分别表达。
- **数据页精简**：移除标题统计和列表内查找行；工具与搜索同在右上，均无边框、无底纹。成功操作通过按钮或实际行状态反馈，失败就近展示并记日志。保留数据读取真实时间，离线不允许基于旧状态写入，恢复后重新读取。
- **搜索性能**：目录先匹配再展开变体；多词分阶段匹配并复用索引表达式；手机添加自建跳过精确总数，用 25+1 判断下一页。保留短词、中文、供应商/类别匹配、多词 AND、字段内 OR、分页前排除与最终防重；网页端默认总数行为不变。
- **管理自选**：移除撤销上次移除；品种移除与分组删除使用相同危险语义的垃圾桶图标按钮。未改变保存范围和冲突处理。
- **静默日志**：更多→应用→日志；取消顶部浮窗、前台事件弹条及原生 alert，保留必要行内错误。日志支持筛选、搜索、详情、复制、脱敏导出、重复合并与恢复关联，保存 7 天且最多 1000 条；告警原投递、回执和处理语义不变。

本轮未调整已认可的 72px 自选行、50px sparkline、M5 最新点、直线绘制、配色、固定代码/价格栏及连接生命周期，也未加入暂缓的自建实时额外视觉标识。

## 风险与兼容性

分类 **F1**：新增本机日志持久载荷，涉及账号隔离及清理。复用 IndexedDB v2 的 snapshots 存储，不升级数据库或删除旧数据；新键为 `application-logs-v1`。测试覆盖旧 v2 打开、账号/来源/匿名隔离、迟到回调隔离、退出与清理竞态、存储失败退回内存、条数/期限限制、合并/恢复及 JSON、Cookie、URL 凭据脱敏。复制和导出复用脱敏内容。

完成独立 Standards / Spec review，发现项已修复并复核；最后的数据读取生命周期修正亦已复核。后端 PostgreSQL 无 schema 或数据迁移。

## 检查结果

| 检查 | 结果与证据 |
| --- | --- |
| 后端搜索、目录及创建检查 | 32 passed；[backend-test.log](backend-test.log) |
| 生产构建 | 通过；[build.log](build.log) |
| 自选、搜索、数据、更多、告警、登录、应用生命周期 | 通过；对应 `*-test.log` |
| 数据完整流程 | 16 组检查、56 张截图通过；[workflow-proof.json](workflow-proof.json)、[workflow-test.log](workflow-test.log) |
| 日志持久化、兼容、隔离、脱敏与清理 | 通过；[logs-test.log](logs-test.log) |
| 自建信息准确性与未知/陈旧状态 | 通过；[facts-test.log](facts-test.log) |
| 图表准备、缓存隔离和后台取消 | 通过；[chart-preparation-test.log](chart-preparation-test.log) |
| 自选几何、固定栏、刷新、缩放及离线回归 | 通过；[geometry-test.log](geometry-test.log) |
| 实际 Ubuntu 部署 | readyz 200，运行源码/资源哈希匹配，无前台 toast、无真实用户写入；[runtime-proof.json](runtime-proof.json) |

浏览器矩阵覆盖 375/412px、深浅主题、默认与 150% 字号；流程还覆盖小视口聚焦、返回与未保存退出、丢失响应读回、维护冲突、实时开关失败回退、离线保护及恢复。应用回归包含真实许可图表、20 次导航切换、离线恢复、网页更新与未提交登录输入保护。

写入行为采用浏览器夹具；真实环境仅只读烟测和搜索，未修改用户真实分组、自建配置或实时开关。56 张流程截图是测试产生的完整清单，仓库保留代表截图，不将夹具数据视为真实供应商结果。

## 搜索实测

同一 Ubuntu 实例、两种搜索模式各 3 轮，共 48 个真实 HTTP 请求；表中合并两种模式共 6 个样本。数据见 [search-http.json](search-http.json)。

| 查询 | 中位数 ms | 范围 ms |
| --- | ---: | ---: |
| 空查询 | 419 | 300–611 |
| xau oa | 44 | 33–52 |
| 黄金 oa | 499 | 459–623 |
| 美股 yahoo | 544 | 502–692 |
| oa | 520 | 430–664 |
| eurusd | 43 | 32–54 |
| aapl | 37 | 30–48 |
| 不存在 | 38 | 30–50 |

此前部分搜索约 1.6–1.8 秒，现已降低；中文和短词仍约半秒以上，不能宣称所有搜索低于 500ms。旧/新查询对 11 个关键词、两种模式完成全结果身份比较，22 组均无增漏；见 [search-identity-comparison.jsonl](search-identity-comparison.jsonl)。SQL 分析见 [search-sql.jsonl](search-sql.jsonl)，可复用 `scripts/mobile_symbol_search_profile.py` 只读分析。

## 截图

人工查看了真实数据页、真实自建详情、日志深浅主题，以及 375px / 150% 字号的自建详情；最终图片均等待动画结束。

- [真实数据页](screenshots/real-data.png)、[详情](screenshots/real-managed-detail.png)、[展开信息](screenshots/real-managed-detail-expanded.png)
- [自选搜索](screenshots/real-watch-search.png)、[添加自建搜索](screenshots/real-create-search.png)
- [日志浅色](screenshots/logs-light-375-14.png)、[日志深色大字](screenshots/logs-dark-375-21.png)
- [数据页大字](screenshots/matrix-home-light-375-21.png)、[详情深色大字](screenshots/matrix-detail-dark-375-21.png)、[小视口表单](screenshots/20-form-small-viewport.png)

## 运行与回退

后续局部更新：数据列表实时开关放大已替换本任务web，当前web镜像与shell以[开关放大验收](../mobile-live-switch-20261114/README.md)为准。下方保留本批次原镜像，作为回退依据；其他服务不变。

- 主机：Ubuntu `quant-server`，Compose project：`mw-managed-live-rollover-20261113`。
- 验收：[自选](https://192.168.7.232:18447/m/watch)、[数据](https://192.168.7.232:18447/m/data)、[更多与日志](https://192.168.7.232:18447/m/more)。18443 生产实例未改动。
- 启动：`/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/start.sh`
- 停止：`/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/stop.sh`
- web 镜像：`sha256:89fd8eb1160485e171a9eb1cd867341aac24c3f1668698189eb39a1c7eb72e95`；shell：`7024b02e926fbfb2`。
- api / data-worker / market-runtime 镜像：`sha256:25e2db4b3ba1a60ad5547b5649395d82a53e803d619cca875bc100436a54975d`。

仅替换本项目应用服务，复用任务数据库及 volume；启动配置更新前在上述私有目录保留了 `*.before-mobile-pending-polish-<UTC>` 备份，旧镜像保留。回退可恢复对应 run/compose 配置再启动本项目，不需回滚数据库；旧 UI 忽略新增日志快照键。凭据、env、许可和浏览器完整状态不入库。

## 待真机复核与已知边界

- Android 软键盘、系统返回/手势退出、剪贴板及导出实际文件行为仍需真机确认；浏览器模拟不替代系统验收。
- 当前 EURUSD / USDCAD 的既有实时认证异常如实展示，本轮没有更改凭据或宣称供源已修复；六源启用配置保留。
- 若现有 APK 指向本验收地址，可以直接复核本次网页更新；本轮未生成新 APK。

## 交付后补查：检查 APK 更新失败

用户反馈后复现：18447 的 `/downloads/android-update.json` 返回 404。原因是更新文件属于 Git 忽略产物，新工作树缺少原已发布的 `web/vendor/downloads`，网页构建成功不代表原生更新目录完整。

已恢复原已发布的 0.1.3（versionCode 4）清单与安装包；校验原 APK 签名、包名、版本、大小和 SHA-256，未重做 APK。将文件保存到本任务私有持久目录 `downloads`，在 `run.json` / `compose.json` 增加只读下载目录挂载，仅重建本项目 web 容器；原配置备份为 `*.before-downloads-<UTC>`，镜像、数据库和 API 未改动。工作树的忽略下载目录也已恢复，供后续构建使用。

复验使用 APK 内置的开发 CA，未跳过 TLS 校验：清单和 APK 均返回 200、清单 no-store、APK 摘要与字节数一致；未知 APK 返回 404，SW 与 readyz 仍返回 200。见 [android-update-proof.json](android-update-proof.json)。已安装 0.1.3 时应显示当前最新版；实际原生桥接点击仍待用户复核。

另外只读检查到 18443 同路径返回 HTML，不能作为 APK 清单解析；该实例未改动。部署文档增加了下载目录保留与部署后验证要求。

后续：品种级历史范围、独立特点标签、删除技术明细/默认组选项及两处搜索缓存提示已另行实施，当前镜像、范围核对与截图见[最新验收记录](../mobile-detail-simplification-20261114/README.md)。本文详情展开与旧镜像为此前验收快照。
