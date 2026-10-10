# 自建行情管理 UI 实施与验收

实施依据：[2026-10-10 方案](../market-watch-dataset-management-ui-plan-20261010.md)。

## 实现

- 五个分类：概览、覆盖与质量、发布版本、维护设置、组合与引用。摘要和分类导航固定，正文使用一个主要纵向滚动区。
- 实际周期按分钟／小时／日周月分组；数字右对齐。窄屏使用两行，缺少的产物不补造，旧可用发布与当前产物计数分别说明。
- 覆盖分区与历史读取共用版本选择。切换版本清理两种分页，既有 `useSnapshot` 取消旧请求并隔离迟到响应。未知、已证实闭市、冲突与请求失败分别展示。
- 版本采用紧凑列表，详情和差异放入右侧或全屏面板。图表和回测固定所选版本；已回收价格只保留合法清单入口。
- 维护表单分组，高级项默认折叠。保留提交锁、稳定请求标识、未保存保护、配置冲突及真实删除保护；原生控件继承全部外层 fieldset 的禁用状态。
- 引用按接口实际类型计数、分组；完整身份进入详情，接口缺少独立版本字段时明确说明。
- 任务入口预填权威 `logical_symbol`、来源、精确 `dataset_id` 和全部状态。修改商品代码解除原数据集／来源限定；查看全部对象保留状态。直接任务入口清除来源返回上下文。
- 返回记录限于当前窗口和工作区，最多 32 条，仅用 opaque key 传递。位置最多 50 条，任务缓存最多 8 组；旧列表 `return_to` 禁止递归嵌套。分类、版本、位置和焦点支持返回／关闭重开恢复。

## 实际环境

| 项目 | 实际值 |
|---|---|
| 主机 | Ubuntu，本机 Docker socket；未使用 unraid |
| worktree | `/home/quant/repos/market-watch-dataset-management-ui-impl-20261010` |
| 分支／基线 | `feat/dataset-management-ui-20261010` / `98c50ea` |
| task / Compose project | `mw-dataset-management-20261010` |
| 数据库 | 独立 PostgreSQL 14，`dataset_management` |
| 数据卷 | `mw-dataset-management-20261010_dataset-management-pg` |
| 当时验收地址 | `https://192.168.7.232:19993/advanced-charts` |
| 当时图表 origin | `https://192.168.7.232:19994` |
| 构建入口 | `mw-docker build`，`purpose=acceptance`，`market-watch-ubuntu` BuildKit |

API、web、chart-origin、TLS 和 PG 实际启动；迁移到 `ar45_market_stream`。没有部署采集 worker，delivery、OANDA stream 和 Yahoo 在此验收实例关闭。配置、独立密码、TLS 私钥和许可库均留在忽略目录。

下面是该实例实际使用的启停命令，运行目录为上述 worktree。退役后地址不可访问；再次验收需要新 task/project 和独立配置，不复用已完成任务。

```bash
sg docker -c 'docker compose --env-file artifacts/dataset-management/compose.env -p mw-dataset-management-20261010 -f artifacts/dataset-management/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/dataset-management/compose.env -p mw-dataset-management-20261010 -f artifacts/dataset-management/compose.yaml stop'
```

## 验收口径

历史柱使用确定性的 fixture adapter，通过真实注册、维护、导入、派生产物与回收契约写入独立 PG。同一 EURUSD 的 Dukascopy NY17、Dukascopy UTC0、OANDA NY17 分别建档；XAUUSD 另有真实已回收版本。真实性边界是业务接口、数据库和 UI 行为；不声称验证了供应商联网采集。

浏览器运行实际认证应用、实际固定许可版本的原生窗口和兼容窗口。图表背景的 provider resolve/history/quotes 使用浏览器替身，避免无关供源访问；固定历史版本 resolve 使用真实 API。空任务、缺少周期、派生中旧发布可用，以及故障和延迟响应使用明确的浏览器 fixture。维护保存、冲突、补数、复查、控制、幂等及回收保护使用真实后端／PG。

浏览阶段既检查未发出维护／采集／控制命令，也比较历史业务表逐行内容的 SHA256 与行数。工作区流订阅的独立心跳表 `market_stream_*` 不纳入此指纹。既有后端测试的 `database` fixture 是 SQLite；其结果与实际 PG 验收分别报告。

## 结果

**通过。** 最终 web 镜像为 `sha256:6227e6e590ccdb3695051b1ad545528f9928ac44bc61307a6599dab5b209b38a`，浏览器没有替换应用 JS/CSS；[实际镜像身份](dataset-management-ui-20261010/final-image-ids.txt)已留存。

| 验证 | 实际结果 | 证据 |
|---|---|---|
| TypeScript / Vite / 原生 bundle | 最终 Ubuntu web 镜像构建成功 | `artifacts/dataset-management/build-web.log`（本地） |
| 导航 helper | 通过：32 条上限、窗口／工作区隔离、安全路径、无递归返回、权威精确任务查询 | [日志](dataset-management-ui-20261010/navigation-tests.log) |
| 既有后端回归（SQLite fixture） | **28 passed**：data center、maintenance、comparison、reclamation impact | [日志](dataset-management-ui-20261010/backend-tests.log) |
| 实际浏览器 / PG API | **27 个场景通过，0 个错误** | [报告](dataset-management-ui-20261010/browser-report.json) |
| 实际 PG 最终检查 | 同代码三个身份分开；精确对象 20 条任务，普通代码 22 条；读取不产生 demand；两个原发布版本保持不变 | [报告](dataset-management-ui-20261010/pg-inspect-final.json) |
| 实际 PG 引用保护 | 临时真实工作区引用使后端拒绝回收；价格不变；引用通过 savepoint 实际回滚 | [报告](dataset-management-ui-20261010/pg-protection.json) |

