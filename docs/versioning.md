# v1.25.1 稀疏日线价格告警修复

兼容补丁同步 Python/web 与锁文件根版本，最终 main 合并提交创建不可移动附注标签 v1.25.1。受测应用提交 6b02eea；最新 main 整合仅带入生产交付文档，无依赖或迁移变化。190 项相关回归、真实 PostgreSQL 和生产输入回放见 [验收证据](verification/sparse-alerts-20261013/README.md)。正式生产使用 clean tag 独立 release 镜像，备份实际恢复、固定镜像及切换证据另行记录；保留 v1.25.0 回滚材料和全部历史标签。

# 版本维护

## v1.25.0 原生指标结果与历史重检发布

PR #55 新增兼容的通用 Python 原生指标结果接口，采用次版本 1.25.0。同步 Python/web 与锁文件根版本、README 和 CHANGELOG；按用户授权合并，以最终 main 合并提交创建不可移动附注标签 `v1.25.0`。受测产品提交 `7a567f0`，最终测试与记录提交 `e6308f79`；版本整理不改变受测运行代码。复审证据见 [PR #55 最终报告](issues/production-pending-pr55-review-fixes-20261013.md)。无新增依赖或 migration；生产 v1.23.0 升级仍需备份、实际恢复并验证前一版本 as46 迁移。已完成生产 v1.23.0→v1.25.0 升级，正式镜像、最终备份恢复和上线证据见 [生产交付](pending-v1.25.0-production-delivery.md)；证据独立提交，保留历史清单与源码标签。

# Git与版本维护

## v1.24.0 ATR 告警偏移源码发布

PR #54 新增兼容的可选 ATR 告警偏移，采用次版本 1.24.0。同步 Python/web 及锁文件根版本、README 和 CHANGELOG；按用户授权合并，以最终 main 合并提交创建并推送不可移动附注标签 `v1.24.0`，保留已有标签。受测产品提交 `5faba2c0369f0ca569fdb76f7aa90fb3d15543f3`，后续发布整理只修改版本及交付记录，不改受测运行代码、依赖或迁移。新增迁移 `as46_provider_price_confirmation` 已在 Ubuntu 验收实例验证，生产执行迁移前需备份；旧 checkpoint 安全重建。测试及最新 11 张截图见 [最终复审](verification/atr-offset-20261012/review-fixes/README.md)，源码清单见 `deploy/releases/v1.24.0-source.json`。实例继续保留供复核，Docker 生命周期 task 未退役；本次授权范围为源码合并和 tag 发布。

## v1.22.1 生产验收 UX 修复源码发布

PR #50 修复既有 UX 与告警入口问题，采用兼容补丁版本1.22.1。同步 Python/web/锁文件根版本及 CHANGELOG；按用户授权合并，并以最终 main 合并提交创建、推送不可移动的附注标签 `v1.22.1`，保留 `v1.22.0`。最终受测交付提交为 `f115f4cebbdd0f1cbcf29c87ac972e0935112858`，包含 main `33ef507`（#51）的集成；发布整理仅修改版本元数据、README和源码发布记录，不改变运行实现、依赖或迁移。299项相关Python、24项真实PostgreSQL、JS与实际登录网页组合模板／工作区／告警／三手机视口复验通过，Standards／Spec无阻塞。原完整验收、14张追加截图、合成价格与未验证边界见 [修复记录](production-ux-fixes-20261012.md)，源码清单见 `deploy/releases/v1.22.1-source.json`。独立验收任务已备份、实际恢复验证及退役。本次授权为源码合并和tag发布，不包含生产部署。

## v1.22.0 Swing 支撑阻力源码发布

