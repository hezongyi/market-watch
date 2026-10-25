# FXCM 模拟账户申请与 ForexConnect 历史权限核对

核查日期：2026-10-24。用途：让用户申请本任务的测试账户，然后由执行 Agent 验证真实目录、EURUSD/黄金 BID M1/H1/D1。这里只提供注册操作清单；没有代用户注册、签署协议、登录、发送客服消息、订阅行情或交易。

## 结论

**可以先申请 Trading Station 模拟账户进行 ForexConnect 接入验证。** FXCM 官方 [API 比较页](https://www.fxcm.com/eu/algorithmic-trading/compare-api/) 把 ForexConnect 的凭据列为 Demo or Live、费用列为 Free，并列出 Linux 支持。[官方 SDK README](https://github.com/fxcm/ForexConnectAPI) 说明 Trading Station 账户无需额外设置，入门步骤为签署 EULA、取得 TSII 账户，且明确提供模拟账户申请路径。

本任务不需要用户入金或交易。用户已确认提交 LTD EULA，且有限真实读取已验证本账户可访问目录、EUR/USD、XAU/USD 与 BID M1/H1/D1；这不证明完整历史覆盖、许可保存范围或所有无报价行为。

## 用户注册步骤

1. 从 [FXCM 官网](https://www.fxcm.com/) 按真实居住国家/地区进入对应站点。不要为了获得产品权限选择不真实的地区。Markets 模拟表单明确排除美国及其他部分地区；不能假定任意地区都能开户。国家是否可选以实际表单与 FXCM 回复为准。
2. 进入 **Platforms → Trading Station → Free Demo / Try Demo**。国际站参考入口为 [Trading Station 免费模拟账户](https://www.fxcm.com/markets/platforms/trading-station/free-demo/)。若自动跳转，用对应地区官网中的同名入口。选择 **Trading Station / TSII**，本次不选择 MT4、MT5 或第三方平台账户。
3. 按实际官方表单填写真实姓名、邮箱和国家/地区，其他字段以页面为准。Markets 的 [Open Demo 页面](https://www.fxcm.com/markets/open-demo/) 明确提到邮箱和居住地；[官方登录 FAQ](https://www.fxcm.com/markets/help/why-am-i-not-able-to-log-into-my-demo-account/) 说明 Demo 登录资料在注册时通过邮箱收到。用户本人阅读并决定是否接受相关协议/联系选项。
4. 保存最终收到的 Trading Station 登录 ID、密码、Demo 环境和连接说明。不要把 MyFXCM 客户门户登录或第三方平台账号误当作 TSII API 凭据。若收到的是其他平台账户，向 FXCM 确认或重新申请 Trading Station demo。
5. 按 [官方 SDK 入门说明](https://github.com/fxcm/ForexConnectAPI#how-to-start) 完成适用 **EULA**。README 当前指向 [EULA 表单](https://www.fxcm.com/uk/forms/eula/)，但该链接具有地区属性；若跳转、不可访问或不适用于自己的账户，请让所在地区 FXCM 客服提供适用链接，不盲目切换实体。Agent 不代用户签署。
6. 可选：用 Trading Station 网页端/客户端登录一次，确认账户可用；搜索 EUR/USD 和 Gold，记录实际黄金代码。打开 m1/H1/D1 可辅助发现明显权限缺口，但网页图表成功不等于 API 已通过，API 验证交给 Agent。无需下单或手工订阅全目录。
7. 把登录材料和连接说明放到 Git 外的私有文件，只提供本机路径。收到客服关于 EULA、有效期、历史权限或费用的答复，也可以保存到同一私有目录。

推荐目录：

```text
/home/quant/.local/share/market-watch-docker/fxcm-history-20261024/
```

目录权限建议 700，凭据文件 600。用本机文本编辑器保存账号材料，不把秘密放进 shell 命令、聊天、仓库、截图或报告。现阶段不要求用户填写尚未冻结的应用配置变量；只需保存收到的登录材料和说明。告诉 Agent 的内容可以仅为：“已申请 Trading Station Demo，凭据文件路径是 ……，EULA 已完成/待确认。”

## 哪些能力已证，哪些仍要验证

| 项目 | 公开官方资料能证明的内容 | 新账户的验证方式 |
| --- | --- | --- |
| Demo 使用 ForexConnect | API 比较页明确为 Demo or Live；SDK 入门明确 TSII Demo | 登录有限只读会话 |
| SDK 费用、Linux | 官方说明 ForexConnect 免费、支持 Linux | 当前本机离线 ABI 已证；用户账户访问及适用许可仍需确认 |
| 独立 API 开通 | 官方 README 说 Trading Station no extra setup required；仍有 EULA 前提 | 先用正确 TSII Demo 尝试，不预设必须另购账户；失败时核对 EULA/权限 |
| BID M1/H1/D1 | 官方 SDK 用于历史，reader 有 BID 字段；[AvailableSymbols](https://github.com/fxcm/ForexConnectAPI/blob/master/AvailableSymbols.md) 举了 EUR/USD、XAU/USD 的 m1/H1/D1 | 账户真实目录与最近已结束交易日样本；代码、范围和原生周期均不从示例推定 |
| 黄金 | 官方公开示例列出 XAU/USD，但明确只是部分热门品种 | 以新账户目录、历史响应和所在地区权限为准；没有黄金不能算任务完整通过 |
| 无实时订阅 | SDK 静态接口存在 NoPrice/non-table-manager | 验证登录、目录、历史组合的实际行为，不能把“忽略回调”当作零报价推送 |
| 只读安全 | 本任务仅调用目录/历史 | Demo 凭据不是已证明的服务端只读 token；不得由“只读用途”推论账号没有交易权限 |
| 本地保存/个人分析、费用 | README 指向 EULA 且声明 personal use；不能代替适用协议 | 用户阅读适用 EULA；不清楚时让 FXCM 确认历史下载保存、Linux 服务端用途及额外限制 |
| Demo 有效期 | [Markets FAQ](https://www.fxcm.com/markets/help/how-can-i-create-a-new-demo/) 写 Trading Station 30 Days of inactivity；[UK FAQ](https://www.fxcm.com/uk/help/trading-station-technical-support-why-am-i-not-able-to-log-into-my-trading-station-demo-account/) 写 after 30 days | 按实际地区条款/客服回复确认，不承诺自动续期；API 历史访问是否算活跃尚未证明 |

官方示例中的历史起始日期不是当前账户历史覆盖承诺。不要为了保活而定时轮询行情；本任务仍要求无图表、无维护需求时零 FXCM 行情请求。

## 需要时发给 FXCM 的询问模板

先申请正确 TSII 模拟账户、完成 EULA 即可交给 Agent 做最小实测，不要求用户先拿到所有客服回复。若开户入口不清楚、EULA 不适用、缺黄金/历史权限，或需要确认保存许可，可把以下文字发给官方客服。[官方 SDK README](https://github.com/fxcm/ForexConnectAPI#note) 公布 API 支持邮箱 `api@fxcm.com`；也可使用对应地区官网客服。Agent 未发送邮件。

> 我准备使用 Trading Station 模拟账户，通过官方 ForexConnect API，在 Linux x86_64 服务端为个人分析系统读取并本地保存历史 K 线，不进行交易，也不订阅实时报价。
>
> 请确认：该 Demo 是否支持 EUR/USD 和一个黄金品种的 BID m1/H1/D1 历史读取？黄金实际代码、可查询历史范围和请求限制是什么？是否需要另外开通 API 权限或签署适用于本地区账户的 EULA？是否允许上述 Linux 服务端与个人本地保存用途，是否有费用？Trading Station Demo 的有效期、延续方式和历史 API 访问是否算账户活跃分别是什么？如果仅需目录和历史，是否支持 NoPrice + non-table-manager 会话而不持续接收报价/交易事件？

不要在邮件正文附密码；如需核对账号，通过 FXCM 认可的安全渠道提供必要标识。

## 材料到位后的执行顺序

1. 确认私有凭据路径与 TSII Demo 环境，不在日志回显秘密。
2. 在任务归属的开发探针中有限登录，核对 NoPrice、无 table manager 和无交易/报价订阅边界。
3. 读取真实目录和指定 EURUSD/实际黄金代码的有限 BID m1/H1/D1 样本，记录账户环境 fingerprint、精度、时间、分页、完成柱与覆盖信息。
4. 真实关口通过后冻结契约，继续源适配和注册接线；不把 Demo 契约冒充 Live 权限/覆盖验证。
5. 整栈验收只在本任务独立 Ubuntu Docker project `mw-fxcm-history-20261024` 中进行，不使用 `$mw-acceptance`；不创建 PR、不合并、不发布生产。

## 本轮来源与读取限制

- 本文引用的 API 比较、Markets Trading Station demo、Markets/UK 到期 FAQ 和当前 GitHub README 经 Web 阅读工具读取；当前页面可能与用户所在地区显示不同。
- 部分模拟开户页面包含 JavaScript 表单占位以及成功/错误提示模板，静态抓取不能证明用户已注册、实时表单故障或提交结果；操作以用户浏览器中的实际表单为准。
- 同一 Ubuntu 主机通过 Python urllib 访问上述 `fxcm.com` 公开页返回 HTTP 403；这只说明该抓取方式受限，不证明用户浏览器无法访问、产品停服或注册失败。
- 官方 GitHub 原始 README 与 AvailableSymbols 本轮 urllib 均为 HTTP 200。没有提交任何开户表单、获取新账户、登录或运行真实历史请求。
