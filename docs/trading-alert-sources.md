# 交易预警网站：数据源与手机提醒核查

核查日期：2026-09-28。只读访问官方文档、项目自身文档及源代码；未接入用户账户，未做 OPPO Find X8 真机或中国大陆运营商网络测试。下文区分可核实接口能力和仍须验证的运行条件。

## 1. Dukascopy：可优先验证的免费三品种候选

- [dukascopy-node 项目](https://github.com/Leo4815162342/dukascopy-node) 的 README 列出 EURUSD、XAUUSD、BTCUSD，并提供历史 tick 下载。正确作者名是 **Leo4815162342**。
- [项目实时文档](https://www.dukascopy-node.app/downloading-real-time-data/) 明确提供 `getRealTimeRates`，描述为从 Dukascopy 免费服务器 API 获取实时行情；支持 `tick`、`s1`、`m1` 等，tick 输出含时间戳及 bid/ask，支持最近 N 条与时间区间。因此“只能下载历史，不能实时”不符合该项目当前文档。
- 上述是第三方客户端项目对其接口的说明，**不是 Dukascopy 官方对公开 REST 的支持、完整性或稳定性承诺**。本次 Dukascopy 官方网页访问失败，未核实服务条款、限流、三品种实时开放情况、最新数据延迟及历史/实时的价格口径一致性。
- 建议先做短期技术验证：每个品种抓取 tick 或 M1，记录源时间/到达时间、连续性、空响应、重复、收盘延迟和断线补齐。若采用 Node 适配器，只负责取数；Python 负责分桶和策略，避免重写数据下载协议。

## 2. OANDA：账户条件明确，报价流不能当成全量 tick

本次 developer.oanda.com 官方文档网站连接失败；成功读取 [OANDA 官方 OpenAPI 定义](https://github.com/oanda/v20-openapi/blob/master/yaml/v20.yaml)。

- `GET /accounts/{accountID}/instruments` 的说明明确：可交易品种依赖账户所属监管实体。不能在未查询账户时承诺 EURUSD、XAUUSD 和 BTCUSD 全部具备，也不能把 Practice API 等同于无条件匿名免费行情。
- Pricing stream 明确每品种最多 **4 个价格/秒**，250 毫秒窗口只传最后有效报价，不传每个价格；不同连接窗口也未必一致。仅从这条流构建 OHLC，可能遗漏高低点，对“突破上一根最高/最低”策略尤其重要。
- 接口具备历史 candles 与 dailyAlignment/alignmentTimezone。用户自行合成 M5/H4/D1 时，可取细周期已完成 candles 作为统一数据底座，stream 用于界面实时价格；如果严格要求完全自己从 tick 聚合，需接受该流采样限制或选择别的来源。
- 待用户具备账户后验证：API token、账户可用品种、历史粒度、实时/历史报价口径与免费使用条件。未声称已验证 OANDA 的中国大陆开户或三品种权限。

## 3. 比特币独立行情备用

[Binance 官方 Spot WebSocket 文档](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md) 支持 trade/aggregate trade 与 kline 流，kline 有 1s/1m 等周期；单条 WebSocket 连接有 24 小时生命周期，需主动重连、心跳和补数。[官方 REST 文档](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) 提供市场数据与历史 K 线接口。

BTCUSDT 可作为用户已接受的独立产品，必须在图表/提醒中显示真实交易所和交易对，不应悄悄映射成经纪商 BTCUSD。交易所可达性和部署地区的服务可用性仍需在用户服务器上验证；当前成功获取 GitHub 文档并不能证明市场接口在用户环境可达。

Kraken 官方文档及行情 API 在本次环境均连接失败，因此未将其当前历史深度或实时性能作为已验证结论。

## 4. ntfy：现成 Android 应用已有持续响铃能力，但完整节奏仍需验证

- [ntfy Android 官方文档](https://docs.ntfy.sh/subscribe/phone/)：可自建服务器；F-Droid 构建不含 Firebase，所有订阅默认使用 instant delivery；即时交付使用持续运行的订阅服务。关闭 instant delivery 可能延迟数分钟乃至数小时。
- [发布文档](https://docs.ntfy.sh/publish/)：支持优先级、Android 通知声音配置及 HTTP action button。可以为消息加入“确认”按钮，调用网站告警确认接口；关闭通知与服务端确认必须明确区分。
- **关键源码证据**：[NotificationService.kt](https://github.com/binwiederhier/ntfy-android/blob/main/app/src/main/java/io/heckel/ntfy/msg/NotificationService.kt) 对 MAX priority 且开启 insistent 的通知调用 MediaPlayer，使用 `USAGE_ALARM`、`isLooping = true`，声音读取通知通道配置，提供停止播放处理。说明不能笼统说 ntfy 只能响一声；当前主分支有持续响铃能力。源码也检查闹钟音量非零。
- 该源码证据不等于已验证用户安装版本、OPPO 锁屏持续运行、任意重复节奏。**“响 15 秒—停 30 秒—继续，直到服务端确认；可限定次数和夜间静音”尚未证明可由原版全部完成。** 还需核对安装版本与 insistent 设置，以及确认按钮是否及时停止本地播放。
- 官方 Android 文档明确支持 Tasker/MacroDroid 自动化：收到消息发送 `io.heckel.ntfy.MESSAGE_RECEIVED` intent，包含 topic、message 等字段。可作为实现定制节奏的候选，需真机验证锁屏与进程回收行为。
- 优先试验“自建 ntfy + F-Droid Android 客户端 + insistent + HTTP 确认”。若节奏必须精确，再评估 Tasker/MacroDroid 或轻量 Android 配套客户端。服务器应持久化未确认事件；手机本地负责响铃节奏，网络断开不应导致本地已收到告警的重复提醒丢失。
- 未核实 OPPO 厂商推送的个人开发者资格及接入限制；不承诺任意系统省电/强制停止状态仍一定送达。真机验证应覆盖锁屏、移动网络/Wi-Fi 切换、重启、夜间静音、确认停止、通知权限和后台运行设置。

## 5. Gotify 与组件候选

[Gotify Android README](https://github.com/gotify/android) 明确支持接收与查看通知；仓库提供 WebSocket 服务实现。本次检视的 [NotificationSupport.kt](https://github.com/gotify/android/blob/master/app/src/main/kotlin/com/github/gotify/NotificationSupport.kt) 未建立原版支持所需响铃节奏的证据。优先 ntfy 的原因是已发现 insistent 与自动化集成的直接证据，不是证明 Gotify 绝对做不到。

主代理于同日通过 GitHub API 核对以下项目非 archived，近期有提交，可作为成熟组件候选；活跃度不等同于项目适配性或已完成功能测试：

| 项目 | 用途 | 核查许可证 | API 来源 |
|---|---|---|---|
| TradingView Lightweight Charts | 行情图表、标记及回放展示底层 | Apache-2.0 | https://api.github.com/repos/tradingview/lightweight-charts |
| FastAPI | Python 服务接口 | MIT | https://api.github.com/repos/fastapi/fastapi |
| TA-Lib Python | 后续通用指标 | BSD-2-Clause | https://api.github.com/repos/TA-Lib/ta-lib-python |

图表库本身不是完整回放引擎；隐藏未来数据、历史时点开预警和一致策略执行需应用层实现。第一版 OHLC 条件不需要为了使用指标库而引入复杂依赖。

## 6. 对设计的直接影响

1. 分桶由系统处理：外汇/黄金按 America/New_York 17:00，BTC 按 UTC 00:00；使用时区数据库处理 DST，并用历史与实时同一数据口径验证边界。
2. 若采用完整 M1 OHLC 重采样，可自建 M5/H4/D1 分桶且保留分钟内极值；这是复用细颗粒数据，不是直接沿用供应商 H4/D1。若要求完全原始 tick，必须评估采样、丢包和补齐。
3. 数据缺口不应填造价格再触发信号；记录缺口并暂停对应信号判定/标记不可靠，补齐后按明确迟到规则处理。
4. 预警触发后停止策略，通知事件独立保持未确认；确认接口幂等，重复消息共用事件 ID，夜间/次数策略有持久记录。
5. 最先验证的是免费三品种行情鲜度与 OPPO 强提醒，再建设完整网站；不应在这两个条件未实测时承诺已经满足生产可靠性。