PR #51 新增兼容的 Swing Python 指标、展示协议与原生模板恢复，采用次版本1.22.0。同步 Python/web/锁文件根版本及 CHANGELOG；按用户授权合并 PR，并以最终 main 合并提交创建、推送不可移动的附注标签 `v1.22.0`。受测产品提交为 `450b48034e151f4e688832bd706b2293c2b5c3fc`，发布整理仅修改版本元数据与交付记录，无新增依赖或数据库迁移。318 项相关 Python、6 项 PostgreSQL、JS 回归与真实登录网页12组验收通过，Standards／Spec 复审无阻塞。冻结日历假设、截图及实例来源见 [验收记录](swing-sr-implementation-acceptance-20261012.md)，源码清单见 `deploy/releases/v1.22.0-source.json`。保留既有标签及验收镜像的实际构建提交；本次授权为源码合并与标签发布。

## v1.21.2 真实日历身份碰撞修复

v1.21.0 的最终生产备份在 Ubuntu 实际恢复后暴露日历目录条目／已登记品种同 ID 排序异常。生产切换门槛阻止了新版本安装，原 v1.20.4 已恢复。采用兼容补丁版本 1.21.2，区分目录身份、按标量字段排序，不改变品种审核关联、日历适用边界或数据结构；保留 v1.21.0 标签。修复与验证见 [补丁记录](calendar-scope-collision-v1.21.2.md)。

## v1.21.0 专业图表生命周期与审核修复源码发布

PR #46 包含兼容的九周期独立绘图可见性，以及图表生命周期、后台恢复、原生界面和日历审核修复，采用次版本 1.21.0。同步 Python/web/锁文件根版本及 CHANGELOG，以最终 main 合并提交创建并推送不可移动的附注标签 `v1.21.0`，保留既有标签。受测产品提交为 `d2108df01d900c234052da469a2a74b09043735b`，其后发布整理仅修改版本和交付记录；无新增依赖或迁移。95 项相关后端测试通过，Standards/Spec 均无剩余阻塞，详情见 [PR #46 复审](verification/pro-charts-20261011/pr46-review.md)，源码清单见 `deploy/releases/v1.21.0-source.json`。本次用户授权范围为合并及源码标签，生产镜像构建和部署另行执行；源码标签不代表生产已升级。

## v1.20.1 既有布局告警初始化修复

修复首次取消未注册图表事件导致既有布局原生告警初始化中断。按兼容补丁同步 Python/web/锁文件为 1.20.1，不移动 v1.20.0 标签、不改历史生产清单；真实许可图表四项及 Ubuntu 独立五图布局六组验收通过，两轴复核无阻断。受测应用实现 `c23537d`，`e6d3393` 仅恢复历史清单；无依赖或 schema 变化。PR #39 已合并，附注标签已推送，Ubuntu 四类正式镜像已部署 unraid；生产登录态六组与备份实际恢复通过，旧行情来源错误边界保留。详见 [生产交付](saved-layout-alert-v1.20.1-production-delivery.md)。

## v1.20.0 原生图表告警 UI

发布已执行：PR #38 合并提交 `73356b7`，不可移动附注标签已推送。Ubuntu 四类正式构建已部署 unraid，数据库备份实际恢复和用户设置指纹核验通过；用户提供密码后的登录态检查发现既有布局首次事件解绑异常，原生告警未初始化；v1.20.1 补丁正在处理。生产来源、固定镜像 ID、回滚和验证边界见 [生产交付](native-alert-v1.20.0-production-delivery.md)。

PR #38 新增兼容的原生告警侧栏与窗口，采用次版本 1.20.0，包含已合入 main 的 v1.19.0 商品状态、报价与日历功能。同步 Python/web/锁文件根版本和 CHANGELOG；受测应用源码为 `c77f67c`，后续 `2d79f38` 仅归档证据，发布整理仅改版本及本记录。两个 P2 与一个 P3 已修复，两轴独立复核无剩余阻断；最终 Ubuntu Docker API/web/chart/workers 均验证 clean `c77f67c` 应用源码，见 [复核记录](verification/native-alert-ui/review-fixes/README.md)。用户已授权合并、推 tag 和 unraid 正式生产部署；以最终 main 合并提交创建不可移动附注标签 v1.20.0，另行构建 purpose=release 镜像并记录固定 ID。无新增依赖或 schema 变更，生产 Yahoo 默认启用；备份实际恢复与生产验证以本次生产清单为准。

