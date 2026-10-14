# 修复后 M1 连续 15 分钟观察

2026-10-14，用户要求再观察 15 分钟并检查 M1 闪屏。观察代码为 `b4cd5ed`；没有修改实现或部署生产。

## 结论与范围

在 Ubuntu 本机隔离实例内，正常 M1 换柱未再触发重复 reset，录屏未观察到 K 线瞬间清空。此结论仅适用于受控行情、单张 M1、无指标和拖动的本轮场景；正式站点仍未部署本次修复，不能据此宣称生产无闪。

时间为新加坡时间 **14:01:49.580–14:16:49.582**（UTC 06:01:49.580–06:16:49.582），实际持续 **900.002 秒**，不是加速交接。初始原生历史加载完成、接收确认成功并稳定 3 秒后开始观察。

受控供源仍用当前 development fixture：每真实 60 秒交接一次，第一次发生于观察开始后 30 秒，最后一次于 870 秒，留出 30 秒观察后续结果；价格、成交量和确认元数据三类交接各 5 次。每约 15 秒更新尾柱。本轮未注入真正历史更正，之前的更正恢复验证见 [修复验收](../main-sse-reset-fix-20261014/README.md)。供源柱时间是模拟时间，观察耗时是实际墙钟时间。fixture 不访问外部 OANDA/Yahoo，报价侧边栏缺少供源数据是隔离配置，不作报价功能验收。

## 数据与画面证据

| 项目 | 结果 |
| --- | --- |
| 正常 M1 换柱 | 15 次，全部进入主 SSE 和原生图表 |
| 尾柱更新 | 59 次 |
| 主 SSE bars 事件 | 74 次 |
| 接收确认 | 74 成功，0 失败 |
| SSE reset | 0 |
| 原生 resetData / resetCache / reloadHistory | 均为 0 |
| 页面 / HTTP / SSE 连接错误 | 均为 0 |
| 原生数据采样 | 8,406 次；0 空数据、0 未就绪 |
| 尾柱时间 | 16 个不同时间，0 回退 |
| 录屏解码 | 9,194 帧，10 Hz，919.4 秒 |
| K 线消失检测 | 0 次 |

[事件与数据结果](result.json)、[画面检测结果](video-analysis.json)、[交接结果](delivery-summary.json) 和 [原始证据哈希](sha256.json) 已保存。受控交接到原生图表的最大观测延迟为 2.779 秒，包含本机录屏负载，不代表真实供源延迟。

录屏在 1600×1000 Chromium 视口中采集。解码固定图表区域 x=80、y=150、1000×600，并缩至 250×150；统计红／绿 K 线像素。首次连续 1 秒显示 K 线后开始检测，以少于 500 像素标记清空候选。实际最小值为 **14,500**，没有候选。图表已显示的录屏覆盖 917 秒，包含完整观察窗口，并额外覆盖观察前后显示过程。人工查看开始、中段、结束帧确认裁剪区域与 K 线颜色。10 Hz 检测分辨率约 100 毫秒，不保证检出更短闪烁或局部细微重绘；结论使用“未观察到”。

## 运行与复核

实际运行主机是 Ubuntu Docker，Compose project/task 为 `mw-native-update-20261014`。API 使用只读当前源码挂载，web/chart 使用之前本任务构建镜像，PostgreSQL 使用独立 `native_reset_browser` schema。浏览器通过本机地址访问实际 HTTP、主 SSE、接受确认和许可原生图表：

- 应用：http://127.0.0.1:17443/advanced-charts
- 图表：http://127.0.0.1:17444/
- 后端与数据库仅在本任务 Docker 网络。

在本 worktree 启动／停止：

```bash
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml -f deploy/native-update/compose.acceptance.yaml up -d --no-build api web chart'
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml -f deploy/native-update/compose.acceptance.yaml stop api web chart'
```

完整事件、原生数据、私有脚本、录像和截图位于 `/home/quant/.local/state/mw-native-update-20261014/m1-monitor-15m/`，目录权限 0700；不提交凭据、会话、原始录像、截图或许可库。本轮保留既有隔离实例；没有 Unraid 发布、资源退役或数据库删除。
