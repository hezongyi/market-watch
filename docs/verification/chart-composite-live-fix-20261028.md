# 图表接入与组合实时恢复补丁（2026-10-28）

## 范围与基线

- 用户报告生产 XAUUSD / GBPUSD 组合行情停更，以及中央提示“图表界面接入未完成，请重新加载。”；要求真实登录截图、排查和修复。
- 基线：`v2.0.0-rc.1` / `0eac4fe7548f5df32c43e26415d9cf7e2e0ff581`；工作分支 `fix/chart-composite-live-20261028`。
- F1：涉及一次性持久实时开关初始化，但不改 schema、既有开关值、历史版本或生产数据。最小检查：确定性失败回归、相关前后端测试、独立 PostgreSQL 合约、Ubuntu 真实许可图表启动与系统消息交互、Standards / Spec review。
- 900 秒备份超时另有交接，不扩大本补丁；Yahoo 及 OANDA `rest_batch` 生产设置保持既有配置。

## 生产证据（只读）

生产主机 `ssh unraid`，Compose project `market-watch-v200rc1`。

1. Playwriter session 7 真实认证登录生产；任务新建页面连续重新加载，第二次出现中央错误条。截图位于本机 `/tmp/mw-production-chart-banner-reproduced-20261028.png`。图表仍有价格，不等于通知组件成功。
2. 生产 `NoticeIntake.body.code=CHART_SHELL_UNAVAILABLE` 报错：`Cannot create button: header widget is not ready or is not loaded - use headerReady to wait until header is ready`，随后有 25 秒接入超时。
3. `nativeNotificationSurface` 在等待 `headerReady` 前创建按钮；首次 `createButton` 又在清理 try/catch 之外。实际 shipped JS 的三项回归在旧代码全部失败。
4. GBPUSD / XAUUSD 源数据集的 managed realtime preference 都在首次启动 `1793198799296` 初始化为 false，没有用户切换审计。确认尾端都停在 `1793197320000`，有效需求为零；EURUSD 开关为 true，确认尾部持续前进。
5. GBPUSD / XAUUSD 均有过期浏览需求和活跃组合修订的 `live_confirmation` 输入事件（分别 1811 / 13982 个）。停机后的首次快照只看未过期租约，将旧实时系列永久保存为关闭。

## 修复与验收标准

- 通知 surface 必须先等待真实 `widget.headerReady()`，再申请原生 shell 和创建按钮；按钮/模块准备失败须释放已申请的 shell。保留故障提示，不通过隐藏提示或延长超时解决。
- 仅在 preference 尚不存在的一次性初始化中，保留同时具有旧浏览需求及真实 `live_confirmation` 输入的当前组合头。过期需求本身、准备历史输入本身、无浏览需求的共享源输入、已退役修订均不足以开启实时。
- 已保存的 true/false 始终优先，重复 bootstrap 不覆盖显式关闭；纯历史数据集保持关闭。
- 原有运行时 compatibility fallback 的租约有效期语义不变。
- 真实浏览器中人为延迟公开 headerReady 边界，连续五次打开/刷新均成功展示系统消息入口并打开消息面板，超过应用的 25 秒超时后没有中央错误条或 pageerror。

## 验证入口

```bash
# 在已启动的本任务 Ubuntu preview 中生成当前日期的合成图表缓存。
# 默认 D1 的旧 managed 品种未接入当前服务，不能将其作为价格渲染证据。
docker compose --env-file /dev/null -p mw-chart-live-fix-20261028 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-chart-live-fix-20261028/run.json \
  run --rm --no-deps -T \
  -v /home/quant/repos/market-watch-chart-live-fix-20261028/scripts/notification_startup_fixture.py:/fixture/notification_startup_fixture.py:ro \
  --entrypoint python api /fixture/notification_startup_fixture.py
PYTHONPATH=backend /home/quant/repos/market-watch/.venv/bin/python -m pytest -q \
  backend/tests/test_realtime_switch.py backend/tests/test_composite_quotes.py \
  backend/tests/test_composite_realtime.py
cd web
npm run test:single-frontend -- --unit
MW_BASE_URL=https://localhost:19843 \
MW_ACCEPTANCE_CREDENTIALS_FILE=/home/quant/.local/share/market-watch-docker/previews/mw-chart-live-fix-20261028/credentials.json \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
node tests/native-notification-startup.browser.cjs
```