## v1.19.0 商品交易状态与报价详情源码发布

PR #37 新增兼容的统一会话状态、报价时间与交易日历功能，采用次版本1.19.0。同步Python/web/锁文件根版本及CHANGELOG，按用户授权合并PR，并在最终main合并提交创建、推送不可移动的附注标签v1.19.0；保留既有标签。受测产品提交为 `400062f`，后续 `b12b520` 仅修正验收脚本的预期取消分类，`1d19fcc` 是审查／证据收口。发布整理仅修改版本元数据及本记录，不改运行实现、依赖或schema。最新main集成后237项后端回归、41个真实许可图表功能场景及范围恢复验证通过；末次runner的预期取消分类断言失败与未重新运行分类修正的边界如实保留。独立Standards/Spec无剩余阻断，Ubuntu验收PG备份、实际恢复与精确退役已完成；详见[修复及复核报告](market-session-details-pr37-fix-20261011.md)。本次仅合并及推送源码标签，生产部署另行授权。

## v1.18.1 历史价格精度修复源码发布

PR #36 修复已有历史价格精度处理，采用兼容补丁版本 1.18.1。同步 Python/web/锁文件根版本和 CHANGELOG；按用户授权合并 PR，并在最终 main 合并提交创建、推送不可移动的附注 tag v1.18.1。受测产品提交为 `b890ae6`，发布整理仅修改版本元数据及记录，无新增依赖或迁移。206 项宿主回归、34 项 Ubuntu 真实 PostgreSQL 测试及桌面/手机编译产物说明检查通过；完整 backend 全集及原生产任务最终发布未验证。验收数据库实际恢复及精确退役已完成，证据见 `docs/verification/history-price-rounding-review-20261011.json`。本次仅合并与发布源码 tag，生产部署另行授权。

## v1.18.0 来源状态页面与生产 Yahoo 默认启用

PR #33 补交来源状态分类，PR #34 将 Yahoo 固定为后续生产默认启用，采用兼容功能次版本 1.18.0。Python/web/锁文件根版本与 CHANGELOG 同步；按用户授权在最终 main 合并提交推送不可移动附注 tag v1.18.0，Ubuntu mw-docker purpose=release 构建四类正式镜像，再部署 unraid。无新增 schema/第三方依赖；生产开关与网络验收依据实际部署记录，不以源码 tag 推断已启用。

## v1.17.0 自建行情管理 UI 与任务导航

PR #31 新增兼容的管理布局与任务返回导航，采用次版本 1.17.0。同步 Python/web 及锁文件根版本和 CHANGELOG；合并后在最终 main 提交创建不可移动的附注标签 v1.17.0。正式镜像通过 Ubuntu `mw-docker`、`purpose=release` 构建，逐服务提交和镜像 ID 由发布清单记录；用户已授权 unraid 正式生产切换，数据库保持 `ar45_market_stream`。原验收与新增位置恢复回归边界见 `docs/verification/dataset-management-ui-20261010.md`。

## 2026-10-10 自选表商品代码筛选 v1.16.1

自选表“添加商品代码”与主搜索统一行情类型和来源筛选，属于已有功能的兼容界面修复，采用补丁版本 1.16.1。同步 Python/web 及锁文件根版本与 CHANGELOG；按用户授权合并 main，并以最终合并提交创建、推送附注标签 v1.16.1，保留全部既有标签。受测产品提交为 `b64d579`；发布整理只更新版本及记录，原生适配代码 SHA256 保持一致。10 项 Ubuntu Docker 浏览器验收及精确退役完成，无新增依赖或迁移。本次发布源码，生产部署另行执行；源码清单见 `deploy/releases/v1.16.1-source.json`。

## v1.16.0 原生数据中心发布

