# 原生连续历史候选验收

2026-10-05；独立 worktree `market-watch-chart-sync`，分支 `fix/native-chart-window-sync`，产品提交 `415ae61`（API/web 构建 `b3dd20c`）。人工验收待完成，未合并或发布生产。

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
| `mw-native-history-chart:415ae61` | `b55bf1e751185f655dd969cce1e3bc1d03724fe7b217a4b77c9ba41433bf5d03` |

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

后端 provider/task/Yahoo/chart/真实 PG 回归 164 passed；前端构建、原生 hook、导航、观察核实、历史 reset、视区测试通过。Standards/Spec 复核无新增阻断项。尚未覆盖：长时间全进程泄漏压力、所有 Binance/Yahoo/DST 组合、指标模板批量加载、低性能客户端最大负载。80,000 是本候选工程预算，不是所有这些组合的 SLA。

原始证据在 [2/4/8 图](verification/native-history/final-2-4-8.json)、[最终完整四图](verification/native-history/final-navigation-latest.json)、[冷任务](verification/native-history/cold-task-evidence.txt) 、[最终 2/8 图](verification/native-history/final-415ae61-2-8.json) 和 [hot profile](verification/native-history/hot-profile.txt)。私有目录保存失败轮次及截图，避免覆盖不通过记录。

## 人工核对与回退

1. EURUSD H4/W1/D1/M5，打开十字线与时间同步。在 D1/W1 点 2025-12-01 附近，M5 到相同时间；鼠标静止、仅移动、等待约 30 秒都不闪烁重建。
2. 加载中再点新目标、回最新、切周期或取消：旧结果不覆盖新日期，后续仍能正常操作。首次远历史可能等数十秒，显示真实加载状态。
3. 原生 MA/RSI/MACD 和 Python SMA、柱宽、价格轴、画线保持；按住拖动即响应，保存后重新打开仍保留。
4. 超过预算时有容量说明，原有图保留；在预算内继续导航可以恢复。不要把任意多年分钟历史当作本候选保证。

停止本项目即可结束验收；保留 PG volume 与旧 `16143/16144` 有限窗口比较实例。旧窗口候选未完整验收，不是生产回退。需要更换整套构建时先停止本项目 worker/消费者，再恢复匹配前后端及配置并重新打开 widget；不在运行图表中热切数据模式。不删除缓存，不触碰 `16243/16244` 其他项目或 Unraid。

最终 `415ae61` 组合另外通过严格范围覆盖与“加载中回最新”：旧公开 Promise 明确 `HISTORY_CANCELLED`，旧 Qf 应用按模型代次失效，延迟结果未改变最新视区；完整四图以及最终 2/8 图均无 JS 错误。
