# FXCM 官方接口与 SDK 公开证据调查

> 更新说明（2026-10-24）：本文件保留初次、未联网账户阶段的研究上下文，不作为当前账户阻塞状态。后续官方方法页已明确 NoPrice 必须登录前设置、volume 是 tick volume、getDate 为 UTC 起点及尾柱可不完整；以 [official-history-semantics.md](official-history-semantics.md) 的精确语义和来源为准。真实登录/目录/历史结果见本目录 evidence 下主任务证据。

查阅时间：2026-10-24 08:20–08:29 UTC。调查环境为 Ubuntu 本机，任务工作树 `market-watch-fxcm-history-20261024`。本报告只核对公开资料、下载与包内源码；没有 FXCM 账户，没有登录、目录/历史数据请求、报价订阅或交易。源码结论不能代替账户实测。

## 结论与关口

**已证：存在 FXCM 官方仓库公开发布的 ForexConnect 1.6.5 Linux x86_64 native SDK，可固定版本下载并校验；Python 3.11 不能直接使用当前官方 forexconnect PyPI Linux wheel。当前可继续验证的候选是 native SDK，不是写死旧 REST 接口。** 已读取主任务保存的 [离线 native 加载探针](evidence/native-loading-probe.json) 与 [离线 C++ ABI 探针](evidence/native-abi-probe.json)：在 Python 3.11.16 / glibc 2.36 / x86_64 任务镜像中，两主库加载成功，最小 helper 可创建/释放 session 并设置静态选项。探针均未登录，也未验证行情；加载和离线 ABI 成功不能升级为可用会话或真实接口通过。

**尚未通过接入关口。** 无账户及 EULA/服务权限确认，不能证明当前账户可用产品、实际目录、黄金权限、M1/H1/D1、BID、历史覆盖、分页限额与尾柱完成语义。SDK 提供 `NoPrice` 模式，但静态源码不能证明登录阶段及有限历史会话完全没有持续报价/交易事件推送。任务书要求上述关口通过后才冻结适配契约；现阶段不能依据 fixture 或安装成功宣称真实接入完成。

## 官方来源与当前性

