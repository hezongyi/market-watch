# OANDA v20 间歇性 401：官方资料核查

核查日期：2026-11-16。范围：官方开发文档、官方 Python SDK 源码及公开 issue 检索。只读查询；未调用用户账户、未修改配置或服务。本文仅记录官方来源，社区案例由主调查另行汇总。

## 结论

官方有明确的认证排查和连接使用建议，但本次未找到官方确认的“有效 token 偶发 401”根因或统一修复公告。不能依据这些资料断言本项目的根因是连接池、请求过多、token 到期或 OANDA 某台认证节点。

官方把 401 定义为 token 无效或未提供；请求频率超限明确是 429。推荐的持久连接、连接限速可作为必要的客户端检查，但它们解决本次 401 的有效性仍需实际对照验证。

## 已核实的官方证据

### 1. 401、403 与 429 必须分开处理

来源：[Troubleshooting & Errors](https://developer.oanda.com/rest-live-v20/troubleshooting-errors/)，HTTP 200，证据强度：高（官方直接定义）。

> “A ‘401 Unauthorized’ response may be returned … however the authentication token is invalid or has not been provided.”

对 `Insufficient authorization to perform request.`，官方要求核实 URL，以及 token 有效且以 HTTP `Authorization` 中的 Bearer token 提交。该页还把 403 定义为 token 不授权所请求操作；错误账户或账户不可交易也有单独说明。因此必须保留实际 HTTP 状态码和响应正文，不能仅按中文“认证异常”标签归因。

来源：[Development Guide — Rate Limiting](https://developer.oanda.com/rest-live-v20/development-guide/)，HTTP 200，证据强度：高。

> “REST API 120 requests per second. Excess requests will receive HTTP 429 error. This restriction is applied against the requesting IP address.”

据此：官方没有把请求速率超限定义为 401。本项目若实际收到 401，不应直接以“达到每秒请求限额”作结论。

### 2. token 管理与期限

来源：[Authentication](https://developer.oanda.com/rest-live-v20/authentication/)，HTTP 200，证据强度：高（对页面明确陈述）；期限部分为“官方页面未说明”，不能扩展成保证。

> “Once created, a token will grant access to all of your sub-accounts.”

> “From there, you can generate a personal access token … as well as revoke a token you may currently have.”

> “OANDA reserves the right to suspend personal access tokens … based on system stability or other technical issues caused by the customer.”

此页描述在 `My Account → My Services → Manage API Access` 生成/撤销 token，以及遗失时撤销并重建。没有给出个人 token 的固定有效期，也没有给出自动刷新 token 的流程。因此不能说“每 N 小时过期”，也不能反向声称“永久绝不失效”。频繁重建 token 不是该页给出的间歇性 401 解决方案。

### 3. Practice 与 Live 环境需一致

来源：[Development Guide — API URLs](https://developer.oanda.com/rest-live-v20/development-guide/)，HTTP 200，证据强度：高。

| 环境 | REST | Streaming |
|---|---|---|
| Practice | `https://api-fxpractice.oanda.com` | `https://stream-fxpractice.oanda.com` |
| Live / fxTrade | `https://api-fxtrade.oanda.com` | `https://stream-fxtrade.oanda.com` |

官方按环境分别描述对应账户及个人 token。排查应同时核对 REST 和 stream 的最终 hostname、账户归属及各 worker 使用的凭据版本，不只核对其中一条链路。这里列出的域名是检查依据，不是建议临时切换环境绕过问题。

### 4. 持久连接、连接数量和请求限制

来源：[Best Practices — Connection Limits / HTTP Persistent Connection](https://developer.oanda.com/rest-live-v20/best-practices/)，HTTP 200，证据强度：高。

> “For new connections, we recommend you limit this to twice per second (2/s).”

> “For an established connection, we recommend limiting this to one hundred per second (100/s).”

> “HTTP Persistent Connection … keeps the underlying TCP connection active for multiple requests/responses.”

来源：[Development Guide](https://developer.oanda.com/rest-live-v20/development-guide/)，HTTP 200，证据强度：高。

> “Streaming API 20 active streams … applied against the requesting IP address.”

> “Client is allowed to make no more than 2 new connections per second. Excess connections will be rejected.”

注意区分：开发指南的 REST 限额是 120 次/秒/IP；Best Practices 建议已建立连接控制在 100 次/秒。后者是推荐值，不是把前者改为 100。新连接限制和流数量限制的正文没有在这里指定拒绝必须返回哪种 HTTP 状态，不能自行补成 401。

工程含义（推导，尚非本项目根因）：避免每次抓取都新建 TCP/TLS；核查同一出口 IP 上所有工作进程和实例的总连接量、stream 数及重连节奏。遵守该建议值得做，但不能未经实验宣称已解决认证问题。

### 5. 官方 SDK 本身复用 Session，但没有“401 自动修复”逻辑

来源：[oanda/v20-python 源码，固定 commit](https://github.com/oanda/v20-python/blob/f28192f4a31bce038cf6dfa302f5878bec192fe5/src/v20/__init__.py)，通过 raw GitHub 取得 HTTP 200，证据强度：高（仅限该版本的源码行为）。

关键代码：

```python
self._session = requests.Session()
self.set_header('Authorization', "Bearer {}".format(token))
http_response = self._session.request(..., headers=self._headers, ...)
```

源码将 HTTP 响应包装返回；未发现 401 的 token 自动刷新或自动重试分支。可以参考其 Session 复用方式，不能据此说更换 SDK 就有官方认证恢复方案。

官方 SDK issue 关键词检索：以下查询在此次访问均返回 `total_count=0`、`incomplete_results=false`：

- [repo:oanda/v20-python 401](https://api.github.com/search/issues?q=repo:oanda/v20-python+401)
- [repo:oanda/v20-python unauthorized](https://api.github.com/search/issues?q=repo:oanda/v20-python+unauthorized)
- [repo:oanda/v20-python intermittent](https://api.github.com/search/issues?q=repo:oanda/v20-python+intermittent)

这只是有限关键词和单一仓库的检索结果，不能证明所有 OANDA 渠道从未有人遇到该问题。扩大到组织级查询时 GitHub 返回 403，未获得可靠结果。

### 6. 用账户只读接口和请求标识建立证据

来源：[Account Endpoints](https://developer.oanda.com/rest-live-v20/account-ep/)，HTTP 200，证据强度：高。

`GET /v3/accounts` 的官方定义：

> “Get a list of all Accounts authorized for the provided token.”

官方列出响应头：

> “RequestID — The unique identifier generated for the request.”

来源：[Pricing Endpoints](https://developer.oanda.com/rest-live-v20/pricing-ep/)，HTTP 200，证据强度：高。

REST pricing、candles 和 streaming 的请求均明确要求 Bearer。已建立的 stream 持续更新，不足以证明之后每一次新 REST 请求认证成功；这是由接口区分得出的诊断判断，不是官方对本案根因的说明。

建议在下一次故障时保留：UTC 时间、实际 HTTP 状态和错误正文、最终 host/path、请求角色、凭据匿名指纹、重试结果、响应中存在的 `RequestID`。官方文档示例列出成功响应的 RequestID，但不能保证每个 401 都有；有则记录，无则记缺失。不得记录 token、Authorization 原文或完整账户号。

## 尚未核实的部分

- `https://status.oanda.com/` 与其 `/api/v2/summary.json` 本次均 TLS EOF，未取得状态数据。
- `https://www.oanda.com/us-en/trading/platforms/system-status/` 被 Cloudflare challenge 返回 HTTP 403。
- 尝试的 help.oanda.com troubleshooting URL 返回登录页面，没有读取到文章正文。
- [官方 release notes](https://developer.oanda.com/rest-live-v20/release-notes/)可读取，但内容是较早版本记录；本次未找到针对间歇 401 的公告。不代表存在或不存在当前服务事故。

所以不能对用户断言“官方目前服务全绿”“OANDA 当前认证服务故障”或“已确认是已知官方 bug”。

## 可采取的最小诊断/缓解路径

1. **先核实每条链路的请求一致性。** 对成功和失败的新 REST 请求比较环境、身份匿名指纹、角色及错误正文；报价 stream 的健康独立判断。
2. **核实持久连接及全出口连接预算。** 按官方规范限制新连接和 stream 数；若已经符合，就不把限流继续当成默认解释。
3. **针对只读请求做有界重试试验。** 极少量、退避、记录每次结果，比较重试前后 HTTP 状态。此项是可检验的工程缓解建议，非官方文档明示的 401 修复。持续失败须转为明确认证故障，不能无限重试，更不能照搬到下单请求。
4. **若同一请求、同一身份在短时间 200/401 交替，带证据请 OANDA 查。** 提交脱敏时间线、host/path、RequestID 与匿名配置说明；不提供 token。只有 OANDA 才能确认其认证层、账户策略或请求落点的原因。

本轮没有实施上述任何代码或运行时调整。
