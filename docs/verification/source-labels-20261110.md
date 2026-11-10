# 行情名称与来源统一

## 范围与验收约定

基线：`bc0b062c57c8307fe03781615f103c3e98d686c5`（main，PR #125）。

用户确认的展示顺序为：商品代码、商品名称、类型、具体来源、价格口径。

- 类型只显示“平台 / 自建 / 组合”。固定历史版本属于自建，版本身份与只读语义保留，详情、版本选择和报价时间仍可说明版本事实。
- 已知交易所前缀从展示代码移除：`SZSE:000001 → 000001`、`SHFE:RB0 → RB0`。保留前导零、期货月份、Yahoo `=F`、指数 `^` 和全部内部 ticker / 原始来源代码。
- 图表交易所图例默认隐藏；真实 exchange 字段仍用于原生元信息和交易时区。
- 来源统一为新浪（AKShare）、腾讯（AKShare）、Dukascopy、OANDA Practice、FXCM Demo、Binance Spot、Yahoo Finance。旧东方财富数据按保存身份展示，账户环境也按保存身份展示。
- 组合明确显示“历史：… → 实时：…”，从已绑定历史数据集和实时映射读取来源，不套用当前账户。
- 自定义名称保留；原生周期控件继续显示周期；Yahoo 延迟、历史数据时间、价格精度与成交量说明保留。
- 覆盖图表解析、商品搜索、自选表报价/初始元信息、平台目录、自建列表/创建/详情/引用，以及组合列表/分段详情。

示例：

```text
000001 · 平安银行 · 平台 · 新浪（AKShare） · 前复权
RB0 · 螺纹钢主力连续 · 平台 · 新浪（AKShare） · 原始价格
GC=F · 黄金期货（COMEX） · 平台 · Yahoo Finance · 来源价格
EURUSD · 欧元/美元 · 自建 · Dukascopy · 买价
EURUSD · 欧元/美元 · 组合 · 历史：Dukascopy → 实时：OANDA Practice · 买价
```

列表加载性能、入口收敛、新增供源组合能力不属于此次改动。

## 风险与最小检查

F0：兼容的 API 展示字段与 UI 改动，没有 schema、持久身份、采集、价格计算或生产行为变更。采用后端相关回归、原生运行时回归、前端完整构建、自审和 Ubuntu 轻量展示 smoke。

重点验证：短代码相同的新浪/腾讯仍有不同 ticker；前导零不丢失；固定历史仍保持原版本绑定；组合使用保存来源；Yahoo 延迟没有因新描述丢失；价格数值/精度不被展示逻辑改动。

## 本地检查

后端回归覆盖 presentation、symbol presentation、platform catalog、provider chart/AKShare、market data、series access/pagination、history catalog/reclamation、composite API 和 quote session contract。

```bash
PYTHONPATH=backend python -m pytest -q \
  backend/tests/test_market_presentation.py backend/tests/test_symbol_presentation.py \
  backend/tests/test_platform_catalog.py backend/tests/test_provider_chart.py \
  backend/tests/test_provider_akshare.py backend/tests/test_market_data.py \
  backend/tests/test_series_access.py backend/tests/test_series_search_pagination.py \
  backend/tests/test_history_catalog.py backend/tests/test_history_reclamation_impact.py \
  backend/tests/test_composite_api.py backend/tests/test_quote_session_contract.py
cd web
node tests/series-source-presentation.cjs
node tests/advanced-watchlist-metadata.cjs
node scripts/test-single-frontend.mjs --unit
```

完整 web 构建通过任务归属的 `mw-docker build`，使用本机固定许可库；许可库和构建产物均不提交。

## Ubuntu 展示 smoke

主机：Ubuntu `quant` 工作区所在主机（实际 hostname `quant-server`）。

- Compose project / task：`mw-source-labels-20261110`。
- 静态候选：`http://127.0.0.1:19657/`，单个 Nginx 服务，上限 128 MiB / 0.1 CPU，无数据库。
- 启动：`docker compose -p mw-source-labels-20261110 -f artifacts/source-labels/compose.json up -d --no-build`。
- 停止：`docker compose -p mw-source-labels-20261110 -f artifacts/source-labels/compose.json stop`。
- 私有运行材料在本任务 ignored `artifacts/source-labels/`，浏览器截图与测试 fixture 在 `/tmp/mw-source-labels-20261110/` 及同名前缀临时文件。

启动前盘点约 11 GiB 可用磁盘、5 GiB 可用内存；现有 mw-dev 和其他任务实例均保留。完整 preview 要求至少 23 GiB，故此次采用静态候选 + 独立 SQLite 测试数据的展示 smoke。

Playwriter 真实登录开发服务 `https://192.168.7.232:18443/`，只在本任务浏览器标签将静态资源路由到候选。后端元信息由本分支在独立 SQLite 生成，浏览器请求使用 fixture；工作区写入被浏览器拦截，未保存 fixture 到开发数据库。核对平台（新浪、腾讯、国内连续期货、Binance、Yahoo 期货）、自建、固定版本自建、组合图表及数据中心组合列表的显示。

边界：该 smoke 验证真实原生图表和 React UI 的展示，不等价于独立完整服务的生产规模、供源实时性或数据迁移验收。开发服务代码和生产服务均未更新。

## 原生价格口径一致性修正

CI 的注册/解析一致性回归发现：OANDA 原生配置覆盖 `basis` 后，配置接口仍保留默认买价展示，解析接口重新计算后则显示实际价格口径。`native_series.configured_metadata` 现在在参数覆盖完成后调用统一 `present`，不改变价格参数、来源身份和注册行为。

原有端到端注册测试覆盖买价、卖价、中间价，同时保留注册幂等、解析结果完全相等、账户隔离及无采集需求的断言。修正前原测试可稳定复现；修正后 native-series、presentation、provider-chart、series-access、platform-catalog、history-catalog 共 174 项回归通过，Ruff 与 diff 检查通过。
