# 统一图表时区与正式登录页验收（2026-10-19）

当前分支 `feat/issue75-notifications-integrated-20261019`，基于 bfe78e4，复用通知 PR #87 的当前代码。用户明确要求复用当前分支/验收实例并同时接入已确认登录页。未动 main、其他任务 worktree 或独立登录预览实例，未合并或发布生产。

增量 **F0 / R1**：时间展示、输入转换、图表事件订阅及登录背景；API/schema/UTC 毫秒格式/告警触发、通知确认和队列语义不变。既有通知底座 F1/R2 证据继续保留。规则见 [产品合同](../../notification-timezone-contract-20261019.md)。

## 实例与操作

- Ubuntu 本机 quant-server（192.168.7.232），Docker project `mw-issue75-v2-20261018`；全服务状态和镜像 ID 见 [runtime.json](runtime.json)。API、PG 和供源/投影/告警 worker 继续运行，更新 web/chart 两个容器；重载当前 gateway 的 Nginx 使它刷新容器 DNS。
- 正式登录：<https://192.168.7.232:18280/login>；真实图表：<https://192.168.7.232:18280/advanced-charts/mw75-real>。图表隔离源 18281。凭据沿用现有实例，单独保存，不提交。
- 当前实例私有 Compose 启停入口：`python3 /tmp/mw75-integrated-compose.py up -d --no-build --no-deps web chart`；停止本轮展示服务：`python3 /tmp/mw75-integrated-compose.py stop web chart`。完整项目按相同 wrapper 的 `up -d --no-build` / `stop` 操作，不使用 `down -v`。不要停止其他 project。
- 构建只走 `mw-docker build --repo . --component web|chart --tag market-watch-web:issue75-v2-candidate|market-watch-chart:issue75-v2-candidate --task mw-issue75-v2-20261018 --project mw-issue75-v2-20261018 --purpose acceptance`；Web 额外传 `--build-arg VITE_ADVANCED_CHART_ORIGIN=https://192.168.7.232:18281`。
- 保留真实 OANDA 行情与上一轮 4 条 worker 实际触发的交易事件。外部投递仍关闭。跨午夜与即时浮窗使用当前隔离实例的明确标识验收条目，不将这些条目称作真实业务故障。创建了一条到期时间验收规则，比较值 9999，已通过正常 UI 暂停，保留回读证据；没有修改原 4 条规则或确认其事件。

## 实施与验证

`chartTime` 统一显式 Intl timeZone 格式化、分组、当地时间到 UTC 毫秒解析和日期边界。桥接统一订阅激活图格/时区/品种；`exchange` 与 datafeed 使用同一实际来源时区。初始 UTC 明确标注。各 React root 订阅共享状态；备用父页通过原有来源+会话校验桥接接收相同值。`api.date` 保持原样。

[Playwriter 结果](results.json)记录可对照 UTC 毫秒与预期显示。Playwriter 独立 session 7，通过本机 task-owned Chrome CDP 19276 验收；浏览器覆盖为 Asia/Shanghai。原浏览器及其他会话保留。

