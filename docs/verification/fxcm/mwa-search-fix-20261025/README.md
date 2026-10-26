# 商品代码搜索修复 · mw-acceptance · 2026-10-25

用户报告的「商品代码搜索一直转圈、不出结果」已在实际长期实例复现并修复。目标为 Ubuntu `quant-server` / `mw-issue75-v2-20261018`，入口 <https://test.kookvv.com:8443>，图表 origin <https://chart-test.kookvv.com:8443>。正常 HTTPS 校验，使用 Playwriter 自建隔离页面，不操作受保护浏览器。

## 原因及修复

真实原生搜索请求 `/api/market-data/series/page?query=EURUSD&kind=all…` 返回 500。FXCM 目录允许未映射的 `logical_symbol=null`，统一商品排序直接调用 `.casefold()` 导致 AttributeError。改为将空值按空字符串排序，仍保留供应商品种代码及未映射状态。

同时，原生搜索控制器在搜索 Promise 拒绝后没有完成加载状态。自有 native-ui adapter 现在在非取消错误时完成本次列表请求，显示「商品搜索失败，请重试。」和「重试搜索」；重试沿用原生请求及当前筛选。取消请求仍按 AbortError 处理。许可库未修改，原生搜索框、筛选、结果行和自选操作保留。

## 验证

- 修复前：真实浏览器 500、持续转圈；错误注入测试因没有重试按钮失败。见 [before/search-regression.json](before/search-regression.json)、[before/search-error-regression.json](before/search-error-regression.json)。
- 后端：真实认证 HTTP 搜索入口覆盖 FXCM 未映射目录、全部/平台类型、空查询/EURUSD；先红后绿。三个专项文件共 **21 passed**，见 [backend-tests.txt](backend-tests.txt)。Ruff、JS 语法及 diff 空白检查通过。
- 部署后：实际 EURUSD 搜索 200，结果可见且加载结束，见 [after/search-regression.json](after/search-regression.json)。
- 实际筛选：FXCM 来源、平台类型、XAUUSD、无匹配、空查询均通过，见 [after/search-filters.json](after/search-filters.json)、[黄金截图](after/fxcm-gold-search.png)。空查询显示首批50项，原生底部加载更多指示器属于分页提示，不能据此断言整个搜索仍在等待首批结果。
- 页面局部注入 500：明确错误提示、结束转圈、点击重试走实际接口并恢复结果，无未捕获脚本错误，见 [after/search-error-regression.json](after/search-error-regression.json)。
- 自选「添加商品代码」共享适配器也完成错误/重试回归，无添加、删除操作，见 [after/watchlist-search.json](after/watchlist-search.json)。

浏览器脚本保存在 `web/tests/mwa-{search,search-error,search-filters,watchlist-search}.playwriter.cjs`，通过 Playwriter `-s SESSION -f FILE` 运行，依赖本人已登录页面 `state.page` 与 `state.searchCheck.reportDir`。不是普通 Node/CJS 可执行脚本。

## 部署与保留边界

F0：兼容的 API 空值处理及自有 UI adapter，无 schema / 持久格式变更。使用 mw-docker 明确 task/project/purpose 构建，只替换 **api、chart**：

- API：`sha256:9ba80a26f1261cc15109dc0e023c08eb0c7d18d32ff5ef8fbb24c78ac5988279`
- Chart：`sha256:e622ac40ff6d96a5809276d31df740c1c23cc783059abc68213caeb8b099686b`
- Web 保持登录证书修复版本；workers 保持原 FXCM 镜像，因为商品排序仅在 API 搜索调用，无 worker 协议/模型变化。

源码基线 `8dd4faf2` 加现有未提交整合差异；[source-identity.json](source-identity.json) 固定产品文件摘要，相比上一 FXCM 制品仅 market_data.py 和 native-ui.js 改变。不能把基线 SHA 当作全部运行源码。没有提交、推送、PR、合并或生产应用发布。

[runtime.json](runtime.json) 核对其余容器身份、全部有效配置、环境、挂载、网络、端口及资源限制；15个服务运行，API/PG healthy。新鲜任务基线的工作区、告警、模板、schema、原通知状态及保护浏览器身份保持。两类 preferences 表指纹有变化，包含运行状态及浏览器初始化；不声明偏好整表逐字节不变，未重置或恢复任何表。没有 seed/migrate/清库或切换用户当前 EURUSD 组合 H4 工作区。

更新 API 的短暂窗口观察到 502，服务健康后重新连接及真实业务验证恢复；此记录不声明更新过程零中断。当前候选和统一 manager 引用已同步，原完整 rollback 留存，本次两服务回退候选另存私有任务目录。

启停/状态：`python3 /home/quant/repos/.mwa-fxcm-20261025/operate.py start|stop|status`。原 `audit` 相对最早 FXCM 基线，可能被正常偏好变化触发；本次使用独立新鲜基线审计，不能把旧 audit 表述为通过。实例和数据长期保留供人工验收。