Ubuntu Docker project/task：`mw-chart-live-fix-20261028`，地址 `https://localhost:19843`，仅回环可访问。独立 PG14.24 volume/network/credentials，API/Web/TLS，禁止真实供源和通知投递。其他任务资源保留。用户已明确豁免磁盘/swap 门槛；启动前核对端口、项目归属、内存和隔离，手动执行与 preview up 相同的镜像固定、迁移、D1 seed、启动顺序。

```bash
# 已初始化实例的启动/停止；不执行 down -v。
docker compose --env-file /dev/null -p mw-chart-live-fix-20261028 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-chart-live-fix-20261028/run.json \
  up -d --no-build --pull never --wait
docker compose --env-file /dev/null -p mw-chart-live-fix-20261028 \
  -f /home/quant/.local/share/market-watch-docker/previews/mw-chart-live-fix-20261028/run.json stop
```

## 当前结果

- 相关 SQLite 后端测试 116 passed；前端单元与交互回归通过；Ruff、diff check 通过。
- 完整许可 Web 和 API 均通过 Ubuntu `mw-docker` 构建。
- 独立 PostgreSQL 14.24 合约：30 passed（176 秒）。覆盖停机后首次快照、固定/跟随当前修订的过期需求、缺失证据仍关闭、显式开关及写入隔离。
- 真实 Chromium + 完整许可图表：五次打开/刷新均有真实原生 K 线渲染（任务合成 BTC 缓存）、系统消息入口/面板可用；每次两个 notification surface 都等待延迟 750ms 的 headerReady。超过 26 秒没有中央提示，pageerror 为零。
- 此浏览器验收只证明 UI 启动与交互，合成缓存不证明真实供源可用；生产两条冻结组合仍需上线后的真实尾部推进验证。
- 候选截图：本机 `/tmp/mw-notification-startup-fixed-20261028.png`。
- 独立 Standards review：0 findings；独立 Spec review：0 findings，另外独立运行 12 项后端 + 3 项通知回归通过。后续仅补充浏览器 probe 等待和隔离合成 fixture，没有修改产品行为。
- 验收镜像（非正式发布候选 tag）：API `market-watch-api:chart-live-fix-20261028` / `sha256:cbdfb0c22a36a09472c580bb3723f6701741b5122472d524340f10edc844a63d`；Web `market-watch-web:chart-live-fix-20261028` / `sha256:1fafc4936072be6676a40c0c4cb0348f9ad25ade74b7a2730732656434c08b29`。产品源码与两个修复提交一致，构建时 worktree dirty 已由工具标签留档。
- 尚未合并、发布正式 tag 或部署生产补丁。

## 生产恢复边界

本补丁不会把生产已经保存的 false 偏好强行覆盖。后续获本次生产授权后：

1. 留存 GBPUSD / XAUUSD 两个历史源 instrument 的当前开关、更新时间和审计；确认期间没有新增用户显式关闭。
2. 通过受支持的 managed-realtime API 仅恢复这两个历史源为 true（不是 OANDA 目标 instrument），保留审计；不改固定历史、工作区、草稿或其他开关。
3. 部署经审查候选 Web/API，保持五服务拓扑、Yahoo 启用和 OANDA rest_batch；沿用适用的已恢复验证备份和旧镜像留存按用户授权流程执行。
4. 用真实生产浏览器检查中央提示消失、系统消息入口/面板可用；确认 GBPUSD / XAUUSD 有效需求恢复，并在两个完成 M1 周期内确认尾端推进。
5. 新异常停止扩大操作并留存证据；不因服务心跳正常就宣布行情或界面正常。
