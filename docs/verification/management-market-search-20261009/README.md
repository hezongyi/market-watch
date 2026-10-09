# 自建行情与组合行情搜索布局验收

2026-10-09，Ubuntu `quant-server` 本机隔离 Docker，task/project `mw-data-center-review-20261008`。沿用用户仍在验收的独立实例；经 mw-docker 构建并更新本项目 web、API、chart origin，不操作 unraid、生产数据或数据库结构。

## 界面与复用边界

两页按平台行情的层级调整：分区标题固定在内容顶部，下面是整行搜索、圆角标签、列表表头与连续滚动结果。移除两页的分页按钮和窄屏筛选遮罩，每批 25 条触底继续读取；失败保留已有结果，重试同一加载前缀；每 10 秒刷新已加载前缀。结果按唯一身份去重，筛选变化取消旧请求，关闭取消读取；详情返回与分区往返恢复行、已加载前缀及滚动。

自建行情：标题右侧保留添加行情和刷新；状态标签为全部、可用、准备中、需处理、已暂停、已归档；来源、资产类别与聚合日界在列表表头。每行显示品种、来源、口径、日界、类别、维护状态；保留打开图表与查看。折叠详情提供可用历史、未知区间、周期、下次维护、错误及删除历史数据入口。完整详情仍提供原有维护与删除保护流程，未修改删除接口或权限。

自建行情与组合候选只从已保存历史维护配置的品种中产生。仅注册目录身份、原生来源或实时映射目标的品种不显示；准备中、失败、暂停仍属于已配置品种，归档继续通过自建的已归档标签查看。过滤在 SQL 总数统计与分页之前完成，两列表共用查询；完整品种详情仍可用于配置，实时映射未配置的候选仍保留供建立组合。无需数据库迁移。

组合行情：已建立组合／可建立候选作为圆角标签。每行显示历史来源→OANDA Practice、日界、状态，以及打开／查看／配置／维护操作；折叠详情显示历史基线、确认尾部、准确来源与策略依赖状态。候选明确点击后才建立并打开，业务锁防重复，仅选中行显示“正在打开…”；后台完成后关闭的原表单不会更改后续窗口。

实际复用原生 `DialogSearch` 和 `Select`，外壳及五分区仍为原生组件；标签和管理结果行为业务组件，采用平台行情的圆角、间距与主题 token。两页未嵌入整套平台商品搜索组件：状态、日界、历史删除和组合接续保留管理语义。完整表单、目标图格保护、认证和 API 沿用原有控制器。没有复制许可源码。

平台行情表头右侧的来源筛选也改为相同原生 Select，默认为“全部来源”。选择来源直接更新列表，不再跳转来源搜索页；保留整行商品搜索、原生类别标签和结果行。通过 SearchContext 隔离来源状态，在原生表头单元格内以 React portal 渲染 Select，不复制或修改许可源码。

暗亮主题和选中标签悬停对比度通过；矮视口压缩顶部与底部留白，实际 200% 缩放下标题、搜索和打开入口可用。原生版本或资源失配时，兼容窗口提供相同两页布局及真实 API 搜索。

## 结果

部署后的 Docker 资源共 **10 套件、68 组检查通过**，均未使用 `LOCAL` 资源替换，页面异常为空。另完成精确清理与最终检查：只删除本轮 integration 报告记录的测试工作区，其他工作区保持；原验收工作区正常打开，关闭回焦；版本失配兼容窗口的自建搜索、组合两模式和图表身份保持通过。

- [专项 13 组](report.json)：真实自建／组合列表、创建与删除入口、详情返回、65 行连续加载与失败重试、唯一身份、前缀与滚动恢复、组合筛选、空结果、输入焦点、暗亮及 375/768/1440 布局、关闭取消、键盘焦点、准确 MWH/MWC ticker、单行加载与候选防重复。
- [套件汇总](final-suites.json)：删除保护 9、实际 200% 缩放 3、原生创建 3、兼容 5、生命周期 4、平台专项 11、搜索联动 7、两页专项 13、原生整合 7、操作 6。
- 后端 [45 项单元回归](backend-unit.log) 及 [5 项 PostgreSQL 验证](postgres.log) 通过；PG 使用随机独立 schema，测试结束自动删除该 schema。
- [真实数据库与部署 API 配置范围核验](configured-scope-report.json)：131 个注册身份中，3 个已配置且未归档，1 个已配置且归档，127 个仅注册；两个默认列表总数均为 3，page size 1 的逐页顺序与身份一致，真实未配置品种在两处搜索均为 0，归档筛选仍返回 1。
- [清理与最后检查](cleanup-smoke-report.json)、[运行服务](runtime.json)。构建含 TypeScript 检查；JavaScript 语法及 `git diff --check` 通过。

长列表、错误与提交使用局部 fixture；实际目录、配置范围、完整详情、兼容窗口与联动采用真实读接口；删除和候选建立测试拦截写入，没有删除真实历史或启动新维护。

截图：[真实自建亮色](managed-real-light.png)、[真实组合暗色](composite-real-dark.png)、[375 px 自建](managed-light-375.png)、[375 px 组合](composite-light-375.png)、[自建 200%](browser-zoom200-1024.png)、[组合 200%](browser-zoom200-composite-1024.png)、[平台原生来源下拉](platform-yahoo.png)、[平台 375 px 暗色](platform-dark-375.png)。

## 实际运行与复验

验收地址：<https://192.168.7.232:19943/advanced-charts>；chart origin：<https://192.168.7.232:19944>。密码沿用原验收密码。Ubuntu 本机 `market-watch-ubuntu` builder 经 `mw-docker build --task mw-data-center-review-20261008 --project mw-data-center-review-20261008 --purpose acceptance` 构建。实例仍保留给用户验收，任务未退役，卷未回收。

在 `/home/quant/repos/market-watch-data-center-impl-20261008` 启停：

```sh
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml up -d --no-build'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml restart tls'
sg docker -c 'docker compose --env-file artifacts/data-center-review/compose.env -p mw-data-center-review-20261008 -f artifacts/data-center-review/compose.yaml stop'
```

需要本机许可资源、私有登录文件及 Chromium，复验：

```sh
LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu \
node web/tests/chart-data-center-management-search.browser.cjs
```

凭据、env、私钥、浏览器状态和许可源码未提交仓库。
