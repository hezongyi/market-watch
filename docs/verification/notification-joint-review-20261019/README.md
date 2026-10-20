# 联合验收 01–06 项修复（2026-10-19）

用户先要求共同查看、记录，随后授权“先把这些待改项全部修复”。本轮运行源码候选 **87a5db8**，沿用当前分支 `feat/issue75-notifications-integrated-20261019`、Draft PR #87 及当前 Ubuntu 验收项目；其他任务代码和实例保留。未合并 main、未创建正式发布 tag、未发布生产。

增量 **F0 / Ubuntu R1**：界面显示/筛选精简、现有同步错误恢复及本机显示排序；不修改后端源码、schema、IndexedDB v1 格式、UTC Unix 毫秒、告警判定、确认协议或手机投递。通知 PR 原有 F1/R2 分类及证据仍有效。

## 当前实例

- Ubuntu quant-server，192.168.7.232，project/task `mw-issue75-v2-20261018`。验收地址：<https://192.168.7.232:18280/advanced-charts/mw75-real?panel=notifications>。沿用已有密码，不归档凭据。
- 15 个长期服务全部运行，API/PostgreSQL 健康，供源、投影和告警 workers 保留真实数据；[运行清单/镜像 ID](runtime.json)。本轮只重建 web/chart，API 未重建，外部手机投递继续关闭。
- 构建：`mw-docker build --repo . --component web|chart --tag market-watch-web:issue75-v2-candidate|market-watch-chart:issue75-v2-candidate --task mw-issue75-v2-20261018 --project mw-issue75-v2-20261018 --purpose acceptance`；Web 另传 `--build-arg VITE_ADVANCED_CHART_ORIGIN=https://192.168.7.232:18281`。
- 启动/更新：`python3 /tmp/mw75-integrated-compose.py up -d --no-build --no-deps web chart`，随后 `docker exec mw-issue75-v2-20261018-gateway-1 nginx -s reload` 刷新容器 DNS。停止本轮展示服务：相同 wrapper 的 `stop web chart`；完整项目按 `stop` 操作，保留 volume，不使用 down -v。
- Playwriter session 7，本机任务浏览器 CDP 19276；保留原浏览器和其他会话。主验收页面恢复 UTC/1600×1000；新建独立 browser context 仅继承登录 cookie、不复制其他浏览器通知缓存，用于重现 109 条积压及检查排序。没有清理用户浏览器数据，没有点击真实交易的确定/手机停止。

## 页面及接口验收

| 项目 | 结果与证据 |
| --- | --- |
| 01 系统消息时区 | 删除独立时区行，列表和详情使用 `UTC+8 / UTC-4 / UTC+0`，仍跟随激活图表。[上海列表](01-system-list-updated.png)、[上海详情](01-system-detail-updated.png)、[同条纽约详情](01-system-detail-new-york-updated.png)。同条事件显示 20:47:33 / 08:47:33，与实际偏移一致 |
| 02 更多筛选 | 实际展开仅级别、来源；选信息+偏好设置后，实际请求仅 `severity=info&source=preferences&audience=system`，无 instrument/workspace/since/until。[两个控件](02-only-level-source-updated.png)、[组合筛选](02-level-source-query-updated.png) |
| 03 三横点入口 | 标题栏仅设置、关闭两按钮；搜索行三横点打开“全部消息/仅未读/更多筛选”。底部全部已读保留。[搜索行菜单](03-search-more-updated.png) |
| 04 交易告警 | 面板/编辑界面不再有显示时区行；到期、日志、事件/检测、通知记录统一紧凑偏移。[列表](04-alert-list-updated.png)、[上海详情](04-alert-detail-updated.png)、[纽约详情](04-alert-new-york-updated.png)、[到期输入及字段偏移](04-expiry-input-updated.png)。只查看既有暂停规则，未保存新版本 |
| 05 同步恢复 | 当前旧游标在真实接口返回 400；新历史基线游标返回 200。独立浏览器在旧版本复现 109 条积压，原样刷新到新版本后，109 个 ID 全部进入服务器历史，本机归零；保留的真实交易浮窗始终未确认。[更新前](05-repro-109-before-update.png)、[恢复后](05-recovery-109-after.png)、[结果/网络时间线](05-recovery-result.json) |
| 06 本机排序与筛选 | 在专用浏览器暂缓 POST 上传以保留 5 条排序样本，显示 005→001，时间倒序；新增本机/历史分区标题。选错误级别后 info 样本隐藏。移除拦截后 5 条自动上传并归零。[排序](06-local-pending-sorted.png)、[遵守筛选](06-pending-respects-filters.png)、[结果](06-sorting-result.json) |
| 850 窄屏 | 面板 400px，x438–838，未横向溢出；未新增顶部布局行。[窄屏](01-narrow-updated.png) |

