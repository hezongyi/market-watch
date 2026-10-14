# 原生更新开发证据（进行中）

2026-10-14。Ubuntu 本机，基点 `b007a829`，分支 `fix/platform-native-update-20261014`，独立任务/project `mw-native-update-20261014`。尚未完成 A1/B，不作为生产或全面无闪验收。

## 已执行与结论

1. 实际 ProviderBar 提交 → `market_stream.delivery` 回放：仅 `complete:false→true` 的旧柱返回 `reset/history_changed`，预期不 reset 的测试失败；OHLC/volume 真更正检测通过。首次运行 **2 failed / 2 passed**（另一失败是尚未实现的分类日志），分类实现后 **1 failed / 3 passed**。保留失败用例，不 xfail 或降级期望。
2. A0 分类观测已实现，由 `ALERTS_PLATFORM_NATIVE_UPDATE_DIAGNOSTICS=true` 开启，默认关闭。成功提交后仅输出有限类别计数、volume 相对幅度桶、确认延迟桶、来源种类/周期/修订以及既有 SHA256 数据集引用（便于同源去重）；没有品种、账户、价格明细。回滚不发成功报告，拒收及删除分别计数。它是供源提交摘要，不能替代消费者接受凭据。
3. [15 个受控 M1 接续](a0-controlled-m1.json)：16 次插入、15 次 metadata 更新、30 次消费者观察，原策略 15 次 `history_changed`、15 次 bars。快照+delivery p50 8.753 ms / p95 15.770 ms，样本只用于该负载基线；不是 getBars、交互、冷/热分层或浏览器性能门槛通过。没有视频，不推断生产频率。
4. 平台价格/指标混版已复现：价格窗口取得后，另一个 PostgreSQL 连接修订输入，旧版价格/凭据配新版 Supertrend。失败用例已运行（1 failed）。修复在价格快照 `on_ready` 内冻结固定 origin 递归前缀，事务外计算；不再开启第二事务回读前缀。超过实际历史容量明确拒绝，不能截断 origin。
5. 修复回归：Supertrend/SWING × 普通/native 历史 × 快照内/外竞争，共 8 组 PostgreSQL 测试通过；观测/回滚/拒收/删除通过。供源 cache/service/PostgreSQL/history-window 联合运行 **92 passed, 3 deselected**（三个候选正常 reset 测试未纳入该次正确性回归）；随后新加固定前缀预算用例 **1 passed**。不得将 deselect 当作无闪通过。
6. 原有 native 共享流 VM 用例缺少加载 `composite-display-batches.js`，初次 ReferenceError；修正 harness 依赖后 generation/order、极值、quotes、无轮询、初始恢复测试通过。该用例只证明接口逻辑，不能证明 licensed native paint。
7. 加入前缀容量用例后的完整新回放 **1 failed / 14 passed**：仍失败的是 metadata 误 reset（A1 待修），其他两个实际 OHLC/volume 更正保持检测通过。没有隐藏失败或标记完成。

## 可重复命令和资源

所有测试在独立 Ubuntu Docker；私有配置 `/home/quant/.local/state/mw-native-update-20261014/tests.env`（0600）不提交。应用镜像通过 `sg docker -c 'mw-docker build --repo /home/quant/repos/market-watch-platform-native-update-20261014 --component api --tag market-watch-api:native-update-20261014 --task mw-native-update-20261014 --project mw-native-update-20261014 --purpose development'` 构建。测试挂载当前工作树只读，`PYTHONPATH=/workspace/backend`，因此执行的是当前代码，不是镜像内旧包。

在工作树执行：

```bash
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml up -d postgres --no-build'
# 全部新回放（预期仍有 metadata 误 reset 的红用例）
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml run --rm tests'
# A0 原策略摘要
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml run --rm tests python -m pytest -p no:cacheprovider backend/tests/test_native_update_diagnosis.py -k a0_fifteen -q -s'
# 已实现部分及现有供源回归
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml run --rm tests python -m pytest -p no:cacheprovider backend/tests/test_native_update_diagnosis.py backend/tests/test_provider_cache.py backend/tests/test_provider_service.py backend/tests/test_provider_postgres.py backend/tests/test_market_stream_history_windows.py -k "not previous_minute_requires_reset" -q'
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml run --rm tests node web/tests/advanced-market-stream.cjs'
# 停止本任务数据库，保留其数据卷（任务仍进行中，不 retire）
sg docker -c 'docker compose --env-file /home/quant/.local/state/mw-native-update-20261014/tests.env -p mw-native-update-20261014 -f deploy/native-update/compose.tests.yaml stop postgres'
```

目前只运行测试数据库，**没有对主机开放端口，没有 UI 验收地址**。Ubuntu web/chart 联合实例和启停方法仍需后续交付；没有新生产部署。

## 尚未证明的要求

| 要求 | 当前证据 / 下一步 |
| --- | --- |
| v3 分期与预算 | 文档已整理；数值候选尚未全部生效或复审 |
| 消费接受、区间账本/候选复核 | 尚未实现；优先建立成功回调后接受，页区间不得推广全局版本 |
| 正常 tail/append/metadata 零 reset | metadata 红用例仍失败；15 边界是旧策略基线 |
| 分页乱序/重叠/首次插入删除/消费延迟/世代 | source 删除已验证，完整消费者矩阵未执行 |
| 正常增量价格 token →指标同版提交 | 后端单请求同观察已修；主机同版 token、pending/拒收尚未闭合 |
| 组合与多图/拖动/预热不退化 | 部分已有供源历史回归通过；联合 native、指标、多图、拖动验收未执行 |
| B 冻结包/队列/容量/取消/画面连续 | 未实现；不得凭 reset 减少宣称完成 |
| A/B 独立服务端开关及切换 | 未实现；诊断开关不能代替它们 |
| 性能/4h/交易时段/浏览器资源指纹 | 未执行；只有小型受控快照+delivery 基线 |
| 视频、完整 Ubuntu UI 实例和 PR | 未交付 |

下一步是接受账本和候选复核，保留真更正普通恢复；不能只把 `revision>1` 改成源分类计数，也不能忽略旧 volume。整体目标保持进行中。
