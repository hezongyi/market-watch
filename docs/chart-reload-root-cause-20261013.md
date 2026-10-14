# 生产 M1 跳动与 Supertrend 闪烁根因

2026-10-13，Ubuntu Chromium 访问正式生产页面，保留原有五图和自选表，阻止用户设置保存。只读生产 DB 使用 READ ONLY 事务；未修改或部署生产代码。

## 已确认的链路

LiveState 仅保存当前分钟 forming。下一分钟报价到来时，live_pricing.py:384 会替换上一分钟的 forming，但上一分钟通常还在等待 REST 确认。composite_series.py:163 清除旧临时输入，且 :184–185 只允许最近 15 秒的新鲜报价进入临时价格柱。跨分钟和报价间隔超过 15 秒都会使已显示的临时柱从返回窗口消失。

market_stream.py:299 将这种窗口删除判为 tail_retracted，bridge.js:2474 将 reset 视为整图历史修订，撤销指标结果、清空尾部时间游标并重读历史。随后 REST 确认原分钟并补入，它处于已加载的新柱之前，于是再次产生 history_changed 与整图重载。指标因此反复清空后恢复；游标归零与缩短尾部也具备回放旧柱的条件。

## 生产证据

150 秒定向采样两次复现相同顺序（新加坡时间）：

| 临时柱撤回 | REST 补回后的修订重载 |
|---|---|
| 14:38:13.247 tail_retracted | 14:38:18.069 history_changed |
| 14:39:05.443 tail_retracted | 14:39:08.007 history_changed |

第一轮重载前 Supertrend 数据 349 行，在 80.7 秒采样为 0，90.9 秒恢复为 340 行。第二轮在 131.5 秒采样为 0，随后恢复。采样无页面脚本或 HTTP 错误，SSE 未断开，结束后已登出。

只读确认：06:37 UTC 的分钟在结束后 17.358 秒获得 REST 确认；06:38 UTC 的分钟在结束后 6.982 秒确认。事件出现时临时窗口已经移除它们，几秒后固定输入修订增加并补回。原 10 分钟窗口中的分钟最终均有 REST 确认，多数在分钟结束后约 7–9 秒，不能把此现象归为来源真正缺 bar。

原窗口 M1 时间回退首次记录于 14:23:43 左右，同一分钟观测到最大报价间隔 19.688 秒。该窗口未捕获回退那一条逐事件原始载荷，因此不能声称已逐条证明该次回退的精确触发；本地真实读路径已证明超过 15 秒会让最新柱消失并返回更早的确认尾部，新采样证明同一重载链路在生产发生。

另一个显示放大因素：indicator-coordinator.js 每次普通尾部结果读取也发送 preparing，随后 ready；本次 150 秒共记录 preparing 46 次、ready 28 次。只有提示并不代表结果清空，必须结合 study rows=0 判定实际闪烁。

## 最小可重复诊断

backend/tests/test_chart_reload_diagnosis.py 使用真实报价发布与组合 chart_data 读路径，分别驱动跨分钟且 REST 未确认、报价年龄达到 16 秒。测试断言已经观察到的 M1 仍应保留为未确认观测，当前版本两个断言均稳定失败，运行约 1 秒。它是诊断红用例，修复尚未实施。

```bash
PYTHONPATH=backend /home/quant/repos/market-watch-production-pending-fixes-20261013/.venv/bin/python -m pytest backend/tests/test_chart_reload_diagnosis.py -q
```

生产事件摘要见 [trace-summary.json](verification/chart-reloads-20261013/trace-summary.json)。包含完整订阅与请求的原始数据仅保留在 /tmp 私有目录，没有提交。

## 建议修复范围

1. 为已实际观察到的临时分钟建立有界生命周期，跨分钟后等待 REST 确认时保留，仍明确 unconfirmed / observation incomplete；以同源、同账户、同世代的 REST 数据替换，不能伪装成完成柱或新增空分钟。
2. 行情新鲜度与观测数据留存分离。报价变旧时更新状态并限制实时告警使用，不因 15 秒无新报价删除已经观察到的历史 OHLC。
3. 普通临时柱更新／确认交接采用尾部替换和相应指标重算，避免整张图 reset；真实历史修订、来源变更仍须失效与恢复。
4. 已有有效结果的普通增量计算不反复显示首次准备提示；修订重算时保持旧值有效性语义，不能仅隐藏提示掩盖结果清空。

应在 Ubuntu 独立实例验证 M1 跨分钟、REST 延迟、16 秒无新报价、真正历史修订、来源世代变化与指标数值一致性，再安排生产发布。

## 原生指标接口与提示处理

当前 bridge.js:1988 配置 MWNativeIndicatorResults，:1993 注册 custom_indicators_getter。Supertrend 使用图表库 study 绘图、样式、填色、标签、参数和保存生命周期；数值由 Python 后端提供。native-indicator-results.js 通过固定 v31 构建的私有 study engine/result adapter 注入时间索引结果，并非图表库内置算法的公共计算接口，也不是 Pine 编译器。不能据此承诺任意场景 100% 等同内置指标；此次实测尤其否定了实时连续性的完全等价。

用户要求取消更新提示后，仅修改 AdvancedWorkspace.tsx：preparing 状态继续保留在内部，不再渲染通知；error 和重试入口继续显示。npm run build 通过，实际 JSX 使用 React 服务端渲染验证 preparing 输出为空、error 输出包含错误及重试按钮。本地 UI 修改尚未部署；临时柱生命周期根因尚未修复。
