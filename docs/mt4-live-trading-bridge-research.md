# Windows MT4 实盘与原生图表接入研究

核查日期：2026-10-02。范围：用户自己的 Windows MT4 终端，与当前项目处于同一局域网。仅研究，未安装 EA、连接账户或提交交易。

项目对照基线：`v1.5.0`（`37cf4048ca10f3206963c1aec67f49b38140f5a8`）。本文随 v1.5.1 文档修订整理；功能现状按该固定源码核查，不表示运行环境已升级。

## 结论

有可复用的桥接方案。最符合当前场景的是 **Darwinex DWX Connect 的 MT4 EA + Windows Python 客户端**，再开发局域网代理和项目 Broker API 适配。它提供现成的终端通信及交易操作，不能直接作为已经完成的原生图表实盘插件。

建议链路：

```text
浏览器原生图表 Broker API
          ↕
market-watch 交易后台（Linux）
          ↕ 带认证的局域网连接
Windows Python agent / DWX client
          ↕ 本机 MQL4/Files 文件通信
MT4 内运行的 DWX Connect EA
          ↕
券商交易服务器
```

Windows agent 可以主动连接项目后台，收取命令并回传账户、报价、订单和持仓。DWX Connect 自身是本机文件桥接，局域网传输、认证、恢复和图表映射由项目新增。当前两台机器同局域网，不需要为了该拓扑引入公网穿透。

## 方案对比与维护状况

| 方案 | 已有能力 | 当前场景适合程度与限制 |
| --- | --- | --- |
| [DWX Connect](https://github.com/darwinex/dwxconnect) | MT4/MT5 EA；Python 客户端；文件通信；账户、订单、历史交易、bid/ask、K 线；市价单、限价/止损挂单、改单、止盈止损、撤单及部分平仓 | 首选本地终端接入基础。BSD-3-Clause。最新默认分支提交为 2025-05-25；核查时未归档。可以复用，但不能把它描述为持续高频维护或承诺生产 SLA 的成品。README 明确不能用于回测。 |
| [旧 DWX ZeroMQ Connector](https://github.com/darwinex/dwx-zeromq-connector) | EA 与外部程序经 ZeroMQ 通信，需要 ZeroMQ、DLL 等依赖 | 不建议新接入。README 在 2022-02-15 明确表示不再积极维护，并建议迁移到 DWX Connect。最新默认分支提交为 2022-05-25；API 的未归档标志不代表仍在维护。 |
| [MetaApi](https://metaapi.cloud/docs/client/) | 托管 MT4/MT5；REST、WebSocket 和 SDK；行情、账户、订单、持仓、历史及交易操作 | 可选商业云服务。添加账户后在云端部署 API/终端，按服务规则收费，需要提供交易账户凭据；不是控制现有 Windows MT4 的本地桥接。若目标明确是使用用户已有终端，不优先选择。 |

维护日期依据 GitHub [DWX Connect commits API](https://api.github.com/repos/darwinex/dwxconnect/commits?per_page=1) 和 [ZeroMQ commits API](https://api.github.com/repos/darwinex/dwx-zeromq-connector/commits?per_page=1)，不是仓库 `updated_at`；后者会因其他活动更新，不能代表源码维护日期。DWX Connect 当前提交为 `ca43c7ba5c0a4dcc5d7906e68f64f5e5be56b142`。

DWX Connect 的能力、部署步骤和参数见其 [README](https://github.com/darwinex/dwxconnect/blob/main/README.md)；[MT4 EA 源码](https://github.com/darwinex/dwxconnect/blob/ca43c7ba5c0a4dcc5d7906e68f64f5e5be56b142/mql/DWX_Server_MT4.mq4)调用实际的 `OrderSend`、`OrderModify`、`OrderClose`、`OrderDelete`，并有命令 ID 防重处理。该处理不能替代项目跨网络、重启和超时情况下的交易核对。其中 `open_orders` 同时包含成交持仓和挂单，`close_order(ticket, lots)` 支持部分平仓；图表 Broker 适配时需拆成订单/持仓模型。文档还提醒 `modify_order` 中省略止损等字段可能将原值清零，适配层必须保留用户未修改的值。

## 与当前项目接入时需要补齐的内容

1. **图表适配**：新增 `broker_factory` / Broker 对象，把下单、撤单、改单、平仓和账户数据接到项目后台，并通过图表 host 更新方法回传真实状态。现有包的核查依据见 [策略、Pine 与交易模块研究](./advanced-charts-v31-strategy-pine-trading-research.md)。
2. **Windows 代理**：运行 DWX 客户端并维持认证的局域网连接；传递 EA 返回的成功/失败及 MT4 ticket。MT4 必须保持运行、账户连接及允许 EA 交易，Windows 应避免睡眠。终端或代理离线时前端禁用交易；恢复后以终端状态重建订单和持仓。
3. **交易状态恢复**：请求 ID、执行结果持久化、心跳、状态核对。超时意味着结果未知，不能立即重发；先核对 MT4 ticket/账户状态，再决定如何恢复，避免重复订单。手动在 MT4 执行的操作也应同步回图表。
4. **交易品种规则**：识别券商品种后缀、报价精度、最小手数、手数步进、合约大小、最小止损距离及允许的订单类型。MT4 的“手数”须明确映射到图表数量字段。
5. **实盘报价**：交易界面使用该 MT4 券商的实际 bid/ask，显示清晰的行情来源。现有 OANDA/Binance 图表报价不能作为 MT4 的成交报价；需新增 MT4 行情源并核对 K 线时区。DWX 文件通信属于轮询/快照方案，不保证每个 tick 都被保留，也不应承诺适合高频交易。

首阶段宜接模拟账户或只读信息，验证账户、品种和实时状态；然后验证市价单、挂单、SL/TP、撤单、部分平仓、手动终端操作同步及断线恢复。具体兼容性仍取决于用户券商、MT4 版本和账户权限，尚未完成端到端验证。

## 官方平台限制

- [MQL4 WebRequest](https://docs.mql4.com/common/webrequest)：只能由 EA 或脚本调用，需在终端允许目标 URL；同步请求会阻塞调用程序，不能在 Strategy Tester 运行。因此直接 EA 发 HTTP 是可行路线，但本机文件桥 + Python 网络层更方便复用现有 DWX 实现。
- [MQL4 DLL 导入](https://docs.mql4.com/runtime/imports)：外部 DLL 在调用程序线程内执行；禁止 DLL、缺少依赖或找不到导出函数会使 EA 停止。旧 ZeroMQ 方案有相关依赖，新 DWX Connect 宣称已移除 ZeroMQ 和第三方依赖。
- 官方 [MetaTrader5 Python 包](https://pypi.org/project/MetaTrader5/)明确是 MetaTrader 5 Terminal API，不能直接当作 MT4 API 使用；包描述指向 [MetaQuotes Python 文档](https://www.mql5.com/en/docs/integration/python_metatrader5)。本次后者网络不可达，包元数据可访问。
- MetaApi 的[账户创建文档](https://metaapi.cloud/docs/provisioning/api/account/createAccount/)说明，投资者密码支持只读，交易功能需要 master password；[FAQ](https://metaapi.cloud/docs/client/faq/)说明云部署、收费及凭据暴露边界。它可以减少自建桥接工作，但改变终端部署位置与凭据管理方式。
