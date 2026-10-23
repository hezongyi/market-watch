# mwa 行情涨跌与浏览器页签验收

风险分类 F0：兼容的行情字段修复与页签显示调整，无 schema 或持久格式迁移；采用定向回归、前端构建和现有 Ubuntu mwa 的 R1 浏览器验收。

## 问题与修复

平台行情已有昨收与涨跌计算，自建固定历史原先只有最新价；组合行情额外要求日线分钟覆盖完整，错误排除了已经闭合且来源确认的日线。后端修复保留同版本/修订、来源确认、时间闭合、正值及非未来约束，使用 Decimal 计算。

浏览器复现命令：`node docs/verification/quote-tab-20261022/mwa-tab.cjs`。修复前平台标题含 `▲ +0.11%`，组合标题为 `EURUSD 1.12452 我的图表`，断言失败。组合收到的 active-quote 消息没有 change。

API 更新后，实时 worker 仍使用旧镜像计算 quote_snapshot，推送的旧结果缺少 ch/chp。只将 market-stream-worker 更新至已验证 API 制品后，未改 Chart，组合标题立即恢复 `EURUSD 1.12420 ▲ +0.10% 我的图表`。因此沿用平台现有标题格式，没有增加前端涨跌算法或修改匹配规则。

自建标题现在为 `EURUSD·历史 [我的图表]`，省略价格、涨幅和迟延字样，保留网站 favicon。

## 验证

- API 镜像环境运行 quote_session_contract、composite_quotes、market_stream_worker：52 passed。
- `cd web && node tests/chart-tab-title.cjs`：先复现历史标题断言失败，修复后正/负/零涨幅、历史无价格、布局改名及工作区隔离通过。
- `cd web && node tests/chart-tab.cjs`：活动图、品种、工作区及销毁隔离通过。
- `cd web && npm run build` 及 mw-docker Web 构建通过；仅既有 bundle 大小提示。
- 实际三类页签及刷新验证见 browser-result.json；临时 Chromium context，保护工作区与偏好写入，未连接既有受保护浏览器 profile。

工作区前后完整一致。测试 context 内偏好保存被拦截，但全局偏好仍观察到变化（其他已打开的会话可以写入）；不能声称所有用户偏好在观察期不变，未以测试快照覆盖回写这些变化。早期版本 smoke 的整组偏好相等断言因此失败，已改为记录全局变化并验证本 context 写入受保护。

涨跌必须有合格昨收；没有可用闭合 D1 的固定历史仍不虚构涨跌。实际固定 USDCAD 已有 ch/chp，其余无可用昨收的自建系列按本次要求仅在页签显示历史身份。

## 运行与保留边界

Ubuntu 本机 quant-server，Compose project `mw-issue75-v2-20261018`，入口 https://192.168.7.232:18280 ，Chart origin https://192.168.7.232:18281 。分支 `feat/composite-mapping-native-20261021`，构建基线 `cc321a0c94eaa14769d4bf2280ce69f85245d48e` 加本轮工作树差异，精确源码与制品见 source.json、runtime-audit.json。

本次页签更新仅替换 Web 与 market-stream-worker；API 保留本会话先前修复制品，Chart 保留原镜像和容器。15 服务 running，API/PG healthy；环境、挂载、网络名称及端口不变，其他容器 ID 不变。无 seed/migrate/reset、清库或生产发布。

本会话更早的 API 更新曾因旧 overlay 引用而意外重建并回退 Web/Chart，已恢复为更新前实际镜像；本目录审计基线取恢复后的实际运行状态，不声称能证明那次操作前后所有容器不变。此次操作前已核对 overlay 与实际全部应用镜像一致，且仅显式操作两个必要服务。

长期运维：`python3 /home/quant/repos/.mwa-v1264-chart-init-20261021/manage.py start|status|stop`，持久 candidate 已更新。该入口 start 会操作全部应用服务，应先核对现状；本次实际使用原 base + candidate overlay，仅对目标服务执行 `up -d --no-deps --no-build --pull never`。

本轮专用回退 overlay：私有运维目录的 `tab-change-rollback-override.json`，结合原 integrated-compose.json，仅操作 web/market-stream-worker，并同步恢复持久 candidate 中这两项镜像引用。不要使用 manager 的历史默认 rollback，也不要整栈 recreate。真实数据、配置与保护浏览器长期保留。
