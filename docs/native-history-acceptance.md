# 原生连续历史候选验收

**后续候选（2026-10-05）：** 当前 Ubuntu 人工入口已更新为默认 200,000 根、可调容量与完整加载提示，且超限图表定位到自身实际最早边界；当前镜像及验证见 [边界验收](history-capacity-boundary-acceptance.md)，此前容量配置见 [容量与提示验收](history-capacity-loading-acceptance.md)。下文80k预算/旧镜像为之前候选记录，不能作为当前运行配置。

2026-10-05；独立 worktree `market-watch-chart-sync`，分支 `fix/native-chart-window-sync`，当前产品提交 `2468143`（API/web 构建 `b3dd20c`）。用户确认原闪烁已消失、各项功能正常；更远周 bar 容量提示仍在核查，未合并或发布生产。新增核验见 [逐项审计](native-history-completion-audit.md)。

## 访问与运行

- Ubuntu：`https://192.168.7.232:16343/advanced-charts`；图表资源：`https://192.168.7.232:16344/`。
- 自签证书；登录沿用该验收实例已有私有配置。凭据、TLS 私钥、许可库均不入库。
- Compose project：`mw-native-history-ubuntu-20261004`，私有配置 `/home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml`。独立网络、PG volume、DB `chart_sync`。业务通知关闭，只有专用历史 worker。Unraid 未改动。

Ubuntu 启停命令（停止保留 PG 缓存）：

```bash
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml up -d'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml stop'
```

API/chart 容器重建后须重载 web/TLS 的 nginx，避免旧容器地址仍在 nginx 中：

```bash
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml exec -T web nginx -s reload'
sg docker -c 'docker compose -f /home/quant/repos/.acceptance/native-history-implementation-20261004/compose.yaml exec -T tls nginx -s reload'
```

可复用脱敏 [Compose 模板](verification/native-history/compose.template.yaml)，私有环境需匹配数据库连接、许可与登录配置，不要直接复用生产目录或全局清理 Docker。

## 候选预算与镜像

[预算](verification/native-history/budget.json)：单源 80,000 根，工作区加权 260,000 根（每 pane 基础 1，每指标加 0.5，另计等待中的请求/指标），响应 32 MiB，任务 600 秒，80 页，最多 8 个任务。首先减少可选储备，必需量超限明确拒绝并保留有效图，不自动切窗。默认配置仍为 20,000，本候选预算没有修改生产。

| 镜像 | 镜像 ID SHA256 |
| --- | --- |
| `mw-native-history-api:b3dd20c` | `1696faa96a669be6f980d2ced2490f58feecb7f8d2de0777c62e5ac7f541da17` |
| `mw-native-history-web:b3dd20c` | `2ea7e5140b90042e5adc5d0dd175cde232a56d4a95b069f670dbaa96df71a570` |
| `mw-native-history-chart:2468143` | `37f44549ae5d1380b6c2546b2a6fb41ad56268b8a490770a0dbd781a04e8aaf2` |

web 镜像复用已构建 P3 前端；随后产品改动均在 API/chart，完整组合通过验收。原生 v31.1 补丁仍固定原始 SHA、唯一锚点和幂等检查；修改库后生成内容版本路径，旧 URL 与本候选不同。

## 实测与边界

共享参考机 4 CPU / 16 GiB；Chromium 153，1600×1000，真实 OANDA NY17 EURUSD。产品浏览器证据包括 HTTP、postMessage、bridge 和原生处理；heap 是原生 iframe 的 JS 堆，不能代表浏览器所有进程 RSS。

| 场景 | 点击至就绪 | 最大观测主线程长任务 | 原生 JS heap |
| --- | --- | --- | --- |
| 2 图 W1/M5 | 6.43 秒 | 0.87 秒 | 83.7 MiB |
| 4 图 W1/M5/H4/D1 | 5.72 秒 | 0.89 秒 | 88.4 MiB |
| 8 图混合周期，共享相同 M5 源 | 6.75 秒 | 1.92 秒 | 121.6 MiB |
| 4 图完整故障/指标/修订回归 | 5.12 秒 | 0.76 秒 | 76.0 MiB |

首次核心跳转实际运输约 6 万根、常驻约 6.5 万根；8 图数据源共享，所以不表示 8 个独立 8 万根来源通过。图表原生处理仍有短时阻塞，不能无限提高容量。

独立 PG schema 从零取真实 60,031 根 M5：16 页，48.18 秒；相同数据热读取 0.93～1.13 秒、12.79 MB；200 根请求含储备交付 1,200 根，0.046 秒、0.26 MB。历史 profile 约 4.4 秒，新候选同量热读取约 1 秒；并非严格相同负载的 benchmark。冷任务使用后台单页 worker，取消或进程退出保留已提交页；重启和消费者租约有模块回归。

完整四图验证：静止光标到 M5 正确、hover 不触发大走廊重建、busy/503 后下一操作恢复、旧公开范围导航取消、MA200/RSI/MACD/Python SMA200、画线、按住拖动、真实 PG 更正经 SSE/review 后一次重载、原生回调具体更正价格、历史视区与柱宽保留、保存重开指标/画线/视区保留。范围外更新及复核失败重试另有模块回归，不能扩大为所有供应商均完成产品验收。