浏览器场景覆盖实际管理入口与周期、详情焦点、精确任务范围、任务详情往返、原列表筛选／行恢复、编辑查询解除限定、空任务上下文、覆盖口径、版本分页重置／请求取消／迟到隔离、固定回测与图表身份、已回收清单、维护未保存保护、无浏览写入、真实配置 409、生命周期控制、补数、复查故障重试与幂等、删除影响、离开取消及关闭停止轮询、缺少产物／旧可用版本、双主题三宽度、五分类关闭重开、真实 200% 缩放、兼容键盘／业务操作，以及实际载入另一个存储工作区后的上下文隔离。最后恢复原工作区和原维护计划，取消本轮提交任务，删除本轮临时工作区。

22 张最终截图覆盖原生／兼容的三宽度双主题、200% 缩放及各分类。已实际查看窄屏、宽屏、覆盖、维护和缩放截图。

## 截图

完整截图保存在 [证据目录](dataset-management-ui-20261010/)。

| 场景 | 原生窗口 | 兼容窗口 |
|---|---|---|
| 浅色 1440 | [概览](dataset-management-ui-20261010/native-light-1440.png) | [概览](dataset-management-ui-20261010/compat-light-1440.png) |
| 深色 375 | [窄屏](dataset-management-ui-20261010/native-dark-375.png) | [窄屏](dataset-management-ui-20261010/compat-dark-375.png) |
| 真实 200% | [缩放](dataset-management-ui-20261010/native-zoom200.png) | [缩放](dataset-management-ui-20261010/compat-zoom200.png) |
| 覆盖与质量 | [覆盖](dataset-management-ui-20261010/native-section-覆盖与质量.png) | [覆盖](dataset-management-ui-20261010/compat-section-覆盖与质量.png) |
| 发布版本 | [版本](dataset-management-ui-20261010/native-section-发布版本.png) | [版本](dataset-management-ui-20261010/compat-section-发布版本.png) |
| 维护设置 | [维护](dataset-management-ui-20261010/native-section-维护设置.png) | [维护](dataset-management-ui-20261010/compat-section-维护设置.png) |
| 组合与引用 | [引用](dataset-management-ui-20261010/native-section-组合与引用.png) | [引用](dataset-management-ui-20261010/compat-section-组合与引用.png) |

验收中修复了任务行返回焦点、关闭窗口后正文焦点、异步证据加载后的滚动恢复、用户已经操作时取消迟到焦点恢复、嵌套控件禁用和菜单箭头字形。早期脚本把最新 M1 柱数误写为 60、把显示名称误认为 EUR/USD，并误把原生 Select 当作 combobox；已改为权威字段、真实计数和实际原生按钮／选项。现有窗口的 host open 只聚焦已打开窗口，独立用例现在先关闭重开；空任务 fixture 通过刷新清理既有缓存。工作区切换遵守原生未保存保护，先真实保存布局再载入另一工作区。

TypeScript/Vite 与原生 bundle 构建成功；已有大于 500 kB 的 bundle 提示保留。没有修改后端业务实现、生产配置或许可库资源。

## 资源退役

已先核对精确清单，再执行 `mw-docker retire --task mw-dataset-management-20261010 --project mw-dataset-management-20261010 --apply`。工具停止应用写入，备份全局角色及 `dataset_management`、`postgres` 两个非模板数据库；在该 Ubuntu PG 中建立临时库，实际恢复并比对所有非系统 schema 的表行数与逐行内容 SHA256，随后再次核对来源库。业务库 87 张表均校验一致。

恢复校验均通过后，删除本 project 的 6 个容器、1 个数据卷、1 个网络及无引用的本 task 镜像。再次按 project/task label 检查，容器、卷、网络、任务镜像均为 0；共享基础镜像和专用 builder 保留。验收地址现已退役。

[退役证明](dataset-management-ui-20261010/retirement-proof.json)包含恢复校验结果、备份 SHA256、表数量和精确资源数量。私有完整归档位于 `/home/quant/.local/share/market-watch-docker/archives/mw-dataset-management-20261010-20261010T125746-f7d49d8e`，包含数据库、角色和配置；不提交该归档或任何凭据。

原验收阶段仅提交独立实施分支。后续用户已授权 PR #31 修复、复审、合并、推 tag 及正式部署，执行结果以 v1.17.0 发布清单为准。

## PR #31 位置恢复修复

复审发现默认概览首次分类往返将滚动从 200 重置为 0：位置按完整 URL 存储，分类切换新增默认 section 或重排参数使键不匹配。现在位置键统一通过合法内部路径校验、补全默认概览分类并排序参数；读取旧位置记录时同样规范化。版本、页码和行锚点保持独立。

Ubuntu Chromium 执行实际 Window／DatasetDetail 代码及只读 API fixture，新增 [3 项浏览器回归](dataset-management-ui-20261010/position-regression.json)全部通过：默认概览 200 → 200、覆盖页参数重排 350 → 350 且版本／页码保持、旧存储记录滚动和焦点恢复。脚本为 `web/tests/dataset-position.browser.cjs`；不启动数据库或供源。导航 helper 同时验证等价位置键与不同版本／页码／锚点隔离。原 27 项 Docker 验收未因该局部修复重新全量执行。