PR #27 在 `54c3720` 合入 main。兼容新增原生数据中心、指标分类详情收藏及商品代码筛选，采用次版本 1.16.0；同步 Python/web 和锁文件根版本及 CHANGELOG。运行功能验收见 `docs/verification/chart-data-center/pr-integration-20261010.md`。用户授权正式生产切换与推 tag；正式镜像从发布整理后的干净 main 提交构建，部署证据另存逐服务发布清单。上线验证稳定后推送不可移动的附注标签 v1.16.0；schema 保持 ar45_market_stream，回退保留 v1.15.1 镜像及已实际恢复验证的备份。

## v1.14.1 发布性能与回退核验修复源码发布

PR #21 修复发布空闲开销、聚合公平性和旧应用回退后覆盖投影过期，采用兼容修复补丁版本1.14.1。同步Python/web及锁文件根包、CHANGELOG与源码清单，以PR #21最终main合并提交创建并推送附注标签`v1.14.1`，保留全部旧标签。最终已复审输入为`4d07139`（产品`9e51fcf`），发布整理仅修改版本及交付资料；未构建或改标生产镜像。

完整后端及ops1455 passed/2 skipped，Standards/Spec无阻断，0.75CPU真实50聚合目标最长等待3.052秒；历史r6长场景仍保持原候选来源，不冒称当前全部重跑。schema为`aq44_aggregation_service_order`，升级/回退及逐身份重新核验见[交付记录](publication-v1.14.1-source-delivery.md)和`deploy/releases/v1.14.1-source.json`。Ubuntu验收已备份恢复验证及精确退役，生产部署另行执行。

## v1.14.0 三层行情与数据中心源码发布

PR #20 新增平台、自建及组合三层行情、数据中心维护与固定输入修订，按兼容新增功能使用次版本 1.14.0。用户授权合并并推 tag 后，同步 Python/web/锁文件根包、CHANGELOG 与源码清单，以 PR #20 最终 main 合并提交创建和推送附注标签 `v1.14.0`；保留旧标签。运行实现、迁移与测试保持复审通过的 `b261423` 输入，发布整理仅修改版本及交付资料。

新增 dukascopy-python 依赖及迁移至 `am40_chart_revision_demand`。完整后端 1324 passed / 2 skipped，跳过项分别补验日历 4 项和 PG 备份恢复 1 项通过；独立 Standards/Spec 无阻塞，Ubuntu 独立资源已备份、实际恢复核对并退役。来源、哈希与迁移/回退边界见 [交付记录](market-data-v1.14.0-source-delivery.md)和 `deploy/releases/v1.14.0-source.json`。本次发布源码，长期观察按用户决定暂缓，生产部署另行执行。

## v1.13.0 双击最大化与验收退役身份校验

PR #17（`699e6ec`）新增兼容的图表双击操作，采用次版本1.13.0；PR #18（`c18b219`）补齐 PG/TLS 共享镜像身份校验。同步 Python/web 及锁文件根包、CHANGELOG 和源码清单后，以发布整理 PR 的最终 main 合并提交创建并推送附注标签 `v1.13.0`，保留旧标签。来源与验证边界见 [交付记录](chart-maximize-v1.13.0-source-delivery.md)及 `deploy/releases/v1.13.0-source.json`。本次发布源码，生产部署另行执行。

## v1.12.1 Ubuntu Docker 运维维护发布

PR #15 在 `ec9403a` 合入main，落地专用BuildKit、任务归属构建、备份及实际恢复验证后的验收退役、定时镜像清理与空间告警。按维护版本1.12.1同步Python/web及锁文件根包、CHANGELOG和源码清单，发布整理不改变受测工具逻辑。用户授权创建并推送附注标签v1.12.1，指向发布元数据PR最终main合并提交，保留旧标签。工具25项测试及Ubuntu实际构建、恢复和清理通过；schema/业务逻辑/依赖不变。见 deploy/releases/v1.12.1-source.json 和 docs/ubuntu-docker-v1.12.1-source-delivery.md。本次发布源码，不切换Unraid生产。

