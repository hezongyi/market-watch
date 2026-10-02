# 原生历史跳转与双侧缓冲边界验证

研究日期：2026-10-02。当前许可库 v31.1；独立、连续 24×7 合成 M5 datafeed，无平台 API、数据库、产品代码修改、reset 或私有 API。

## 结论

**跳到过去之后，可以合法形成双侧已有历史，但“前缓冲 + 视区需求 + 后缓冲”不能直接作为每次 `getBars` 响应数量公式。** 原生 `countBack` 可能包含目标到现有缓存边界的整段历史；首个历史视区的 `to` 甚至仍指向当前日期。先满足这个真实需求，再附带更早的缓冲即可，较新侧往往已经被原生需求和现有缓存覆盖。

四组测试全部只返回时间 `< periodParams.to` 的 bar。跳转完成后向旧历史拖动、拖回、再越过原目标向较新历史拖动，三次实际移动均无新的 `getBars`。这验证了所加载双侧历史可实际使用；不是依赖浏览器独立缓存，也没有调用 reset。

**不建议为了凑“后 600/2000 根”而额外返回 `>=to` 的 bar。** 官方规定历史区间为 `[from,to)`；较新原生缓存若存在应保留利用。若实际 native 请求到某个较新边界，只能在该合法区间内满足需求，不能假设支持任意不连续历史拼接。[S1]

## 四个场景与实际数量

固定目标视区宽约 165 根，位于最新日期前 10000 根。cold/cache 是合成测试的数量预算，分别模拟用户建议的缓冲规模，不表示实际 PostgreSQL 冷暖状态。

| 场景 | 最新首屏 | 跳转/历史首请求 `countBack` | 额外更早缓冲 | 该请求实际返回 | 跳转后三次拖动新增历史请求 |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold：最新首屏后 `setVisibleRange` 跳转 | 174 + 600 = 774 | 9391 | 600 | 9991 | 0 |
| cached：最新首屏后跳转 | 174 + 3000 = 3174 | 6991 | 2000 | 8991 | 0 |
| cold：以公开 `timeframe` 直接打开历史视区 | 无独立最新首屏 | 10166 | 600 | 10766 | 0 |
| cached：直接打开历史视区 | 无独立最新首屏 | 10166 | 2000 | 12166 | 0 |

四组均无 `pageerror`，全部响应的 `hasAtOrAfterTo=false`。最新首屏的末 bar 为 `1790812500`，原生首请求 `to=1790812860`；synthetic feed 已知最新数据固定于 2026-10-01。

## 为什么右侧已经有数据

### 从最新首屏跳转

两组 `setVisibleRange` 目标均为 `1787763300..1787812800`。cold 组跳转请求的 `to=1790580600`，恰好是此前 774 根原生缓存的最早 bar；cached 组 `to=1789860600`，是此前 3174 根缓存的最早 bar。

原生请求填补目标与已有历史之间的间隙：cold 的 `countBack=9391`，cached 的 `countBack=6991`。返回连续历史、严格排除 `to` bar，因此与已有原生缓存相接而不重复。目标之后的历史由本次合法补齐区间和原来的最新缓存共同覆盖，远超“后 600/2000 根”。

所以加 600/2000 根的方向是更早历史方向，不能再机械加一次较新方向缓冲而把已有缓存 bar 重复交给库。已有历史带来的右侧覆盖应参与方案分析。

### 直接打开历史视区

公开构造参数 `timeframe:{from,to}` 指定过去的 165 根窗口时，原生请求 `from=1787763300`，但 `to=1790812860` 仍是最新日期，`countBack=10166`。这与当前本地 `.d.ts` 明确说明一致：历史 `timeframe` 范围仍请求至当前日期，以支持向前滚动。[L1]

这里不是只取目标附近的 165 根，而是原生要求从目标附近到当前的整段历史。满足请求后，较新方向本来就有很长的历史走廊。因此“冷 jump 前600 + countBack + 后600”里的 `countBack` 必须理解为原生真实需求，不能替换为当前一屏数量。

