# 超容量定位到真实边界验收（2026-10-05）

当前候选在 `fix/native-chart-window-sync` 独立 worktree，基线 `664dc57`。实现 [已授权方案](history-capacity-boundary-plan.md)：每个导航超限的图表分别定位到自身最早可显示的真实 bar，容量反馈统一进入右下角历史提示，不为该行为 reset 图表。未合并或发布生产。

**人工验收已通过（2026-10-05）：** 用户针对产品提交 `30dce45` 反馈“我验收感觉可以”，此前已确认“不闪烁，各项功能也正常”。原生连续历史实施及后续容量/边界/加载反馈范围的开发、自动验证与人工验收可以收口，无已知未解决阻断项。合并、推送及生产发布另行处理；当前实例继续保留用于复核。

收口依据：原EURUSD四周期超过20k需求成功、静止/hover光标及无无关重建；PG分页缓存与冷热复用；故障/取消/新目标及共享来源生命周期；既有真实价格/指标前缀修订、日历、模板、保存重开与受控资源压力证据；当前默认200k配置、分别超限定位、5秒/立即显示规则、累计量及跨批计时，均有相应验证和人工反馈。完整原功能矩阵使用较早匹配候选验证，最新边界/提示增量采用针对性的VM及真实四图专项；未宣称最终镜像重新执行全部供应商/周期矩阵。

## 行为及提示机制

原超额请求明确结束，随后按单源及工作区加权剩余预算执行独立补齐，每批最多 20,000 根，经原供应商历史任务与 PG 缓存路径加载。不是截断原请求冒充成功。容量耗尽后仍定位；降低阈值保留已有历史。指标预热影响最早可显示位置，因此反馈报告实际视区落点，而非底层缓存第一根。边界左对齐，避免居中时再次触发更老请求。未发起导航的同源 pane 不跟着强制移动；到不了的日期不伪装十字线成功同步。

普通加载提示由真正的 getBars 请求驱动，以请求 ID 和工作区 epoch 追踪排队、检查缓存、等待/补数、交付、原生处理阶段；原生回调后两个绘制帧收尾。持续超过约 5 秒才显示（超限结果及其相关请求详情立即显示）；完全依靠内存缓存定位时没有提示。按品种周期分组，多请求显示最近活动请求对应的根数、UTC 区间、真实页数/收到数量及耗时，不使用假百分比。短暂显示过的任务保留结束状态以减轻闪动。

容量边界操作另有持续结果：补齐中显示原因，完成后显示请求日期、实际到达日期、限制类型及已加载量；用户可以关闭或直接调整容量。新导航、来源变化及工作区切换清理相关结果。上游空页但未确认历史结束、错误或超时明确标注“现有数据边界；补齐未完成”，不称为容量极限。取消保留已提交缓存，清理预算、等待事件及旧导航；缓存对象、源代次、模型导航代次和工作区 epoch 均约束迟到任务。

容量默认仍为每源 200,000 根，用户设置 20,000–1,000,000；默认工作区加权 800,000，每 pane 权重 1、每指标增加 0.5。单源设置不能绕过加权总量、响应或后台任务保护。容量调低后 resident 可以大于新阈值，已有数据不删除，新增增长受限。

## 验证

