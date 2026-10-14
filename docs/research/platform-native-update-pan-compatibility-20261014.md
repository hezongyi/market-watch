# 平台原生增量更新与无感历史拖动的兼容性

日期：2026-10-14。范围：v1.25.3 当前源码的只读分析；未改应用、未运行或改动生产。遵守根目录 `AGENTS.md`。本文不重复原生 API 契约研究。

## 结论

可以兼容。当前已经是连续原生序列：历史左侧由 `getBars` 和 native reserve 扩展，实时右侧由 `subscribeBars` 回调更新。两者共享原生 thread/cache。把平台正常更新恢复为增量路径，无须撤销历史缓存、预热、动态储备或多图联动；减少不必要的 reset/purge 反而能够减少中断历史读与破坏已加载缓存的机会。

这里“原生更新”指正常 bar 更新/追加通过原生回调，不指浏览器绕过后端直连供源。缓存未命中、供源边界及容量限制仍存在，不能保证无限历史、任意拖动速度均零等待。

## 必须保留的现有能力

| 能力 | 源码证据与兼容关系 |
| --- | --- |
| 原生历史请求及后端分页 | `advanced-host/bridge.js:1060–1070` 原样传递 `countBack/from/to`，由后端负责缓存政策和分页；`backend/alerts/provider_cache.py:605–646` 在一致快照内区分必需历史、指标前缀和可选额外历史。正常实时增量无须更改此路径。 |
| 动态左侧储备 | `advanced-host/native-reserve.js:43–51,72–89` 普通阈值 2 屏/批量 1 屏，快速拖动提高为 3 屏/批量 2 屏；优先把已有原生缓存提升为可见历史，并为指标保留前缀；没有独立重复 bar cache（文件开头）。 |
| PG 快速读和后台预热 | `backend/alerts/provider_cache.py:687–713` reserve 只读已证明连续的 PG 历史，miss/partial 激活现有预热，不能把空 miss 当历史终点。`743–758` 普通历史成功也建立供源 history interest。不能删 provider cache/worker/activate 来实现“直连”。 |
| 交互请求优先级 | `advanced-host/bridge.js:510–527` 优先 viewport、交互 historyCache 和必需历史，reserve 最多 2 路；维持普通请求 4 路限制。保留，避免后台预热挡住拖动。 |
| 连续导航、容量和旧请求隔离 | `advanced-host/native-navigation.js:25–29,347–406` 使用真实序列身份；当前 `chartWindow()` 为 undefined、`historical()` 为 false、`takeSeed()` 为 undefined，兼容分支不表示现行窗口切换架构。`46–72` 容量预算，`438–517` 旧 cache/source generation fencing 与回调接受前预算检查。 |
| 多图范围、间距及加载保护 | `advanced-host/range-sync.js:19–35` 在品种/周期加载时暂停同步到 dataReady；`advanced-host/viewports.js:152–235` 对真实数据边界和交易时段缺口协调范围，取消旧 generation。这些保护与 bar 增量分类不同，应保留。 |
| 指标前缀与稳定起点 | `advanced-host/native-reserve.js:83–89` 保留 warmup，`backend/alerts/provider_cache.py:767–788` 保持跨分页/实时的计算前缀及 origin，`advanced-host/indicator-coordinator.js:64–99,117–150,181–194` 绑定稳定计算身份和版本、拒绝旧结果。不能因拖动扩展价格历史就重置递归指标起点。 |

## 修改边界及潜在影响

1. 正常同时间更新/新时间追加目前已有实现：`advanced-host/bridge.js:100–119`。真正需要调整的是事件分类和 reset 判定；当前 `2540–2605` 的 reset 会清历史状态并进入 recovery。不能按 cache revision/确认状态变化就直接判定绘图历史变化，但真实旧 OHLC/volume/缺口修正仍需受控修复。
2. 每次历史分页接受后，`acceptMarketHistory` 扩展已接受的 first/last 并重新注册订阅（`bridge.js:361–380`）；`registerMarketBar` 发送 cursor、loaded_after/before、历史 revision/observed_at 并更新 generation（`206–225`）。不可删除这层协调。它把向左拖出的新增历史纳入修订关注范围，并隔离迟到 SSE。要验证分页期间实时尾部不丢失、旧 generation 不被采纳、订阅游标不倒退。
3. reserve 填充只追加左侧旧数据（`native-reserve.js:103–119`），真实 reset/purge 会换 cache 并取消在途读（`native-navigation.js:519–528`），所以减少正常 reset 对保留拖动缓存有利。异常恢复也要尊重现有 navigation/range/edge busy 检查（`bridge.js:1471`），不能把用户正在拖动的视图强行恢复到旧位置。
4. 原生 navigation 的 `admitCheckpoint`（`native-navigation.js:557–562`）是 undo/history 栈预算预检，不是 Supertrend 数值检查点；两者不要混同。Supertrend 修正仍须从受影响点之前的有效计算状态重新计算，不能只改最后值或随 viewport 改 origin。

## 验收边界

在 Ubuntu 隔离实例同时验证实时和历史，连续跨 10–15 个 M1 边界：普通/快速左拖、缩放、返回实时尾部、多图同步、带 Supertrend、reserve miss、断线重连、拖动中真实历史修正。对照修改前后的缓存保留、必需历史延迟、游标连续性、范围/间距、指标 origin，并用事件记录和视频确认普通新增 bar 不 reset/闪烁。真实冷历史仍允许有明确加载，真实历史修复允许必要恢复；本次源码分析不能替代该验收。