全部文字/查询/尺寸断言见 [ui-results.json](ui-results.json)。主页面和恢复页面的 pageerror 均为空；最终主页面 API 诊断无失败。开发期间的旧游标 400、排序样本暂缓上传 503，以及容器重建阶段的连接失败是明确场景，不把浏览器历史 console 的这些条目称为最终界面异常。

## 积压根因、恢复与数据边界

用户[原截图](05-user-pending-109.png)中“仅本机待同步、连接受限、109 条本机记录”证明实际积压。日志中一个旧变化流游标重复 400 共 113 次；只读验证其 epoch/签名均与当前 stream 不同。旧实现只处理 409/NOTICE_RESET，400 会一直退避重试，且异常发生在本机上传之前，导致上传饥饿。[脱敏诊断](05-cursor-diagnosis.json)。

修复仅在“读取新消息”阶段识别 `400/无效通知游标`（兼容现有 API）或专用 `NOTICE_CURSOR_INVALID` 错误码，自动重新取基线。普通 400/503 不重置游标；认证 401 停止上传。把原有持久上传/投影确认提取为同步步骤，变化流读取失败后仍可进行上传；显示具体失败阶段。新基线不会把历史快照作为新触发回放；未确认交易凭据/浮窗保留，本机记录继续幂等上传。

**109 条恢复验收使用专门标记的隔离实例样本，不是从用户浏览器取得的那 109 条原始记录。** 样本接入真实 IndexedDB、API、数据库和投影 worker；所有 ID 唯一，服务端逐条回读确认。系统消息列表按事故合并，因此正常列表可显示 1 个累计事故；验证逐条记录时明确使用 `grouped=false` 查询，得到 109 条。另加 5 条排序样本，均自动上传，无手工删除。样本为 info，避免测试产生系统弹窗/声音；真实交易浮窗来自既有 EURUSD 事件，只在该专用浏览器保存待确认凭据，不确认、不新触发交易、不修改手机状态。

用户原浏览器仍需**刷新页面加载新版**；其既有本机记录保留，由新同步逻辑恢复。没有声称读取或清空用户那台浏览器的 IndexedDB。

## 自动检查与已保留边界

- TypeScript/Vite 构建、Web/chart Docker 构建、`git diff --check` 通过。
- `notifications-runtime.cjs` 新增并验证：旧签名 400/明确错误码恢复，读取失败仍上传，普通 400/503 不误重置，401 不上传，未确认交易保留，200 条显示上限下保留最新记录，同刻稳定排序。修复前新增恢复断言真实失败，修复后通过。
- `notifications-persistence.cjs` 真实 IndexedDB 的事务、去重、未确认保留、主体隔离及 v1 兼容通过（NODE_PATH 指向独立测试依赖，未修改其他 worktree 的 node_modules）。
- `chart-time.cjs` 在上海/洛杉矶两个宿主 TZ 通过：紧凑偏移、半小时/45 分钟、跨午夜、DST gap/fold、23/25 小时日界线及桥接订阅。`single-app-routing.cjs`、`chart-tab.cjs` 通过。
- 源码候选 CI：<https://github.com/hezongyi/market-watch/actions/runs/39254873984>，修复源码候选 `87a5db8` 的 Backend、Web、Compose 和 required checks 全部通过，状态见 ci.json；后续证据归档提交不改变运行源码。
- 用户暂时跳过的“系统即时浮窗不消失”反馈仍保留，未改 8 秒/悬停/焦点及交易必须确认的规则。本轮不扩大到长期压力、生产发布、物理手机送达或其他验收实例。
