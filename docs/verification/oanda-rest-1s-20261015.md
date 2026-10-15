# OANDA REST 每秒轮询与 12 品种批量取数验证

日期：2026-10-15（Asia/Singapore）。本文件保留原始 OANDA 接口探针的可复核证据；
探针运行来源为生产标签 `v1.25.4`，提交 `42b4864b0153ed4419c35d17f77241b163735ad4`。
当前实施工作树基线为 `v1.25.6` / `ee5b885626104577244f4fc40342d60b1a52c664`；
REST adapter、worker 和 candle-only 消费者已有局部实现，但系统验收尚未完成。

## 结论

OANDA REST 单品种每秒读取、12 品种每秒合并读取，都在本次短时验证中成功。
`GET /v3/accounts/{accountID}/candles/latest` 接受 CSV 格式的
`candleSpecifications`，例如 `EUR_USD:M1:B,GBP_USD:M1:B`。
实测每批返回 12 个品种，每品种两根最新蜡烛，包含最终确认、形成中状态及成交量。
原始探针运行时的生产后端尚未接入该批量接口；该历史证据不能替代当前工作树的系统验收，
也不能仅修改轮询参数就宣称完成 REST 迁移。

## 供应商与网络实测

Ubuntu 本机 Docker 独立 project `mw-oanda-rest-1s-20261015`，独立网络、PG14
数据库和卷，复用已核验的本地 `market-watch-api:v1.25.4` 镜像；该镜像只属于原始探针，
不代表当前 `v1.25.6` 工作树的验收镜像。
使用既有私有代理访问 OANDA practice，只发送只读行情 GET。
测试固定每秒一个起始时刻，单个连接复用；慢请求错过时刻就跳过，不补发追赶。

| 项目 | 单品种 candles，最近 3 根 | 12 品种 candles/latest 批量 |
|---|---:|---:|
| 持续时间 | 300 秒 | 120 秒 |
| 请求数 | 299 | 120 |
| HTTP 200 | 299/299 | 120/120 |
| 实际请求/秒 | 0.997 | 1.000 |
| 耗时中位数 | 302 ms | 295 ms |
| 耗时 P95 | 457 ms | 416 ms |
| 最大耗时 | 1,114 ms | 768 ms |
| 请求起始间隔中位数 | 1,000 ms | 1,000 ms |
| 响应正文平均大小 | 430 B | 3,694 B |
| 进程 CPU / 单核 | 0.148% | 0.140% |

批量返回品种为 EUR_USD、GBP_USD、USD_JPY、USD_CHF、AUD_USD、NZD_USD、USD_CAD、
EUR_JPY、GBP_JPY、EUR_GBP、AUD_JPY、XAU_USD。120 批全部覆盖这 12 个品种，
全部包含已确认柱和 volume。118 批中每个品种都有形成中柱；边界时另外 2 批有
部分品种尚未出现形成中柱，不应自行伪造它。

单品种跨 5 次分钟闭合，首次观察到 `complete=true` 在边界后约
1.50、2.47、2.64、1.63、1.69 秒。把同一响应序列每 15 秒取一个样本作模拟比较，
相应观察时间约为 12.49～12.71 秒；这不是另一个同时运行的真实 15 秒客户端。
批量跨 2 次闭合，共 24 个品种分钟确认，首次观察在边界后 1.26～2.32 秒。
以上是本机首次收到数据的时间，不能当作供应商发布时刻或长期延迟保证。

按 12 品种一批、每秒一批、24 小时不停运行计算，响应正文约 13.3 MB/小时、
319 MB/天（十进制），每天 86,400 次请求。正文大小不等于实际线速流量，
未计请求、响应头、TCP/TLS 开销及压缩差异。上述 CPU 只包含取数和解析；
不包含 12 序列写库、指标、SSE 和图表绘制。

## 现有后端的额外限制

1. 未改适配器的测试中，携带 `to=本机当前时间` 的部分请求得到 HTTP 400：
   `Invalid value specified for 'to'. Time is in the future`。
   同一环境不带 `to`、或回退 2 秒则成功。Ubuntu NTP 同步状态为 true，
   仍不能据此确定供应商/代理时钟差；没有修改主机时钟。
2. 仅在 HTTP 分页函数中把 `to` 回退 2 秒，外层缓存仍追赶较新的读取边界，
   会一次读取多次请求。本次诊断中固定每秒调度 91 秒，仅完成 41 次读取，
   却发起 163 次请求。该诊断探针不构成可采用的修复。
3. 再把读取边界与 HTTP 边界一起回退，在独立探针中设置轮询/缓存 1 秒、
   固定每秒读取 90 秒：完成 89 次调用，47 次 HTTP 请求全部成功，
   请求间隔中位数约 2 秒。缓存的有效期与取得租约/记录时间的偏移，
   使下一次整秒调用仍可能命中旧缓存，说明需要一起设计调度和失效时间。
   该取数进程 CPU 约占一核 1.43%，共 1,568 条 SQL；仍非完整图表负载。

