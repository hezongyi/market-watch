# MCP 实际行情默认口径验收

结论：本次指标专项验收通过，已更新 mw-acceptance。

F0：兼容 API 参数与默认行为调整，复用现有 observed 引擎，无 schema、公式或 worker 改动；采用自审、82 项定向回归和现有 Ubuntu mwa 真实 HTTP 验收。

## 行为与版本

- API 产品提交 `807688018ba55461862a81127f0ba0350288661c`，集成分支 market-watch-integration-20261023。
- 固定镜像 `sha256:9e5d85fa488ee7a842e3336b94567dc18bf9fc2c1f42186823a1c0d8a529852c`。
- 自建历史 history、组合 composite 的 MCP 默认 observed_display_v1，按真实已收盘 OHLC 连续计算，不因分钟缺口重置；整根缺失留空并继续。
- 仍可显式选择 strict_confirmed_v1，两种计算状态独立。组合可固定 revision/input_revision。平台和旧 managed 维持既有口径。
- AGENTS.md 已写入个人使用、个人维护及避免过度防御编程原则。

## 验证

修改前新增缺口回归已失败；修改后 82 项定向测试通过，Ruff/diff 检查通过。合成数据覆盖每天少 15 根 M1、缺失整天、自建/组合 H4/D1、五类指标、严格状态隔离及图表一致性。

mwa 真实 HTTP MCP：EURUSD、USDCAD、XAUUSD × 自建/组合 × H4/D1 共 12 组，EMA20/ATR14/RSI14/SMA20/MACD12,26,9 最新已收盘值全部有效，价格、指标和依赖与真实图表接口相同，H4 固定输入分页通过。由后台自然完成任务，未手动 tick。

下表为查询窗口内非空数；MACD 统计三条序列之和。D1 初始预热 null 正常保留。

| 品种 | 类型 | 周期 | K线 | EMA | ATR | RSI | SMA | MACD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| EURUSD | history | H4 | 300 | 300 | 300 | 300 | 300 | 900 |
| EURUSD | history | D1 | 209 | 190 | 195 | 195 | 190 | 528 |
| EURUSD | composite | H4 | 300 | 300 | 300 | 300 | 300 | 900 |
| EURUSD | composite | D1 | 210 | 191 | 196 | 196 | 191 | 531 |
| USDCAD | history | H4 | 300 | 300 | 300 | 300 | 300 | 900 |
| USDCAD | history | D1 | 209 | 190 | 195 | 195 | 190 | 528 |
| USDCAD | composite | H4 | 300 | 300 | 300 | 300 | 300 | 900 |
| USDCAD | composite | D1 | 210 | 191 | 196 | 196 | 191 | 531 |
| XAUUSD | history | H4 | 300 | 300 | 300 | 300 | 300 | 900 |
| XAUUSD | history | D1 | 206 | 187 | 192 | 192 | 187 | 519 |
| XAUUSD | composite | H4 | 300 | 300 | 300 | 300 | 300 | 900 |
| XAUUSD | composite | D1 | 209 | 190 | 195 | 195 | 190 | 528 |

EMA500 在历史不足时仍返回 null/insufficient_input；非法 policy 拒绝；OANDA 原生 provider 指标、MD 自建读取及空旧 managed 的 DATA_UNAVAILABLE 行为通过。最初附加检查使用超上限 EMA2000 和无数据 EURUSD legacy 输入，已更正脚本并补验收，不涉及代码补丁。

## 实际运行与边界

Ubuntu quant-server，Compose project mw-issue75-v2-20261018；入口 https://192.168.7.232:18280 ，Chart https://192.168.7.232:18281 ，MCP http://127.0.0.1:18275/mcp 。

仅 API 替换，其他 14 容器身份和镜像保持；15 服务运行，API/PG healthy。环境、挂载、资源、网络、端口与保护浏览器保持，持久 overlay 已同步。无 seed/reset/migrate/卷删除。数据集、历史版本/清单、周期产物保持一致。

验收期间已有一个工作区 revision 2→3，图表偏好也变化；本轮脚本未调用布局/偏好写接口，未覆盖这些变化，不宣称所有工作区哈希静止。一次并发图表请求触发 CancelledError；连接池超时和 HTTP500 均为 0，本轮验收请求全部成功。完整浏览器 UI 矩阵与长期稳定性未重跑。

持久启停：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`。完整私有依据与 API-only 回退材料：`/home/quant/repos/.mwa-observed-default-20261023`；回退需明确决定，仅用本轮 rollback-override.json 配合原 base，恢复 previous-candidate-override.json，不使用旧全栈回退。

本轮未推送、更新 PR、合并 main、创建 tag 或发布生产。
