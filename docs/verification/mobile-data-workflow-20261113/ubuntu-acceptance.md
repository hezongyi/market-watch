# Ubuntu 独立实例验收 · 2026-11-13

状态：真实供应商全流程通过，Android 真机待用户确认。风险 F0。基线 v2.0.11，实现提交 a87b6768；本次验收另修复手机端 Yahoo 代码展示并完善测试。

## 环境与构建

- 实际运行：Ubuntu `quant-server`，LAN `192.168.7.232`，Docker Compose project `mw-mobile-data-workflow-20261113`。不是 SSH 转发服务，未在 Unraid 部署。
- 独立服务：PostgreSQL 14.24、一次性 migrate、API、data worker、market runtime、web、TLS；独立 `_default` / `_egress` 网络与 `mw-mobile-data-workflow-20261113_postgres-data` volume、数据库和登录凭据。仅 TLS 在 loopback/LAN 18446 暴露，PG/API 无宿主发布端口。
- 私有配置及启停脚本：`/home/quant/.local/share/market-watch-docker/previews/mw-mobile-data-workflow-20261113/`。`run.json` 固定运行镜像 ID。此目录含凭据/证书，不提交 Git，也不是 preview 管理器的 prepare 记录。
- 服务预算约 4 GiB RAM / 3.85 CPU；用户清理后磁盘约 53–55 GiB 可用。保持其他任务实例。
- OANDA Practice/代理仅复用已有私有连接配置；初次验收时 Yahoo 开启、AKShare/FXCM 与外部通知关闭；按用户后续要求已开启全部供应商，见下方补验。OANDA stream，常驻 symbol 列表为空，持续需求由明确的手机实时开关产生。
- 构建均通过 `mw-docker compose-build` 关联 task/project/purpose=acceptance。完整 API 依赖下载极慢，终止本任务构建后，核实既有 v2.0.11 API 镜像 `requirements.lock` / `pyproject.toml` 与当前一致，再以其为依赖 base，删除并复制本分支 backend/migrations，执行 `pip install --no-deps --no-build-isolation .`。未直接复用旧应用代码。
- 依赖 base：`market-watch-api:android-personal-v205-two-kinds-20261113`，ID `sha256:d98ab8f2db8cc7dde6eb11075b49efdc8b41a6fb6b02006043820d8519544c70`。
- 实际 API：`sha256:dc9e1624c17081435a1d11ad3a53f181b22e78ed83cc83ebe2e721e1eac6f849`；最终 web：`sha256:0c708700ae4177a2a23de202340da751a33f191aa83154ad0ca26d88e14cb37e`，详见 [镜像清单](real/images.json)。这些是验收镜像，不是正式发布 tag。
- 容器已安装 `alerts.dataset_summaries` 与当前源码 SHA-256 一致：`a652a8b87dd3aa76888de0057df080f25384abee5242efc8d5f0f120c1d54791`。线上 shell 指纹 `4fe27040ab40b361`，mobile JS `mobile-C32ZJgKo.js`，mobile CSS `mobile-BLaEX3k5.css`。桌面 bundles 未变化。

访问与启停命令见 [主验收记录](README.md)。已有 debug APK 信任本环境的开发 CA；没有新构建 APK。

## 真实流程与证据

`web/tests/mobile-data-workflow.real.cjs` 仅允许本任务 18446 地址，并检查独立数据库目标；使用实际 UI/API/供应商，不拦截 HTTP、不直接写 SQL、不人工发布历史。脚本将动作分为阶段，重复执行维护/实时开关前应核对当前状态，不能把它当成无副作用的全量脚本。运行方式：在 `web/` 目录执行 `node tests/mobile-data-workflow.real.cjs <phase>`，phase 为 create/maintain/enable/inspect/update/disable/restore/schedule/chart/desktop。