## v1.12.0 范围映射与柱宽同步源码发布

PR #12 在 `77834e5` 合入main，新增范围映射、原生同步设置及柱宽同步，采用兼容功能次版本1.12.0。Python/web/锁文件根版本和CHANGELOG同步，发布整理分支只调整版本及记录，不改变受测功能源码。用户授权合并及推tag；以发布整理PR的最终main合并提交创建、推送附注标签v1.12.0，保留旧标签。当前Ubuntu候选54项/4组浏览器和21项模块通过，两轴审核无开放P1/P2；候选镜像保持实际来源。见 deploy/releases/v1.12.0-source.json 和 docs/chart-range-v1.12.0-source-delivery.md；本次只发布源码，生产另行授权。

## v1.11.0 图表告警源码发布

PR #11 新增 Advanced Charts 后台持久告警并与原生 MCP 汇合，采用兼容功能次版本 1.11.0。独立控制修订号、生命周期持久幂等及 published 观察时间绑定等七项审阅发现已修复，两轴复审无剩余阻断。完整后端 586 passed / 46 skipped、真实 PG 8 passed、最终 Ubuntu 浏览器 8 场景及 HTTPS MCP 15 checks 通过；新增 t21 汇合与 u22 请求身份迁移。按用户授权在最终 main 合并提交创建、推送附注标签，保留全部旧标签；受测输入、实际镜像与交付边界见 deploy/releases/v1.11.0-source.json 和 docs/chart-alerts-v1.11.0-source-delivery.md。本次不部署生产，schema 回退须恢复验证过的备份。

## v1.10.0 原生 MCP 源码发布

PR #10 新增原生 HTTP MCP 与注册式 agent 能力，采用兼容功能次版本 1.10.0。Python/web/锁文件根包及 CHANGELOG 同步，用户授权合并 PR 并在最终 main 合并提交上创建、推送附注标签 v1.10.0；不移动旧标签。实际 Ubuntu 独立环境和 Codex 验收已通过，源码清单见 deploy/releases/v1.10.0-source.json，验收与发布输入边界见 docs/native-mcp-v1.10.0-source-delivery.md。新增 `s20_agent_capabilities` 迁移及官方 MCP SDK 依赖；MCP 默认关闭。此次源码发布不重建或改标已有验收镜像、不切换生产、不执行生产迁移。

## v1.9.0 指标窗口源码发布

PR #9 新增兼容的指标搜索窗口及 Python 声明契约，使用次版本 1.9.0。同步 Python/web/锁文件根包版本与 CHANGELOG；两轴独立 review 及修复复审通过，75 项后端测试和 Ubuntu 独立实例20项真实产品验收通过。按用户授权合并 PR 并以最终 main 合并提交创建、推送附注标签 v1.9.0；不移动旧标签。源码清单为 deploy/releases/v1.9.0-source.json，构建与验收来源边界见 docs/chart-v1.9.0-source-delivery.md。无新增迁移或依赖，本次不构建或改标容器、不切换实例或部署生产。

## v1.8.0 连续历史加载发布

PR #7 的原生连续历史、持久加载任务、容量设置和边界提示属于兼容新增功能，使用次版本 1.8.0。共享取消及数据库超时问题在独立修复分支完成，两轴复审无剩余问题，Python/web/锁文件版本同步。修复 PR #8 已合并，附注标签 v1.8.0 指向 main 合并提交 `b700911` 并已推送；四类镜像以该标签源码另行构建，2026-10-06 已切换 Unraid 正式生产。

固定配置和实际镜像映射见 deploy/releases/v1.8.0-production.yaml/json；新增专用 native-history-worker，应用 r19 增量迁移，保留原行情缓存和 v1.7.0 回退点。升级前后备份在 Ubuntu 独立 PG14 实际恢复通过；正式登录、既有原生图表和退出登录的只读验收已通过，验收后用户状态保持一致。执行状态和验证边界见 docs/chart-v1.8.0-delivery.md。后续证据提交只更新文档，不移动 v1.8.0。

