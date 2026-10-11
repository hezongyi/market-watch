# 交易状态与详情时间修复验收（2026-10-11）

本记录覆盖接续审查后的修复，最终浏览器与资源退役状态见文末。原审查的失败和早期有限验收保留为历史证据，不代表当前实现结果。

## 实现与审查问题对应

- 会话认证从实际观测身份取得 source/channel/environment/account/symbol，而非从待验证规则反向构造身份；内置规则和配置 profile 都拒绝不匹配身份。建议复核日期只产生维护提醒，实际适用截止才限制规则有效性。
- 冲突按观测发生时刻判定。周六保留周五正常报价不会误报；闭市内部出现观测保留价格并提示待核实；合法边界分钟保留。
- provider 成功页缓存与失败回退缓存均隔离实际账户／环境。首次失败保留状态、明确无成功价格和时间，不借用其他身份数据。
- provider、自建、固定历史、组合共用报价展示契约。组合绑定实际接续来源及修订；M1 使用柱起始时间并注明不含终点的结束范围，精确报价事件单独显示；无时间、失败、等待和固定历史分别表达。
- host 仅缓存原始快照，时区与活动图表事件重排全部订阅品种。迟到 HTTP、已撤销订阅和 reset 不能覆盖已接受的新推送或残留旧商品。
- 日历 API 读取实际配置、已保存目录、自建数据集和已使用原生身份，不读供应商或创建需求。页面复用原生控件，展示启用状态、规则版本、证据链接、页面时区与官方原始时区；常用代码搜索支持 XAUUSD/XAU/USD。
- 固定许可库在窄屏会隐藏整个右侧详情栏。新增 host 紧凑状态条，沿用现有订阅和统一 formatter，显示当前商品状态及时间；ResizeObserver、主题、布局、活动图表和页面卸载均有绑定及清理，无独立轮询。

## 验证证据

| 检查 | 结果与证据 |
| --- | --- |
| 最终 API 镜像中八套相关后端测试 | **168 passed**；[backend-tests.log](verification/market-session-details-fix-20261011/backend-tests.log) |
| host 回归及既有价格格式 | 通过，包含迟到 HTTP、stream/reset、订阅撤销；价格格式 38 项；[host-tests.log](verification/market-session-details-fix-20261011/host-tests.log) |
| 改动 Python Ruff | 通过；[lint.log](verification/market-session-details-fix-20261011/lint.log) |
| Web 与 chart 构建 | 通过 Ubuntu `mw-docker` / `market-watch-ubuntu`，实际验收实例使用最终镜像 |
| Node 语法与 diff 空白检查 | 通过；文档收口时再次检查 |

八套为 `test_market_calendar`、`test_quote_session_contract`、`test_market_data`、`test_provider_chart`、`test_composite_quotes`、`test_series_access`、`test_live_session`、`test_market_stream_quotes`。测试覆盖真实身份不匹配、复核提醒与适用期分离、闭市冲突、边界分钟、失败回退、固定／组合时间契约、运行日历读取不产生需求等行为。

原生浏览器脚本为 [market-session-details.browser.cjs](../web/tests/market-session-details.browser.cjs)。直接断言详情首屏可见、关闭误导性原生开市标签、UTC/UTC+8/纽约/交易所时区、两图活动切换、七类受控状态、快速订阅替换与原生商品切换、明暗主题下 375/768/1440、键盘展开、Chrome `tabs.setZoom(2)` 真正 200% 缩放，以及 M1/H1/H4/D1/W1/MN 的 `dataReady`。受控状态在现有原始快照展示接口注入，后端判定由独立回归校验。

周期切换验收同时等待切换前订阅的公开 `onDataLoaded` 事件。固定库的 `dataReady()` 只检查非空数据，切换回调也可能在新周期完成前触发；早期 harness 连续切换可让旧时间刻度与新周期交错，捕获 `nearestIndex / Value is undefined`。加入实际加载事件后完整流程通过，未屏蔽页面错误或删除周期断言。最终结果见 [browser.json](verification/market-session-details-fix-20261011/browser-final/browser.json)：36 个场景通过，页面错误为空。另连续切换 H1/H4/D1/W1/MN 三轮，共 15 次实际加载通过，页面错误为空，见 [period-load-regression.json](verification/market-session-details-fix-20261011/period-load-regression.json)。