因此，下一步应接入批量最新蜡烛、按账户和参数共享取数、明确每批截止时间，
并调整调度/缓存协作，避免慢请求堆积或重复追赶。历史分页、断线缺口修复仍需
单品种历史接口；最新两根不能替代 `getBars` 的全部历史请求。
组合的日历、价格类型、来源身份和固定确认输入需要保持一致，另行验收图表
换柱顺序、真实修订、指标以及 reset 行为。本次不证明它们已修复或不闪。

## 证据与复现

- [数值证据](oanda-rest-1s-20261015.json)
- [单品种及后端探针](../../scripts/verify_oanda_rest_1s.py)
- [批量探针](../../scripts/verify_oanda_rest_batch.py)
- [OANDA 批量接口及参数](https://developer.oanda.com/rest-live-v20/pricing-ep/)
- [CandleSpecification 格式](https://developer.oanda.com/rest-live-v20/pricing-df/)
- [官方限流](https://developer.oanda.com/rest-live-v20/development-guide/)

私有 Compose、环境、样本和数据库归档保存在 Ubuntu
`/home/quant/.local/state/mw-oanda-rest-1s-20261015`，权限受限，不提交仓库。
两个探针通过隔离容器内环境读取凭据，样本不记录价格、账号、token 或 URL。
隔离实例没有监听端口或网页地址；访问对象为 OANDA 行情接口。

```bash
docker compose -p mw-oanda-rest-1s-20261015 \
  -f /home/quant/.local/state/mw-oanda-rest-1s-20261015/compose.private.json up -d --no-build
docker compose -p mw-oanda-rest-1s-20261015 \
  -f /home/quant/.local/state/mw-oanda-rest-1s-20261015/compose.private.json stop
```

当前保存的私有 Compose 配置复现批量探针和最后一轮带读取边界保护的缓存探针。
完整单品种探针默认还会运行 5 分钟直接取数，再运行两种后端调度；环境变量
`OANDA_REST_SKIP_DIRECT`、`OANDA_REST_ONLY_CACHED`、`OANDA_REST_GUARD_TO`、
`OANDA_REST_GUARD_SCOPE` 控制诊断阶段，具体见源码。

验证结束已停止所有本任务容器。数据库已导出并实际恢复到隔离库，89 张 public
表的行数和全部内容 SHA256 一致。`mw-docker retire` 预览因复用正式镜像、
未登记匹配的 acceptance 构建任务而拒绝；未绕过该工具删除资源，容器和卷保留停止状态。

## 当前工作树系统验收（r5，2026-10-15）

上面的探针记录的是迁移前的网络事实；以下是当前工作树
`verify/oanda-rest-1s-20261015` 的独立 Ubuntu runtime 证据。运行镜像为
`market-watch-api:oanda-rest-batch-20261015-r5`，digest 为
`sha256:d1aba682529acc3038cd92703874084bd1a9c4b58424f745af833187cf3443de`。
未改变生产实例、生产配置或生产数据库。

验收主机为 **Ubuntu 本机 Docker**。当前独立 Compose project 为
`mw-oanda-rest-runtime-20261015`，实际入口为：API health
`http://127.0.0.1:18463/healthz`，带 TLS 的主站
`https://127.0.0.1:18472/`，独立 chart origin
`https://127.0.0.1:17444/`。私有 Compose 文件不入仓库，启动和停止命令为：

```bash
docker compose -f /tmp/mw-oanda-rest-runtime-compose-20261015-ui.json up -d --no-build
docker compose -f /tmp/mw-oanda-rest-runtime-compose-20261015-ui.json stop
```

该 project 使用独立 PG14 volume、网络、端口和只读行情配置；命令不会操作生产
Compose。停止后现场保留，未执行全局 prune 或删除 volume。

- 相关定向测试：变更核心套件 `105 passed`；组合/SSE/worker 回归套件
  `188 passed, 1 skipped`。Ruff 针对本次变更文件通过，compileall 和
  `git diff --check` 通过。
- `verify_oanda_rest_contract.py --seconds 120`：60/60 批次为 `data`，请求起始
  间隔中位数 2,000 ms，P95 2,000 ms，12 品种的 36 个已闭合 M1 与历史确认接口
  Decimal OHLCV 对比全部通过；首次确认延迟中位数 1,364 ms，P95 5,138 ms。
- runtime 现场 180 秒采样覆盖 12 个目标品种，全部保持 `connected/ready`；采样
  间隔中位数约 2,125 ms，最大约 2,226 ms。个别品种的供应商接收时间间隔曾达到
  10,054 ms，但没有写入 error，也没有追赶式请求堆积；该窗口保留为上游慢响应
  的独立抖动证据。
- r5 web 和 chart-origin 镜像均已构建；`VITE_ADVANCED_CHART_ORIGIN` 已编译为
  独立 chart origin。独立 TLS runtime 的 web、chart-origin、`range-sync.js` 和 API
  health smoke 均返回 HTTP 200。此项证明静态入口和反向代理可用；真实登录后的
  组合图表长时换柱、指标和 reset 行为仍需浏览器级验收。

证据文件：

- [r5 adapter contract](oanda-rest-1s-20261015-r5-contract.json)
- [r5 runtime window](oanda-rest-1s-20261015-r5-runtime.json)
- [r5 UI smoke](oanda-rest-1s-20261015-r5-ui.json)

## 当前 r7 验证增补（2026-10-15）

r7 使用 REST 实现 commit `a3088f53b90f870fc4ea99d4bf62aea3bba1aa36` 构建（后续仅补充验证文档），CI 基线修复提交为 `3b502eb8e159d51c8a05416c34c5ba8482987a15`；镜像用途为 Ubuntu Docker acceptance；没有切换生产配置、生产数据库或生产采集模式。隔离 preview 已实际启动并通过健康检查：

- task/project：`mw-oanda-rest-1s-20261015-r7`
- API/主站：`https://localhost:18493`
- chart origin：`https://localhost:17464`
- API 镜像：`sha256:ce8fbcd7bfba8ee64517be5af9d4538578a4a7b9eddb60b6013b43b7e93dcbbe`
- Web 镜像：`sha256:7f625f8f2137ff89b9fc4a8637efb94d9df29a978e60bbf7c04cb8c46d304ac6`
- chart 镜像：`sha256:ed3b3fe24b8f2f0671f499cba73fd669ad147bb2f0d4b7a7ebaf966e2dcb618d`
- PostgreSQL：14.24，JIT healthcheck 通过；preview seed 使用固定 D1 数据集

实际 smoke 结果：`/healthz`、`/readyz`、主站、chart origin、登录、`/api/session`、`/api/charts/catalog`、组合中心列表和组合候选列表均返回成功。预置数据库没有组合定义，因此真实供应商组合长时图表需要使用带私有 OANDA 配置的隔离运行时另行验收；本 preview 不发起真实供应商连接。

测试在 r7 API 容器内执行，避免使用主机安装环境：

```bash
docker exec mw-oanda-rest-1s-20261015-r7-api-1 \
  sh -lc 'PYTHONPATH=/app/backend pytest -q /tmp/mwtests/test_oanda_rest_batch.py /tmp/mwtests/test_oanda_worker_lifecycle.py /tmp/mwtests/test_market_stream_worker.py /tmp/mwtests/test_composite_quotes.py'
# 80 passed in 54.78s

docker exec mw-oanda-rest-1s-20261015-r7-api-1 \
  sh -lc 'PYTHONPATH=/app/backend:/tmp/mwtests pytest -q /tmp/mwtests/test_unified_sse_composite_fixture.py /tmp/mwtests/test_market_stream.py /tmp/mwtests/test_market_stream_api.py /tmp/mwtests/test_live_pricing.py /tmp/mwtests/test_composite_chart.py /tmp/mwtests/test_composite_series.py /tmp/mwtests/test_provider_cache.py /tmp/mwtests/test_provider_chart.py'
# 152 passed in 166.41s
```

preview 的启动/停止命令如下；状态目录和凭据仍只保存在 Ubuntu 本机私有目录，不进入仓库：

```bash
python3 deploy/ubuntu/mw_docker.py preview up \
  --task mw-oanda-rest-1s-20261015-r7 \
  --project mw-oanda-rest-1s-20261015-r7
python3 deploy/ubuntu/mw_docker.py preview stop \
  --task mw-oanda-rest-1s-20261015-r7 \
  --project mw-oanda-rest-1s-20261015-r7
```

这组证据证明当前 r7 镜像、共享 SSE、组合 fixture、REST candle 规范化和 worker 回归可运行；仍不证明生产切换、正式发布、浏览器级 15 分钟真实组合图表观察或长期供应商 SLA 已完成。

### r7 定向复核与 CI 失败分类

在同一个 r7 API 容器中追加执行了组合恢复、历史回放、指标计算和 PostgreSQL 需求并发检查：

修复提交后的定向结果为：

```text
test_alerts_mcp_migration.py + test_chart_alert_calculation_contract.py + test_history_replay.py: 34 passed
test_composite_recheck.py + test_composite_price_confirmation.py: 31 passed
test_market_demand_postgres.py::test_same_key_first_registration_commits_both_requests[data_sync]: 1 passed
test_health.py::test_catalog_fault_does_not_stop_import_or_report_false_success: 1 passed
```

此前 PR CI 的 31 项失败已逐项覆盖：迁移 head、provider chart calculation、组合恢复、worker health、history replay 兼容 seam，以及 market-demand PostgreSQL 并发 barrier。GitHub Actions 全量 backend run `38819011830` 已通过（`2395 passed, 11 skipped, 50 warnings`，约 11 分 57 秒），Web 和 Compose 同样通过；生产切换、正式 tag 和部署仍未执行。
