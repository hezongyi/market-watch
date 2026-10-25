# FXCM 模拟账户注册与 ForexConnect 权限调查

查阅日期：2026-10-24 UTC；同日补核 EULA 当前入口。范围仅为公开资料调查；本研究没有注册、提交表单、登录、联系支持、读取账户凭据、运行行情请求或修改验收实例。

## 结论

**官方材料支持先申请 Trading Station / TSII 模拟账户作为 ForexConnect 历史接入的起点；不需要为了这次验证先开入金的真实账户。** 官方 API 对比页将 ForexConnect 的 Required Credentials 列为 Demo or Live，费用列为 Free，支持 Linux；官方 ForexConnect README 明确要求 TSII 账户、先签 EULA，并提供模拟账户申请入口，同时写明 Trading Station 账户无需额外 setup。[S1][S2]

这里的“支持模拟账户”不等于已证明任意地区新注册的账户都具有本任务需要的目录、黄金、BID M1/H1/D1、指定历史范围和本地保存权限。上述账户级事实仍须申请后的最小只读测试和必要的官方确认。账户材料是否已提供与实际登录、权限验证是不同事实；本公开资料调查不读取凭据，也不把静态文档升级为真实 API 验收。

## 已有官方证据

| 问题 | 官方材料支持的结论 | 边界 |
| --- | --- | --- |
| 选哪种账户 | ForexConnect 官方 README 要求 FXCM TSII 账户，并明确提到申请 demo；比较页列 Demo or Live。[S1][S2] | 本任务应选 Trading Station / Trading Station II / TSII，而不把 MT4、MT5、TradingView 登录凭据当成等价的 ForexConnect 凭据。无需为此新增 MT 桥接。 |
| 是否额外开通 API | README 写 Trading Station 账户 no extra setup required。[S1] | 可以先走标准 TS demo 流程；不据此承诺用户所在地区不需要任何合同、EULA 或账户级授权。 |
| 是否收费 | 官方比较页和 README 将 ForexConnect 标为 Free。[S1][S2] | 仅指公开标示的 API 产品费用，不替代用户所属地区、账户、用途或数据授权条款；不能推导为免费转售或公开分发数据。 |
| 是否必须 EULA | 官方 README 的第一步明确要求先签 EULA，并链接 UK 官方 EULA 页面。[S1][S6] | 同机本轮只读请求仍为 HTTP 403，web 打开没有可读内容，无法独立核实当前页面标题、申请按钮、电子表单目标、协议正文或字段；不推断 demo/地区适用性、签署完成或审核时长。SDK 包内许可与账户的 FXCM EULA 也不是同一份文件。 |
| 模拟账户有效期 | Markets FAQ 写 Trading Station demo 在 30 Days of inactivity 后到期。[S4] | 这是该 Markets 页的措辞，不把它泛化为所有地区统一规则；以注册邮件和所属地区客服说明为准，也不承诺后台 API 登录必然重置其 inactivity。 |
| 注册页面 | Markets Trading Station free-demo 页提供 TS demo 申请入口，展示模拟账户与虚拟资金。[S3] | 按用户浏览器中的实际表单填写；不同抓取中出现 JavaScript 占位和成功/错误模板，无法保证字段完整，不能据此判断当前注册成功或失败。未提交表单，不证明用户当前地区申请一定成功。 |
| 历史/黄金示例 | 官方 AvailableSymbols 列有 EUR/USD、XAU/USD 与 m1/H1/D1 数据说明。[S5] | 不是完整目录，不是用户账户权限或当前覆盖保证；黄金真实代码和账户权限必须在目录实测。 |
| 技术支持 | 官方 README 给出 api@fxcm.com。[S1] | 仅提供用户可自行联系的官方地址，本轮没有发送邮件或其他消息。 |

## 建议用户操作顺序