## v1.7.0 原生视窗储备发布

PR #6 的原生视窗储备属于兼容新增功能，使用次版本 1.7.0。先合入最新 main 并修复复审阻断，再同步 Python/web/锁文件版本，通过独立规范与需求复审后合并 PR，创建并推送附注标签。生产镜像使用最终标签源码另行构建；实际部署由 v1.7.0-production.json 管理，不将原 v1.5.2 验收镜像冒称新构建。PR #6 已合并、附注标签已推送；生产从 v1.5.0 升级并通过迁移及备份恢复验证。后续证据提交仅更新文档，不移动 v1.7.0。旧标签与旧生产镜像保留，生产升级、备份及回退见 docs/chart-v1.7.0-delivery.md。

## 版本规则

- `v1.0.0`：首个正式交付版本，采用附注标签；发布后不移动或覆盖标签。
- `v1.0.1`：兼容的问题修复；`v1.1.0`：兼容的新功能；`v2.0.0`：不兼容变更。
- `main`保存可发布代码，日常变更在`feature/...`或`fix/...`分支进行。

## 发布流程

1. 在Ubuntu开发分支修改，使用独立开发/测试库，关闭真实通知。
2. 运行与变更风险匹配的测试，审查差异、迁移和凭据排除情况。
3. 更新`pyproject.toml`、`web/package.json`及锁文件根包版本，更新`CHANGELOG.md`。
4. 合并main，生成逐服务镜像/构建提交/镜像ID发布清单及Compose覆盖文件，再创建附注标签。
5. 按发布清单在Unraid部署；涉及迁移先备份。上线后检查健康、行情、worker和相关变更。手机响铃测试需约定窗口。
6. 回滚依据前一发布清单；有不兼容数据库迁移时，先评估数据恢复，不能仅回退镜像。

## 首次发布说明

`v1.0.0`对应已验收系统，复用既有生产镜像，不声称这些镜像由版本标签重新构建。实际来源与镜像ID保存在`deploy/releases/v1.0.0.json`；Compose覆盖文件为同名yaml。版本元数据变更将在后续构建时进入镜像。

## 远程仓库与秘密

已配置origin。执行合并或推送前刷新远端引用，检查实际提交范围和同名标签；只推明确选定的分支/标签，不force、不移动发布标签。源码推送与生产部署分别执行。

`.env`、artifacts中的凭据、数据库及备份不提交Git；`.env.example`只保留示例。新增秘密文件也需排除。公开仓库前必须单独检查整个历史中的敏感信息。

生产配置与数据库备份保存在`/mnt/user/backup/trading-alerts`；凭据与数据恢复按备份指南处理，不依赖源码仓库。

## v1.0.1 项目改名

项目名为`market-watch`，网站继续显示“守望 · Market Watch”，本地目录为`/home/quant/repos/market-watch`。Python发行包名为`market-watch`，内部导入仍为`alerts`。现有`ALERTS_*`配置、生产数据库、Docker服务和部署/备份目录均保留原标识。

v1.0.1仅发布本地源码标签，未部署；生产镜像仍以`deploy/releases/v1.0.0.json`为准。本版本没有新的生产镜像清单，后续部署时再生成真实镜像映射。远端由用户自行配置和推送。

本地目录迁移同时更新虚拟环境脚本中的绝对路径并重新安装可编辑包；其他开发机首次检出应按README新建虚拟环境。历史验收记录及旧标签保持原样。

## v1.2.0 独立图表模块本地交付

按本轮保留原项目、独立接入和仅本地交付要求，v1.2.0标签保留在feature/advanced-charts，不合并原仓库main，不推远端、不部署生产。包版本1.2.0；本机镜像使用1.2.0-local，构建提交与镜像ID见deploy/releases/v1.2.0-local.json。本机origin固定为回环HTTPS，后续生产发布须另行配置和构建。

## v1.3.0 双系列本地交付

