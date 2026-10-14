# PR #62 审查修复及复审

实现基点 `5bc1745`。审查对象为 `b007a829...5bc1745`，新增修复为 `258d695..5bc1745`。正式站点没有部署，也没有执行合并。

## 问题及修复

1. P2：`acceptMarketHistory` 对最多 2048 条凭据分别调用 `bars.some()`，反复扫描历史页。改为对实际接收的柱一次构建 start 集合，再用 Set.has 筛选；仍先按原生 chart_time 确认接收，再按 ProviderBar.start 关联凭据。
2. 完整函数大历史复核发现相邻既有代码 `rememberIndicatorBinding` 将全部 start 展开为 Math.min/max 参数，200,000 根时抛出 RangeError。改为逐柱合并最小／最大值，保留旧范围、空页语义和完整历史。

## 验证及复审

- 原生回调 VM 回归新增 200,000 根、2048 条凭据、输入／历史范围检查，以及 chart_time 不同于 start 的部分接收场景。以 start 属性访问预算验证线性读取，不依赖机器速度或时间阈值：旧代码在 20,000 根时因重复扫描失败；只修扫描后 200,000 根在展开参数处失败；两处修复后完整回归通过。
- 订阅传输回归通过；均在 Ubuntu Docker 运行。规范与需求两轴只读复审，完整 PR 及新增修复未发现剩余合并阻碍。
- 前一审查已在同一后端实现跑过 PostgreSQL 接受确认和诊断回归，38 passed；本轮只改前端历史登记与边界计算，没有重跑不受影响的后端。
- Ubuntu Docker 中执行实际 acceptMarketHistory（包含 rememberIndicatorBinding、接收过滤、合并与范围登记）：4,000 根约 7 ms，20,000 根约 62 ms，200,000 根约 580 ms，均保留 2048 条凭据和完整起止范围。这是当前机器单次 Node VM 基准，非浏览器响应或供源延迟保证；旧嵌套筛选表达式的 200,000 根基准约 9,554 ms，仅作问题复现。
- 经 mw-docker 使用既有 development task/project `mw-native-update-20261014` 重建 chart，通过原生 reserve/toolset 构建校验；更新仅 Ubuntu 本机 chart 容器。运行镜像 ID 为 `sha256:a5ae2bd67e94b760df426f7710f32d0fe608870aecfb86416e3aa3a3a283be84`。容器和 worktree 的 bridge.js SHA256 均为 `906acc3b5217ff84f19d9e5416a54b6a95f46e8fca86e7bdfefc7d75904a0308`。
- 重建后 [真实原生图表验收](native-browser.json)：5 次正常交接 0 resetData，2 次真实历史更正触发 2 次 resetData；11 次接收确认成功、0 失败、0 页面异常。

Supertrend 无闪仍未验证。先前 [M1 15 分钟录屏](../main-sse-reset-m1-15m-20261014/README.md) 对应 `b4cd5ed`，本轮没有把那次录屏当作新增代码的 15 分钟验证，也未开展新的生产监测。

## Ubuntu 实例与复核命令

应用 `http://127.0.0.1:17443/advanced-charts`，图表 `http://127.0.0.1:17444/`；API 与 PostgreSQL 仅在任务网络。完整启动／停止命令见 [原生修复验收](../main-sse-reset-fix-20261014/README.md)。

```bash
sg docker -c 'docker exec -w /workspace/web mw-native-update-20261014-api-1 node tests/advanced-market-stream.cjs'
sg docker -c 'docker run --rm --name mw-native-update-20261014-review-transport --label task=mw-native-update-20261014 --label com.docker.compose.project=mw-native-update-20261014 --network none -v /home/quant/repos/market-watch-platform-native-update-20261014:/workspace:ro -v /home/quant/repos/market-watch/web/node_modules:/workspace/web/node_modules:ro -w /workspace/web node:22-bookworm-slim node tests/advanced-provider-subscriptions.cjs'
NODE_PATH=/home/quant/repos/market-watch/web/node_modules LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu NATIVE_RESET_EVIDENCE_DIR=/home/quant/.local/state/mw-native-update-20261014/pr62-review node web/tests/advanced-provider-reset-acceptance.browser.cjs
```

凭据、原始事件和失败截图只存于上述私有目录，不提交。没有退役资源或删除数据库。