| 检查 | 结果与证据 |
| --- | --- |
| 浏览器上海、图表 UTC | 真实消息 1792403924794 显示 09:58:44；[UTC 列表](system-UTC.png)，[上海列表](system-Shanghai.png)，[纽约列表](system-New_York.png) |
| 已展示详情随时区更新 | [纽约事故详情](system-detail-new-york.png)、[展开排查记录](system-detail-expanded.png)；API 的 occurred_at/recorded_at 前后相同 |
| 跨午夜分组 | 两条 23:30Z/00:30Z 隔离验收记录，在 UTC 分两天、上海同为 19 日、纽约同为 18 日；[UTC](midnight-UTC.png)、[上海](midnight-Shanghai.png)、[纽约](midnight-New_York.png) |
| 筛选转换 | 纽约当地零点实际请求 since=1792296000000 / until=1792382400000；切 UTC 保留区间并显示 04:00；[转换后的输入](filter-utc-converted.png)。三个时区按各自日期边界查询分别命中 1/2/2 条跨午夜记录 |
| 纽约 DST 日期边界 | 3 月 8 日请求 05:00Z 至次日 04:00Z（23 小时）；11 月 1 日请求 04:00Z 至次日 05:00Z（25 小时）；[25 小时范围](filter-dst-25-hours.png)。超出留存的日期/未来日期返回 0 条，仅证明转换和实际查询，不伪称有该日期真实事件 |
| 多图激活图格 | 两图分别设上海/纽约，切激活图通知时区对应更新；[双图截图](multi-chart-active-ny.png)；整条记录 timestamp 不变。截图拍在清除筛选刷新间隙，分组数据另有上面的稳定截图 |
| 交易事件、检测和通知记录 | 原有真实事件同时显示事件/检测时间、网页/投递记录和服务端生成消息行；[上海详情](alert-detail-shanghai.png)、[UTC 详情](alert-detail-utc.png)。原始技术 JSON 保留 UTC 数字 |
| 即时浮窗与同条详情 | 同一系统事件 1792405973483 在 [纽约浮窗](instant-new-york.png)显示 06:32:53，[UTC 浮窗](instant-utc.png)显示 10:32:53，与 [详情](instant-matching-detail.png)一致。交易浮窗复用同一个 NoticeBubble/formatter；本增量未重新触发真实交易，队列/确认回归沿用既有验收及持久化测试 |
| exchange 与备用界面 | EURUSD 的 exchange 解析为 America/New_York；主动模拟原生呈现不可用后，[备用界面](fallback-shanghai.png)仍显示上海。检查完刷新恢复原生入口，移除浏览器临时拦截 |
| 到期创建/编辑与 DST | [02:30 跳跃拒绝](expiry-dst-gap.png)；[重复时间选择第二次 UTC−05:00](expiry-dst-fold-second.png)提交 1793514600000；[上海回读 14:30](expiry-edit-shanghai.png)保存新版本后仍是同一 UTC 值 |
| 正式登录页 | [深色](login-dark.png)、[浅色](login-light.png)、[窄屏](login-narrow.png)、[18.5 秒动态录屏](login-demo.mp4)。实际错误密码显示“密码不正确”；真实密码登录返回原图表；输入时动画继续、光标保持；暂停跨刷新保留；减少动态效果静止。背景不接收点击。后台停止的生命周期在同一最终组件的 [预览验收](../login-particles-preview-20261019/README.md)已有可见性证据 |

DST 重复时刻曾尝试原生 Select；实际鼠标验收发现菜单被原生对话框底部拦截，已替换为两枚原生 Button 并完成真实创建/编辑，无强制点击绕过。Nginx 在容器更换后出现过旧 DNS 的临时 502，重载后两个源均 HTTP 200；这些部署期间失败被现有系统消息如实保留。

## 自动检查与边界

- `npm run build`（TypeScript/Vite/数据中心 bundle）、正式 Web/chart Docker 构建、`node --check advanced-host/bridge.js`、`git diff --check` 通过。
- `chart-time.cjs` 在 `TZ=Asia/Shanghai` 和 `TZ=America/Los_Angeles` 都通过，覆盖 UTC/上海/纽约、毫秒往返、epoch 0、半小时/45 分钟时区、DST gap/fold、23/25 小时边界，以及真实桥接函数的激活图/交易所解析/重复订阅检查。
- `notifications-runtime.cjs`、真实 IndexedDB `notifications-persistence.cjs`、`chart-tab.cjs`、`single-app-routing.cjs` 通过；无新依赖、DB 迁移或后端源码改动。
- 排查 JSON 和手机已有投递正文是原始证据，仍保留底层 UTC 格式；网页生成的可读时间均随图表。无法重新解释的旧本机缺失警示浏览器时间后缀在显示时省略，保留条数且不迁移持久格式。
- 不宣称覆盖每个 IANA 历史时区、每种浏览器、物理手机送达、长时间压力或重新触发真实交易；本轮重点是显示/输入转换与正式登录。图表库为当前版本，未修改其许可库文件。
