# REST 原生 M1 订阅无法加载

v1.25.7 已部署生产，生产采集仍为 stream。Ubuntu 独立生产副本运行 rest_batch 时，平台 EURUSD M1 首次加载失败，界面显示 `HISTORY_NO_PROGRESS`，无法开始 15 分钟观察。组合 M1 已开始真实更新，平台 M5/M15/M30/H1/H4/D1/W1/MN 浏览器加载通过；不能据此宣布 REST 迁移收口。

## 复现与原因

共享 REST 最新批量写入确认蜡烛的真实覆盖范围，形成中蜡烛不提供确认覆盖。当当前分钟已过去超过 freshness 容差，原生读取不接受相邻形成中柱作为可读尾部，随后进入 latest 取数。此时账号共享采集的门禁返回 HistoryPending，历史加载任务不执行分页，最终以未推进失败。

使用固定时钟、真实 ProviderDataset/ProviderInterest 和 native 数据读取入口，新增回归在修复前为 3 failed / 1 passed，修复后为 4 passed。用例覆盖当前柱可读但覆盖不扩大、冷历史继续分页、过期最新数据仍等待账号采集，以及中间缺口必须经过真实历史分页。

## 修复与边界

原生读取可以在确认覆盖末端读取相邻形成中蜡烛，但不扩大覆盖、不提升 complete。缺失的必需历史通过有界原生历史分页补齐；正常最新刷新仍由账号共享 worker 执行。数据已满足但最新观察过期时返回 pending，不启动第二个 latest 轮询。

F1：修改共享采集与原生历史的后台衔接；不改 schema、固定历史、账户或告警配置。最小检查：新增回归、provider cache/native history/REST worker 专项、真实 PG14、两轴 review，以及 Ubuntu 真实原生 M1 和组合长观察。生产启用 REST 必须等这些证据通过；v1.25.7 标签保持不变。
