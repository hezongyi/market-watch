# 验证记录

2026-10-23：按用户 `$mw-acceptance 更新到这个实例 进行验收` 授权，已更新既有 mwa 并完成本次 MCP 业务验收，结论通过。

## 实际运行候选

- Ubuntu 主机 `quant-server`，Compose project `mw-issue75-v2-20261018`。
- 网页 `https://192.168.7.232:18280`，Chart origin `https://192.168.7.232:18281`；MCP `http://127.0.0.1:18275/mcp`，连接名 `mw-a`。
- 仅替换 API，干净产品提交 `2a943eec6717e25e7a5c9b5cf236c19a0f2a6b91`，固定镜像 `sha256:9ca7a217ecf1b12a7de53d0dfb764019191e11ffddf4eeeeb7a62151595fc67f`。运行 actions/models/series_access 文件哈希与提交一致。
- 10 个 worker 及 Web 保留 `914525a`，Chart 保留 `b7ef7be`；固定指标引擎、存储和调度代码与保留的 worker 兼容。旧源码是候选祖先，此前连切/通知修复保留。
- 15 个服务 running，API/PostgreSQL healthy。实际环境值、挂载、资源、命令、网络及端口与更新前相同；仅 API 容器替换。
- 真实数据、配置、TLS、MCP/Yahoo 配置和数据库卷保留。保护浏览器 `mw-issue75-v2-browser` 的容器 ID/启动时间不变；另一登记名称 `mw-chart-time-browser-20261019` 在操作前已不存在，未创建。

## 真实 MCP 与业务证据

全部通过现有 localhost HTTP MCP，使用现有只读凭据。新建独立 HTTP cookie jar 登录网页接口核对，不读取或覆盖用户浏览器存储。未对真实库 seed/reset/migrate，未调用人工 indicator_tick。

| 验收项 | 实际结果 |
|---|---|
| 工具发现及权限 | 28 个只读工具；指标支持 managed/provider/composite/history，原通用报价/K 线仅 managed/provider |
| 明确旧历史版本 | EURUSD `63bc01d4-3943-45cc-93a5-b04c3caaab16`，与最新 `9de54312-dfec-42d8-b4c5-750d61965582` 不同；价格、版本和 checksum 均指向指定旧版本 |
| 同源计算依据 | 页级 input_manifest/历史 checksum、逐指标 input_evidence/calculation_origin、逐点 dependencies 和 K 线时间对齐 |
| 历史冷启动 | EMA19/RSI17 首次 pending；现有 history worker 自然完成，实际轮询观察 pending→complete，无浏览器需求或直接 tick |
| 全历史数值 | 4,984 根 H1，三页读取与 history_get_bars 完全相同；从版本起点独立读取/验块，再用 TA-Lib 批量 oracle 对照，EMA 766 个有效值、RSI 931 个有效值，最大绝对误差均 0；其他 null 全部一致 |
| 数值/网页等价 | 选择两项指标均非 null 的七根行情，真实 `/api/charts/data` 的价格、指标、依赖与计算依据匹配 MCP |
| 历史分页及输入 | UUID/MWH 大写规范化相同；UTC exclusive cursor 无重叠、复用原计算 run；完成但预热全 null 时 visible_complete=true |
| 历史错误 | 缺失版本返回 DATA_UNAVAILABLE；published、input_revision、类型冲突和 period=0 返回 INVALID_ARGUMENT，共 5 组 |
| 组合固定输入 | EURUSD 组合 revision `4c239291-470a-4554-90b1-ba13b2c7d331`、input_revision=1899；价格与 composite_get_bars 相同，指标依据指向相同组合修订/输入修订/历史版本 |
| 组合有效数值 | EMA7/RSI7 后台完成，七根共 14 个有效值、价格、依赖及依据与真实网页接口相同；MWC 标识规范化通过。EMA20/RSI14 的预热 null 及完成状态另行验证 |
| 原有接口 | provider EURUSD H1 价格/EMA7 使用相同七根行情，返回有效指标；报价、指标目录 10 项、系统状态和现有 MD 自建行情读取正常。无行情的旧 EURUSD managed ID 明确 DATA_UNAVAILABLE |

## 数据及现场保留

前后只读快照核对：数据集、12 个历史版本及 manifest/checksum、108 份周期产物、工作区内容/修订与偏好哈希全部一致。供应商 SourceFetch=219、HistoryRun=12 均未增加。FixedIndicatorRun 从 4678 增至 4767，包含本次请求创建的计算任务以及原现场继续运行的后台任务，不能将全部增量归因于本次调用。

MarketDemand 前后均 131 行，原保护浏览器继续续期，整表 hash 有变化；另对 history+composite 调用前后核对身份和目标完全相同。IndicatorDemand 由原浏览器继续调整，不宣称其整表不变。代码/自动化验证确认 MCP 不传 client/consumer、不创建市场需求或指标消费租约。没有停止现场浏览器来制造静态结果。

可提交脱敏证据见 [mwa-acceptance.json](mwa-acceptance.json)。完整协议返回、前后观察及操作资料保留在仓库外私有目录 `.mwa-mcp-history-indicators-20261023/`，不提交 headers、token、cookie、环境配置或原始 manifest 正文。

## 自动化与 CI

- Ubuntu Docker 首轮定向回归 **71 passed**；最终候选定向 **30 passed**；相关 Python 文件及验证脚本 Ruff 通过。
- 最终产品提交 `2a943ee` 的 [CI 全部成功](https://github.com/hezongyi/market-watch/actions/runs/39934964194)：后端 **2856 passed / 18 skipped**，工具链 **97 passed / 66 subtests**，额外 PostgreSQL **1+8 passed**；Web、Compose 和全部保护检查成功。
- 自动化协议验证另外覆盖 cold→partial→ready、无效参数原子拒绝、未发布/回收/无周期明确失败和新版本发布不替换指定版本。真实历史轮询未捕获 partial，不冒充观察到该状态；组合首轮曾观察 pending/partial/complete。

## 边界与运维

固定历史版本/周期须已发布。真实数据中的缺口或预热不足可返回 null，任务完成不等于每点有值。本次对 API/MCP 修改验证了真实图表 HTTP 等价，未重复执行完整图表 UI 操作矩阵；未修改真实版本来制造未发布/回收错误。无剩余本次业务阻断项，不包含跨调用复算协议或固定工作流。

持久运维入口：

```bash
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py status
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start
python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py stop
```

仅记录命令，本轮未停止验收实例。持久 overlay 已同步固定 API 镜像；精确 API-only 回退配置和更新前快照保留在本轮私有操作目录，异常回退需明确决定，不调用旧 manager 默认整栈回退。未 main 合并、打正式 tag、发布生产或删除永久数据。