| 场景 | 结果与证据 |
| --- | --- |
| 原生搜索→创建自建→后台历史 | Dukascopy EURUSD/XAUUSD、Yahoo AAPL 实际创建与发布；[发布记录](real/publications.json)、[AAPL 创建](real/real-create-AAPL.png) |
| 历史数据量 | EURUSD M1 首版 3999 / 更新版 4009 根，黄金 M1 3828 根；AAPL D1 31 / W1 7 / MN 2 根。图表使用后准备其他派生周期，属正常行为 |
| 必要步骤与精度 | EURUSD 目录缺精度，要求手填 5 后继续；黄金使用目录精度。保留真实必需字段 |
| 维护保存与暂停 | 手机保存 01:30 UTC，经独立 GET 读回；暂停计划不改变实时选择；结束时恢复计划。[过程](real/maintenance.json)、[保存截图](real/real-maintenance-saved.png) |
| 首次实时匹配 | EURUSD 普通匹配；黄金产品差异确认不可跳过；保存后明确开启。[过程](real/enable.json)、[黄金确认](real/real-live-confirm-XAUUSD.png) |
| 离页持续采集 | [首次观测](real/live-away-first.json) / [98 秒后](real/live-away-second.json)：零图表/策略/告警消费，durableTarget=true，connected/receiving，receivedAt/confirmedEnd 均推进，preparation=queried |
| 历史更新不替换实时基线 | 更新任务 published；before/after revision 完全一致，含 history_version_id/seam。[最终记录 baselinePreservation](real/final.json) |
| 明确关闭、单步重开 | 关闭 EURUSD 只移除其 durable target，黄金保持开启；重开复用已存匹配，不重复核对。[关闭观测](real/live-disabled.json)、[最终检查](real/final.json) |
| 实际专业图表 | 数据详情开图，许可 widget pane 可见，真实 charts/data 返回非空 bars。[手机图表](real/real-mobile-chart.png) |
| 桌面维护回归 | 桌面上下文直接打开 data_center 维护深链，原表单可用，时间读回 01:30，无修改。[截图](real/real-desktop-maintenance.png) |
| 运行健康 | 六个常驻服务零重启，API/PG healthy，migrate exit 0；按 checked_at/stale_after_ms 核查 27 个已启用角色，无 stale/missing/error_type。chart_alert / switch_activation 在任务配置中关闭，未作为缺失角色计数。[服务](real/services.json)、[角色](real/runtime-health.json) |

最终页面：[主页](real/real-home.png) · [EURUSD](real/real-detail-EURUSD.png) · [黄金](real/real-detail-XAUUSD.png) · [AAPL](real/real-detail-AAPL.png)。截图已人工检查。最终 EURUSD/黄金实时开启、维护计划恢复；AAPL 历史可用，当前实时不支持。

## 验收中修复与限制

Yahoo API 的 display_symbol 是内部逻辑编号，provider_display_symbol 才是 AAPL。本次修复只在手机端统一显示供应商代码，不改行情身份或服务端字段；主页、详情、任务、维护、实时核对及共用自选搜索使用同一显示函数。夹具改为真实字段组合，重新通过 13 组/54 张截图与共用搜索回归；最终构建通过。

供应商不是零故障：Dukascopy 首次目录刷新、Yahoo 首次探测曾返回 502，随后显式刷新/探测恢复；界面保留表单并允许重试。data worker 初次启动日志曾有一次 history_versions IntegrityError 警告，之后历史均成功发布，当前角色健康且无重启。本次短时验收不能证明供应商长期稳定。

桌面验证范围仅数据中心维护表单。截图背景默认原生 XAUUSD 图表提示未接入平台周期或交易日历，不作为桌面图表通过的证据；手机通过的是已准备好的 MWC 自建实时身份。首次桌面脚本误用了手机上下文、根路径重定向丢 query，修正测试入口后通过，未因此修改产品代码。

仓库证据只保留去凭据 JSON 与代表截图；失败截图及原始临时日志不作为通过证据。enable.json 保留首次开启时的历史状态，最终状态看 final.json。浏览器夹具和真实供应商结果分别记录，均不冒充 Android 真机。

## 剩余验收

Android 系统返回键、键盘、安全区、抽屉拖动、真实网络切换仍待用户在 APK 确认。当前无 ADB 设备；环境继续运行。未更新 PR/CI、合并、正式 tag、发布生产，也未退役仍需验收的数据 volume。

## 全供应商启用补验

用户要求“把所有供应商源都打开”后，已在同一 Ubuntu 验收实例启用全部六个来源，并持久写入私有 compose.json / run.json。API、data worker、market runtime 均核实 enabled_sources(history=True) 为 OANDA、Binance、Yahoo、Dukascopy、AKShare、FXCM。

FXCM 使用已有模拟账户连接的任务私有副本，SDK/helper 及凭据只读挂载；凭据为 0600、属容器 app uid 10001，configured()=true，动态库可解析。没有修改其他实例配置，没有提交私有材料；旧配置私有备份保留。API/worker 以原固定镜像重新创建，数据 volume 保留。

| 来源 | 当前可搜索目录条数 |
| --- | ---: |
| OANDA | 127 |
| Binance | 3742 |
| Yahoo | 8108 |
| Dukascopy | 1504 |
| AKShare | 8114 |
| FXCM | 517 |

FXCM 真实目录刷新成功；AKShare A 股 5223、港股 2808、期货 83，均真实刷新成功。这里验证配置与目录连接，不代表逐个品种/周期均完成历史拉取。31 个已启用运行角色状态正常；重启后 EURUSD/黄金恢复 connected/receiving，quote_ready=true。[目录证据](real/all-sources.json) · [角色](real/runtime-health-all-sources.json) · [实时恢复](real/live-all-sources.json)。访问地址与启停命令不变。
