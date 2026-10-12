# ATR 阈值实现与 Ubuntu 验收

日期：2026-10-12。实施目录 `/home/quant/repos/market-watch-atr-offset-20261012`，分支 `feat/atr-offset-alert-20261012`。需求见[实施契约](atr-offset-alert-plan-20261012.md)和[研究依据](research/atr-trendline-breakout-threshold-20261012.md)。

## 基线与实现

起始基线为 `cbd0477e2848a252f2e4490a1b56e35b1894a73b`。收尾 fetch 发现 PR #52 已合并；已无冲突快进到 `origin/main=463b863482a908c3d7317f5e191e4f291f1a6d4a`，保留本次全部未提交修改。该基线包含 Swing、UX 与 Python Supertrend；ATR offset 没有扩大普通告警指标白名单。

- 可空 `Condition.offset`；默认关闭，开启预填 D1/14/0.2。校验价格单位、四种方向、周期、整数长度和有限正乘数。缺失/null offset 保持旧请求 hash。
- 共享偏移模块复用 Wilder `IndicatorState`，按判定柱开盘前最近预期完整收盘柱取值。缺失/未确认时等待，不能跳到更旧参考；当根盘中及最终收盘固定。
- 普通 managed/provider 独立绑定 ATR 起点和第二 dataset。固定起点向前分批初始化，每页 2048 源柱（聚合按完整目标桶）；持久检查点保证重启后增量计算。
- 数据库 count/revision 摘要先检测历史变化；变化后以流式价格摘要核对，成交量/观察元数据不误阻断。正常轮次只追加新价格摘要。provider 未变化重读使用保留的 changed_at，避免将 overlap 重读时间当首次价格确认。
- 只换算上一右值的偏移差，不插入虚构观察。消费、计数、偏移证据、信号及 Outbox 同一锁/事务提交。断线、缺口、确认延迟或修订恢复建立基准，保留计数和历史事件。
- provider 第二周期轮询按 dataset 去重，主周期 fresh 不阻止 ATR 需求；active/paused 清理保护覆盖第二 dataset。managed 仅请求既有批准历史的发布，不扩大下载范围。
- composite 使用固定 revision/history/input revision 的聚合及指标输出，独立检查 ATR 水位和初始化；保留接缝策略。派生计算等待与输入缺失区分处理。
- 实际原生 React 创建/编辑控件、列表/事件快照和通知显示 ATR、原目标、有符号偏移与实际边界；画线更新保持 offset。补修共享 dataset_for 对 GeometryQuery 不存在 condition 字段的访问。

## 验证证据

PR #54 修复与两轴复审已完成，最新证据见[修复与最终复审](verification/atr-offset-20261012/review-fixes/README.md)。确认时间现在与读取/成交量元数据独立，普通与 composite 路径检查完整 ATR 递归前缀的真实可用时间；旧 checkpoint 安全重建。新增 as46 可空迁移已在实例执行。最新扩展回归 328 passed / 1 skipped、ATR 67 passed、真实 PostgreSQL 151 passed及追加 5 项补验；完整浏览器和 11 张截图逐图审阅通过，三项 P1 关闭，无新增阻塞。下文保留初次验收的数字和时间来源。

证据目录：[verification/atr-offset-20261012](verification/atr-offset-20261012/README.md)。本机扩展回归 277 passed / 1 skipped（跳过项需要 PostgreSQL），另追加 NY17 完整 worker 夹具 1 passed；包括新基线 Supertrend 与 fixed-indicator 回归。Node bridge/RPC 10 passed；Ruff 和 diff check 通过。新基线三个 Docker 镜像构建通过，Web 构建含既有 bundle 大小提示。

ATR 合同覆盖刷新不误报和首笔不漏、上下方向严格相等、水平/趋势/对数/SMA目标、原目标运动语义、跨周期与共享收盘边界、固定起点/增量/Wilder 对照、缺口/确认延迟/修订、volume-only、旧幂等、事务回滚及并发消费。

真实 PostgreSQL 在独立 PG14 数据库的唯一 schema 内验证，包含迁移、锁竞争、事务回滚、provider 保留、published、跨周期 composite 水位/修订、连续接缝拒绝与显式接受、NY17/DST 周末及确认时点。最终 Docker 99 passed，无 PostgreSQL 跳过；浏览器结果见证据 README。

浏览器不拦截 API 请求：实际 HTTPS 登录、H4 许可图表和原生 React 表单；D1/14/0.2 创建、编辑 0.3、暂停恢复；水平线属性修改及真实鼠标拖动，松手后新版本保留 ATR；刷新恢复。关闭全部浏览器后 H4/D1 持续采集、worker 产生一次事件、本任务 ntfy sink 接受一次消息，重启无重复。检查消息实际边界/原目标/ATR/偏移，图表 origin 没有收到登录 cookie/authorization，页面无异常。

此环境用任务专属可控 Binance OHLC adapter，实际 API、缓存、后台采集、事务、许可图表与通知 worker 都运行产品代码。不是供应商实盘测试或参数收益回测；NY17/OANDA 用固定来源合同夹具验证，没有访问生产或真实 OANDA 账户。

## 本机实例与操作

主机 **quant-server（Ubuntu 本机 Docker）**，项目/task `mw-atr-offset-20261012`，独立网络、PG14 volume 和数据库。应用 `https://localhost:17443`，图表 `https://localhost:17444`，端口只监听本机。私有材料 `/tmp/mw-atr-offset-20261012-private`（0700）；许可库 ignored，不提交。通知仅至隔离内部 sink。

实例保留用于用户复核，任务未退役；已执行精确退役预览，没有 apply，也没有删除数据或资源。以下命令从实施目录执行；用户已授权 `sg docker`：

```bash
# 启动（镜像已经构建）
sg docker -c 'docker compose --env-file /tmp/mw-atr-offset-20261012-private/compose.env -p mw-atr-offset-20261012 -f deploy/ubuntu/atr-offset.acceptance.yaml --profile notification up -d --no-build'
# 真实 PostgreSQL 验证；需先确认 migrate 成功
sg docker -c 'docker compose --env-file /tmp/mw-atr-offset-20261012-private/compose.env -p mw-atr-offset-20261012 -f deploy/ubuntu/atr-offset.acceptance.yaml run --rm --no-deps verification'
# 完整浏览器验收（会归档本任务旧规则、创建新规则及生成一条本地通知）
LD_LIBRARY_PATH=/tmp/chromium-libs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome NODE_PATH=web/node_modules node web/tests/atr-offset-runtime.browser.cjs
# 停止，保留数据
sg docker -c 'docker compose --env-file /tmp/mw-atr-offset-20261012-private/compose.env -p mw-atr-offset-20261012 -f deploy/ubuntu/atr-offset.acceptance.yaml stop'
# 复核结束后按生命周期规则预览，再 apply（会归档数据库及实际恢复校验）
sg docker -c 'mw-docker retire --task mw-atr-offset-20261012 --project mw-atr-offset-20261012'
```

构建统一使用 `sg docker -c 'mw-docker build ...'`，组件 api/chart/web，明确 task/project/purpose=acceptance，专用 `market-watch-ubuntu` builder。Web build arg 为 `VITE_ADVANCED_CHART_ORIGIN=https://localhost:17444`。重建/重建容器后显式 restart 本任务 tls（必要时 web）以刷新 nginx 已解析的上游地址，避免旧 IP 导致 502。操作约束见[Ubuntu 生命周期规则](../deploy/ubuntu/README.md)。验收证据采集于提交前；用户随后授权提交 PR，生产尚未发布。
