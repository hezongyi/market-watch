# 三层大目录搜索与纯选择分页

日期：2026-10-07。本阶段实现及定向真实验收完成；完整 A–E 与长期质量尚未收口。

## 实现

- 新增认证 `/api/market-data/series/page`，显式选择平台、自建或组合，支持来源和自建聚合日界。
  平台使用完整目录，不再受旧 250 条内部截断。保留原列表接口；混合列表按三层交错，
  不让一个大来源或平台目录遮蔽其他层。准确代码、前缀优先；自建来源在 SQL 分页前交错。
- 自建只选择最新有可读产物的发布版本，排除已回收版本与归档数据集；组合还要求 M1 产物、
  明确映射、默认权限与当前账户。每次最多检查 500 个候选，分页游标按实际检查数量推进。
  不把候选数量当合格结果总数；空页也可能有下一页。来源确认或接缝不足仍会被真实门槛拒绝。
- 组合结果使用已经定位的准确映射，不对每条结果重新扫描整个映射目录。
  已建立组合展示当前启用修订的历史、映射和日界，不展示创建时的旧映射身份。
  MCP 既有 `series_search` 支持相同分页，旧参数仍返回列表；分页和筛选需要明确层级。
- 策略、回测选择器每页 25 条，来源/日界筛选与准备状态分别分页，翻页或无结果保留已选行情。
  请求中禁用选择，避免点击上次搜索结果。维护状态页提供准确数据中心入口。
- 原生图表新增“行情搜索”弹窗，三层/来源/日界/关键词分页；仅明确点击结果才切换图表。
  原生搜索默认当前行情层，保留旧 managed 兼容。取消不改绑定，错误后可重试。
  iframe 沙箱禁止表单提交，关闭按钮改为显式 `dialog.close()`；不放宽宿主安全限制。
  支持浅色/深色、Escape、焦点恢复、桌面宽度和内容缩放。

## 验证与限制

- 全量后端 **1063 passed /226 skipped /337.28s**，33 项既有 Alembic 弃用警告。
  此次全量后，补充当前修订映射元数据修复与回归：相关本地 **19 passed /20.89s**，
  实际 Ubuntu PostgreSQL **4 passed /15.35s**。跳过项不计通过。
  PostgreSQL 使用独立 disposable schema，没有向真实验收库写入合成行情。
- 大目录合同覆盖 260 个自建条目、600 个平台条目、56 个明确映射组合；检查跨页不重复/不丢失、
  来源公平、准确/字面通配符检索、最新可用产物、归档/回收、限制查询量，以及启用日界/映射变更。
  这些容量数据为测试夹具，不冒称真实供应商发布数据。
- 真实 HTTP/MCP 遍历 Dukascopy **1380** 个平台目录项，另含 OANDA 目录、自建、组合及筛选，
  共 **66 页**；MCP 首/末页与 HTTP 相同。私有 JSON 逐页保存实际耗时及前后数据库数量，
  搜索没有创建组合/数据集或增加采集需求。有限缓存 interest 可能按 TTL 清理，数量不等于活跃需求。
  该脚本使用短期 `market:read` 凭据并按 digest 撤销，不提交或打印 token。
- 实际浏览器完成 1380 项目录分页核对、策略筛选/无结果保留选择、固定回测绑定、许可图表分页及
  明确切换、取消后绑定不变、当前层默认值。1024/1440/1920、200% 内容缩放、键盘、两主题及
  Escape 焦点恢复通过，无 pageerror。注入搜索 HTTP 503 时禁用旧行，重试恢复且未改图表绑定；
  该故障是明确注入的 API 搜索失败，不是供应商真实故障。
- TypeScript/Vite 构建、Ruff、JS 语法、既有 series 桥接兼容与 diff 检查通过。
  保留既有大 chunk 提示。构建核对涵盖 Dockerfile、HTML 和 bundle 输入中的新增脚本/CSS；
  本次真实许可图表实例按下面 Compose 的宿主 bind mount 提供资源。
- 失败分母保留：初始夹具/任务参数及查询数量断言调整；浏览器工具栏在子 iframe、
  debounce 后旧行可点击、等待 symbol promise 阻挡关闭，以及 sandbox 的表单关闭问题。
  追加断言定位关闭后仍 open，最小 sandbox 复现显示表单关闭失败、显式关闭成功。
  扩展键盘检查曾误期待禁用日界控件可获得焦点，修正为检查真实下一可操作控件。
  一轮浏览器与 API 重启同时运行导致登录失败，稳定后复验通过；失败资料中的密码已脱敏。
  另有一次 Node 兼容检查 cwd 错误，改在 web 目录后通过，未将错误运行计通过。

脚本：`scripts/verify_series_search.py`、`web/tests/search-pagination-real.browser.cjs`。
私有 ignored 证据在 `artifacts/data-integration/`：
`search-pagination-full-regression.log`、`search-pagination-active-metadata-tests.log`、
`search-pagination-postgres-final.log`、`search-pagination-real-final.log`、
`search-pagination-browser.json/log`、`search-pagination-build-final.log`，以及失败归档和截图。
登录、账户、token、许可资源不提交。

## 实际环境及启停

Ubuntu 本机独立 Compose **market-watch-three-layer**，PostgreSQL 14，migration ak38（本阶段无迁移）。
UI/API <http://127.0.0.1:16629>；许可图表 origin <http://127.0.0.1:16630>。
工作树根执行，保留数据库和其他项目：

```sh
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime start api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
sg docker -c 'docker compose --env-file artifacts/data-integration/three-layer-compose.env -p market-watch-three-layer -f docs/verification/three-layer/compose.yaml --profile realtime stop api history-worker native-history-worker composite-aggregate-worker pricing-worker web chart-origin'
```

本阶段无需用户补充业务决策、权限或容量；当前约 55GB 可用，没有清理其他资源。
仍需实际日界/映射修订、3–10 品种/多图与维护并发、429/401/旧世代/两分钟断线恢复、
完整桌面/旧绑定审计，以及稳定版本单独 48 小时工程观察。新观察尚未启动；到期不自动通过。
旧观察实例、其他任务与生产未改。没有推送、PR 或下单；MT4 后续。