包版本1.3.0，附注标签v1.3.0仍保留在feature/advanced-charts。API/web/chart由源码提交a71439b34964fea9cf825d7a6e2d412bac071fc5统一构建，发布清单deploy/releases/v1.3.0-local.json记录镜像ID、构建标签和运行核验。交付标签增加验收、运行/回退文档和用户修订的性能验收规则，未改变镜像运行代码；不为文档变更重新构建或移动旧标签。

用户2026-10-02明确接受大多数冷首屏低于3秒，不再要求每次低于3秒；已有代理/TLS/上游长尾保留在审计及证据中。候选镜像内market-watch.accepted=false为构建时状态，最终本地验收结论以v1.3.0-local.json为准，不改写镜像历史元数据。不合并main、不push、不操作Unraid。

## v1.3.1 历史修订修复与源码发布

v1.3.1修复自建历史内部更正无法发布及图表不自动重载的问题；新增o16_managed_revisions迁移。按用户本轮授权合并main并推送main及v1.3.1附注标签，保留v1.3.0及其发布记录。新版本是源码发布，测试/构建关联及镜像状态见deploy/releases/v1.3.1-source.json和docs/chart-v1.3.1-delivery.md；没有把v1.3.0镜像改标为新版。生产域名、镜像、迁移/备份、worker及部署验收仍单独安排。

## v1.3.2 平台连接生命周期修复与源码发布

v1.3.2修复平台chart池容量为二却只预热/维护一条连接及后台额度等待未及时让位的问题。整合最新main的v1.3.1自建历史修订修复，schema仍为o16_managed_revisions，没有新增迁移。按用户授权合并main并推送main及v1.3.2附注标签，保留全部旧版本标签和证据。源码发布清单为deploy/releases/v1.3.2-source.json，验证/构建关系和性能限制见docs/chart-v1.3.2-delivery.md；未构建或部署新容器，不把旧镜像标为新版。

## v1.3.3 Volume 本机交付

以v1.3.2为基线在fix/volume-v1.3.3隔离worktree完成平台/自建Volume、独立修订和有界历史补量，新增p17_volume。逐服务同提交镜像及本机数据库备份、批准补量清单、运行复验见deploy/releases/v1.3.3-local.json和docs/chart-v1.3.3-delivery.md。用户最后明确性能问题不需处理，保留原性能失败证据，不将其描述为通过。本机验收阶段仅更新Ubuntu，未合并main、推送远端或创建正式标签；后续源码发布见下节。

## v1.3.3 Volume 源码发布

用户确认可以合并并授权执行及打标签后，通过fix/volume-v1.3.3到main的PR保留原提交历史，采用附注标签v1.3.3指向最终main合并提交。源码发布清单为deploy/releases/v1.3.3-source.json；运行、测试和构建输入须与已验收源码edc799a保持逐字节一致，后续提交仅整理证据与发布文档。保留全部旧版本标签和失败记录，不force、不将旧镜像改标为标签提交的新构建。本次源码发布不重建或切换运行镜像、不操作生产；性能排除和旧历史量partial/null限制继续有效。最终关系和回退见docs/chart-v1.3.3-source-delivery.md。

## v1.4.0 原生历史缓冲源码发布

原生历史缓冲是兼容新增功能，采用次版本1.4.0，并同步Python/web包与锁文件根包版本。用户授权推送及合并后，通过feature/native-history-buffer到main的PR保留实现、验收和集成修复历史，附注标签v1.4.0指向最终main合并提交。源码清单见deploy/releases/v1.4.0-source.json；最终受测集成源码为93db03b，其332项运行时/测试源码及229项原验收证据哈希保持一致，版本元数据与发布文档另行核对。schema保持p17_volume，无新增迁移。

此次按源码发布范围交付，不生成或改标容器镜像，也不执行生产部署；既有逐服务镜像和Compose来源继续由原native-history运行清单及v1.3.3-local清单管理。最终395项后端、40项非浏览器脚本及构建验证不冒充新组合镜像的浏览器验收。用户接受的Binance数值失败和旧证据保留，回退和后续部署要求见docs/chart-v1.4.0-source-delivery.md。

