# 新浪港股旧前复权日线诊断与修复建议

日期：2026-11-12。结论：已定位并离线验证可解决“整张图打不开”；不能据此恢复坏记录当天的真实价格。本轮只诊断、保存证据，没有改业务代码、部署或更新 PR #135。

## 基线与复现

- 工作树：`/home/quant/repos/market-watch-sina-hk-ohlc-20261112`。
- 分支：`docs/sina-hk-ohlc-diagnosis-20261112`。
- 基线：PR #135 的 `92fe075ba41988d2dcb0d6360145a5ad761e9674`，业务源码为开发实例已运行的 `833d1ccf`。
- 实际环境：Ubuntu quant-server 的 `mw-dev`，`https://192.168.7.232:18443`；没有修改 Unraid。
- 真实请求：`POST /api/charts/data`，`instrument=AKSHARE:430fea2075d156a988cc93abda28cb5e`、`series_kind=provider`、`timeframe=D1`、`limit=30`。返回 HTTP 422、0 bars，`NativeBarRow / Invalid OHLC extremes`。凭据仅从本机私有文件读取。

离线最小复现不依赖网络、数据库或凭据，约 1 秒：

```bash
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python \
  docs/research/evidence/sina-hk-ohlc-20261112/replay.py strict
# 当前代码预期失败：ValidationError / Invalid OHLC extremes

PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python \
  docs/research/evidence/sina-hk-ohlc-20261112/replay.py
# 当前已有显式隔离能力：2 条有效记录保留，2 条异常进入审计，正常 OHLCV 未变化。
```

## 原因与证据

最初依次核查：解码精度尾差、来源原始序列异常、复权因子/日期对齐异常。

00700 的 AKShare 新浪不复权数据共 5,513 条，有 15 条 OHLC 范围异常，其中 13 条仅为 0.00001 精度尾差；现有精度规则已覆盖这种尾差。前复权数据共 5,510 条，四位小数舍入后只剩两条明显异常：

| 日期 | 不复权开/高/低/收 | 前复权开/高/低/收 | 异常 |
|---|---|---|---|
| 2006-06-13 | 16.3 / 17.3 / 16.799 / 16.3 | 2.763 / 2.9325 / 2.8475 / 2.763 | 最低价高于开收盘；复权后偏差 0.0845，超出精度尾差范围 |
| 2009-01-01 | 50 / 49.5 / 49.5 / 50 | 8.5334 / 8.448 / 8.448 / 8.5334 | 最高价低于开收盘；成交量、成交额均为 0，日期为元旦 |

这些异常在复权之前已经存在，所以不能归咎于本次新增周期或单纯的复权计算。正复权因子不会把合法的大小关系翻转。本次尚未独立解码新浪压缩原文或取得交易所原始逐日记录，因此准确归因停留在“新浪经 AKShare 解码的来源记录已有异常”，不能进一步断言一定是新浪存档错误而非解码器问题。不能只凭 OHLC 约束推断应修改哪一个价格。

放大故障的本地原因位于 `backend/alerts/provider_akshare.py`：

1. `stock_hk_daily` 不接收日期范围，返回全历史。
2. `platform_page` 对该类来源以 `left=0` 获取和共享完整快照。
3. `AKShareHistory.native_page` 调用严格的 `parse_records`，任意一条无效柱都会抛错。
4. 截取用户需要的最近 30 根发生在全量校验之后，因此 2006 年坏记录也能阻断 2026 年图表。

不是最近 30 根全部坏了，也不是 CPU 或请求超时。v2.0.8 原代码已有相同失败，见上一轮的[基线对照](../verification/akshare-native-periods-20261112/sina-hk-baseline-comparison.json)。

## 影响面与可行性验证

同日抽查 4 个新浪港股前复权快照，按价格正数与 OHLC 范围约束统计：

| 品种 | SDK 返回条数 | 无效记录数 |
|---|---:|---:|
| 00700 腾讯控股 | 5,510 | 2 |
| 02318 中国平安 | 5,467 | 4 |
| 00941 中国移动 | 6,993 | 27 |
| 00005 汇丰控股 | 7,011 | 3 |

中国平安包含 2026-09-04 的开盘 57.3、最低 57.3、收盘 57.15，不能仅裁掉早年历史来绕过问题。这里只是代表样本，不推断整个港股目录的异常比例。[抽样证据](evidence/sina-hk-ohlc-20261112/hk-samples.json)。

调用已有 `parse_records(..., invalid_records=warnings)` 对 00700 全量回放：输入 5,510，正常输出 5,508，异常审计 2；正常 OHLCV 逐字段与输入相同，最新日为 2026-11-12。[全量验证摘要](evidence/sina-hk-ohlc-20261112/exclusion-feasibility.json)。此为离线可行性，实际平台路径尚未接入该策略，开发接口仍会报错。

## 建议的小补丁方案

优先恢复正常历史可读性，按记录隔离异常，并保留审计。不要提高精度容差来吞掉明显错误，不使用其他来源价格覆盖新浪前复权序列，也不按代码/日期硬编码排除名单。

范围限定旧新浪港股平台前复权 D1，不扩大到 A 股、期货、新原生入口或自建/组合历史。分类按 F1 保守执行：虽然已有审计格式可复用，但涉及已有来源读取策略和持久缓存，需要兼容验证。

拟修改位置与顺序：

1. `backend/alerts/provider_akshare.py`：只为该平台路径声明一个版本化的异常隔离参数，使共享来源缓存与原严格策略区分；保存 ticker、前复权口径和供应商 OHLCV 不变，不改全局 `RULES` 以免其他来源重建缓存。
2. 该参数对应的读取器显式传入 `invalid_records`，将坏记录原日期、OHLCV 和原因放进 `NativeCandleBatch.source_warnings`；现有 `source_history_store.py` 已能完整持久化、读取该审计封装，不需要新表或重写旧 blob。
3. `platform_page` 将审计传入已有 API 的 `source_warnings`；`backend/alerts/platform_catalog.py` / `akshare_catalog.py` 沿用已有 `quality_note`，明确来源个别日线无效、已排除且未补价。无需新增前端控件，具体元数据落点以当前目录组装为准。
4. 默认解析器仍严格。不能把网络失败、缺字段、因子不可用等情况笼统转成成功；全部记录无效时返回明确失败，避免缓存成正常空历史。
5. `backend/tests/test_provider_akshare.py` 增加上述真实坏记录回归：严格模式仍失败；平台隔离路径保留全部正常值、审计恰好包含坏记录；共享缓存命中后审计和 OHLCV 不变；旧身份和其他来源策略不变。按需复用现有 PostgreSQL 缓存测试。
6. 用户授权的开发实例复验 4 个样本：最近 30/80 根正常显示，历史翻页不阻断；API 审计包含错误日期；已有正常 A 股/期货、新八周期接口不回归；不新增定时任务或后台服务。

修复后的含义是正常 K 线恢复、坏记录当天无有效 K 线。真实坏价不能凭空修复；如需补全这些交易日，应另取得同来源可靠记录再修订，不能把另一供应商混入旧身份。任何依赖这些缺失日期的完整性结论都不能提升为完整。

停止条件：发现需要跨来源补价、修改旧持久行情、全局放宽价格约束或改变前复权口径时，保留证据并重新确定范围。仅数据隔离无此需要。后续实施不合并、不打 tag、不发布生产、不追踪 CI。