后端 provider/task/Yahoo/chart/真实 PG 回归 164 passed；前端构建、原生 hook、导航、观察核实、历史 reset、视区测试通过。Standards/Spec 复核至 `2468143` 无新增阻断项。补充验证了指标模板恢复、输入修改、真实计算前缀更正、共享取消、6 轮 2/4/8 布局资源压力、实际浏览器内容版本缓存更新及 OANDA/Binance/Yahoo 的部分高周期日历。未把几分钟受控压力扩大成全天无泄漏、所有商品组合或低性能客户端最大负载保证。80,000 是本候选工程预算，不是所有组合的 SLA。

原始证据在 [2/4/8 图](verification/native-history/final-2-4-8.json)、[最终完整四图](verification/native-history/final-navigation-latest.json)、[冷任务](verification/native-history/cold-task-evidence.txt) 、[最终 2/8 图](verification/native-history/final-415ae61-2-8.json) 和 [hot profile](verification/native-history/hot-profile.txt)。私有目录保存失败轮次及截图，避免覆盖不通过记录。

## 人工核对与回退

1. EURUSD H4/W1/D1/M5，打开十字线与时间同步。在 D1/W1 点 2025-12-01 附近，M5 到相同时间；鼠标静止、仅移动、等待约 30 秒都不闪烁重建。
2. 加载中再点新目标、回最新、切周期或取消：旧结果不覆盖新日期，后续仍能正常操作。首次远历史可能等数十秒，显示真实加载状态。
3. 原生 MA/RSI/MACD 和 Python SMA、柱宽、价格轴、画线保持；按住拖动即响应，保存后重新打开仍保留。
4. 超过预算时有容量说明，原有图保留；在预算内继续导航可以恢复。不要把任意多年分钟历史当作本候选保证。

停止本项目即可结束验收；保留 PG volume 与旧 `16143/16144` 有限窗口比较实例。旧窗口候选未完整验收，不是生产回退。需要更换整套构建时先停止本项目 worker/消费者，再恢复匹配前后端及配置并重新打开 widget；不在运行图表中热切数据模式。不删除缓存，不触碰 `16243/16244` 其他项目或 Unraid。

最终 `415ae61` 组合另外通过严格范围覆盖与“加载中回最新”：旧公开 Promise 明确 `HISTORY_CANCELLED`，旧 Qf 应用按模型代次失效，延迟结果未改变最新视区；完整四图以及最终 2/8 图均无 JS 错误。

`a2f9004` 完整四图再次通过上述导航、故障、指标、价格及前缀修订、保存重开链路。该次热 PG 点击至就绪 6.69 秒；同 widget 已加载区间公开范围定位约 2 毫秒，没有后端历史读取（就绪检查另含约 0.5 秒测试等待）。独立空 PG 的完整产品首次四图加载约 44.27 秒，基于 `415ae61` 同一连续加载链路；不是后端冷任务耗时替代产品计时。

模板恢复曾绕过单指标插入准入，本轮已修复：首次应用、撤销、重做及 checkpoint 在修改前重新检查，宏命令累计各图预算。超额模板保持原图与指标；拒绝撤销保留原生 undo/redo 栈，之后仍可正常操作。真实浏览器、嵌套宏与双图组合模块回归分别归档，未把单图浏览器证据扩大为全部宏的产品矩阵。

冷产品验证额外项目 `mw-native-history-cold-product-20261005` 使用独立 PG volume 和 `16553/16554` 端口，完成后已停止、保留缓存；不作为人工验收入口。私有配置位于 `/home/quant/repos/.acceptance/native-history-cold-product-20261005/compose.yaml`，可按前述 `up -d` / `stop` 命令替换路径复跑。现有 `16343/16344` 验收项目继续运行。

补充真实交互审计发现关闭源图后仍保留它的光标时间；`97864b5` 清除该源在其他图上的重放记录，`2468143` 将身份初始化放到原生模型构造完成后的挂钩阶段。Ubuntu 人工项目已更新 chart 至 `2468143`，API/web 与容量配置保持原组合。新增 [真实交互证据](verification/native-history/supplemental-20261005/interactions-2468143.json) 包含原四图大请求与 hover、Alt+G 原生日期定位、关闭同步后无外部光标重绘、关闭 D1 源图并卸载后旧光标失效、九个支持周期及双 M5 范围同步。周期检查是真实供应商尾部导航，不代表全部跨周期同步组合。

`2468143` 的 [最终完整四图](verification/native-history/supplemental-20261005/final-2468143-full.json) 再次通过故障、导航、指标、价格/前缀修订、拖动和保存重开。该轮热 PG 点击至就绪 5.15 秒；同 widget 定位 3 毫秒、历史读取 0。仅真实修订触发一次重载，hover 无额外历史请求。修订试验数据已恢复，人工入口可继续使用；首次冷加载仍参考已有独立空 PG 产品测量，不用热耗时替代。

额外 [源身份及反向同步证据](verification/native-history/supplemental-20261005/interactions-source-identity-reverse-2468143.json)：M5 点击向高周期导航及静止标签、D1→H4 与 EURUSD→XAUUSD 源变更、双 M5 两方向范围同步通过。静止鼠标下源变更可由原生按新 bar 广播，核对新语义时间；不要求屏上光标全部清空。产品镜像不变，本次只补测试与证据。

用户已人工确认“不闪烁，各项功能也正常”。新增反馈是更远周 bar 超容量，单源上限仍为 80,000；2025-03-03 附近受控复现投影 M5 117,994，明确拒绝且可恢复。该日期未得到用户确认，见 [诊断记录](verification/native-history/supplemental-20261005/capacity-far-weekly-2468143.json)。需要扩大支持跨度时重新验证容量，原功能通过不作为任意远历史支持结论。