1. 从 [FXCM 官方网站](https://www.fxcm.com/) 选择真实居住地区，进入 **Trading Station 模拟账户**。Markets 公开入口为 [Trading Station free demo][S3]；只有它适用于真实居住地区时才使用。不要选错成 MT4/MT5 demo，也不要使用虚假国家或规避地区限制。
2. 在官方表单填写真实姓名、邮箱与国家/地区，完成邮件要求的注册/验证。保存邮件中的账户类型、用户名、登录环境及适用地区主体。网页账户门户登录不自动等于 TSII 交易账户登录；需确认收到的是 Trading Station demo 凭据。
3. 用 Trading Station 官方客户端或网页确认一次能成功登录，查看 EUR/USD 和黄金品种、历史图。此步骤只用于确认账户与品种访问，不需要下单。界面能看图仍不能替代 API 权限实测。
4. 依据官方 ForexConnect README，在首次 API 调用前完成 [FXCM EULA][S6]：在本人浏览器打开官方入口，按页面显示的申请/签署流程操作，先读取协议和实际字段再决定签署。本轮无法读取该页面，未核实当前申请按钮、电子表单地址、要求哪些字段，也未核实该 UK 入口是否适用于用户所属地区、开户主体或 demo 账户。若页面要求真实账户号而没有 demo 选项、条款主体不符、表单打不开或无法确认提交结果，勿猜填或以 demo 登录成功代替 EULA；由用户向所属地区支持或 api@fxcm.com 确认正确入口与流程。签署后将可获得的确认邮件或完成文件保存在 Git 外私有目录；本报告不承诺必有何种回执、自动开通 API 或具体处理时效。
5. 将凭据只存到本机私有文件，建议目录 `/home/quant/.local/share/market-watch-docker/fxcm-history-20261024/`；目录权限 700，凭据文件权限 600。聊天中只提供路径，不提供账号、密码或 token。注册邮件/许可等辅助资料也只放私有目录；不要提交仓库。
6. 材料齐全后由实现任务执行有限的目录和指定品种历史请求，验证实际 API 契约。整栈验收仅在任务独立 Ubuntu Docker project 中进行，不使用 `$mw-acceptance`；本调查不构成该验收的许可。

## 用户可向官方支持确认的最小问题

可复用下述内容作为用户自行发送的咨询，按地区和账户实际情况补充，勿包含密码：

> I am registering a Trading Station II demo account for personal market analysis. Can this demo account use the current ForexConnect API from Linux to read the instrument catalogue and historical BID OHLC bars for EUR/USD and the available gold instrument at M1, H1 and D1, without placing orders or subscribing to live prices? Please confirm the applicable EULA process, demo expiry policy, any separate API or market-data permissions/fees, history coverage and limits, and permission to retain/display the retrieved historical data privately. Please also confirm the supported connection/environment settings and whether NoPrice can be used for catalogue and historical requests.

API 凭据可能同时具备模拟交易能力；公开材料没有证明存在独立的服务端“只读历史凭据”。本任务的只读边界由实现限制调用并实际验证，不能向用户承诺平台层已经禁用交易权限。

## 当前仍未解决的事项

- 用户居住地区、适用 FXCM 主体及新 demo 的实际申请资格未确认；不依据执行环境或时区推断用户居住地。
- EULA 入口仅由官方 README 链接确认；官网当前标题、申请按钮、电子表单地址/正文、字段、地区/开户主体与 demo 适用性、提交结果、回执和是否需单独 API 激活均未核实。
- 当前账户的 EUR/USD、黄金代码、精度、M1/H1/D1、BID、历史覆盖、分页与完整柱语义均未实测。
- NoPrice、无 table manager、登录/目录/历史调用组合在真实账户上的行为仍未验证；不订阅实时报价来绕过该关口。
- 私人保存/展示历史数据的适用授权、地区差异和具体账户费用不能由 Free 字样代替确认。

## 资料与访问限制

本轮 Ubuntu shell 对 Markets FAQ、Markets free-demo、中文 demo/API、UK API 等官网页面的只读 urllib 请求返回 HTTP 403，EU compare-api 请求出现 TLS unexpected EOF。**这是本调查环境的读取限制，不证明用户浏览器也不能访问、产品停止或页面不存在。** 主任务已通过 web 检索/打开官方页面核对上述公开资料与措辞；动态注册页存在 JavaScript 占位，不能替代用户浏览器现场或真实提交结果。本研究同时直接成功读取官方 GitHub raw README（HTTP 200），交叉确认 demo、TSII、EULA、免费、Linux 和联系地址。没有通过绕过访问控制取得内容。

2026-10-24 EULA 补核：直接只读打开 `https://www.fxcm.com/uk/forms/eula/` 仍返回 HTTP 403；web 工具打开未返回可读内容或可引用来源。因此本轮只采用已能读取的官方 README 所列 EULA 入口，不将转述的 FORM APPLICATION、Adobe Sign 域名或表单参数记录为已证事实，也不能核实电子协议的区域/demo 适用性或任何用户已接受协议。本轮没有提交、签署或登录。

本文件不宣称已有登录结果，也不更改 `api-contract.json` 的未通过状态。旧官网/SDK 文档中的连接参数仅是官方示例，不能作为当前用户账户 endpoint 已验证的证据。

[S1]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/README.md "FXCM 官方 ForexConnectAPI README，固定提交；本轮 raw 200"
[S2]: https://www.fxcm.com/eu/algorithmic-trading/compare-api/ "FXCM 官方 API 比较：ForexConnect Demo or Live、Free、Linux"
[S3]: https://www.fxcm.com/markets/platforms/trading-station/free-demo/ "FXCM Markets Trading Station 模拟账户表单"
[S4]: https://www.fxcm.com/markets/help/how-can-i-create-a-new-demo/ "FXCM Markets 模拟账户创建与 inactivity 到期 FAQ"
[S5]: https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/AvailableSymbols.md "FXCM 官方历史品种示例，并非账户实测"
[S6]: https://www.fxcm.com/uk/forms/eula/ "官方 README 指向的 EULA 入口；2026-10-24 shell 补核仍为 403，web 未返回可读内容"