直接截图：[初始原生详情](verification/market-session-details-fix-20261011/browser-final/details-initial.png)、[375px 紧凑状态](verification/market-session-details-fix-20261011/browser-final/details-dark-375.png)、[200% 详情](verification/market-session-details-fix-20261011/browser-final/details-zoom200.png)、[快速切换](verification/market-session-details-fix-20261011/browser-final/details-rapid-selection.png)、[200% 日历](verification/market-session-details-fix-20261011/browser-final/calendar-zoom200.png)。运行容器／镜像身份分别保存在 [runtime-containers.log](verification/market-session-details-fix-20261011/runtime-containers.log) 与 [runtime-images.log](verification/market-session-details-fix-20261011/runtime-images.log)。

## 实际环境及数据边界

主机为 Ubuntu 本机 Docker，独立 task `mw-session-details-fix-20261011`、Compose project `mw-session-details-fix-ubuntu-20261011`、网络与 PostgreSQL 14 卷。验收时应用地址 `https://localhost:17443`，chart origin `https://127.0.0.1:17444`，均只监听 loopback。未访问 unraid 或部署生产。

真实应用、数据库、worker 和固定版本许可图表运行；供应商历史价格由 [fixture-runtime.py](verification/market-session-details-fix-20261011/fixture-runtime.py) 注入。它验证身份、状态和 UI 行为，不认证供应商线上可用性。凭据、TLS 私钥和许可库留在仓库外／ignored 路径；不能把该 Compose 当成生产配置。

验收实例运行时的启动／停止方式（从本 worktree 执行）：

```bash
sg docker -c 'docker compose -p mw-session-details-fix-ubuntu-20261011 -f docs/verification/market-session-details-fix-20261011/compose.yaml up -d --no-build'
sg docker -c 'docker compose -p mw-session-details-fix-ubuntu-20261011 -f docs/verification/market-session-details-fix-20261011/compose.yaml stop'
```

退役后不能直接使用旧 task 恢复开发；重建应登记新 task/project，准备私有配置并重新通过 `mw-docker` 构建。上面命令记录实际验收期间操作。

## 官方证据边界与接续工作

四来源维护与覆盖见 [calendar-maintenance](market-session-details-calendar-maintenance-20261011.md)。此次官方重查连接失败或 Yahoo 429，没有推进核实日期。Dukascopy XAU/USD、EUR/USD 常规规则沿用可靠旧证据；Binance BTCUSDT 缺可靠认证，降为 unverified；OANDA 仅适用实际身份匹配 profile，Yahoo 无通用认证。2026-10-11 至 2027-01-11 例外覆盖保持未知，不能宣称未来没有假日或临时调整。

验收收口时实现位于 `feat/market-session-details-20261010`，基线 `8c65edfdee15f0281750e888711cf8ecd20de1a0`，当时全部变更可审阅但尚未提交。用户随后授权提交 PR；提交前刷新远端 main，最新为 `75f8f3476afc1b6c25236928ca353f5fb6e745f1`（历史价格精度修复），与本次修改文件无重叠。验收证据对应原基线上的实现，最新 main 的集成验证不包含在上述 168 项及浏览器结果中；有可靠官方材料后补各账户、交易所与品种映射。没有执行合并、tag 或生产发布。

## 最终收口

实现及上述 Ubuntu 验收通过。`mw-docker retire` 先预览本任务 7 个容器、单个 PostgreSQL 卷与独立网络，再执行 `--apply`。应用写入停止后导出数据库，在本机 PG 建立临时库实际恢复并核对 public 表行数；最终返回 `restore_verified: true`，见 [retire.log](verification/market-session-details-fix-20261011/retire.log)。

私有归档路径：`/home/quant/.local/share/market-watch-docker/archives/mw-session-details-fix-ubuntu-20261011-20261010T221054-ba354bbf`。路径中的 UTC 日期与本记录 Asia/Singapore 日期不同。归档含私有配置，不提交仓库。任务容器、卷、网络与无引用任务镜像已精确清理；验收网址现在不再提供服务。构建时一次 task 日期拼写错误被工具拒绝，没有创建错误镜像；无资源登记已通过 `mw-docker finish` 结束。

最终 Node 语法、host 回归、38 项价格格式及 `git diff --check` 再次通过；文档本地链接均存在。验收收口时变更未提交；之后按用户授权提交 PR，未合并、打 tag 或发布生产。没有全局 prune，没有清理其他任务或生产资源。