这也揭示成本：远距离跳转可能要求数千甚至更多 bar。测试用内存连续生成一次满足请求，不证明真实上游在固定时间内完成；平台页数、已有 PostgreSQL 覆盖和有限预热预算仍需按实际 API 行为处理。

现有 API 的 `limit` 和 `countBack` 上限为 20000，取数缓存层也校验 `count <= 20000`（`backend/alerts/chart_api.py:59`、`:61`，`backend/alerts/provider_cache.py:278`）。更远的原生跳转若需求超过该值，直接桥接可能触发既有 422 或根数限制；本轮四组最高 10166，没有验证更远边界，也没有修改此上限。

## 拖动观测

每个场景跳转加载完成后，执行三次真正的鼠标拖动：向旧历史、反向回到原目标、再向较新历史越过目标。固定 600 px 手势；因不同初始缩放，实际各约 86–91 根移动。

- `setVisibleRange` 两组最终目标范围为 `1787763300..1787812800`，柱距约 5.988；旧向移动后约 `1787736000..1787785800`，返回原目标后再较新向移动至 `1787790300..1787840100`。
- `timeframe` 两组初始实际可见范围略有边距差，为 `1787765400..1787812800`；三次手势同样改变范围且没有取数。

这些是已有原生序列可用的证据；本轮未逐帧计算空白，不能给出全程视觉连续的独立证明。所谓“立即左右移动”是跳转请求完成后立即进行，不承诺远跳本身无需等待，也不承诺无限连续拖动永不越界。

## 一项重要公开选项陷阱

`setVisibleRange(target,{percentRightMargin:0})` **并不等于无边距保持目标 `to`**。本地 `SetVisibleRangeOptions` 明确：设置 `applyDefaultRightMargin` 或 `percentRightMargin` 会忽略所传 `to`，用最新已载入 bar 的时间。[L2]

独立探路时此选项使范围锚定最新并大幅缩小柱距。正式四组结果已纠正为 `setVisibleRange(target)`，不传右侧边距选项；这不是原生跳转失败。产品实现若需要精确历史窗口，必须尊重该语义。

## 对用户数量方案的建议

- 最新 cold 首屏采用真实 `countBack + 600`、已有缓存首屏采用 `countBack + 3000`，可作为有限原生缓冲目标。
- 历史 jump 使用真实原生 `countBack`，cold 额外更早 600、cache 额外更早 2000；较新覆盖先由原生已载入区间及合法本次 `[from,to)` 响应判断。
- “后 600/2000 根”适合作为后端缓存覆盖目标，不宜固定加到任意历史回调里；若它们已在 native 历史序列中无需重复返回。若超出 native `to`，不能直接回传。
- 缓冲判断和数量预算仍应在 API 后取数层统一处理，datafeed保持桥接；native 真实 `countBack` 必须原样传递，不能用预设屏幕200根覆盖它。
- 本轮验证未比较 600/2000/3000 的最优内存或首屏成本，不把这些数量标为已性能验收。

## 可重复证据与来源

- [完整四组参数、响应范围、移动轨迹和限制](verification/native-history/additive-jump/results.json)
- [独立研究脚本](../web/tests/advanced-native-additive-jump.browser.cjs)
- [S1：官方 Datafeed API — Correct amount of data / unique chronological bars](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Datafeed-API/)
- [S2：官方 setVisibleRange](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.IChartWidgetApi/#setvisiblerange)
- L1：本地 `advanced-host/charting_library/charting_library.d.ts:4833`，公开 `timeframe` 历史范围请求到当前日期；许可源码不复制或提交。
- L2：同文件 `:20349`，`SetVisibleRangeOptions` 的 `to` 覆盖行为。

复现，工作目录 `web`：

```bash
LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu node tests/advanced-native-additive-jump.browser.cjs
```

默认输出 `/tmp/mw-native-additive-jump`；`NATIVE_ADDITIVE_OUTPUT` 可指定输出目录。结果附研究脚本 SHA256。合成 feed 只有 50 ms 人为回调延迟，24×7 连续时间，无指标、交易休市和实际提供方错误；结论限于公开 API 下的历史区间与双侧缓存可用性。
