# 超容量定位到真实边界验收（2026-10-05）

当前候选在 `fix/native-chart-window-sync` 独立 worktree，基线 `664dc57`。实现 [已授权方案](history-capacity-boundary-plan.md)：每个导航超限的图表分别定位到自身最早可显示的真实 bar，容量反馈统一进入右下角历史提示，不为该行为 reset 图表。未合并或发布生产。

## 行为及提示机制

原超额请求明确结束，随后按单源及工作区加权剩余预算执行独立补齐，每批最多 20,000 根，经原供应商历史任务与 PG 缓存路径加载。不是截断原请求冒充成功。容量耗尽后仍定位；降低阈值保留已有历史。指标预热影响最早可显示位置，因此反馈报告实际视区落点，而非底层缓存第一根。边界左对齐，避免居中时再次触发更老请求。未发起导航的同源 pane 不跟着强制移动；到不了的日期不伪装十字线成功同步。

普通加载提示由真正的 getBars 请求驱动，以请求 ID 和工作区 epoch 追踪排队、检查缓存、等待/补数、交付、原生处理阶段；原生回调后两个绘制帧收尾。持续超过约 250ms 才显示；完全依靠内存缓存定位时没有提示。按品种周期分组，多请求显示最近活动请求对应的根数、UTC 区间、真实页数/收到数量及耗时，不使用假百分比。短暂显示过的任务保留结束状态以减轻闪动。

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
| `mw-native-history-web:boundary-20261005` | `44ecff1ba2ddeb21dc7e2461e2ec50e3f31684dc5f4087d4516f14b037b463ef` |
| `mw-native-history-chart:boundary-20261005` | `1593fa7bf1719716f3ac8a36c21a85df32d598c7ae1cfc789e34efe621d8e0cd` |

人工核对：刷新后原四周期开启时间及十字线同步，先设置 80,000，再点 W1 2025-07-14。M5 应移动到自身边界；多个周期超限时各自移动。右下角核对请求/实际日期、限制及已加载量，关闭和调整容量可用。再提高容量重试，应能继续加载；已有历史范围仍能导航，hover 不应引起反复重建。验收后建议恢复默认 200,000。