| 来源 | 本轮观察 | 能证明与不能证明 |
| --- | --- | --- |
| [FXCM ForexConnectAPI README（固定 commit）](https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/README.md) | 200；SDK 用途包括历史与报价；支持 C++/Linux；需先签 EULA、Trading Station II 账户；历史示例使用 non-table manager | 官方明确列出的产品/接入前提；不是用户已有权限证据 |
| [官方仓库元数据](https://api.github.com/repos/fxcm/ForexConnectAPI) | `archived=false`；本次 master `4c536d29fc722996d4a4bc40be247376f8c83eb9`；`license=null` | 当前仓库可访问；不能由 GitHub license 元数据推断 SDK 无许可或自由分发 |
| [Linux tar 文件提交记录](https://api.github.com/repos/fxcm/ForexConnectAPI/commits?path=ForexConnectAPI-1.6.5-Linux-x86_64.tar.gz&per_page=1) | `5b278a119bbe650bd378ce802f422c690b30f506`，2026-08-27，`Add ForexConnect API 1.6.5 Linux x86_64 release tarball` | Linux 包是官方仓库本年新增发布文件；不能证明其服务端权限或所有 ABI 均兼容 |
| [官方 GitHub releases API](https://api.github.com/repos/fxcm/ForexConnectAPI/releases) | 200，空数组 | 本轮版本依据是仓库文件，不是不存在的 release asset/签名 |
| [PyPI forexconnect JSON](https://pypi.org/pypi/forexconnect/json) | 最新 `1.6.43`；Linux 仅 cp35/cp36/cp37 的 manylinux1 i686/x86_64 wheels；该版无 sdist、无 cp311 Linux wheel；cp310 文件属于 macOS arm64 | 不能给现有 Python 3.11 后端直接 `pip install forexconnect`；不因此建议主服务降级到旧 Python |
| [PyPI fxcmpy JSON](https://pypi.org/pypi/fxcmpy/json) | 当前 `0.0.0.1`，说明为 `Security Holding Package`、已删除包的空占位 | 不能将旧教程里的 fxcmpy 当当前可维护安装入口；此证据自身不证明 REST 服务已经停服 |
| [FXCM MarketData README](https://github.com/fxcm/MarketData/blob/master/README.md) | 公开历史 CandleData 是部分年份/品种 sample，D1 文件按年更新 | 不能替代当前账户目录与日更历史 API，也不能据此保证黄金可用 |

官网 [API trading /markets](https://www.fxcm.com/markets/algorithmic-trading/api-trading/)、[ForexConnect /markets](https://www.fxcm.com/markets/algorithmic-trading/forexconnect-api/)、[API trading /uk](https://www.fxcm.com/uk/algorithmic-trading/api-trading/)、[ForexConnect /uk](https://www.fxcm.com/uk/algorithmic-trading/forexconnect-api/)、[REST /uk](https://www.fxcm.com/uk/algorithmic-trading/rest-api/)、[EULA /uk](https://www.fxcm.com/uk/forms/eula/) 与 README 指向的 [Getting Started PDF](https://apiwiki.fxcorporate.com/api/Getting%20Started.pdf) 本轮均返回 HTTP 403。这是本机访问限制，不能推论产品停服。

旧 [fxcm-api.readthedocs.io](https://fxcm-api.readthedocs.io/)、其 `/en/latest/` 和 [fxcm.github.io/rest-api-docs](https://fxcm.github.io/rest-api-docs/) 本轮返回 404；官方当前组织仓库列表没有 REST/fxcmpy 仓库，`fxcm/fxcmpy` API 与原始 README 返回 404。结合官网无法读取，本轮**未找到可核实为当前受支持且适合用户账户的 HTTP 历史接口**；这是未证，不是宣布所有 HTTP 服务已停止。不得据旧文档硬编码 REST URL/认证字段。

README 链接的 [FXCodeBase Download](https://fxcodebase.com/wiki/index.php/Download) 及旧 [ForexConnect online help](https://www.fxcodebase.com/documents/ForexConnectAPI/web-content.html) 现在虽返回 200，却最终跳转到 `https://docs.gehtsoftusa.com/fxcodebase-backup/`，页面自称原 fxcodebase 网站已经下线，保存的是 Indicore/论坛归档。它不再是当前 ForexConnect 下载/帮助目录；不能把这个 200 当作官方文档验证成功。

## 可重复取得的 native 包

固定官方下载地址：

```text
https://raw.githubusercontent.com/fxcm/ForexConnectAPI/4c536d29fc722996d4a4bc40be247376f8c83eb9/ForexConnectAPI-1.6.5-Linux-x86_64.tar.gz
```

实际下载：HTTP 200，7,324,536 bytes；本轮计算 SHA-256：

```text
a4c1ec512f0ede326afd0d63eb587c578b986b382cdd1e63900ce11a8c28f696
```

这是本轮下载所得的固定校验值，不是官方签名或独立发布的官方 checksum。没有找到附带的签名/checksum 文件。公开下载和 tar 目录已实测；SDK 尚未登录。原始公开资料及 SDK 仅保存在任务私有临时目录 `/tmp/mw-fxcm-official-research-20261024/`，没有 SDK bytes 进入 Git。

解压根目录为 `/tmp/mw-fxcm-official-research-20261024/sdk/ForexConnectAPI-1.6.5-Linux-x86_64/`。实际包包含：

- `lib/libForexConnect.so`、`lib/libpricehistorymgr.so` 及其支撑库；包中有相对符号链接，解压使用 Python tarfile `filter='data'`。
- `include/ForexConnect.h`、`include/forexconnect/IO2GSession.h`、`include/forexconnect/O2GEnum.h`、`include/forexconnect/IO2GRequestFactory.h`、`include/forexconnect/Readers/IO2GMarketDataSnapshotResponseReader.h`。
- `samples/cpp/NonTableManagerSamples/GetHistPrices/`、`GetOffers/`、`SubscriptionStatus/`、`TwoConnections/`；另有 `samples/cpp/PriceHistoryAPI/GetHistPrices/`。
- `doc/readme.txt` 和 `doc/license.txt`。readme 说明 C++ 连接 `-lForexConnect` 并包含 `<ForexConnect.h>`；这为最小 native helper 提供编译入口，不要求旧 Python wheel。

## 许可的实际文字边界

许可来源是上述官方 tar 的 `doc/license.txt`，标题为 `GEHTSOFT USA, LLC SOFTWARE END USER LICENSE AGREEMENT`，Copyright 2019，Version 1.0 August 2018。它不是仓库样例源码许可证的等价替代。

- §3：允许安装使用任意份软件用于设计、开发、测试应用。
- §4：允许修改/分发 `samples` 中的 Sample Code，允许将 Distributable Code 随开发的应用分发，但要求作为应用的一部分而非独立分发；除样例/另行开源组件外不得修改分发代码；要求下游接受足够保护条款、保留版权商标通知，并包含赔偿及支持责任条款。
- §5：第三方/开源组件仍受其单独条款约束。§11 限制逆向并要求不得过载服务。§14–15 包含可终止和条款变更约定。

FXCM README 另要求先签 FXCM EULA；用户当前是否已接受、账户是否允许 Linux 服务端历史调用/本地保存/应用分发/展示，以及服务费用，均未验证。故本任务不把 SDK 或许可二进制提交仓库、不制作公开包含 SDK 的分发物。样例仓库的 [Gehtsoft Open License](https://github.com/gehtsoft/forex-connect/blob/0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7/GEHTSOFT%20USA%20OPEN%20LICENSE%20v1.0.md) 是该源码 Work 的许可，不能据它覆盖官方 binary tar 内 EULA。

## 非 table manager 的目录、历史与报价边界

FXCM README 指向的 [Gehtsoft 样例仓库](https://github.com/gehtsoft/forex-connect/tree/0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7/samples/Linux/cpp) 是配套实现者的一手源码；本轮固定 tree `0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7`。以下同时与官方 tar 内接口/样例交叉核对，均未运行联网流程。

### 历史

[NonTableManagerSamples/GetHistPrices main.cpp](https://github.com/gehtsoft/forex-connect/blob/0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7/samples/Linux/cpp/NonTableManagerSamples/GetHistPrices/source/main.cpp) 使用 `CO2GTransport::createSession()`、登录控制会话、`getRequestFactory()->getTimeFrameCollection()`、`createMarketDataSnapshotRequestInstrument(instrument, timeframe, timeframe->getQueryDepth())`、`fillMarketDataSnapshotRequestTime()`、`sendRequest()` 与 `createMarketDataSnapshotReader()`。样例以响应中最早日期向前翻页，空页或日期无进展时停止。这证明官方调用形态，**不冻结实际页数/分页闭开边界/最早覆盖**。

包内 reader header 明确 `getDate(index)` 是周期开始时间，提供 BID 与 ASK 的独立 OHLC、`getVolume()`、`getLastBarTime()`。`getVolume()` 注释只有“Gets the volume”，本轮没有足够官方语义证据将其定为 tick volume 或成交量；reader 没有逐柱 `complete` 字段。SDK 使用 `DATE`/double 输出，需要实际验证 UTC 转换、原生相位、十进制精度及尾柱状态；不能仅凭时间结束伪造来源 complete。原生周期必须从账户会话的 timeframe collection 实测，不能把 enum 的单位列表当作可用周期全集。

### 目录

官方 tar `samples/cpp/NonTableManagerSamples/GetOffers/source/main.cpp` 通过 `getLoginRules()->isTableLoadedByDefault(Offers)` 判断登录已有目录响应；否则调用 `createRefreshTableRequest(Offers)`，再由 offers reader 读取。`IO2GOfferRow.h` 提供 `getInstrument()`、`getDigits()`、`getPointSize()`、`getSubscriptionStatus()`、`getInstrumentType()` 及对应有效性函数。

[AvailableSymbols.md](https://github.com/fxcm/ForexConnectAPI/blob/4c536d29fc722996d4a4bc40be247376f8c83eb9/AvailableSymbols.md) 列了 `EUR/USD` 和 `XAU/USD` 的 m1/H1/D1 示例，但原文明示只是少部分热门品种，完整数据须联系 FXCM。不能据此硬编码黄金代码、目录或用户历史权限；其中历史范围只能作为旧文档数据点，不作为当前覆盖承诺。

### 禁用报价的证据和缺口

包内 `include/forexconnect/O2GEnum.h` 定义 `O2GPriceUpdateMode {Default=0, NoPrice=1}`、`O2GTableManagerMode {No=0, Yes=1}`；`IO2GSession.h` 提供 `setPriceUpdateMode()` 与 `useTableManager()`。包内 `samples/cpp/NonTableManagerSamples/TwoConnections/source/Connection.cpp` 在 `login()` 成功后对第二个会话调用 `setPriceUpdateMode(NoPrice)`，注释为 `Disable receiving price updates for the second account`。这证明有禁价格更新能力；**不证明登录前调用合法或登录期间没有推送**。该 TwoConnections 样例还包含下单代码，本轮未执行，后续也不能直接拿它当只读探针。

non-table manager 仅意味着不用 table manager 预加载/维护全部表；它自身不等于零推送。[历史 ResponseListener.cpp](https://github.com/gehtsoft/forex-connect/blob/0f1b2d0e8ca972ddc83b01acdb74e75d3aef9bf7/samples/Linux/cpp/NonTableManagerSamples/GetHistPrices/source/ResponseListener.cpp) 的 `onTablesUpdates` 为空，丢弃回调不证明网络没有收到更新。`GetOffers` 样例甚至等待 10 秒让更新输出，不能原样当有限目录刷新实现。

`subscribeSessionStatus` 是控制连接状态回调，`subscribeResponse` 是请求响应监听，不能仅凭方法名字就判为主动报价订阅；但监听对象也能收到 `onTablesUpdates`，需实际统计/过滤证明。`SubscriptionStatus` 样例通过 `createOrderRequest` 提交 `SetSubscriptionStatus` 来改变品种订阅状态；本任务不应执行它来“清空全部订阅”，因为那会修改账户订阅状态，且无法证明登录时无报价。

## 继续所需的最小补充条件

1. 用户申请官方 Trading Station/ForexConnect 账户及 API 历史权限，完成适用 EULA；由 FXCM 明确 Linux 服务端使用、历史存储/展示、费用、黄金和 M1/H1/D1 权限。凭据只放私有 env/secret file。
2. 两主库的离线加载和最小 helper/session ABI 探针已通过；仍需确认当前服务端支持的会话 URL/环境与安全传输，并在真实账户上验证登录。README 的示例连接参数不是本轮已验证 endpoint。
3. 有账户后仅运行有限目录和指定品种/区间历史探针：记录实际 timeframe collection、EUR/USD 与账户实际黄金代码、BID、精度、时区、原生高周期相位、volume、尾柱、分页/限额、取消/恢复。输出只保存脱敏摘要及样本校验和。
4. 显式 non-table manager 与 `NoPrice` 路径需向官方文档/支持确认可用时点，并以控制连接/历史响应/报价更新的分项计数核对无持续报价与账户交易事件订阅。若无法在任务边界下建立目录/历史会话，就停在此关口，不放宽为“收到但忽略实时数据”。

目前结论：可以完成这些不依赖账户的兼容性准备；真实接口契约、适配器接入和全链路验收仍受账户与无报价边界验证阻塞。本轮不以静态资料冒充真实接口验收。