- [最终边界多图与同源产品证据](verification/native-history/capacity-boundary-20261005/boundary-multi-shared-product.json)、[实际提示截图](verification/native-history/capacity-boundary-20261005/boundary-notice.png)：Ubuntu 隔离真实四图 W1/M5/H4/D1，每图 MA200/RSI/MACD：80,000 下点击 W1 2025-07-14，M5 补到实际 80,000 根，跳到 2025-09-09 01:15 UTC，点击到就绪 10.500 秒。该时间是本次缓存与原生指标组合的实测，不是固定日期或所有首次冷加载时长保证。
- 同次多图检查：调低至 20,000 后 M5 保留已有约 80,376 根，M5 和 M15 均定位到自身真实边界；M15 受工作区加权容量限制。两项结果都在右下角，没有容量 modal；结果持续显示、关闭、调整容量入口及后续 hover 检查通过。
- [提高容量与普通加载提示专项](verification/native-history/capacity-boundary-20261005/capacity-raise-loading-product.json)：80k 超限定位后，菜单提高到 200k，同一目标日期成功到达；热加载提示完整、降低容量保留缓存导航、同 iframe 工作区切换的提示/菜单隔离通过。最终偏好已恢复 200k。
- 最终镜像额外产品检查：两张 M5 共享来源，关闭时间同步后只在其中一张图请求更远日期，另一张图实际可见区间完全保持不变。
- VM 回归：剩余单源/加权预算补齐、无余量仍定位、取消后迟到数据不插入、同源新读不会竞争预留、未结束空页不谎称补齐、身份切换清除旧光标门槛、失败到 timer 之间 purge 不启动旧任务，均通过。
- [完整四图回归](verification/native-history/capacity-boundary-20261005/full-four-chart.json)：普通历史同步及 hover、busy/provider/timeout/capacity 注入后的恢复、加载取消、回最新、MA/RSI/MACD/Python SMA、按住拖动、画线、保存重开通过。容量补齐后固定日期已进入缓存，旧取消测试改为依据真实缓存起点选择未加载日期，并临时提高容量留出测试请求空间；重开前恢复默认值。保留 [前两次测试脚本失败记录](verification/native-history/capacity-boundary-20261005/regression-script-failures.json)，不将其冒充通过。
- 普通加载进度、历史 reset/修订区间、range guard、reserve 生命周期与并发优先级回归通过。前端及原生 assets Docker 构建通过。完整回归在 `3bb20b0ce033` 图表镜像运行，随后最终镜像只补充 purge/卸载后的结果清理；该增量有 VM 回归，边界产品专项使用最终镜像。
- Spec/Standards 复核提出的空页、竞争、事件清理、身份及延迟任务源代次问题均已修复，最终剩余发现 0。

原生同步处理大量 K 线仍有 CPU 与内存成本，绘制帧收尾不表示全部后台可选储备完成；取消无法中断已运行的同步 JavaScript 计算。此次没有新增真实供应商修订注入或全部周期/指标组合性能保证。

## 人工访问及管理

Ubuntu 本机 Docker，独立 project `mw-native-history-ubuntu-20261004`、网络及 PG volume；API/PG healthy。人工入口 **https://192.168.7.232:16343/advanced-charts**，独立图表来源 `16344`。登录沿用现有验收凭据。生产及 Unraid 未操作。

```bash
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml up -d'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml stop'
```

API 仍为容量候选，web/chart 更新后已 reload tls nginx。私有 `compose.pre-boundary-20261005.yaml` 保留此前组合；回退只处理本项目并 reload tls，不删除 PG volume。许可、登录、私钥与 env 不进入仓库。

| 镜像 | SHA256 |
| --- | --- |
| `mw-native-history-api:capacity-notice-20261005` | `fcb39f454ef71112d1c2cc3a699ca5791a73526c1805cfa8bfbff4e6e92f935a` |
| `mw-native-history-web:notice-operation-20261005` | `8bbbb13f156b926806798d2481706d40b9ae7097f13898adab64c2e0f84acb6d` |
| `mw-native-history-chart:notice-operation-20261005` | `057713ce4b6e280013d81e6af01b0c12e8665e3947746af050551036491642d1` |

人工核对：刷新后原四周期开启时间及十字线同步，先设置 80,000，再点 W1 2025-07-14。M5 应移动到自身边界；多个周期超限时各自移动。右下角核对请求/实际日期、限制及已加载量，关闭和调整容量可用。再提高容量重试，应能继续加载；已有历史范围仍能导航，hover 不应引起反复重建。验收后建议恢复默认 200,000。

