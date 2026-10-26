# AkShare A 股日线网络故障调查

调查日期：2026-10-25 UTC
范围：`ak.stock_zh_a_hist`（A 股日/周/月历史行情），特别是 AkShare 所用东方财富 `push2his.eastmoney.com` 端点。仅查阅 AkShare 官方文档与官方 GitHub 仓库、Issue、PR、release；不改部署或业务代码。

## 结论

- AkShare 官方文档仍将 `stock_zh_a_hist` 描述为东方财富沪深京 A 股日频历史行情接口，并明确可按周期和日期区间查询。官方源码仍向 `https://push2his.eastmoney.com/api/qt/stock/kline/get` 发送请求；参数仍使用 `secid`、`klt`、`fqt`、`beg`、`end`。本次查到的官方资料没有显示该接口已迁移到另一个端点或近期调整了该调用协议。
- 存在与本次故障高度相关的官方仓库记录。Issue [#7402](https://github.com/akfamily/akshare/issues/7402) 于 2026-08-20 报告 `stock_zh_a_hist()` 持续连接异常，堆栈是 `RemoteDisconnected`；维护者于 2026-08-21 评论：“是数据源的访问频率限制”。这是 AkShare 维护者对该 issue 的明确诊断，支持“东方财富数据源可能会对访问频率限流”的判断。
- 官方仓库还有多起相似报告：#7051（2026-02-12，多个股票代码均 `RemoteDisconnected`）、#6816（2025-11-26，ConnectionError）、#6729（2025-11-04，报告称接口不可用）、#6988（2026-01-22，RemoteDisconnected）。这些是用户报告，且多数关闭状态本身不等于上游修复或官方确认。
- 因此，本次 `SZSE:000001` 返回 `ConnectionError` 与已知的东方财富访问频率限制现象一致，但现有证据不能断定 `mwa` 这次请求一定是被限流。连接被对端关闭也可能来自当前代理、出口网络、TLS 中间层或临时上游故障。AkShare issue #7402 的维护者结论不能替代对 `mwa` 请求出口和服务端响应的现场证据。
- 未查到东方财富官方发布的对应故障公告、限流阈值或封禁恢复时长。AkShare 仓库 issue 是第三方项目中的报告及维护者答复，不是东方财富运营公告。

## 一手来源

1. AkShare 文档，“历史行情数据-东财”，接口 `stock_zh_a_hist`：<https://akshare.akfamily.xyz/data/stock/stock.html#id24>（本次访问日期 2026-10-25）。文档说明其数据源为东方财富沪深京 A 股、日频数据，并列出 `daily`、`weekly`、`monthly` 周期及参数示例。
2. AkShare 官方仓库源码 `akshare/stock_feature/stock_hist_em.py`，函数 `stock_zh_a_hist`：<https://github.com/akfamily/akshare/blob/main/akshare/stock_feature/stock_hist_em.py#L952-L1039>（本次访问日期 2026-10-25）。源码仍请求 `https://push2his.eastmoney.com/api/qt/stock/kline/get`，`klt` 映射为 `101/102/103`，`fqt` 映射复权方式，并直接执行 `requests.get(url, params=params, timeout=timeout)` 后解析 JSON。该函数没有重试逻辑。
3. AkShare 官方仓库 Issue [#7402](https://github.com/akfamily/akshare/issues/7402)，创建于 2026-08-20，维护者回复于 2026-08-21（[精确评论链接](https://github.com/akfamily/akshare/issues/7402#issuecomment-5364718779)）。Issue 描述调用 `stock_zh_a_hist()` 在交易和非交易时间均报连接异常，堆栈为 `RemoteDisconnected('Remote end closed connection without response')`。维护者原文：“是数据源的访问频率限制”。这是目前找到的最直接限流证据。
4. AkShare 官方仓库 Issue [#7051](https://github.com/akfamily/akshare/issues/7051)，创建于 2026-02-12。报告多个代码的 `stock_zh_a_hist` 与 `stock_individual_info_em` 均遇到 `RemoteDisconnected`；同时列出另一组代码列表接口能正常返回。此为用户报告，不是官方对限流的确认。
5. AkShare 官方仓库 Issue [#6816](https://github.com/akfamily/akshare/issues/6816)，创建于 2025-11-26，标题为 `stock_zh_a_hist接口ConnectionError`。用于佐证类似连接异常并非首次报告；issue 关闭不代表已证明上游修复。
6. AkShare 官方仓库 Issue [#6988](https://github.com/akfamily/akshare/issues/6988)，创建于 2026-01-22，报告 `RemoteDisconnected('Remote end closed connection without response')`：<https://github.com/akfamily/akshare/issues/6988>。
7. AkShare 官方仓库 Issue [#6729](https://github.com/akfamily/akshare/issues/6729)，创建于 2025-11-04，用户报告东方财富历史行情接口近期不可用：<https://github.com/akfamily/akshare/issues/6729>。
8. AkShare 官方仓库 Issue [#6214](https://github.com/akfamily/akshare/issues/6214)，创建于 2025-05-28，报告一次请求近 200 只股票后连接被中止，并询问访问频率限制。它是用户对批量访问的描述；限流诊断主要依据 #7402 的维护者答复，而不是从该 issue 推断。
9. AkShare 官方仓库 PR [#7333](https://github.com/akfamily/akshare/pull/7333)，创建于 2026-07-08，标题为“handle RemoteDisconnected error in retry logic”。其说明指出 `RemoteDisconnected` 未被当时相关重试帮助函数的异常集合捕获。GitHub API 当前元数据标记该 PR 为 closed 且 `merged_at` 为空，因此不能把其中的重试改动当成已发布修复。它也说明连接错误的恢复策略和上游限流/断连原因是不同问题。
10. 官方仓库对上述源码文件的近期路径提交记录：<https://api.github.com/repos/akfamily/akshare/commits?path=akshare/stock_feature/stock_hist_em.py&since=2025-01-01T00:00:00Z&per_page=100>（本次访问日期 2026-10-25）。当前返回的 2025-01 之后文件提交中，最近一次是 2026-08-13 的全文件中文标点/版本提交；较早相关提交涉及文档或其他函数，未发现将 `stock_zh_a_hist` 改到新端点的提交。此结论仅基于该文件历史，不等同于东方财富未改变未公开的服务端行为。

## 本次现场证据与限制

- 候选验收目录中的 [akshare-alternative-probe.json](./akshare-alternative-probe.json) 记录：对 `SZSE:000001` 的 `stock_zh_a_hist` 周、月请求以 `AKShareRequestError` 结束，底层为 `ConnectionError`；同轮 `stock_hk_hist` 返回了数据。此前 [akshare-proxy-probe.json](./akshare-proxy-probe.json) 记录其他 AkShare 调用在代理路径出现 `ProxyError`。这些记录支持“单个 provider endpoint/网络路径失败，而非全站所有 AkShare 接口都不可用”，不能区分是东财按出口 IP 限流还是网络/代理问题。
- 调查时从当前工作环境直接 `curl` 一次 `push2his` 示例请求，在收到 HTTP 响应前失败，输出为 `OpenSSL SSL_read: ... unexpected eof while reading`；同一环境访问东方财富行情页面 `https://quote.eastmoney.com/concept/sz000001.html` 返回 HTTP 200。该探测只代表当前调查环境、当时一次请求；它不等于 `mwa` 容器的出口路径，也不能证明行情 API 服务本身故障或正常。
- 此调查没有持续测试、换出口 IP、清除限流窗口或变更线上实例；无法确认限流阈值、作用范围（IP/接口/账号）、持续时间、是否按请求速率或并发触发，也无法确认是否存在东方财富公告未公开或不可检索。

## 建议的判别步骤

1. 对 `mwa` 的同一 API 容器记录目标 host DNS、TCP/TLS 建连结果、HTTP 状态码/响应头、异常类型和耗时；避免打印敏感代理凭据。当前 `RemoteDisconnected` 或 TLS EOF 发生在响应体解析前，只有 HTTP 429/明确错误体才能直接指向可见的限流响应。
2. 在低请求频率下间隔重试同一个最小请求，并记录准确 UTC 时间；同时用一只沪市代码和一只深市代码各做一次，避免批量请求继续触发限制。
3. 对照同一时刻容器内和可信外部网络的相同请求结果，区分实例出口/代理影响与上游服务问题；不要据一次成功/失败调整生产调用频率或切换出口。
