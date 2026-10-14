# 主 SSE 重复 history_changed 修复

2026-10-14。用户认可 [10 分钟生产监测](../main-sse-reset-monitor-20261014/README.md) 后授权修复。分支 `fix/main-sse-repeat-reset-20261014`，Ubuntu 独立 worktree/project/task `mw-native-update-20261014`；未部署正式站点。本轮限定平台主 SSE 的已接受尾柱确认重复 reset，不关闭旧 provider SSE，不声称完整 v3 A1/B 已完成。

## 行为与边界

HTTP 平台历史返回按柱的原生 OHLC、合法 volume、chart_time 指纹；原生历史回调成功后才登记。主 SSE 返回同样的有界凭据；原生实时回调成功后，host 经 parent 发送 `/api/charts/stream/accept`。单纯 EventSource 收到消息、旧世代、已取消订阅、返回 false／抛异常的回调不产生接受确认。

后端验证会话、client/listener、generation、result_epoch、sequence，并对照已提交 MarketStreamResult（首次绑定必要时用同 sequence 的完整 snapshot），不拿当前可变 ProviderBar 生成旧结果的接受证明。每柱的 sequence 防止迟到 ack 覆盖新值；重连登记保留新接受凭据，各消费者独立。历史检查仍保留 HTTP observed_at，对变动候选逐柱比较已接受指纹；不推进全图观察时间。已交付的确认交接不再触发重复 reset，真正不同的旧柱价格／成交量／时间标签、未接受的修订及删除仍恢复。

主价格指纹不包括 complete／volume_complete，因此仅确认元数据变化不重置。直接 Python study 订阅额外包含确认／覆盖依赖，不能用价格指纹豁免指标输入变化。该指纹是消费接受凭据，不是完整冻结恢复包或普通增量指标 token 协议。

当前每消费者保留最多 **2048** 根凭据，实时接受批次最多 **128** 根；超过候选比较预算、凭据缺失／结果淘汰／ack 失败采用原恢复，不忽略历史更正，不裁剪已加载图表。该预算不是 v3 候选全窗口账本已落地的声明；长期性能和长历史覆盖需要后续评估。

## 验证

- 先运行 PostgreSQL 提交 → durable result → consumer → ack 的新回归，旧实现失败（没有接受协议）；随后实现后通过。原 metadata-only 红用例现在用真实已接受 HTTP 页的指纹，OHLC／volume 真修订期望保持不变。
- 相关后端回归 **134 passed**：原生历史、平台 cache/service、主流历史窗口、API/worker/IO，以及新接受链（当时 21 个用例）。
- 独立 PostgreSQL 主流合同及接受链 **68 passed**；和前一组部分重叠，不累计宣称唯一用例总数。
- 最终接受链 **23 passed**：M1/M5/H4 × 同价／价格／volume 确认，ack 前并发同柱价格/volume 修订，其他旧柱更正、删除、未接受，generation/epoch/错误指纹/sequence/会话隔离，乱序 ack／重连，15 个连续边界，真实 HTTP auth/CSRF，两个共享同一 task 的独立消费者。
- host VM 与 providerSubscriptions transport 回归通过：成功回调才 ack，拒收／异常／旧世代不 ack，重连保留凭据。
- `mw-docker` 前端构建通过 TypeScript 与 Vite；chart 构建通过既有 licensed reserve/toolset 校验。
- [真实原生图表](native-browser.json)：Ubuntu Docker 内受控供源、实际 PostgreSQL、已构建 web/chart、真实 HTTP/SSE/原生缓存。5 次加速正常分钟交接（metadata/价格/volume）及每次之后的下一轮尾柱更新，**0 次 resetData**；注入前一根 close 更正及其他旧柱 volume 更正，**2 次 resetData**；11 次 ack 均成功，零 pageerror。整理可重复脚本后再次执行同样通过。

后续完成了 [M1 连续 15 分钟观察及录屏](../main-sse-reset-m1-15m-20261014/README.md)：Ubuntu 受控供源按真实 60 秒交接，15 次换柱、74 次接收确认，0 reset、0 原生重置、0 数据清空；录屏 10 Hz 解码未观察到 K 线消失。未进行修复后的生产监测，不把受控单图结果称为生产或全面无闪验收。组合 K 线逻辑未改，既有共享合同回归通过；指标、多图/拖动/预热联合长期验收及更正恢复画面连续仍不在本次证据范围。

## Ubuntu 本机隔离实例

- 应用：http://127.0.0.1:17443/advanced-charts
- 图表：http://127.0.0.1:17444/
- API/PG 只在本任务 Docker 网络，不发布端口。
- 当前受控行情页面保留运行；测试凭据 `/home/quant/.local/state/mw-native-update-20261014/browser-acceptance/credentials.private.json`，0600、仅在私有目录，不提交。此实例没有真实供源账号、不会外发通知。
- `fixture.py` 仅由下面 development Compose 使用，替代供源 IO、以独立 `native_reset_browser` schema 验证当前源码；不是应用生产入口。应用使用已有任务 API 镜像并以只读源码挂载覆盖当前模块。web/chart 镜像均经本任务 `mw-docker` 构建。

启动／停止（在本 worktree）：

```bash
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml -f deploy/native-update/compose.acceptance.yaml up -d --no-build api web chart'
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml -f deploy/native-update/compose.acceptance.yaml stop api web chart'
```

复现接受链和原生图表：

```bash
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml -f deploy/native-update/compose.acceptance.yaml run --rm tests python -m pytest -p no:cacheprovider backend/tests/test_provider_stream_acceptance.py -q'
NODE_PATH=/home/quant/repos/market-watch/web/node_modules LD_LIBRARY_PATH=/home/quant/.local/share/playwright-deps-jammy/usr/lib/x86_64-linux-gnu node web/tests/advanced-provider-reset-acceptance.browser.cjs
```

完整浏览器事件、会话、原始图表数据仅存私有目录。没有新生产镜像、发布或 Unraid 配置变更，没有退役任务或删除数据库。