## 5 秒门槛与页数估算增量

用户要求普通历史提示持续超过 5 秒才显示，超限立即显示；允许总缓存页数采用预估。本次请求按原生 countBack / 来源单页容量向上取整（OANDA/Yahoo 4,000、Binance 1,000），显示“本次新增缓存 N 页 / 预计总共约 M 页”。待补数时实际页数接近估算会向上调整，完成后显示实际新增缓存页数。该值不是整个 PG 库页数，也不是准确剩余页数或完成百分比：已有缓存、区间实际需求、指标前缀、短页及共享补数都可能改变数量；不影响后台加载或容量策略。

[浏览器提示时序](verification/native-history/notice-five-second-20261005/notice-timing.json) 验证 4.4 秒仍隐藏、5 秒后出现、超限关联详情立即出现及清理，使用可信 iframe 模拟消息，仅证明 UI 契约。[真实四图专项](verification/native-history/notice-five-second-20261005/four-chart-capacity-loading.json) 验证实际超限定位、提高容量继续加载、缓存导航及工作区切换通过。普通进度 VM 增加来源页容量估算与最终实际页数验证；构建通过。Ubuntu 已更新 web/chart 并 reload tls，偏好仍为 200k，私有旧组合保留 compose.pre-notice-5s-20261005.yaml。

## 整次边界补齐进度与计时修复

用户报告 EURUSD 每次都是 20,000 根/预计 5 页、等待计时不正确。确定性组件回归先实际失败：第二批已等待显示 5 秒，整次从起点已过 15 秒。根因是只展示最近 getBars 批次、起点跟随批次更换，且仅存在边界操作而没有活动请求时 ticker 停止。修复为原导航边界操作保存 start/finish、计划补齐量、累计实际补齐根数与已完成批次页数；在途批次按来源/操作 ID/批号加入累计页数，已归入操作的批次不再重复累计。整次时钟在批次间及原生定位期间继续，结束冻结耗时。当前批次仍标明最多 20k，不能把每批 5 页当总量。批次 `from` 是 countBack 补数的控制边界，原 1 秒区间显示容易误读；现在明确“从本批边界向更早历史补数”。

[浏览器时序证据](verification/native-history/notice-operation-20261005/operation-clock-ui.json) 确认无请求空档计时继续、整体 60k/15 页与当前批次分开、普通 5 秒门槛及超限立即显示仍通过。该项模拟可信 iframe 消息，不是供应商性能证据。[真实四图多批证据](verification/native-history/notice-operation-20261005/multi-batch-product.json) 中 M5 计划 29,657 根，分两批补齐 20,000+9,657，整体估算 8 页，开始时间一致且累计量单调，最终结果保持同一起点与 29,657 根累计量；PG 热命中，两批实际新增页数为 0。多周期边界、同源闲置 pane 保持视区、结果关闭与设置入口通过。加载模块验证冷任务实际页数可经结果/callback归入操作；hot 返回不计新增页。来源单页容量现在完整传到父级 loadNativeHistory，不再在父级构造 query 时丢失。组件、边界生命周期、普通加载与连续导航 VM 通过，镜像构建通过。

Ubuntu web/chart 已更新并 reload tls，API 未改、容量仍默认 200k；私有旧组合保留 compose.pre-notice-operation-20261005.yaml。整次汇总针对容量边界操作，普通原生 getBars 仍显示各自实际请求与请求等待时间，不声称任意多次原生调用共享一次业务跳转 ID。

真实产品初轮还发现指标预热 promotion 会引发后续超限 read，之前按新边界任务重置统计。最终镜像将相同模型导航代次下这段原生内部收尾沿用 start/total/loaded/pages/batch；新的用户导航仍失效旧操作，缓存 purge 不继承。VM 模拟 promotion 后超限，确认计时、40 根与两页累计保留；最终真实产品再次运行通过，完成结果不再归零。