## v1.5.0 专业图表与账户源码发布

图表菜单、可选自动保存、账户密码和自选报价操作属于兼容新增功能，采用次版本1.5.0，并同步Python/web包及锁文件根包版本。按用户授权，通过feature/chart-ui-account到main的PR保留原22项UI/部署提交及主线集成修复；附注标签v1.5.0指向最终main合并提交。受测源码为535e1c7，发布阶段仅调整版本元数据和交付资料，源码清单见deploy/releases/v1.5.0-source.json。schema保持p17_volume，无新增迁移。

最终验证为406项后端通过/1项跳过、42项非浏览器脚本及8项受控Chromium密码边界检查；新版包和前端构建另行记录。原v1.3.2实例、Volume及native-history镜像和浏览器证据均保持原来源，不冒称新组合镜像已完成完整运行验收。本次不重建/改标容器、不改变实际账户密码或部署生产；未来账户凭据回退和部署要求见docs/chart-v1.5.0-source-delivery.md。

## v1.5.1 图表能力与 MT4 桥接文档修订

按用户要求将五篇研究文档整理为一次提交，使用补丁版本 1.5.1 同步 Python/web 包及锁文件根包版本。以 v1.5.0（37cf404）为固定运行源码基线，修正文档的实际 bundle、源码引用和已接功能状态；没有新增运行功能、依赖或迁移。开发分支 fix/docs-v1.5.1 单次提交，本地 main 快进到该提交，并创建附注标签 v1.5.1。

本次仅本地源码发布，不推送远端、不生成或改标容器、不改变运行实例。发布清单见 deploy/releases/v1.5.1-source.json；已有 v1.5.0 功能测试与运行验收边界继续保留原记录，本次只验证文档、版本一致性及发布构建。

## v1.5.2 布局刷新修复源码发布

布局保存后刷新覆盖首图品种及行情来源属于兼容缺陷修复，采用补丁版本 1.5.2。修复通过 PR #4 合入 main（9de3a39），Python/web 包及锁文件根包同步更新；发布提交仅整理版本和交付资料，附注标签 v1.5.2 指向 main 的发布提交并推送远端。保留 v1.5.0/v1.5.1 标签与原交付记录。

源码清单见 deploy/releases/v1.5.2-source.json，单图及 2/4/8 图回归、版本一致性及构建核对见 docs/chart-v1.5.2-source-delivery.md。schema 保持 p17_volume，无新增依赖或迁移。此次源码发布未构建或改标容器、未切换运行实例或部署生产；既有历史缓冲及 Binance 性能验收边界继续保留原记录。

## v1.6.0 Yahoo 原生行情与中文搜索源码发布

Yahoo 原生行情、延迟报价和平台品种中文搜索属于兼容新增功能，采用次版本 1.6.0。实现及审查修复通过 PR #5 合入 main（`4ef0e845f2acc63e68ede8603d3a622086444e66`），最终受测功能提交为 `b747d5b5656c8dbcca3cab8c9e8dd7e6c28071e9`。发布提交只同步 Python/web 包及锁文件根包版本，整理 CHANGELOG、源码清单和交付记录；附注标签 v1.6.0 指向该 main 发布提交并推送远端。

源码清单为 deploy/releases/v1.6.0-source.json，发布输入等价、版本和构建核对见 docs/verification/yahoo-release-v1.6.0/audit.json。源码新增 yfinance 依赖和 q18_yahoo_catalog 迁移，但发布阶段不再次修改运行代码、依赖或迁移。Yahoo 默认关闭，启用须配置代理并应用迁移；实际部署先备份，并核对目标实例来源。此次仅发布源码标签，不构建或改标容器，不切换生产服务或执行生产迁移。源码回退基线 v1.5.2；生产回退继续依据其原运行清单。
