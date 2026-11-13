# 黄金形成中柱缺失：定位记录

用户确认症状：右侧缺少正在形成的一根，历史 K 线正常。当前尚未修复或部署。用户提醒网页已有 `getBars` / `subscribeBars`；进一步核对确认手机已经复用，先前提出 M1 补柱过早，该选项已撤回，不改变数据口径。仍需确认用户实际查看的两端数据集身份，不能以同名 XAUUSD 代替身份匹配。

Ubuntu quant-server 隔离项目 `mw-android-personal-v205`，只读访问 <https://192.168.7.232:18445/m/>，未修改真实自选、告警、偏好，未操作 Unraid。浏览器使用实际许可 widget、手机触摸视口及 APK blob 导航回放，不代表 Android 真机验收。

## 复现与证据

2026-11-13 08:39–08:40 UTC，自选 XAUUSD 实际身份为 `MWP:DUKA:C2893271B856E9D2550CADC243BDF793`。

- H1 原生模型最后一根为 07:00–08:00 UTC，08:00 形成中柱缺失。
- M5 模型最后一根为 08:30–08:35 UTC，08:35 形成中柱缺失。
- HTTP 历史、SSE 推送和 widget 最后一根一致，均只有已结束柱。
- `rightOffset=10`，最新柱位于可见范围；预览覆盖层不存在。切回 H1 仍缺少当前柱。

脱敏记录与截图见 [chart-current-bar](chart-current-bar/)。实时复现脚本 `/tmp/mw-current-bar-probe.cjs`；对捕获的 H1 模型断言其时间戳等于当前 H1 桶，得到 `MISSING_FORMING_BAR`。真实上游是否有报价受交易时段和服务延迟影响，该断言用于本次已开市的诊断，不作为通用休市判断。

通过现有 SDK、既有 pooled transport 和共享请求预算直接核对 Dukascopy JSON3：H1 当前游标、下一小时游标以及正向游标，本次均止于 07:00 的已结束柱；M5 正向读取也止于上一根已结束柱。更换游标并未获得形成中柱。未将未完成历史自动认定为休市，也未切换数据源或合成价格。

## 排除前端过滤

`web/tests/chart-stream-native.browser.cjs` 补入 `complete:false` 的当前分钟新柱，并在相同时间戳再次更新。实际 datafeed、共享 SSE transport 和许可 widget 均能画出、更新该柱，时间戳保持正确；同时保留 supplier/composite 的 reset、切换、重连和旧世代拒收检查。命令在 `web/` 运行：

```bash
node tests/chart-stream-native.browser.cjs
```

结果 PASS。后端已有原生未完成柱解析检查：

```bash
PYTHONPATH=backend python -m pytest backend/tests/test_provider_dukascopy.py -q -k month_boundary_and_elapsed_status
```

结果 `1 passed, 23 deselected`。这些检查证明收到未完成柱时能够保留并显示，不证明当前 JSON3 接口会提供它。

## 网页与手机共用能力复核

两端共用 `advanced-host/chart-runtime.js` 中的 `getBars`（1539 行）和 `subscribeBars`（1795 行），由相同 `marketRuntime` 发送历史请求，由相同 `providerSubscriptions` 管理 SSE。手机 `MobileChart.tsx` 的 market-subscribe 分支传递原始订阅参数，并将回调继续交给同一 runtime。`provisional` 后端默认 True；本次没有发现手机单独关闭未完成柱的参数。

通过实际网页入口 `/advanced-charts/bar-parity-fixture`，在浏览器内提供临时工作区响应，选择与手机相同 Dukascopy 黄金 H1；所有工作区/偏好/通知写操作由浏览器路由截获并返回局部测试响应，未落服务器。数据、历史与订阅接口保持真实。两端均注册 `kind=bars, series_kind=provider, timeframe=H1, historical=false`，接受历史后的 cursor 均为 `1794553200000`。网页模型和收到的 SSE 也止于 07:00 已结束柱，网页未出现手机没有的形成中柱。当前证据只适用于本 Ubuntu 实例、这一数据集；不能推断用户其他服务器/来源/自建或组合品种的状态。网页记录及截图见 [parity](chart-current-bar/parity/)。

`getBars` 负责首次/历史数据，`subscribeBars` 将服务端新柱和同柱更新交给 widget；这两项能力已存在且已接入，但它们不会自动补出服务端没有发送的当前柱。因此下一步应先核准用户实际比较的数据集身份和部署版本，再沿现有链路定位；目前不应另建手机专用取数或 M1 合成逻辑。

未跑 CI、未更新 PR、未构建/替换镜像；当前运行版本仍是十字线尺寸修正版。
