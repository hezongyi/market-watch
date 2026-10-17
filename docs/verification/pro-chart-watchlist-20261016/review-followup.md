# PR #78 独立审查后续补丁

PR #78 已于 2026-10-16 合入 main（`8ae2eed`），CI backend/web/compose 全部通过；用户此前明确确认人工验收通过。独立审查与 CI 并行进行，审查结果在合并前已返回；主代理未及时明确提醒阻塞项，提醒晚于用户合并。这些是现有 CI 未覆盖的问题，本补丁针对这些边界补修，不代表已有人工验收覆盖所有异常路径。没有生产发布。

## 分类与范围

F1 / R2，沿用 Issue #73 的重要组合报价链路分类，无 schema、持久格式或采集策略变化。工作分支 `fix/issue73-review-followup-20261016`，复用同一任务的 Ubuntu 隔离 project `mw-issue73-real-20261016`；不使用其他任务或生产数据库。报价基准的兼容行为为：不能证明完整日收盘时保留最新价并省略涨跌，待真实完整产物发布后恢复。完整搜索/添加品种模型仍留后续。

## Standards

独立审查没有发现 AGENTS.md 硬性违规或值得扩大范围的代码气味。正确性观察：D1 完整覆盖未检查；不支持的库版本回退后 CSS 仍隐藏名称；32 条元数据分批超时可让启动等待约 32 秒。

## Spec

独立审查发现四项 P2：上标替换原生 Text 节点导致原生更新脱离页面或留下旧尾数；不完整日线被用作已确认基准；尚未发布的产物返回空结果被长期负缓存；库版本不匹配时名称门控不能释放。上述内容与 Standards 的部分正确性观察重合，两轴独立保留。

## 修正与针对性证据

- D1 基准必须 complete、coverage_complete、source_confirmed、time_closed 全部为真。稀疏历史 API 用例明确断言没有涨跌；新增不完整、无效数值与发布后恢复回归。不缓存 None，仅缓存有效固定输入基准。
- 上标用 CSS 单字符覆盖层绘制，保留原生 Text 节点及全文；原节点更新回归必须准确显示 `1.12340`，不再接受旧测试的 `1.123400`。覆盖层使用空替代文本，不加入复制/排序的文本节点。
- 库版本不匹配显式释放名称 CSS 门控；回到支持版本恢复保护。新增两个方向回归。
- 可选名称预热共用 4 秒预算、同一 AbortController 和 Promise.race，不再每批延长；回归覆盖 32 条慢项、取消、不合作的迟到响应和完整快路径。
- 将相关 bridge 与 Chromium DOM 回归加入 PR CI，避免只运行 web build 和指标用例即判定本补丁通过。

本地 backend 针对性检查 **27 passed**，Ruff 通过；startup 预算及 bridge 回归、web build、Chromium 名称与原生布局测试通过。二次 Standards 与 Spec review 均无剩余阻塞发现；Spec 审查者另独立重跑预热与 Chromium 测试通过。功能提交 `eab74f7` 的 PR CI backend（12m31s）/web（50s，含新增 Chromium）/compose（9s）全部通过；本证据提交后的 CI 仍以 PR 最新状态为准。

## 真实页面补验（2026-10-17）

00:12 UTC，真实表单登录，未拦截或注入行情。周末重启后 OANDA 平台报价返回暂不可用，四条 OANDA 平台行无价；此结果不作为 OANDA 有价详情、持续更新或全部来源通过的证据，根因未在本补丁中确定。组合真实已确认 M1 存量价为 1.12384；当前 D1 无完整基准，涨跌为空而不伪造。

从实际 Binance catalog 选取 BTCUSDT，临时原生列表取得真实价格 **81,572.66 → 81,572.67**，原始全文/aria、单字符上标、亮暗主题、悬停和移出检查通过，pageErrors 为空。临时列表已通过原生 API 删除，并轮询 preference 确认落库后再关闭浏览器；原活动列表、五条当前品种、原主题和原主图恢复。当前五条品种来自本轮开始时用户列表，不覆盖为先前包含 Dukascopy 的旧快照。

七张截图均逐张打开检查：[当前列表](review-real/01-current.png)、[EURUSD](review-real/02-eurusd.png)、[黄金](review-real/03-gold.png)、[真实 Binance](review-real/07-live-crypto.png)、[亮色悬停](review-real/04-theme-hover.png)、[移出与真实更新](review-real/05-theme-rest.png)、[恢复页面](review-real/06-restored.png)。[脱敏报价、原生文本、截图哈希与镜像引用](review-real/evidence.json)。OANDA 相关截图明确保留真实无价状态，不以空白数值判为成功。

三个候选镜像均由 mw-docker 构建，源码提交 `eab74f7`、dirty=false。仅在 Ubuntu project `mw-issue73-real-20261016` 更新 API/web/chart 及相应 worker；原候选配置保留在任务私有目录用于回退。无迁移、无生产发布。

页面仍为 <https://192.168.7.232:18483/advanced-charts>，原凭据保留。启动/停止：

```bash
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json up -d --no-build
docker compose -p mw-issue73-real-20261016 -f /tmp/mw-issue73-real/compose.json stop
```

永久真实复验脚本 `web/tests/advanced-watchlist-review-real.browser.cjs` 使用 MW_BASE、MW_CHART、MW_OUTPUT、MW_CREDENTIALS 显式指定本任务实例；不会伪造缺价。首轮曾错误要求休市重启后五行全部有价并超时，该失败未记为通过。

## 验收边界

当前没有完整证明最初计划中的键盘矩阵、quote p95/查询数、物理触屏、生产规模与长期稳定性；不标注为全覆盖。不据此推断生产发布授权。新 PR CI 与适用验收齐备后，在合并检查点等待用户决定。
